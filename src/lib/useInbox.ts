/**
 * The agent inbox's list as a state of the shell (App.tsx): whether the inbox mode is on (lib/inboxMode.ts),
 * whether the list stands in the pane's place now, and what the reader left in it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { INBOX_FILTERS, inboxStartsOpen, type InboxFilter } from "./agentInbox.ts";
import type { PaneView } from "./actions.ts";
import type { AppLink } from "./deepLink.ts";
import { focusWorkspaceListToggle } from "./focus.ts";
import { newQuestionReads } from "./useInboxQuestions.ts";
import { newSummaryReads } from "./useInboxSummaries.ts";

/**
 * The shell's part in the mode's coming and going (App.tsx). The drawer is put away whenever the mode's shell stands,
 * however it came to (its entry, a Forward onto it); the way in closes the drawer, leaves a file open over the pane
 * behind (its viewer closes and its own entry stays under the mode's, so Back shows the pane with its file again),
 * enters the mode on its list, then where it may on the thread of the pane the app is on (below); and a mode with no
 * pane to show a thread of shows its list, once the page's link has landed. Left by any way
 * (Back to Ovis, the system Back), the mode takes its controls with it: a focus left nowhere goes to the classic
 * header's workspace-list toggle, as it does whenever the control that had it is gone (lib/focus.ts). A row's thread
 * takes the list off a phone's screen the same way, and the focus goes to the thread's Back.
 * The classic app and the mode are two views of one place: the conversation the app shows is the thread the mode
 * opens, and a thread opened in the mode is the pane the classic app shows (opening a row selects its pane; browsing
 * the list selects nothing). A draft and a chat's scroll belong to their pane (lib/composerDraft.ts, lib/chatScrollMemory.ts)
 * and come with it. So the way in opens the thread of the pane the app is on, when that pane has a row in the list
 * and already shows its chat (`here`): from 769px always, beside the list; on a phone, whose list is the mode's
 * screen, only when the mode was left on that same thread, and the list otherwise. A pane on its terminal enters on
 * the list, as one with no row does: opening its chat would change its lens and so release its pty's size, and the way
 * in sends nothing to any pane. It takes a reader's own two steps: the list first, as every way in does, and once the
 * list has covered the panes (they note what they hold as it covers them), the row's own opening of its pane (`open`),
 * which leaves the list by a history entry of its own, so the thread's Back is the list.
 */
export function useInboxShell({ inMode, shown, show, open, enter, setDrawerOpen, hideFile, selectedPaneId, linkLanded, thread, here, wide = false, focusInput }: {
  /** the mode's shell stands: the mode is on and the setup guide does not hold the classic shell */
  inMode: boolean;
  shown: boolean;
  show(): void;
  /** opens the selected pane's thread as its row in the list does */
  open?: () => void;
  enter(): void;
  setDrawerOpen(open: boolean): void;
  /** closes the file viewer and keeps the file's history entry (lib/useFileViewer.ts) */
  hideFile(): void;
  selectedPaneId: string | null;
  linkLanded: boolean;
  /** the thread the mode shows, by its row's key (lib/agentInbox.ts inboxKey); none on the list and in the classic app */
  thread: string | null;
  /**
   * the pane the app shows, by the same key, where it has a row in the list (an agent's pane) and shows its chat; else
   * null. Asked as the way in is taken
   */
  here?: () => string | null;
  /** the window is wider than a phone's (769px and up): the list stands beside the thread */
  wide?: boolean;
  /** puts the focus in the shown pane's input (its composer), where a fine pointer's typing goes */
  focusInput?: () => void;
}): { enterInbox(): void; returnTo: string | null } {
  useEffect(() => { if (inMode) setDrawerOpen(false); }, [inMode, setDrawerOpen]);
  useEffect(() => { if (inMode && !shown && selectedPaneId === null && linkLanded) show(); }, [inMode, shown, selectedPaneId, linkLanded, show]);
  const wasInMode = useRef(inMode);
  useEffect(() => {
    if (wasInMode.current === inMode) return;
    wasInMode.current = inMode;
    if (!inMode) focusWorkspaceListToggle("lost");
  }, [inMode]);
  // A row's thread takes the list off a phone's screen, and the row that had the focus with it: a focus left nowhere
  // goes to the thread's Back, which stands in the drawer toggle's place (lib/focus.ts) and raises no keyboard on a
  // touch screen. Where the pointer is fine it goes to the thread's input, as a pick does on a wide window: a row
  // whose pane was the one under the list (the classic app's, entered from) is no new pick, and nothing else gives
  // it there. On a wide window the row is still there: a focus that is somewhere stays.
  // Only a thread the list opened: a page that opens on one, and a thread that takes another's place, move no focus.
  const listed = useRef(false);
  const focusInputRef = useRef(focusInput); focusInputRef.current = focusInput;
  useEffect(() => {
    if (!inMode) { listed.current = false; return; }
    if (shown) { listed.current = true; return; }
    if (thread === null || !listed.current) return;
    listed.current = false;
    window.requestAnimationFrame(() => {
      if (document.activeElement !== null && document.activeElement !== document.body) return;
      if (window.matchMedia?.("(pointer: coarse)").matches !== true) focusInputRef.current?.();
      // the input could not take it (the terminal shown, a modal): Back
      focusWorkspaceListToggle("lost");
    });
  }, [inMode, shown, thread]);
  // the thread the mode was last on (none when it was last on its list), kept while the classic app stands
  const leftOn = useRef<string | null>(null);
  useEffect(() => { if (inMode) leftOn.current = thread; }, [inMode, thread]);
  const entry = useRef({ here, wide, open }); entry.current = { here, wide, open };
  // the pane whose thread the way in opens once its list stands
  const opening = useRef<string | null>(null);
  const enterInbox = useCallback((): void => {
    setDrawerOpen(false); hideFile(); enter(); show();
    const pane = entry.current.here?.() ?? null;
    opening.current = pane !== null && entry.current.open !== undefined && (entry.current.wide || leftOn.current === pane) ? pane : null;
  }, [setDrawerOpen, hideFile, enter, show]);
  // after the commit that put the list over the panes: the panes' own effects of that commit ran first
  useEffect(() => {
    if (!inMode || !shown || opening.current === null) return;
    opening.current = null;
    entry.current.open?.();
  }, [inMode, shown]);
  // The row a list opened by Back from a thread gives the focus to (components/InboxList.tsx): the thread that was
  // shown, so a keyboard or a screen reader keeps its place. A list opened any other way (the page's start, a way
  // in, a link whose pane is gone) returns to none and takes the focus itself. Set in the render that opens the
  // list, so the list drawn by that render already sees it.
  const [was, setWas] = useState({ thread, inMode });
  const [returnTo, setReturnTo] = useState<string | null>(null);
  if (was.thread !== thread || was.inMode !== inMode) {
    setWas({ thread, inMode });
    setReturnTo(inMode && was.inMode && thread === null && shown ? was.thread : null);
  }
  return { enterInbox, returnTo };
}

/**
 * Whether the way in may open the thread of the pane the classic app is on: only a pane with a row in the list that the
 * app draws alone (no split of the app's own shown, and its tab draws that one pane: a one-pane tab or one zoomed onto
 * it), on its chat with no terminal peek over it. Opening its thread then changes nothing the classic app draws: a
 * sibling or another half would be hidden or unmounted (a release, a detach), and a peek or a terminal would give up
 * the pty's size. Every other pane enters on the list, as the mode always did.
 */
export function wayInOpensThread({ hasRow, view, peek, drawnPanes, splitShown }: {
  hasRow: boolean; view: PaneView; peek: boolean; drawnPanes: number; splitShown: boolean;
}): boolean {
  return hasRow && !splitShown && drawnPanes === 1 && view === "chat" && !peek;
}

/** What the list lets the shell ask of it (components/InboxList.tsx), for as long as it is drawn. */
export interface InboxListHandle {
  /** to the list's top, with the keyboard's focus on the list: the press on the rail's current place (components/InboxRail.tsx) */
  toTop(): void;
}

/** The history entry's mark that it was pushed on leaving the list: Back on such an entry returns to it. */
export const INBOX_FROM_KEY = "ovis:from-inbox";

/** What the reader left in the list, kept in the tab's session storage: a reload keeps it, a new tab starts fresh. */
export const INBOX_LIST_KEY = "ovis:inbox-list";
interface KeptList { filter: InboxFilter; query: string; scroll: number }

function keptList(): KeptList {
  const fresh: KeptList = { filter: "all", query: "", scroll: 0 };
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(INBOX_LIST_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return fresh;
    const { filter, query, scroll } = value as Partial<Record<keyof KeptList, unknown>>;
    return {
      filter: INBOX_FILTERS.find((choice) => choice === filter) ?? "all",
      query: typeof query === "string" ? query : "",
      scroll: typeof scroll === "number" && Number.isFinite(scroll) && scroll >= 0 ? scroll : 0,
    };
  } catch {
    return fresh;
  }
}

function keepList(list: KeptList): void {
  try {
    window.sessionStorage.setItem(INBOX_LIST_KEY, JSON.stringify(list));
  } catch {
    /* no session storage (private mode, a page with none): the list is kept for the page only */
  }
}

export function useInbox({ on, initialLink, drawerOpenRef }: {
  /** the app is in the inbox mode: the list is a place of it, at every width */
  on: boolean; initialLink: AppLink | null; drawerOpenRef: RefObject<boolean>;
}) {
  const enabled = on;
  // open from a start whose address names no pane until a pane is picked; a mode entered later opens it itself
  // (App.tsx), and a thread opened by its own address opens it from the header's Back (back)
  const [open, setOpen] = useState(() => inboxStartsOpen(on, initialLink));
  const shown = open && enabled;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  // How many times the list has opened: the page's start on it, a way in, a Back onto it. The list takes the focus
  // once for each (components/InboxList.tsx notes which in `taken`), so one only drawn again for another width (a
  // window widened past a phone's with a thread open) takes none and the thread's composer keeps the focus. Counted
  // in the render that shows the list, so the list drawn by that render already sees it.
  const [opening, setOpening] = useState(shown ? 1 : 0);
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    if (shown) setOpening(opening + 1);
  }
  const focusTaken = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // no pane was opened since the page loaded: nothing is mounted for one under the list
  const coldRef = useRef(shown);
  useEffect(() => { if (!shown) coldRef.current = false; }, [shown]);
  const cold = shown && coldRef.current;
  const show = useCallback(() => setOpen(true), []);
  const leave = useCallback(() => setOpen(false), []);
  // a step back asked of the history and not landed yet: the entry still carries the mark until it has, and a
  // second step would go past the list (out of the app on a cold start). A step that leaves the document and is
  // cancelled, or a page restored from the page cache, fires pageshow and no popstate
  const goingBack = useRef(false);
  useEffect(() => {
    const landed = (): void => { goingBack.current = false; };
    window.addEventListener("popstate", landed);
    window.addEventListener("pageshow", landed);
    return () => {
      window.removeEventListener("popstate", landed);
      window.removeEventListener("pageshow", landed);
    };
  }, []);
  useEffect(() => { if (shown) goingBack.current = false; }, [shown]);
  /** the header's Back: the entry the list pushed is left through the history, any other place opens the list */
  const back = useCallback(() => {
    if (goingBack.current) return;
    if ((window.history.state as Record<string, unknown> | null)?.[INBOX_FROM_KEY] === true) {
      goingBack.current = true;
      window.history.back();
    } else setOpen(true);
  }, []);
  const [kept] = useState(keptList);
  const [filter, setFilter] = useState<InboxFilter>(kept.filter);
  const [query, setQuery] = useState(kept.query);
  /** the list's scroll offset, kept while a thread is open, while the mode is left, and over a reload */
  const scroll = useRef(kept.scroll);
  /** the list drawn now, which the mode's rail asks for its top */
  const list = useRef<InboxListHandle>(null);
  const listRef = useRef({ filter, query });
  listRef.current = { filter, query };
  useEffect(() => { keepList({ filter, query, scroll: scroll.current }); }, [filter, query]);
  useEffect(() => {
    // the offset changes on every scroll event: it is stored as the page is hidden, which comes before a reload
    const store = (): void => { keepList({ ...listRef.current, scroll: scroll.current }); };
    const hidden = (): void => { if (document.visibilityState === "hidden") store(); };
    window.addEventListener("pagehide", store);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", store);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  /** the waiting agents' questions, kept for the page (the list unmounts whenever a thread opens) and read again at each mount */
  const [questionReads] = useState(newQuestionReads);
  /** each row's last words, read for the page as the questions are */
  const [summaryReads] = useState(newSummaryReads);
  /** whether the drawer or the list covers the selected pane: its finishes are not read, its alerts not held back */
  const coveredRef = useMemo(() => ({ get current(): boolean { return drawerOpenRef.current === true || shownRef.current; } }) as RefObject<boolean>, [drawerOpenRef]);
  return { enabled, shown, cold, shownRef, enabledRef, coveredRef, show, leave, back, filter, setFilter, query, setQuery, scroll, list, questionReads, summaryReads, focus: { opening, taken: focusTaken } };
}
