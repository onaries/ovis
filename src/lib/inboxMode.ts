/**
 * The agent inbox as a mode of the app: the list of agents and the thread a row opens, in the shell's place, on a
 * phone and on a desktop (components/InboxList.tsx, components/InboxMode.tsx). The address says the mode
 * (`?app=inbox`), in a parameter of its own that lib/deepLink.ts leaves in place while the app moves between panes,
 * so a reload, a link, Back and Forward agree on where the app is. A change of mode is one history entry in either
 * direction, and Back undoes it; a page that opened in the mode has nothing of the app under it. A phone whose
 * device setting says so (Settings → Start in the agent inbox on a phone) starts in the mode on a fresh navigation: its address
 * takes the mark by a replace, so Back on its list still leaves the app.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { inboxStartsOpen } from "./agentInbox.ts";
import { NAV_KEY, type AppLink } from "./deepLink.ts";
import { SEEN_KEY } from "./historyKeys.ts";
import { pageAddress, pageSearch } from "./pageQuery.ts";


const PARAM = "app";
const INBOX = "inbox";

/** Whether an address is the inbox mode's. */
export function inboxAddress(search: string): boolean {
  return new URLSearchParams(search).get(PARAM) === INBOX;
}

/** `search` with the mode's mark set or dropped, everything else as it was. */
export function withInboxAddress(search: string, inbox: boolean): string {
  const query = new URLSearchParams(search);
  if (inbox) query.set(PARAM, INBOX);
  else if (query.get(PARAM) === INBOX) query.delete(PARAM);
  const text = query.toString();
  return text ? `?${text}` : "";
}

/**
 * Whether a page load is a fresh navigation: an address opened, typed, pasted or tapped. Not a reload, not a step
 * through the history onto the page, and not an entry the app has stood on before, which carries a state where a
 * fresh one carries none. Every entry the app adds has a state of its own (a move between panes, a change of mode,
 * a sheet's or a dialog's entry); the entry a page loaded on has none, and the address bar writes on it with the
 * state it finds there, so useInboxMode marks it (SEEN_KEY, lib/historyKeys.ts), and marks any entry left without
 * a state as the page is hidden. The state stays with its entry over a reload and when the browser restores the
 * tab or loads it again after discarding it, which a browser may report as a navigation. `type` is how the
 * browser says the page was loaded (pageNavigation), undefined where it does not say: the entry's state alone
 * tells then.
 */
export function freshNavigation(type: string | undefined, state: unknown): boolean {
  return type !== "reload" && type !== "back_forward" && state === null;
}

/** How the browser says this page was loaded: navigate, reload, back_forward or prerender; undefined where it does not say. */
export function pageNavigation(): string | undefined {
  const [entry] = window.performance?.getEntriesByType?.("navigation") ?? [];
  return (entry as { type?: string } | undefined)?.type;
}

/**
 * Whether a fresh navigation to an address that names a pane (a tapped notification, a pasted link) starts in the
 * mode on a device that starts in the inbox: that pane's thread, with the list one Back under it. Yes, as the list
 * inside the classic shell opened such an address before the mode; kept on its own because the maintainer decides
 * this case.
 */
export function paneAddressStartsInInbox(link: AppLink | null): boolean {
  return Boolean(link?.pane);
}

/**
 * Whether a page starts in the mode on this device (Settings → Start in the agent inbox on a phone): a phone-width window that a
 * fresh navigation opened on the app's own start, which opens the list, or on a pane's address
 * (paneAddressStartsInInbox). An address that names only a workspace or a file opens as it always did, and so does
 * every wider window. The setting says where the phone starts, not where it stays: a reload and a restored page
 * open where their address says, so a phone that went Back to Ovis is still there afterwards.
 */
export function startsInInbox(setting: boolean, phone: boolean, link: AppLink | null, fresh: boolean): boolean {
  return setting && phone && fresh && (inboxStartsOpen(true, link) || paneAddressStartsInInbox(link));
}

/** startsInInbox for the page load this is. */
export function pageStartsInInbox(setting: boolean, phone: boolean, link: AppLink | null): boolean {
  return startsInInbox(setting, phone, link, freshNavigation(pageNavigation(), window.history.state));
}

export interface InboxMode {
  /** the app is in the inbox mode */
  on: boolean;
  /**
   * Whether the address the history is on is the mode's. A Back or Forward lands on its entry before React draws
   * the mode that entry is in, so what a listener does with the entry is decided here, not by `on`.
   */
  at(): boolean;
  /** into the mode, by one history entry */
  enter(): void;
  /** out of it, by one history entry */
  leave(): void;
  /**
   * Whether the shell has no drawer, for what asks outside a render (lib/useSidebarLayout.ts: a press, an edge
   * swipe). It starts as the mode the page loads in; the shell then says each render whether the mode's shell
   * stands, which the setup guide may hold back.
   */
  drawerBlocked: RefObject<boolean>;
}

/**
 * The mode the address names, kept in step with Back and Forward. Its popstate listener only reads: every
 * listener after it hears the same event (src/conventions.test.ts).
 */
export function useInboxMode({ startsIn }: {
  /** whether this device starts in the mode whatever its address says: asked once, as the page loads */
  startsIn?: () => boolean;
} = {}): InboxMode {
  const [starts] = useState(() => startsIn?.() === true);
  const [on, setOn] = useState(() => starts || inboxAddress(pageSearch()));
  const drawerBlocked = useRef(on);
  useEffect(() => {
    // a device that starts in the mode says so in its address, at load only: where it starts, not where it stays
    const address = starts && !inboxAddress(pageSearch()) ? pageAddress(window.location.pathname, withInboxAddress(pageSearch(), true), window.location.hash) : undefined;
    // An entry the app has stood on carries a state (freshNavigation): the one the page loaded on from here, and one
    // left without a state since (the auth link's own replace, a fragment typed into the address) by the time the
    // page is hidden, which comes before the browser can discard the tab or close with it.
    const seen = (): void => { if (window.history.state === null) window.history.replaceState({ [SEEN_KEY]: true }, ""); };
    const hidden = (): void => { if (document.visibilityState === "hidden") seen(); };
    if (address !== undefined) window.history.replaceState(window.history.state ?? { [SEEN_KEY]: true }, "", address);
    else seen();
    window.addEventListener("pagehide", seen);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", seen);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    const onPop = (): void => setOn(inboxAddress(pageSearch()));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((next: boolean): void => {
    const search = withInboxAddress(pageSearch(), next);
    if (search !== pageSearch()) window.history.pushState({ [NAV_KEY]: true }, "", pageAddress(window.location.pathname, search, window.location.hash));
    setOn(next);
  }, []);
  const enter = useCallback((): void => go(true), [go]);
  const leave = useCallback((): void => go(false), [go]);
  const at = useCallback((): boolean => inboxAddress(pageSearch()), []);
  return { on, at, enter, leave, drawerBlocked };
}
