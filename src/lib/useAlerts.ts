import { useMemo, useRef } from "react";
import type { AgentStatus } from "../../shared/protocol.ts";
import { alertPrefs, type Settings } from "./settings.ts";

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
