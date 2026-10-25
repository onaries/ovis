import type { AgentStatus, PaneInfo } from "./herdr-api.generated.ts";
import { paneStorageId } from "./machines.ts";

/**
 * When a pane is worth interrupting the user for, and what the interruption says.
 * Shared by the browser's tab notifications and the server's web push, so a device
 * with the app open and a phone with it closed fire on exactly the same events.
 */

/** Statuses worth interrupting the user for. `idle`/`working` are the busy baseline. */
export function shouldNotifyStatus(previous: AgentStatus | undefined, next: AgentStatus): boolean {
  if (previous === undefined) return false; // first sighting (app open, new pane): not news
  if (previous === next) return false;
  return next === "blocked" || next === "done";
}

/**
 * The status the alerts take a pane for. One at rest whose turn's background work still runs
 * (`background_wait`, server/background-wait.ts) is working: that work's notice starts the next
 * turn by itself, and the finish is told once, when the work's turn ends.
 */
export function alertStatus(status: AgentStatus, waiting: boolean | undefined): AgentStatus {
  return waiting === true && status !== "working" && status !== "blocked" ? "working" : status;
}

/** The name a pane goes by in the sidebar and in every notification. */
export function paneTitle(pane: Pick<PaneInfo, "pane_id" | "cwd" | "terminal_title" | "terminal_title_stripped">): string {
  return pane.terminal_title_stripped ?? pane.terminal_title ?? pane.cwd ?? pane.pane_id;
}

const STATUS_BODY: Readonly<Record<string, string>> = {
  blocked: "waiting for your input",
  done: "work finished",
};

export function statusNotificationBody(status: AgentStatus): string {
  return STATUS_BODY[status] ?? String(status);
}

export const ENDED_NOTIFICATION_BODY = "terminal ended";

/** One notification slot per pane: a newer one replaces the older, whichever path showed it. */
export function paneNotificationTag(paneId: string, machineId = "local"): string {
  return machineId === "local" ? `herdr-pane-${paneId}` : `herdr-remote-${encodeURIComponent(machineId)}-${encodeURIComponent(paneId)}`;
}

/**
 * What one device wants to be alerted about. `input`: an agent waiting on the user.
 * `done`: a finished turn: never, only after one that worked a while (`long`, the default:
 * a quick answer is read where it was asked), or every one.
 */
export type DoneAlerts = "off" | "long" | "always";
export interface AlertPrefs {
  input: boolean;
  done: DoneAlerts;
}
export const DEFAULT_ALERTS: AlertPrefs = { input: true, done: "long" };

/** Only known values survive; anything else is the default, so a device never loses its alerts to a typo. */
export function parseAlerts(value: unknown): AlertPrefs {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const done = record["done"];
  return {
    input: typeof record["input"] === "boolean" ? record["input"] : DEFAULT_ALERTS.input,
    done: done === "off" || done === "long" || done === "always" ? done : DEFAULT_ALERTS.done,
  };
}

/** Whether a device with these preferences hears about this status at all (timing aside). */
export function alertsAllow(prefs: AlertPrefs, status: AgentStatus): boolean {
  if (status === "blocked") return prefs.input;
  if (status === "done") return prefs.done !== "off";
  return false;
}

/**
 * Whether the pane's alerts are off for everyone (the shared `muted_panes`, shared/preferences.ts):
 * then no channel (push, in-app, chime, tab notification) says anything about it, in any browser,
 * while its status is still tracked. The list keys a pane with its PC (`paneStorageId`), so a
 * pane id reused on another PC never inherits the mute. No list (an older server) mutes nothing.
 */
export function paneAlertsMuted(mutedPanes: readonly string[] | null | undefined, machineId: string, paneId: string): boolean {
  return mutedPanes != null && mutedPanes.includes(paneStorageId(machineId, paneId));
}
