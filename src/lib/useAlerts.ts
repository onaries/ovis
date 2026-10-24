import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AgentStatus, HerdrPane, ServerMessage } from "../../shared/protocol.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import { sendTestPush } from "./api.ts";
import { alertPaneTitle } from "../components/Sidebar.tsx";
import { alertPrefs, type Settings } from "./settings.ts";
import type { Translate } from "./i18n.ts";
import type { SelectionMark } from "./selectionMark.ts";
import {
  notificationState,
  refreshNotificationState,
  requestNotificationPermission,
  shouldNotifyStatus,
  alertStatus,
  alertsAllow,
  showPaneEndedNotification,
  showPaneStatusNotification,
  type NotificationState,
} from "./notifications.ts";
import { ensurePushSubscription, pushSupported, removePushSubscription } from "./push.ts";
import { hasNativePlugin, PUSH_PLUGIN } from "./nativeApp.ts";
import type { NotificationTarget } from "./notificationTarget.ts";
import { dropletAllows, endedTurn, seedStatuses, showDroplet, trackTurn, type DropletKind } from "./droplet.ts";
import { canPlayAlertSound, playAlertSound, unlockAlertSound, type AlertSoundKind } from "./alertSound.ts";
import { createAlertTurnPlayer } from "./alertTurns.ts";
import { sameTarget, type SplitState } from "./split.ts";

type PaneStatusMessage = Extract<ServerMessage, { type: "pane-status" }>;
type PaneExitedMessage = Extract<ServerMessage, { type: "pane-exited" }>;
type TakeNotificationTargetRef = RefObject<(target: NotificationTarget) => unknown>;

// the alerts take a pane waiting on its turn's background work for working (shared/notify-policy.ts)
const alerting = (list: Machine[]) => list.map((machine) => ({
  id: machine.id,
  snapshot: machine.snapshot && { panes: machine.snapshot.panes.map((pane) => ({ pane_id: pane.pane_id, agent_status: alertStatus(pane.agent_status, (pane as HerdrPane).background_wait) })) },
}));

/** This device's alert choices and its Alerts switch, with refs for the event stream. */
export function useAlertPrefs({ settings }: { settings: Settings }) {
  // this device's alert choices: sent with its push subscription, and applied to tab alerts here
  const alerts = useMemo(() => alertPrefs(settings), [settings.alertInput, settings.alertDone]);
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  // the Alerts item's switch for this device (the header's More menu): off drops its push subscription and silences tab and in-app alerts
  const alertsOn = settings.alertsOn;
  const alertsOnRef = useRef(alertsOn);
  alertsOnRef.current = alertsOn;
  return { alerts, alertsRef, alertsOn, alertsOnRef };
}

/** The browser's notification permission and whether this device has a push subscription. */
export function useNotificationState() {
  const [notifications, setNotifications] = useState<NotificationState>(() => notificationState());
  // in the phone app the permission is the app's (lib/notifications.ts): read from the app at load,
  // and again whenever the page comes back, as it may have been changed in the phone's Settings
  // meanwhile. A browser page keeps the permission it read at load, as before.
  useEffect(() => {
    if (!hasNativePlugin(PUSH_PLUGIN)) return;
    let current = true;
    const read = () => {
      // the newest permission known once the check answers, not the check's own reading: a tap's
      // answer that overtook it must not be put back to what the check read (lib/notifications.ts)
      refreshNotificationState().then(() => { if (current) setNotifications(notificationState()); }, (err) => console.warn("could not read the notification permission", err));
    };
    const onVisible = () => { if (document.visibilityState === "visible") read(); };
    read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      current = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  // this device has a server-side push subscription: alerts come from the server, not the tab
  const [pushOn, setPushOn] = useState(false);
  const pushOnRef = useRef(pushOn);
  pushOnRef.current = pushOn;
  return { notifications, setNotifications, pushOn, setPushOn, pushOnRef };
}

/** The per-pane turn bookkeeping and the in-app alert and sound switches, as refs. */
export function useAlertRefs({ settings }: { settings: Settings }) {
  // last-seen agent status per pane: the baseline that decides whether a push is news
  const statusRef = useRef<Map<string, AgentStatus>>(new Map());
  // when each pane's turn began, so an in-app alert knows a long turn from a quick one
  const turnStartRef = useRef<Map<string, number>>(new Map());
  // how long each pane's last finished turn took: a pane that ends is told by it too
  const lastTurnRef = useRef<Map<string, number>>(new Map());
  const alertInAppRef = useRef(settings.alertInApp);
  alertInAppRef.current = settings.alertInApp;
  const alertSoundRef = useRef(settings.alertSound);
  alertSoundRef.current = settings.alertSound;
  return { statusRef, turnStartRef, lastTurnRef, alertInAppRef, alertSoundRef };
}

export interface AlertSignalsParams {
  settings: Settings;
  selectionRef: RefObject<SelectionMark>;
  drawerOpenRef: RefObject<boolean>;
  splitRef: RefObject<SplitState | null>;
  splitShownRef: RefObject<boolean>;
  machinesRef: RefObject<Machine[]>;
  alertsRef: RefObject<AlertPrefs>;
  alertsOnRef: RefObject<boolean>;
  pushOnRef: RefObject<boolean>;
  statusRef: RefObject<Map<string, AgentStatus>>;
  turnStartRef: RefObject<Map<string, number>>;
  lastTurnRef: RefObject<Map<string, number>>;
  alertInAppRef: RefObject<boolean>;
  alertSoundRef: RefObject<boolean>;
}

/** The in-app alert and the alert sound, and what the event stream does with a status change. */
export function useAlertSignals({ settings, selectionRef, drawerOpenRef, splitRef, splitShownRef, machinesRef, alertsRef, alertsOnRef, pushOnRef, statusRef, turnStartRef, lastTurnRef, alertInAppRef, alertSoundRef }: AlertSignalsParams) {
  // In-app alerts (components/Droplet.tsx): only while the app is on screen - a hidden app has
  // its system notifications - and never for the pane already open in front of the user.
  const dropIn = useCallback((machine: Machine, pane: HerdrPane, kind: DropletKind) => {
    if (!alertsOnRef.current || !alertInAppRef.current || document.visibilityState !== "visible") return;
    const open = selectionRef.current;
    if (open.machineId === machine.id && open.paneId === pane.pane_id && !drawerOpenRef.current) return;
    if (splitShownRef.current && sameTarget(splitRef.current?.other ?? null, { machineId: machine.id, paneId: pane.pane_id }) && !drawerOpenRef.current) return;
    showDroplet({
      machineId: machine.id,
      paneId: pane.pane_id,
      agent: pane.agent ?? null,
      title: alertPaneTitle(pane),
      machine: machinesRef.current.length > 1 ? machine.name : null,
      kind,
    });
  }, []);

  // The alert sound (lib/alertSound.ts): heard also while the tab is hidden and a Focus silences
  // system notifications; never for the pane open in front of the user.
  const alertTurns = useRef<ReturnType<typeof createAlertTurnPlayer> | null>(null);
  useEffect(() => {
    const player = createAlertTurnPlayer({
      play: (kind) => alertsOnRef.current && alertSoundRef.current && playAlertSound(kind),
    });
    alertTurns.current = player;
    return () => { player.dispose(); alertTurns.current = null; };
  }, []);
  const chime = useCallback((machine: Machine, pane: HerdrPane, kind: AlertSoundKind) => {
    if (!alertsOnRef.current || !alertSoundRef.current || !canPlayAlertSound()) return;
    const open = selectionRef.current;
    if (document.visibilityState === "visible" && open.machineId === machine.id && open.paneId === pane.pane_id && !drawerOpenRef.current) return;
    if (document.visibilityState === "visible" && splitShownRef.current && sameTarget(splitRef.current?.other ?? null, { machineId: machine.id, paneId: pane.pane_id }) && !drawerOpenRef.current) return;
    alertTurns.current?.chime(JSON.stringify([machine.id, pane.pane_id, kind]), kind);
  }, []);

  // a page plays audio only after a tap or key on it: each one lets the next chime play. A mouse
  // activates the page on press, a touch only on release, so both ends of a tap try
  useEffect(() => {
    if (!settings.alertSound) return;
    const unlock = () => { void unlockAlertSound(); };
    const events = ["pointerdown", "pointerup", "keydown"] as const;
    for (const event of events) window.addEventListener(event, unlock, true);
    return () => { for (const event of events) window.removeEventListener(event, unlock, true); };
  }, [settings.alertSound]);
  const onRoster = useCallback((machines: Machine[]) => {
    seedStatuses(statusRef.current, alerting(machines), { started: turnStartRef.current, lasted: lastTurnRef.current });
  }, []);
  const onPaneStatus = useCallback((machine: Machine, message: PaneStatusMessage, takeNotificationTargetRef: TakeNotificationTargetRef) => {
    const key = paneStorageId(machine.id, message.pane_id);
    const previous = statusRef.current.get(key);
    const status = alertStatus(message.agent_status, message.background_wait);
    statusRef.current.set(key, status);
    const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
    const worked = trackTurn(turnStartRef.current, key, previous, status, Date.now());
    if (worked !== null) lastTurnRef.current.set(key, worked);
    if (pane && shouldNotifyStatus(previous, status) && dropletAllows(alertsRef.current, status, worked)) {
      const kind = status === "blocked" ? "blocked" : "done";
      dropIn(machine, pane, kind);
      chime(machine, pane, kind);
    }
    if (pane && shouldNotifyStatus(previous, status) && alertsOnRef.current && !pushOnRef.current && alertsAllow(alertsRef.current, status)) showPaneStatusNotification(message.pane_id, `${machine.name} · ${alertPaneTitle(pane)}`, status, () => takeNotificationTargetRef.current({ machine_id: machine.id, pane_id: message.pane_id, view: "chat", workspace_id: pane.workspace_id }), machine.id, pane.workspace_id);
  }, []);
  const onPaneExited = useCallback((machine: Machine, message: PaneExitedMessage, takeNotificationTargetRef: TakeNotificationTargetRef) => {
    const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
    const worked = endedTurn(turnStartRef.current, lastTurnRef.current, paneStorageId(machine.id, message.pane_id), Date.now());
    if (pane && dropletAllows(alertsRef.current, "done", worked)) {
      dropIn(machine, pane, "ended");
      chime(machine, pane, "done");
    }
    if (message.type === "pane-exited" && alertsOnRef.current && !pushOnRef.current && alertsRef.current.done !== "off") {
      const pane = machine.snapshot?.panes.find((p) => p.pane_id === message.pane_id);
      if (pane) showPaneEndedNotification(message.pane_id, `${machine.name} · ${alertPaneTitle(pane)}`, () => takeNotificationTargetRef.current({ machine_id: machine.id, pane_id: message.pane_id, view: "chat", workspace_id: pane.workspace_id }), machine.id, pane.workspace_id);
    }
  }, []);
  return { dropIn, chime, onRoster, onPaneStatus, onPaneExited };
}

export interface NotificationSwitchParams {
  updateSettings: (patch: Partial<Settings>) => void;
  locked: boolean | null;
  notifications: NotificationState;
  setNotifications: Dispatch<SetStateAction<NotificationState>>;
  alerts: AlertPrefs;
  alertsRef: RefObject<AlertPrefs>;
  alertsOn: boolean;
  setPushOn: Dispatch<SetStateAction<boolean>>;
}

/** The Alerts switch: turning this device's alerts on and off, and keeping its push subscription. */
export function useNotificationSwitch({ updateSettings, locked, notifications, setNotifications, alerts, alertsRef, alertsOn, setPushOn }: NotificationSwitchParams) {
  const enableNotifications = useCallback(async () => {
    // in-app alerts need no permission: the switch goes on whatever the browser answers
    updateSettings({ alertsOn: true });
    const current = notificationState();
    const next = current === "default" ? await requestNotificationPermission() : current;
    setNotifications(next);
    if (next !== "granted") return false;
    try {
      const endpoint = await ensurePushSubscription(alertsRef.current);
      setPushOn(endpoint !== null);
      // the confirmation push proves the whole path (server -> push service -> this device)
      if (endpoint) await sendTestPush(endpoint);
      return endpoint !== null;
    } catch (err) {
      console.warn("web push unavailable, alerts stay tab-only", err);
      return false;
    }
  }, [updateSettings]);

  // The browser's permission cannot be taken back from the page: turning alerts off drops
  // this device's push subscription (the server forgets it) and silences the tab's own.
  const disableNotifications = useCallback(async () => {
    updateSettings({ alertsOn: false });
    setPushOn(false);
    await removePushSubscription().catch((err) => console.warn("could not drop the push subscription", err));
  }, [updateSettings]);

  // in the app, alerts turned off while the PC could not be told keep the app's endpoint (lib/push.ts),
  // and the phone goes on getting this PC's alerts until the PC forgets it. With alerts off the removal
  // is tried again at load and whenever the app comes back into view (as when one of those alerts opens
  // it); it does nothing once the app holds no endpoint for this PC
  useEffect(() => {
    if (locked !== false || alertsOn || !hasNativePlugin(PUSH_PLUGIN)) return;
    const retry = () => { removePushSubscription().catch((err) => console.warn("could not drop the push subscription", err)); };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };
    retry();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [locked, alertsOn]);

  // a device that already allowed alerts re-registers on every load: idempotent, and it
  // brings the device back if the server lost its subscriptions; a changed choice of
  // alerts goes the same way
  useEffect(() => {
    if (locked !== false || notifications !== "granted" || !alertsOn || !pushSupported()) return;
    let cancelled = false;
    ensurePushSubscription(alerts)
      .then((endpoint) => {
        if (!cancelled) setPushOn(endpoint !== null);
      })
      .catch(() => {
        if (!cancelled) setPushOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [locked, notifications, alerts, alertsOn]);
  return { enableNotifications, disableNotifications };
}

export interface AlertsBellParams {
  t: Translate;
  settings: Settings;
  alertsOn: boolean;
  notifications: NotificationState;
  pushOn: boolean;
  enableNotifications: () => Promise<unknown>;
  disableNotifications: () => Promise<unknown>;
}

/** What the Alerts item in the header's More menu shows and does. */
export function alertsBell({ t, settings, alertsOn, notifications, pushOn, enableNotifications, disableNotifications }: AlertsBellParams) {
  // The Alerts item says what this device does, whatever the browser's permission: in-app alerts
  // need none, so they count as on. A device that has not answered the permission question is
  // asked by the item; one that has answered gets a plain switch.
  const bell: { state: string; title: string; on: boolean; run: () => Promise<unknown> } =
    !alertsOn
      ? { state: t("Off on this device"), title: t("Alerts off on this device. Tap to turn them on"), on: false, run: enableNotifications }
      : notifications !== "granted"
        ? !settings.alertInApp
          ? { state: t("Off on this device"), title: t("Notify me when a pane needs input or finishes"), on: false, run: enableNotifications }
          : notifications === "default"
            ? { state: t("On in the app"), title: t("Alerts on in the app. Tap to allow them when it is closed too"), on: true, run: enableNotifications }
            : { state: t("On in the app"), title: t("Alerts on in the app. Tap to turn them off"), on: true, run: disableNotifications }
        : pushOn
          ? { state: t("On, pushed to this device"), title: t("Alerts on, pushed to this device, even with the app closed. Tap to turn them off"), on: true, run: disableNotifications }
          : {
              state: t("On in this tab"),
              // turning them off and on again retries the push subscription
              title: pushSupported()
                ? t("Alerts on while this tab is open. Tap to turn them off")
                : t("Alerts on while this tab is open (closed-app alerts need https, and on iPhone the home-screen app). Tap to turn them off"),
              on: true,
              run: disableNotifications,
            };
  // hidden only where it could do nothing: no system notifications and in-app alerts off
  const bellVisible = notifications === "default" || notifications === "granted" || settings.alertInApp;
  // the menu's button carries a dot while alerts are off here: the one state of the menu worth a glance
  const alertsOffDot = bellVisible && !bell.on;
  return { bell, bellVisible, alertsOffDot };
}
