import type { SessionSnapshot } from "../../shared/protocol.ts";
import { readLink, resolveLink, type AppLink } from "./deepLink.ts";
import { desktopLinks, type DesktopLinks } from "./desktopLink.ts";

export type NotificationPaneView = "chat" | "terminal";
/**
 * `workspace_id`: the workspace the pane was last seen in (server/push.ts), so an ended pane's tap opens it.
 * `link`: a desktop link's place, as the address's own link reads it (lib/desktopLink.ts): it lands as
 * that link does (linkLanding).
 */
export type NotificationTarget = { machine_id: string; pane_id: string; view?: NotificationPaneView; workspace_id?: string; link?: AppLink };
type Target = NotificationTarget;
type Select = (target: Target) => void;

export function notificationTargetFromSearch(search: string): NotificationTarget | null {
  const params = new URLSearchParams(search);
  const pane_id = params.get("pane");
  const view = params.get("view");
  if (!pane_id || (view !== "chat" && view !== "terminal")) return null;
  return { machine_id: params.get("machine") ?? "local", pane_id, view };
}

export function notificationViewForPane(target: NotificationTarget | null, machineId: string, paneId: string | null): NotificationPaneView | null {
  if (!target || paneId === null || target.machine_id !== machineId || target.pane_id !== paneId) return null;
  return target.view ?? null;
}
/** The roster is in and does not list this PC: it was removed since (the roster lists every PC set up, connected or not). */
export function machineMissing(roster: readonly { id: string }[], machineId: string): boolean {
  return roster.length > 0 && !roster.some((machine) => machine.id === machineId);
}

/**
 * Whether a PC named at roster `since` (the count of rosters the server had sent then) is gone:
 * only a roster the server sent after that can say so. The list in hand when a link or a
 * selection was made may predate the PC (a tab resumed before its roster refreshed, a PC just
 * added), and a list rebuilt from it (a pane's status) is no newer. `since` null: nothing waits.
 */
export function machineGone(roster: readonly { id: string }[], rosterSeq: number, since: number | null, machineId: string): boolean {
  return since !== null && rosterSeq > since && machineMissing(roster, machineId);
}

type RosterMachine = { id: string; snapshot?: { panes: readonly { pane_id: string }[] } | null };

/**
 * Where a tapped notification lands. A pane the roster lists: selected at once. Anything else
 * waits as a link to that pane (and the workspace it was last seen in) does, settled against the
 * PC's roster with the same notes (lib/deepLink.ts resolveLink). A PC the roster in hand does not
 * list is `stale`: only a roster asked for now says whether it is gone (machineGone).
 */
export function notificationLanding(roster: readonly RosterMachine[], target: NotificationTarget): { kind: "select" } | { kind: "link"; link: AppLink; stale: boolean } {
  const machine = roster.find((candidate) => candidate.id === target.machine_id);
  if (machine?.snapshot?.panes.some((pane) => pane.pane_id === target.pane_id)) return { kind: "select" };
  const link: AppLink = { machine: target.machine_id, workspace: target.workspace_id ?? null, pane: target.pane_id, view: target.view ?? null, settings: null };
  return { kind: "link", link, stale: machineMissing(roster, target.machine_id) };
}

type LinkRoster = { id: string; state?: string; snapshot?: Pick<SessionSnapshot, "workspaces" | "panes" | "layouts"> | null };

/**
 * Where a desktop link lands: as the address's own link does (lib/deepLink.ts resolveLink, as
 * lib/useAddressBar.ts lands a Back). Its pane is selected at once only when its PC is connected and
 * resolveLink places it with no note: in the workspace the link's id names, or the one its slug
 * names when the id was handed out again (a slug no open workspace has does not overrule the id);
 * a link with no workspace by its pane id. Anything else selects no pane yet: the link waits as the
 * address's does, settled once its PC is connected with its roster in, with its note
 * (lib/useSelection.ts), since an offline PC's cached roster may list a pane that has closed.
 * `stale`: as notificationLanding's.
 */
export function linkLanding(roster: readonly LinkRoster[], link: AppLink): { kind: "select"; pane: string } | { kind: "wait"; stale: boolean } {
  const machine = roster.find((candidate) => candidate.id === link.machine);
  const landed = machine?.state === "connected" && machine.snapshot ? resolveLink(machine.snapshot, link) : null;
  if (landed?.pane && !landed.note) return { kind: "select", pane: landed.pane };
  return { kind: "wait", stale: machineMissing(roster, link.machine) };
}

/** The same place: a second delivery of one tap (public/sw.js names it before and after focus), or of one link (its slug too). */
export function sameLink(a: AppLink | null, b: AppLink): boolean {
  return a !== null && a.machine === b.machine && a.pane === b.pane && (a.workspace ?? null) === (b.workspace ?? null)
    && (a.workspaceSlug ?? null) === (b.workspaceSlug ?? null) && (a.view ?? null) === (b.view ?? null);
}

type MessageSource = { addEventListener: (type: string, listener: (event: Event) => void) => void };

/**
 * The event the Android app dispatches on an open page's window with a tapped alert's "select-pane"
 * as its data (PCStore.selectionScript): a page on plain http has no navigator.serviceWorker. Taken
 * as the worker's message is, and cancelled, so the app knows this page heard it and does not
 * dispatch it on the worker as well, as it does for an older page.
 */
export const SELECT_PANE_EVENT = "ovis-select-pane";

/**
 * The pane a desktop link names, with the place as the address's own link reads it (`link`), which
 * is how it lands (linkLanding). A link that names no pane is no target.
 */
export function linkTarget(query: string): NotificationTarget | null {
  const link = readLink(query);
  if (!link.pane) return null;
  const place: AppLink = { machine: link.machine, workspace: link.workspace, workspaceSlug: link.workspaceSlug ?? null, pane: link.pane, view: link.view, settings: null };
  return { machine_id: link.machine, pane_id: link.pane, ...(link.view ? { view: link.view } : {}), link: place };
}

/**
 * Keep the newest target until App is ready, then deliver new selections directly: a tapped
 * notification's (the worker's messages, `source`, and SELECT_PANE_EVENT on the page, `page`), or a
 * desktop link's.
 */
export function notificationTargets(source?: MessageSource, links?: DesktopLinks, page?: MessageSource): (select: Select) => () => void {
  let pending: Target | null = null;
  let consumer: Select | null = null;
  const take = (target: Target): void => {
    if (consumer) consumer(target);
    else pending = target;
  };
  links?.onOpen((query) => {
    const target = linkTarget(query);
    if (target) take(target);
  });
  // a MessageEvent from the worker or the app; any other event has no data and is ignored
  const receive = (event: Event) => {
    const data = (event as Partial<MessageEvent>).data as { type?: unknown; pane_id?: unknown; machine_id?: unknown; view?: unknown; workspace_id?: unknown } | null;
    if (data?.type !== "select-pane" || typeof data.pane_id !== "string") return;
    const target: Target = {
      machine_id: typeof data.machine_id === "string" ? data.machine_id : "local",
      pane_id: data.pane_id,
    };
    if (data.view === "chat" || data.view === "terminal") target.view = data.view;
    if (typeof data.workspace_id === "string" && data.workspace_id !== "") target.workspace_id = data.workspace_id;
    take(target);
  };
  source?.addEventListener("message", receive);
  page?.addEventListener(SELECT_PANE_EVENT, (event) => {
    event.preventDefault();
    receive(event);
  });
  return (select) => {
    consumer = select;
    const target = pending;
    pending = null;
    if (target) select(target);
    return () => { if (consumer === select) consumer = null; };
  };
}

// Browser messages can arrive after document loading but before React's effect.
// Install this listener while App's module loads, before creating its root.
export const onNotificationTarget = notificationTargets(
  typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
  desktopLinks(),
  typeof window !== "undefined" ? window : undefined,
);
