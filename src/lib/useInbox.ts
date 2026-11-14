/**
 * The phone's agent inbox as a state of the shell (App.tsx): whether it is offered (the setting, at a
 * phone's width), whether it stands in the pane's place now, and what the reader left in it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { inboxStartsOpen, type InboxFilter } from "./agentInbox.ts";
import type { AppLink } from "./deepLink.ts";
import { SHEET_QUERY } from "./sheets.ts";
import { newQuestionReads } from "./useInboxQuestions.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

/** The history entry's mark that it was pushed on leaving the list: Back on such an entry returns to it. */
export const INBOX_FROM_KEY = "ovis:from-inbox";

export function useInbox({ setting, initialLink, drawerOpenRef }: { setting: boolean; initialLink: AppLink | null; drawerOpenRef: RefObject<boolean> }) {
  const phone = useMediaQuery(SHEET_QUERY);
  const enabled = setting && phone;
  // open from a start whose address names no pane until a pane is picked (a window widened and narrowed
  // again before then shows it again); a setting turned on later opens it from the header's Back (back)
  const [open, setOpen] = useState(() => inboxStartsOpen(setting && typeof window !== "undefined" && window.matchMedia?.(SHEET_QUERY).matches === true, initialLink));
  const shown = open && enabled;
  const shownRef = useRef(shown);
  shownRef.current = shown;
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
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [query, setQuery] = useState("");
  /** the list's scroll offset, kept while a thread is open */
  const scroll = useRef(0);
  /** the waiting agents' questions, read once for the page: the list unmounts whenever a thread opens */
  const [questionReads] = useState(newQuestionReads);
  /** whether the drawer or the list covers the selected pane: its finishes are not read, its alerts not held back */
  const coveredRef = useMemo(() => ({ get current(): boolean { return drawerOpenRef.current === true || shownRef.current; } }) as RefObject<boolean>, [drawerOpenRef]);
  return { enabled, shown, cold, shownRef, enabledRef, coveredRef, show, leave, back, filter, setFilter, query, setQuery, scroll, questionReads };
}
