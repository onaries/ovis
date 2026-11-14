import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Monitor, Plus, Search, X } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { heldOrder, INBOX_FILTERS, inboxEmpty, inboxFiltered, inboxKey, inboxOrder, inboxSearched, inboxStatus, inboxWords, type InboxFilter } from "../lib/agentInbox.ts";
import { agentGroup, type AgentRow } from "../lib/agentRoster.ts";
import { useT } from "../lib/i18n.ts";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { useSettings } from "../lib/settings.ts";
import { agentName } from "../lib/runtimeMove.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";
import { agentContext, agentTabName, paneMark } from "../lib/sidebarAgents.ts";
import { knownStatus, STATUS_WORD } from "../lib/status.ts";
import { questionTargets, useInboxQuestions, type QuestionReads } from "../lib/useInboxQuestions.ts";
import { AgentMark } from "./AgentMark.tsx";
import { agentRowTitle, blockedNote } from "./AgentSidebar.tsx";
import { RowMenu } from "./RowMenu.tsx";
import { compactWorktreeName } from "./Sidebar.tsx";
import "./AgentInbox.css";

export interface AgentInboxProps {
  machines: Machine[];
  activity: SidebarActivity;
  /** this device only watches: it is offered no New workspace */
  watching: boolean;
  filter: InboxFilter;
  onFilter(filter: InboxFilter): void;
  query: string;
  onQuery(query: string): void;
  scroll: RefObject<number>;
  onOpen(machineId: string, paneId: string): void;
  onNew(machineId: string): void;
  /** the page's reader of the waiting agents' questions (lib/useInbox.ts), which outlives this list */
  questionReads: QuestionReads;
}

/** the marks drawn as a full tile, which fill the round face; the others sit on it as a glyph */
const TILE_MARKS = new Set(["claude", "omp", "omo"]);
/** a filter's words: the Agents list's heading for the same state */
const FILTER_WORD: Record<Exclude<InboxFilter, "all">, string> = { blocked: "Needs you", working: "Working", done: "Done" };
/** how long after a press in the list its rows keep their order */
const PRESS_HOLD_MS = 1000;

/**
 * A phone's first screen: every shown PC's agents in one list, the ones that need the reader first.
 * A row opens its agent's chat; nothing is answered or typed from here.
 */
export function AgentInbox({ machines, activity, watching, filter, onFilter, query, onQuery, scroll, onOpen, onNew, questionReads }: AgentInboxProps) {
  const t = useT();
  const titleId = useId();
  const pressPane = useContext(PanePressContext);
  const root = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const radios = useRef(new Map<InboxFilter, HTMLButtonElement>());
  const { settings } = useSettings();
  // within a state, the Agents list's own order (Settings → Within a state), names as its rows draw them
  const { agentGroupSort: sort, sidebarRows } = settings;
  const all = useMemo(() => inboxOrder(machines, activity, { sort, name: (row) => agentRowTitle(row, sidebarRows === "one").drawn }), [machines, activity, sort, sidebarRows]);
  const questions = useInboxQuestions(questionReads, questionTargets(all, activity));
  /** the agent's own words its row draws: the search finds them too */
  const wordsOf = (row: AgentRow): string | null => {
    const online = row.machine.state === "connected";
    return inboxWords({
      group: agentGroup(inboxStatus(row, activity)), blocked: online ? blockedNote(row.entry.pane, t) : null,
      question: questions.get(inboxKey(row)) ?? null, plan: online ? row.entry.pane.plan : undefined, last: null,
    });
  };
  const found = inboxSearched(inboxFiltered(all, filter, activity), query, machines, t, wordsOf);

  // a state change never moves a row under a finger or the focus (AgentSidebar.tsx): while either is in the list,
  // rows keep the order last drawn; the reader's own doing (a filter, a query) draws them as they are at once
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

  // the place the list had is reached again once its rows are back: a waiting row's question comes after the mount,
  // and a list shorter than the place clamps it. Until the place is reached or the reader touches the list, a scroll
  // (the clamp's own) is not kept as the place; once they do, the place is theirs and is never set again
  const restoring = useRef<number | null>(scroll.current);
  const stopRestoring = (): void => { restoring.current = null; };
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null || restoring.current === null) return;
    node.scrollTop = restoring.current;
    if (node.scrollTop === restoring.current) restoring.current = null;
  }, [questions]);
  useLayoutEffect(() => { root.current?.focus({ preventScroll: true }); }, []);

  const [pcMenu, setPcMenu] = useState<HTMLElement | null>(null);

  const describe = (row: AgentRow) => {
    const { machine, entry } = row;
    const { pane, workspace, tab } = entry;
    const online = machine.state === "connected";
    const status = inboxStatus(row, activity);
    const group = agentGroup(status);
    const title = agentRowTitle(row, false).title;
    const tabs = machine.snapshot?.tabs.filter((candidate) => candidate.workspace_id === workspace.workspace_id) ?? [];
    const place = agentContext({
      agentLabel: null, title, markAgent: null, machineName: machines.length > 1 ? machine.name : null,
      workspaceLabel: workspace.worktree?.is_linked_worktree ? compactWorktreeName(workspace.label) : workspace.label,
      tabName: agentTabName(tab, tabs, t),
    }).filter((part) => part !== title);
    const words = wordsOf(row);
    return {
      key: inboxKey(row), machine, pane, online, status, group, title, words, mark: paneMark(entry) ?? "", kind: entry.canonicalAgent,
      place: [...place, ...online ? [] : [t("Offline")]].join(" · "),
    };
  };
  const rows = shown.map(describe);
  const connected = machines.filter((machine) => machine.state === "connected");
  // the sheet of PCs is for a choice among two or more: it closes when that choice goes, and stays closed if it comes back
  useEffect(() => { if (connected.length < 2) setPcMenu(null); }, [connected.length]);
  const emptyWhy = inboxEmpty(machines, all.length, rows.length);
  const empty = emptyWhy === "loading" ? t("Loading agents…") : emptyWhy === "none" ? t("No agents running") : emptyWhy === "no-match" ? t("No agents match") : null;

  const stepFilter = (event: KeyboardEvent<HTMLButtonElement>, value: InboxFilter): void => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = INBOX_FILTERS[(INBOX_FILTERS.indexOf(value) + step + INBOX_FILTERS.length) % INBOX_FILTERS.length]!;
    onFilter(next);
    radios.current.get(next)?.focus();
  };

  return (
    <section className="agent-inbox" aria-labelledby={titleId} tabIndex={-1} ref={root}
      onWheel={stopRestoring} onTouchStart={stopRestoring} onPointerDown={stopRestoring} onKeyDown={stopRestoring}>
      <div className="inbox-scroll" ref={scroller} onScroll={(event) => { if (restoring.current === null) scroll.current = event.currentTarget.scrollTop; }}>
        <h1 id={titleId} className="inbox-title">{t("Agents")}</h1>
        <div className="inbox-search" role="search">
          <Search className="inbox-search-glass" aria-hidden="true" />
          <input ref={search} className="input inbox-search-input" type="search" value={query} placeholder={t("Search agents")} aria-label={t("Search agents")}
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="search" onChange={(event) => onQuery(event.currentTarget.value)} />
          {query !== "" && <button type="button" className="inbox-search-clear" aria-label={t("Clear search")} onClick={() => { onQuery(""); search.current?.focus(); }}><X aria-hidden="true" /></button>}
        </div>
        <div className="inbox-filters" role="radiogroup" aria-label={t("Filter agents by state")}>
          {INBOX_FILTERS.map((value) => (
            <button key={value} type="button" role="radio" className="inbox-filter" data-status={value} aria-checked={filter === value} tabIndex={filter === value ? 0 : -1}
              ref={(node) => { if (node) radios.current.set(value, node); else radios.current.delete(value); }}
              onKeyDown={(event) => stepFilter(event, value)} onClick={() => onFilter(value)}>
              {value === "all" ? t("All") : t(FILTER_WORD[value])}
            </button>
          ))}
        </div>
        {empty !== null ? <p className="inbox-empty" role="status">{empty}</p> : (
          <ul className="inbox-list" onPointerDown={holdAfterPress} onTouchEnd={holdAfterPress}
            onFocus={() => setFocusIn(true)} onBlur={(event) => { if (!(typeof Node === "function" && event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setFocusIn(false); }}>
            {rows.map((row) => {
              const known = knownStatus(row.status);
              return (
                <li key={row.key} className={`inbox-item${row.online ? "" : " is-offline"}`} data-machine={row.machine.id} data-pane={row.pane.pane_id} data-state={row.group}>
                  <button type="button" className="inbox-row" disabled={!row.online}
                    onPointerDown={(event) => { if (event.button === 0 && row.online) pressPane?.(row.machine.id, row.pane.pane_id); }}
                    onClick={() => onOpen(row.machine.id, row.pane.pane_id)}>
                    <span className={`inbox-avatar${TILE_MARKS.has(row.mark) ? " is-tile" : ""}`} aria-hidden="true">
                      <span className="inbox-avatar-face"><AgentMark agent={row.mark} size={TILE_MARKS.has(row.mark) ? 48 : 28} /></span>
                      {row.group === "blocked" && <span className="inbox-dot" />}
                    </span>
                    <span className="inbox-body">
                      {row.kind && <span className="visually-hidden">{agentName(row.kind)}: </span>}
                      <span className="inbox-line">
                        <span className="inbox-name">{row.title}</span>
                      </span>
                      {row.words !== null && <span className="inbox-words">{row.words}</span>}
                      <span className="inbox-meta">
                        {row.group !== "idle" && <span className={`badge badge-${known} inbox-chip`}>{t(STATUS_WORD[known])}</span>}
                        {row.place !== "" && <span className="inbox-place">{row.place}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {!watching && connected.length > 0 && (
        <button type="button" className="btn btn-primary inbox-new" aria-haspopup={connected.length > 1 ? "menu" : undefined} aria-expanded={connected.length > 1 ? pcMenu !== null : undefined}
          onClick={(event) => {
            if (connected.length === 1) onNew(connected[0]!.id);
            else setPcMenu(pcMenu === null ? event.currentTarget : null);
          }}>
          <Plus aria-hidden="true" />{t("New workspace")}
        </button>
      )}
      {pcMenu !== null && !watching && connected.length > 1 && <RowMenu anchor={pcMenu} title={t("New workspace")} onClose={() => setPcMenu(null)}
        items={connected.map((machine) => ({ id: machine.id, label: machine.name, icon: Monitor, run: () => onNew(machine.id) }))} />}
    </section>
  );
}
