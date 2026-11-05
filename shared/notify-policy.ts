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
/** a blocked agent that said it waits for a permission (AlertKind `permission`) */
export const PERMISSION_NOTIFICATION_BODY = "waiting for your permission";
/** a turn that stopped on an error (AlertKind `error`) */
export const ERROR_NOTIFICATION_BODY = "stopped on an error";

/** One notification slot per pane: a newer one replaces the older, whichever path showed it. */
export function paneNotificationTag(paneId: string, machineId = "local"): string {
  return machineId === "local" ? `herdr-pane-${paneId}` : `herdr-remote-${encodeURIComponent(machineId)}-${encodeURIComponent(paneId)}`;
}

/**
 * What one device wants to be alerted about. `input`: an agent waiting on the user.
 * `done`: a finished turn: never, only after one that worked a while (`long`, the default:
 * a quick answer is read where it was asked), or every one.
 * `permission`: an agent that said it waits for a permission (herdr-core's `agent_kind`); absent,
 * it follows `input`, as it did before there was a choice. A blocked agent that does not say what it
 * waits for is `input`. `error`: a turn that stopped on an error (OmO and GJC say so); absent is off.
 * `pcs_off`: the PCs whose panes this device hears nothing of, each by its relay ID where it has one
 * (one both its own server and every roster know it by), else by its name; absent is none.
 */
export type DoneAlerts = "off" | "long" | "always";
export interface AlertPrefs {
  input: boolean;
  done: DoneAlerts;
  permission?: boolean;
  error?: boolean;
  pcs_off?: string[];
}
export const DEFAULT_ALERTS: AlertPrefs = { input: true, done: "long" };

/** What an alert is about, as the push says (shared/push.ts PushPayload `kind`). */
export type AlertKind = "input" | "permission" | "done" | "ended" | "error";

/** PCs one device can silence; more are a hand-edited record. */
export const ALERT_PCS_MAX = 64;

/** A list of PC names: strings only, each once, bounded. Anything else is none. */
export function parseAlertPcs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === "string" && name.length > 0 && name.length <= 200))].slice(0, ALERT_PCS_MAX);
}

/** Only known values survive; anything else is the default, so a device never loses its alerts to a typo. */
export function parseAlerts(value: unknown): AlertPrefs {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const done = record["done"];
  const pcsOff = parseAlertPcs(record["pcs_off"]);
  return {
    input: typeof record["input"] === "boolean" ? record["input"] : DEFAULT_ALERTS.input,
    done: done === "off" || done === "long" || done === "always" ? done : DEFAULT_ALERTS.done,
    ...(typeof record["permission"] === "boolean" ? { permission: record["permission"] } : {}),
    ...(typeof record["error"] === "boolean" ? { error: record["error"] } : {}),
    ...(pcsOff.length > 0 ? { pcs_off: pcsOff } : {}),
  };
}

/** What a blocked pane waits for, by what its agent reported (`agent_kind`, herdr-core only). */
export function blockedAlertKind(agentKind: string | null | undefined): "input" | "permission" {
  return agentKind === "permission" ? "permission" : "input";
}

/** Whether a device with these preferences hears of this kind of alert (timing and PC aside). */
export function alertKindAllowed(prefs: AlertPrefs, kind: AlertKind): boolean {
  switch (kind) {
    case "input": return prefs.input;
    case "permission": return prefs.permission ?? prefs.input;
    case "done":
    case "ended": return prefs.done !== "off";
    case "error": return prefs.error === true;
  }
}

/**
 * Whether a device with these preferences hears of the panes of a PC known by `keys`: its name and,
 * where known, its relay ID (shared/machines.ts pcAlertKey). One of them listed in `pcs_off` silences it.
 */
export function alertPcAllowed(prefs: AlertPrefs, ...keys: readonly (string | undefined)[]): boolean {
  const off = prefs.pcs_off ?? [];
  return !keys.some((key) => key !== undefined && off.includes(key));
}

/**
 * Whether a device with these preferences hears about this status at all (timing aside). A blocked
 * pane is told by what it waits for (`agentKind`, blockedAlertKind).
 */
export function alertsAllow(prefs: AlertPrefs, status: AgentStatus, agentKind?: string | null): boolean {
  if (status === "blocked") return alertKindAllowed(prefs, blockedAlertKind(agentKind));
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
