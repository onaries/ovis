/**
 * The phone's agent inbox as a state of the shell (App.tsx): whether it is offered (the setting, at a
 * phone's width), whether it stands in the pane's place now, and what the reader left in it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { inboxStartsOpen, waitStartsAfter, type InboxFilter } from "./agentInbox.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";
import { sidebarPinKey } from "./sidebarPins.ts";
import type { AppLink } from "./deepLink.ts";
import { SHEET_QUERY } from "./sheets.ts";
import { newQuestionReads } from "./useInboxQuestions.ts";
import { newSummaryReads } from "./useInboxSummaries.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

/**
 * When this page saw each agent begin to wait, by its row's key (lib/agentInbox.ts waitStartsAfter), fed every state
 * the roster shows so it outlives the list, which unmounts whenever a thread opens.
 */
export class InboxWaits {
  private readonly listeners = new Set<() => void>();
  private starts: ReadonlyMap<string, number> = new Map();
  private before: ReadonlyMap<string, AgentStatus | undefined> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The same object until a start is added or removed. */
  current = (): ReadonlyMap<string, number> => this.starts;

  /** Every row's shown state now, by key (none for a PC that is away), seen at `at`. */
  observe(statuses: readonly (readonly [string, AgentStatus | undefined])[], at: number): void {
    const next = waitStartsAfter(this.starts, this.before, statuses, at);
    this.before = new Map(statuses);
    if (next === this.starts) return;
    this.starts = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Forgets every start and state seen: the next observation is a first one, as at a page load. */
  reset(): void {
    this.before = null;
    if (this.starts.size === 0) return;
    this.starts = new Map();
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Feeds the page's waits every pane's shown state (none on a PC that is away) whenever one changes, list shown or not,
 * while the list is enabled on this device; otherwise it reads nothing and the waits keep no starts.
 */
export function useInboxWaits(waits: InboxWaits, machines: readonly Machine[], activity: SidebarActivity, enabled: boolean): void {
  const statuses = enabled ? machines.flatMap((machine) => (machine.snapshot?.panes ?? []).map((pane) =>
    [sidebarPinKey(machine.id, pane.pane_id), machine.state === "connected" ? activity.status(machine.id, pane) : undefined] as const)) : [];
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const signature = enabled ? statuses.map(([key, status]) => `${key}=${status ?? ""}`).join("\n") : null;
  useEffect(() => {
    if (enabled) waits.observe(statusesRef.current, Date.now());
    else waits.reset();
  }, [waits, enabled, signature]);
}

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
  /** the waiting agents' questions, kept for the page (the list unmounts whenever a thread opens) and read again at each mount */
  const [questionReads] = useState(newQuestionReads);
  /** each row's last words, read for the page as the questions are */
  const [summaryReads] = useState(newSummaryReads);
  /** when the page saw each agent begin to wait, fed by the roster (useInboxWaits) */
  const [waits] = useState(() => new InboxWaits());
  /** whether the drawer or the list covers the selected pane: its finishes are not read, its alerts not held back */
  const coveredRef = useMemo(() => ({ get current(): boolean { return drawerOpenRef.current === true || shownRef.current; } }) as RefObject<boolean>, [drawerOpenRef]);
  return { enabled, shown, cold, shownRef, enabledRef, coveredRef, show, leave, back, filter, setFilter, query, setQuery, scroll, questionReads, summaryReads, waits };
}
