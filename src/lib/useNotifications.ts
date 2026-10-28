import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { Settings } from "./settings.ts";
import { ApiError, sendTestPush } from "./api.ts";
import { notificationState, refreshNotificationState, requestNotificationPermission, type NotificationState } from "./notifications.ts";
import { ensurePushSubscription, pushSupported, registeredPushEndpoint, removePushSubscription } from "./push.ts";
import { refreshPushHealth, resetPushHealth, runPushAction, type PushActionOutcome, type PushActionResult } from "./pushHealth.ts";
import { hasNativePlugin, PUSH_PLUGIN } from "./nativeApp.ts";

/**
 * Why making and registering this device's subscription threw. The PC's own answer is an ApiError
 * (a retired endpoint the browser keeps handing over is "gone"), and a fetch that never reached it
 * a TypeError; anything else came from the browser's PushManager or the app's push plugin, which
 * would not make a subscription (Brave with its push service off, a phone without one).
 */
export function subscribeFailure(error: unknown): PushActionResult {
  if (error instanceof ApiError) return error.code === "subscription_gone" ? "gone" : "unregistered";
  return error instanceof TypeError ? "unregistered" : "refused";
}

/** A repair's outcome, about the subscription it registered when it got that far (lib/pushHealth.ts). */
export function repairOutcome(result: PushActionResult): PushActionOutcome {
  return result === "sent" ? { result, endpoint: registeredPushEndpoint() } : { result };
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
  const alertsOnRef = useRef(alertsOn);
  alertsOnRef.current = alertsOn;
  // what it came to is the repair's answer too (lib/pushHealth.ts): "sent" once this device is
  // subscribed and its confirmation push went out, else why not
  const enableNotifications = useCallback(async (): Promise<PushActionResult> => {
    // in-app alerts need no permission: the switch goes on whatever the browser answers
    updateSettings({ alertsOn: true });
    const current = notificationState();
    const next = current === "default" ? await requestNotificationPermission() : current;
    setNotifications(next);
    if (next !== "granted") return "permission";
    try {
      let endpoint: string | null;
      try {
        endpoint = await ensurePushSubscription(alertsRef.current);
      } catch (err) {
        console.warn("web push unavailable, alerts stay tab-only", err);
        return subscribeFailure(err);
      }
      setPushOn(endpoint !== null);
      // no subscription and nothing thrown: push is not here at all, or the service worker never came up
      if (endpoint === null) return pushSupported() ? "no-worker" : "unsupported";
      // the confirmation push proves the whole path (server -> push service -> this device)
      try {
        await sendTestPush(endpoint);
      } catch (err) {
        console.warn("the confirmation push failed", err);
        return "failed";
      }
      return "sent";
    } finally {
      // what the confirmation push came to is now the device's latest delivery: the notice reads it
      void refreshPushHealth(alertsOnRef.current);
    }
  }, [updateSettings]);

  // The browser's permission cannot be taken back from the page: turning alerts off drops
  // this device's push subscription (the server forgets it) and silences the tab's own.
  const disableNotifications = useCallback(async () => {
    updateSettings({ alertsOn: false });
    setPushOn(false);
    resetPushHealth();
    await removePushSubscription().catch((err) => console.warn("could not drop the push subscription", err));
  }, [updateSettings]);

  // the notice's repair is Settings' Turn alerts on again: one flow, one state (lib/pushHealth.ts)
  const repairNotifications = useCallback(() => {
    void runPushAction("repair", async () => repairOutcome(await enableNotifications()), () => alertsOnRef.current);
  }, [enableNotifications]);

  // in the app, alerts turned off while the PC could not be told keep the app's endpoint (lib/push.ts),
  // and the phone goes on getting this PC's alerts until the PC forgets it. With alerts off the removal
  // is tried again at load and whenever the app comes back into view (as when one of those alerts opens
  // it); it does nothing once the app holds no endpoint for this PC
  useEffect(() => {
    if (locked !== false || alertsOn || !hasNativePlugin(PUSH_PLUGIN)) return;
    const retry = () => {
      if (alertsOnRef.current) return;
      removePushSubscription().catch((err) => console.warn("could not drop the push subscription", err));
    };
    const onVisible = () => { if (document.visibilityState === "visible") retry(); };
    retry();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [locked, alertsOn]);

  // a device that already allowed alerts re-registers on every load: idempotent, and it
  // brings the device back if the server lost its subscriptions; a changed choice of
  // alerts goes the same way
  useEffect(() => {
    if (locked !== false || !alertsOn) return;
    // the permission changed away from granted (taken back in the phone's Settings while the app was away,
    // read only once it is back): what is known of this device is read again, so no repair stays offered
    // that cannot help
    if (notifications !== "granted" || !pushSupported()) {
      void refreshPushHealth(true);
      return;
    }
    let cancelled = false;
    ensurePushSubscription(alerts)
      .then((endpoint) => {
        if (!cancelled) setPushOn(endpoint !== null);
      })
      .catch(() => {
        if (!cancelled) setPushOn(false);
      })
      // registered (or not): what the server knows of this subscription says whether alerts arrive
      .finally(() => {
        if (!cancelled) void refreshPushHealth(true);
      });
    return () => {
      cancelled = true;
    };
  }, [locked, notifications, alerts, alertsOn]);

  // back in front (a phone switching apps, a tab chosen again): a push that failed meanwhile is read now
  useEffect(() => {
    if (locked !== false || !alertsOn) return;
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && alertsOnRef.current) void refreshPushHealth(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [locked, alertsOn]);
  return { enableNotifications, disableNotifications, repairNotifications };
}
