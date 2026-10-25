import type { AgentStatus } from "../../shared/protocol.ts";
import { ENDED_NOTIFICATION_BODY, paneNotificationTag, statusNotificationBody } from "../../shared/notify-policy.ts";
import { callNative, hasNativePlugin, PUSH_PLUGIN } from "./nativeApp.ts";

/**
 * Tab alerts: Web Notifications for pane status transitions while this page is open
 * but hidden. A device with a push subscription (lib/push.ts) gets the same alerts from
 * the server instead, and App skips these. Notification exists only in secure contexts
 * (https or localhost) - a plain-http LAN deployment reports "unsupported", and the bell
 * there switches only the in-app alerts.
 *
 * The phone app's web view has no Notification either: there the permission is the app's, asked
 * through its push plugin (lib/nativeApp.ts), and the app shows the server's pushes itself.
 *
 * The transition policy is shared with the server (shared/notify-policy.ts).
 */

export { alertStatus, alertsAllow, paneAlertsMuted, shouldNotifyStatus } from "../../shared/notify-policy.ts";

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

/** The app's permission, the newest of its push plugin's answers (`askApp`); the page cannot read it synchronously. */
let appPermission: NotificationState = "default";
/**
 * Orders the plugin's answers, so an out-of-date one never replaces a newer one. A check counts from
 * when it was asked: what it read can be older than an answer that overtakes it (the page came back
 * into view as the user tapped Alerts, and the check answers after the tap's request). A request
 * counts from when its answer came, as the user gave it then.
 */
let turns = 0;
let answeredTurn = 0;

export function notificationState(): NotificationState {
  if (hasNativePlugin(PUSH_PLUGIN)) return appPermission;
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  return globalThis.Notification.permission;
}

/**
 * Capacitor's permission states as the app's push plugin answers them; Android's "prompt-with-rationale"
 * may still ask. Resolves to the newest permission known, which an answer that overtook this one set.
 */
async function askApp(method: "checkPermissions" | "requestPermissions"): Promise<NotificationState> {
  const asked = method === "checkPermissions" ? ++turns : 0;
  const { notifications } = await callNative<{ notifications?: string }>(PUSH_PLUGIN, method);
  const turn = method === "requestPermissions" ? ++turns : asked;
  if (turn > answeredTurn) {
    answeredTurn = turn;
    appPermission = notifications === "granted" ? "granted" : notifications === "denied" ? "denied" : "default";
  }
  return appPermission;
}

/** The app's permission read anew from its push plugin, as the phone's Settings can change it while the page is away; elsewhere notificationState(). */
export async function refreshNotificationState(): Promise<NotificationState> {
  return hasNativePlugin(PUSH_PLUGIN) ? askApp("checkPermissions") : notificationState();
}

export async function requestNotificationPermission(): Promise<NotificationState> {
  if (hasNativePlugin(PUSH_PLUGIN)) return askApp("requestPermissions");
  if (typeof globalThis.Notification === "undefined") return "unsupported";
  const permission = await globalThis.Notification.requestPermission();
  return permission === "granted" ? "granted" : permission === "denied" ? "denied" : "default";
}

/**
 * Shown through the service worker when there is one: Android Chrome has no
 * `new Notification()`, and the worker's notificationclick (public/sw.js) selects the
 * pane. The constructor is the fallback for a page without a worker.
 */
async function show(paneId: string, title: string, body: string, onClick?: () => void, machineId = "local", workspaceId?: string): Promise<void> {
  if (typeof globalThis.Notification === "undefined") return;
  if (globalThis.Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return; // visible tab: the UI already shows it
  const options: NotificationOptions = { body, tag: paneNotificationTag(paneId, machineId), data: { pane_id: paneId, machine_id: machineId, ...(workspaceId ? { workspace_id: workspaceId } : {}) }, icon: "/icons/icon-192.png?v=sheep1" };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
    if (registration?.active) {
      await registration.showNotification(title, options);
      return;
    }
    const notification = new globalThis.Notification(title, options);
    notification.addEventListener("click", () => {
      window.focus();
      onClick?.();
    });
  } catch {
    /* no way to show it here: the sidebar badge still carries the change */
  }
}

/** `workspaceId`: the pane's workspace, as the server's push names it (server/push.ts), so a tap after the pane ends opens it. */
export function showPaneStatusNotification(paneId: string, title: string, status: AgentStatus, onClick?: () => void, machineId = "local", workspaceId?: string): void {
  void show(paneId, title, statusNotificationBody(status), onClick, machineId, workspaceId);
}

export function showPaneEndedNotification(paneId: string, title: string, onClick?: () => void, machineId = "local", workspaceId?: string): void {
  void show(paneId, title, ENDED_NOTIFICATION_BODY, onClick, machineId, workspaceId);
}
