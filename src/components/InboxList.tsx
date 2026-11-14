import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Ellipsis, ListFilter, Monitor, Plus, Search, Terminal, TriangleAlert, X } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { heldOrder, INBOX_FILTERS, inboxEmpty, inboxFiltered, inboxKey, inboxOrder, inboxSearched, inboxSinceAt, inboxStatus, inboxWords, plainWords, type InboxFilter } from "../lib/agentInbox.ts";
import { agentGroup, type AgentRow } from "../lib/agentRoster.ts";
import { stateSince } from "../lib/agentStateSince.ts";
import type { HeaderConnection } from "../lib/headerConnection.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { inboxAsks, inboxRowLine, inboxStateWord } from "../lib/inboxRow.ts";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { agentName } from "../lib/runtimeMove.ts";
import { useSettings } from "../lib/settings.ts";
import { knownStatus } from "../lib/status.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";
import { agentContext, agentTabName, paneMark } from "../lib/sidebarAgents.ts";
import { useAgentStateStamps } from "../lib/useAgentStateSince.ts";
import { questionTargets, useInboxQuestions, type QuestionReads } from "../lib/useInboxQuestions.ts";
import { summaryTargets, useInboxSummaries, type RowSummary, type SummaryReads } from "../lib/useInboxSummaries.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { AgentMark } from "./AgentMark.tsx";
import { OvisMark } from "./OvisMark.tsx";
import { agentRowTitle, blockedNote, stateAge } from "./AgentSidebar.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { compactWorktreeName, StatusBadge } from "./Sidebar.tsx";
import "./InboxList.css";

/** More, drawn by the list (the top start control on a phone, the column's foot from 769px); the shell owns its menu. */
export interface InboxMore {
  label: string;
  expanded: boolean;
  /** what a press opens: a popover menu, or a phone's sheet */
  popup: "menu" | "dialog";
  onPress(anchor: HTMLElement): void;
}

export interface InboxListProps {
  machines: Machine[];
  activity: SidebarActivity;
  /** this device only watches: it is offered no New workspace */
  watching: boolean;
  /** the column beside the thread it opens (from 769px); else the list is the screen */
  wide: boolean;
  filter: InboxFilter;
  onFilter(filter: InboxFilter): void;
  query: string;
  onQuery(query: string): void;
  scroll: RefObject<number>;
  /**
   * How many times the list has opened and the opening it last took the focus for (lib/useInbox.ts), and the row
   * (inboxKey) that opening gives the focus to: the one whose thread a Back just left; none on any other opening.
   */
  focus: { opening: number; taken: RefObject<number>; row?: string | null };
  /** the row (inboxKey) whose thread shows beside the list */
  current?: string | null;
  onOpen(machineId: string, paneId: string): void;
  onNew(machineId: string): void;
  /** the page's reader of the waiting agents' questions (lib/useInbox.ts), which outlives this list */
  questionReads: QuestionReads;
  /** the page's reader of each row's last words (lib/useInbox.ts), which outlives this list */
  summaryReads: SummaryReads;
  more?: InboxMore;
  /** the way out of the mode, drawn at the column's foot where the classic sidebar's foot has the way in */
  onExit?: () => void;
  /** the header's note, between a phone's two top controls: the list has no header to say it in */
  note?: ReactNode;
  /** what the connection has to say (lib/headerConnection.ts), which a thread says under its name: one quiet line here */
  connection?: HeaderConnection;
  /** why the roster's last load failed (the read's own message), and the way to load it again: the read it starts, which
   *  the list waits on to say a Retry is on its way */
  failure?: { error: string; retry(): Promise<void> | void } | null;
}

/** the marks drawn as a full tile, which fill the round face; the others sit on it as a glyph */
const TILE_MARKS = new Set(["claude", "omp", "omo"]);
/** how long after a press in the list its rows keep their order */
const PRESS_HOLD_MS = 1000;
/** how often the rows' times are drawn again, while one is drawn */
const CLOCK_MS = 30_000;

/** The words a row's last turn says: the agent's as written, the user's own marked as theirs. */
function lastWords(summary: RowSummary | undefined, t: Translate): string | null {
  if (summary === undefined) return null;
  const text = plainWords(summary.text);
  if (text === null) return null;
  return summary.role === "user" ? t("You: {text}", { text }) : text;
}

/** An agent's round mark: a tile mark fills the face, any other sits on it; a pane with no agent draws the shell's glyph. */
export function InboxAvatar({ mark }: { mark: string | null }) {
  const tile = mark !== null && TILE_MARKS.has(mark);
  return (
    <span className={`inbox-avatar${tile ? " is-tile" : ""}`} aria-hidden="true">
      <span className="inbox-avatar-face">{mark === null ? <Terminal /> : <AgentMark agent={mark} size={32} />}</span>
    </span>
  );
}

/**
 * The inbox mode's list: every shown PC's agents, the ones that need the reader first, each a row of two lines.
 * A row opens its agent's chat; nothing is answered or typed from here.
 */
export function InboxList({ machines, activity, watching, wide, filter, onFilter, query, onQuery, scroll, focus, current = null, onOpen, onNew, questionReads, summaryReads, more, onExit, note, connection = null, failure = null }: InboxListProps) {
  const t = useT();
  const pressPane = useContext(PanePressContext);
  const root = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const { settings, resolvedLanguage } = useSettings();
  // at a phone's width a menu of the list's is a sheet, a dialog (RowMenu): its button says which
  const popup = useMediaQuery(SHEET_QUERY) ? "dialog" : "menu";
  // within a state, the Agents list's own order (Settings → Within a state), names as its rows draw them
  const { agentGroupSort: sort, sidebarRows, statusIndicators } = settings;
  const all = useMemo(() => inboxOrder(machines, activity, { sort, name: (row) => agentRowTitle(row, sidebarRows === "one").drawn }), [machines, activity, sort, sidebarRows]);
  const questions = useInboxQuestions(questionReads, questionTargets(all, activity));
  const summaries = useInboxSummaries(summaryReads, summaryTargets(all, activity));
  // when this device saw each agent's state begin: App stamps the changes for as long as the page lives, the Agents
  // list reads them, and a waiting row's time is read from the same stamps (lib/useAgentStateSince.ts)
  const stamps = useAgentStateStamps();
  // the rows' times age on a clock that ticks only while one is drawn (AgentSidebar.tsx); the time is read in the
  // render that draws new words, a new wait or another set of timed rows, so their landing costs no second render
  const [tick, setTick] = useState(0);
  /** the agent's own words its row draws: the search finds them too */
  const wordsOf = (row: AgentRow): string | null => {
    const online = row.machine.state === "connected";
    const key = inboxKey(row);
    return inboxWords({
      group: agentGroup(inboxStatus(row, activity)), blocked: online ? blockedNote(row.entry.pane, t) : null,
      question: questions.get(key) ?? null, plan: online ? row.entry.pane.plan : undefined, last: lastWords(summaries.get(key), t),
    });
  };
  const found = inboxSearched(inboxFiltered(all, filter, activity), query, machines, t, wordsOf);

  // a state change never moves a row under a finger or the keyboard's focus (AgentSidebar.tsx): while either is in
  // the list, rows keep the order last drawn; the reader's own doing (a filter, a query) draws them as they are at
  // once. Only a focus drawn with its ring holds them: the one this list gives a row after a thread's Back is no
  // one's place on a touch screen, and held there it would keep a new question from rising to the top
  const [focusIn, setFocusIn] = useState(false);
  const [pressHeld, setPressHeld] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdAfterPress = (): void => {
    if (pressTimer.current !== null) clearTimeout(pressTimer.current);
    setPressHeld(true);
    pressTimer.current = setTimeout(() => { pressTimer.current = null; setPressHeld(false); }, PRESS_HOLD_MS);
  };
  useEffect(() => () => { if (pressTimer.current !== null) clearTimeout(pressTimer.current); }, []);
  const readerKey = `${filter}\n${query}`;
  const kept = useRef<{ readerKey: string; order: readonly string[] } | null>(null);
  const holding = (focusIn || pressHeld) && kept.current?.readerKey === readerKey;
  const shown = holding ? heldOrder(found, inboxKey, kept.current?.order ?? []) : found;
  useEffect(() => {
    if (!holding) kept.current = { readerKey, order: shown.map(inboxKey) };
  });

  // the place the list had is reached again once its rows are back: a waiting row's question and each row's last words come after the mount,
  // and a list shorter than the place clamps it. Until the place is reached or the reader touches the list, a scroll
  // (the clamp's own) is not kept as the place; once they do, the place is theirs and is never set again
  const restoring = useRef<number | null>(scroll.current);
  const stopRestoring = (): void => { restoring.current = null; };
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null || restoring.current === null) return;
    node.scrollTop = restoring.current;
    if (node.scrollTop === restoring.current) restoring.current = null;
  }, [questions, summaries]);
  // The list takes the focus once for each time it opens. One only drawn again for another width finds its opening's
  // focus taken, and leaves the focus where it is: in the composer of the thread it now stands beside. Opened by
  // Back from a thread, it gives the focus to that thread's row while it still draws it: the reader's place.
  const { opening, taken, row: returnTo = null } = focus;
  const rowNodes = useRef(new Map<string, HTMLButtonElement>());
  useLayoutEffect(() => {
    if (taken.current === opening) return;
    taken.current = opening;
    ((returnTo === null ? undefined : rowNodes.current.get(returnTo)) ?? root.current)?.focus({ preventScroll: true });
    // the row is the opening's, read as the opening changes
  }, [opening, taken]);

  const [pcMenu, setPcMenu] = useState<HTMLElement | null>(null);
  const [filterMenu, setFilterMenu] = useState<HTMLElement | null>(null);
  // the column's search field opens on request and stays while it holds words: a query never narrows the list unseen
  const [searchAsked, setSearchAsked] = useState(false);
  const searchOpen = !wide || searchAsked || query !== "";
  useLayoutEffect(() => { if (wide && searchAsked) search.current?.focus(); }, [wide, searchAsked]);

  const severalPcs = machines.length > 1;
  const rows = shown.map((row) => {
    const { machine, entry } = row;
    const { pane, workspace, tab } = entry;
    const online = machine.state === "connected";
    const status = inboxStatus(row, activity);
    const group = agentGroup(status);
    const title = agentRowTitle(row, false).title;
    const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
    const place = agentContext({
      agentLabel: null, title, markAgent: null, machineName: null,
      workspaceLabel: workspace.worktree?.is_linked_worktree ? compactWorktreeName(workspace.label) : workspace.label,
      tabName: agentTabName(tab, tabs, t),
    }).filter((part) => part !== title).join(" · ");
    const kind = entry.canonicalAgent;
    const key = inboxKey(row);
    const summary = summaries.get(key);
    // a finished turn whose last words are a request the agent recorded as failed: it says so, never Done
    const failed = online && group === "done" && summary?.failed === true;
    const state = !online ? t("Offline") : failed ? t("Turn failed") : inboxStateWord(group, t);
    const line = inboxRowLine({ online, group, words: wordsOf(row), place, machine: severalPcs ? machine.name : null, failed }, t);
    return {
      key, machine, pane, online, status, group, title, line, failed, mark: paneMark(entry) ?? "", kind, state,
      asks: online && inboxAsks(group), since: online ? inboxSinceAt(group, summary, group === "blocked" ? stateSince(stamps, machine.id, pane.pane_id, pane.terminal_id, "blocked") : null) : null,
    };
  });
  const timed = rows.some((row) => row.since !== null);
  // read again whenever the clock ticks, new words or a new wait land, or the rows that draw a time change (a filter
  // that drew none while the clock stood still brings one back)
  const timedRows = rows.flatMap((row) => row.since === null ? [] : [row.key]).join("\n");
  const now = useMemo(() => Date.now(), [tick, summaries, stamps, timedRows]);
  useEffect(() => {
    if (!timed) return;
    const timer = setInterval(() => setTick((count) => count + 1), CLOCK_MS);
    return () => clearInterval(timer);
  }, [timed]);
  const connected = machines.filter((machine) => machine.state === "connected");
  const offerNew = !watching && connected.length > 0;
  // the sheet of PCs is for a choice among two or more: it closes when that choice goes, and stays closed if it comes back
  useEffect(() => { if (connected.length < 2) setPcMenu(null); }, [connected.length]);
  const emptyWhy = inboxEmpty(machines, all.length, rows.length);
  // The mode's own three empty states, each saying what happened and, where there is something to do, what, on a
  // line of its own: the round plus starts a workspace, and is named only where it is drawn. None says what the
  // rows are: the mode's chrome does not.
  // a load that failed with no row to show says so, with its cause and a way to try again, where a load in flight
  // says Loading… and a roster with nothing running says so: a failure is never taken for either
  const failed = failure !== null && all.length === 0 ? failure : null;
  // a Retry's read on its way, from the press until that read ends: Retry takes no other press meanwhile
  const [retrying, setRetrying] = useState(false);
  const retry = (): void => {
    if (retrying || failed === null) return;
    setRetrying(true);
    void Promise.resolve(failed.retry()).finally(() => setRetrying(false));
  };
  // The failure gave way to rows (or the empty line): Retry left the page, and with it the focus it held. The list
  // takes the focus, as it does each time it opens, without a scroll; a focus that is somewhere else stays there.
  const failing = failed !== null;
  const wasFailing = useRef(failing);
  useLayoutEffect(() => {
    const was = wasFailing.current;
    wasFailing.current = failing;
    if (!was || failing) return;
    const at = document.activeElement;
    if (at === null || at === undefined || at === document.body) root.current?.focus({ preventScroll: true });
  }, [failing]);
  const empty = emptyWhy === "loading" ? [t("Loading…")]
    : emptyWhy === "none" ? (offerNew ? [t("Nothing is running yet"), t("Use + to start a workspace")] : [t("Nothing is running yet")])
    : emptyWhy === "no-match" ? [t("No results")] : null;

  /** a state's mark as the Agents list's rows end with it (Sidebar.tsx): drawn only for the states that have one */
  const drawsMark = (status: AgentStatus | undefined): boolean => statusIndicators !== "classic" || agentGroup(status) !== "idle";
  // a failed turn has a mark of its own, the warning a pane herdr could not restore draws in the sidebar: its shape
  // tells it from a finish, not its colour alone. Any other mark is named by the row's own state word (`word`), the
  // one the thread's chip and the filters say: the mode has one vocabulary for a state. The ring of a turn that waits
  // on its background work says so after that word, as the eye tells the ring from the working dot
  const stateMark = (status: AgentStatus | undefined, failed: boolean, word: string) => failed ? (
    <span className="inbox-state is-drawn"><span className="badge badge-blocked sidebar-status" data-status="failed" role="status" aria-label={t("Turn failed")} title={t("Turn failed")}><TriangleAlert aria-hidden="true" /></span></span>
  ) : (
    <span className={`inbox-state${drawsMark(status) ? " is-drawn" : ""}`}><StatusBadge compact status={status} label={knownStatus(status) === "waiting" ? t("Working, waiting on background work") : word} /></span>
  );

  const closeSearch = (event: KeyboardEvent<HTMLInputElement>): void => {
    // an Escape that ends an IME's composition is the composition's
    if (event.key !== "Escape" || !wide || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // a first Escape takes the words away, the next one the field
    event.preventDefault();
    if (query !== "") onQuery("");
    // the field goes from under the focus: the button that opened it takes it
    else { setSearchAsked(false); searchToggle.current?.focus(); }
  };
  const searchField = searchOpen && (
    <div className="inbox-search" role="search">
      {!wide && <Search className="inbox-search-glass" aria-hidden="true" />}
      <input ref={search} className="input inbox-search-input" type="search" value={query} placeholder={t("Search")} aria-label={t("Search")}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => onQuery(event.currentTarget.value)} onKeyDown={closeSearch} />
      {query !== "" && <button type="button" className="inbox-search-clear" aria-label={t("Clear search")} onClick={() => { onQuery(""); search.current?.focus(); }}><X aria-hidden="true" /></button>}
    </div>
  );
  const newButton = offerNew && (
    <button type="button" className="icon-button inbox-round inbox-add" aria-label={t("New workspace")} title={t("New workspace")}
      aria-haspopup={connected.length > 1 ? popup : undefined} aria-expanded={connected.length > 1 ? pcMenu !== null : undefined}
      onClick={(event) => {
        if (connected.length === 1) onNew(connected[0]!.id);
        else setPcMenu(pcMenu === null ? event.currentTarget : null);
      }}>
      <Plus aria-hidden="true" />
    </button>
  );
  const filterWord = (value: InboxFilter): string => value === "all" ? t("All") : inboxStateWord(value, t);
  const filterLabel = filter === "all" ? t("Filter by state") : t("Filter by state: {state}", { state: filterWord(filter) });
  const filterButton = (
    <button type="button" className={`icon-button inbox-round inbox-filter-toggle${filter === "all" ? "" : " is-on"}`} aria-label={filterLabel} title={filterLabel}
      aria-haspopup={popup} aria-expanded={filterMenu !== null} onClick={(event) => setFilterMenu(filterMenu === null ? event.currentTarget : null)}>
      <ListFilter aria-hidden="true" />
    </button>
  );
  // The connection's word, in the document before its words (lib/useAnnouncedText.ts) and drawn by nothing while there
  // is none. The column's top row is the search field's while that is open: the word is still said, not drawn.
  const connectionWord = useAnnouncedText(connection === null ? null : t(connection === "connected" ? "Connected" : "Reconnecting…"));
  const connectionLine = <p className={connectionWord === null || (wide && searchOpen) ? "visually-hidden" : "inbox-connection"} role="status">{connectionWord}</p>;
  const moreButton = more && (
    <button type="button" className="icon-button inbox-round inbox-more" aria-label={more.label} title={more.label}
      aria-haspopup={more.popup} aria-expanded={more.expanded} onClick={(event) => more.onPress(event.currentTarget)}>
      <Ellipsis aria-hidden="true" />
    </button>
  );

  return (
    <section className={`mode-inbox${wide ? " is-wide" : ""}`} aria-label={t("Agent inbox")} tabIndex={-1} ref={root}
      onWheel={stopRestoring} onTouchStart={stopRestoring} onPointerDown={stopRestoring} onKeyDown={stopRestoring}>
      <div className="inbox-top">
        {wide ? <>
          {connectionLine}
          {searchField}
          <button type="button" ref={searchToggle} className="icon-button inbox-round inbox-search-toggle" aria-label={t("Search")} title={t("Search")} aria-expanded={searchOpen}
            onClick={() => { if (!searchOpen) setSearchAsked(true); else if (query === "") setSearchAsked(false); else search.current?.focus(); }}>
            <Search aria-hidden="true" />
          </button>
          {newButton}
        </> : <>
          {moreButton}
          {note}
          {connectionLine}
          {newButton}
        </>}
      </div>
      <div className="inbox-scroll" ref={scroller} onScroll={(event) => { if (restoring.current === null) scroll.current = event.currentTarget.scrollTop; }}>
        {failed !== null ? (
          <div className="inbox-failed">
            {/* what happened, in the app's words, and the read's own message, where it has one, smaller under it; while a
                Retry's read is on its way the loading words stand there instead (the message keeps its room, so Retry
                does not move), and a failure again is a new alert */}
            {retrying ? (
              <div key="loading" className="inbox-failed-words is-loading" role="status">
                <p className="inbox-failed-line">{t("Loading…")}</p>
                {failed.error !== "" && <p className="inbox-failed-cause" dir="auto" aria-hidden="true">{failed.error}</p>}
              </div>
            ) : (
              <div key="failed" className="inbox-failed-words" role="alert">
                <p className="inbox-failed-line">{t("Couldn't load the list.")}</p>
                {failed.error !== "" && <p className="inbox-failed-cause" dir="auto">{failed.error}</p>}
              </div>
            )}
            {/* aria-disabled, not disabled: a press keeps the focus it had; its two words share one cell, so it keeps one box */}
            <button type="button" className="btn inbox-retry" aria-disabled={retrying || undefined} aria-busy={retrying || undefined} onClick={retry}>
              <span className="inbox-retry-words">
                <span aria-hidden={retrying || undefined}>{t("Retry")}</span>
                <span aria-hidden={!retrying || undefined}>{t("Retrying…")}</span>
              </span>
            </button>
          </div>
        ) : empty !== null ? <p className="inbox-empty" role="status">{empty.flatMap((line, at) => [...(at > 0 ? [" "] : []), <span key={line}>{line}</span>])}</p> : (
          <ul className="inbox-rows" onPointerDown={holdAfterPress} onTouchEnd={holdAfterPress}
            onFocus={(event) => setFocusIn(event.target.matches(":focus-visible"))} onBlur={(event) => { if (!(typeof Node === "function" && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocusIn(false); }}>
            {rows.map((row) => {
              const open = wide && row.key === current;
              const words = <span className="inbox-words" dir="auto">{row.line}</span>;
              // how long the agent has been in its state: drawn at the name's end on a phone, said in the row's
              // name and tooltip in the column, which draws no time
              const age = row.since === null ? null : stateAge(now - row.since);
              const at = row.since === null ? null : new Date(row.since);
              // what a screen reader hears for the row: who it is, how it is, what it says, then for how long
              const spoken = [row.kind ? agentName(row.kind) : null, row.title, row.state, row.line === row.state ? null : row.line, age].filter((part) => part !== null).join(", ");
              return (
                <li key={row.key} className={`inbox-item${row.online ? "" : " is-offline"}${row.asks ? " is-asking" : ""}${open ? " is-current" : ""}`} data-machine={row.machine.id} data-pane={row.pane.pane_id} data-state={row.group}>
                  <button type="button" className="inbox-row" disabled={!row.online} aria-label={spoken} aria-current={open ? "true" : undefined}
                    ref={(node) => { if (node) rowNodes.current.set(row.key, node); else rowNodes.current.delete(row.key); }}
                    title={wide ? [row.title, row.line, at === null ? null : `${age} · ${at.toLocaleString(resolvedLanguage)}`].filter((part) => part !== null).join("\n") : undefined}
                    onPointerDown={(event) => { if (event.button === 0 && row.online) pressPane?.(row.machine.id, row.pane.pane_id); }}
                    onClick={() => onOpen(row.machine.id, row.pane.pane_id)}>
                    <InboxAvatar mark={row.mark} />
                    <span className="inbox-body">
                      <span className="inbox-line">
                        <span className="inbox-name">{row.title}</span>
                        {!wide && at !== null && <time className="inbox-time" dateTime={at.toISOString()} title={at.toLocaleString(resolvedLanguage)}>{age}</time>}
                      </span>
                      {wide ? words : <span className="inbox-sub">{words}{stateMark(row.status, row.failed, row.state)}</span>}
                    </span>
                    {wide && stateMark(row.status, row.failed, row.state)}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="inbox-foot">
        {wide ? <>
          {onExit ? <button type="button" className="btn btn-ghost sidebar-footer-action inbox-exit" onClick={onExit}>
            <OvisMark width="22" height="22" className="inbox-exit-mark" />
            <span className="inbox-exit-label">{t("Back to Ovis")}</span>
          </button> : null}
          <span className="inbox-foot-start" />
          {filterButton}
          {moreButton}
        </> : <>
          {filterButton}
          {searchField}
        </>}
      </div>
      {pcMenu !== null && !watching && connected.length > 1 && <RowMenu anchor={pcMenu} title={t("New workspace")} onClose={() => setPcMenu(null)}
        items={connected.map((machine) => ({ id: machine.id, label: machine.name, icon: Monitor, run: () => onNew(machine.id) }))} />}
      {filterMenu !== null && <RowMenu anchor={filterMenu} title={t("Filter by state")} choice onClose={() => setFilterMenu(null)}
        items={INBOX_FILTERS.map((value) => ({
          id: value, label: filterWord(value), icon: ListFilter, checked: filter === value, run: () => onFilter(value),
          ...(value === "all" ? {} : { glyph: <span className="inbox-filter-mark" aria-hidden="true"><StatusBadge compact status={value} label={filterWord(value)} /></span> }),
        }))} />}
    </section>
  );
}
