/**
 * The agent inbox's list (components/InboxList.tsx): every shown PC's agents in one list, the ones
 * that need the reader first, narrowed by state. Built on the Agents list's own rows and shown state
 * (lib/agentRoster.ts, lib/sidebarActivity.tsx), so the two never disagree.
 */
import type { Machine } from "../../shared/machines.ts";
import { parseInline, shownText } from "../../shared/markdown.ts";
import type { AgentStatus, PlanSummary } from "../../shared/protocol.ts";
import { agentGroup, agentRoster, groupAgentRows, type AgentGroup, type AgentRow } from "./agentRoster.ts";
import { fileFromLink, type AppLink } from "./deepLink.ts";
import type { Translate } from "./i18n.ts";
import type { AgentGroupSort } from "./settings.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";
import type { RowSummary } from "./useInboxSummaries.ts";
import { capped } from "./promptText.ts";
import { machineFilter, sidebarFilter } from "./sidebarFilter.ts";
import { sidebarPinKey } from "./sidebarPins.ts";

/** All, then the three states that ask for a look or say work goes on; a resting agent shows only under All. */
export const INBOX_FILTERS = ["all", "blocked", "working", "done"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** A row is its PC and its pane: two PCs may reuse a pane id. */
export function inboxKey(row: AgentRow): string {
  return sidebarPinKey(row.machine.id, row.entry.pane.pane_id);
}

/** The state a row draws, as the Agents list draws it; a PC that is away says none. */
export function inboxStatus(row: AgentRow, activity: SidebarActivity): AgentStatus | undefined {
  return row.machine.state === "connected" ? activity.status(row.machine.id, row.entry.pane) : undefined;
}

/**
 * Every agent row: needs you, working, done, resting; within a state in the order the Agents list grouped by
 * state uses (Settings → Within a state: the longest in that state first by default, each PC's rows apart).
 */
export function inboxOrder(machines: readonly Machine[], activity: SidebarActivity, { sort = "wait", name = () => "" }: { sort?: AgentGroupSort; name?: (row: AgentRow) => string } = {}): AgentRow[] {
  const rows = agentRoster(machines, { byActivity: false, seqs: activity.seqs, pinned: [] }).rest;
  return groupAgentRows(rows, { sort, status: (row) => inboxStatus(row, activity), name, seqs: activity.seqs })
    .flatMap((group) => group.rows);
}

/** The rows a filter keeps, by each row's own state. */
export function inboxFiltered(rows: readonly AgentRow[], filter: InboxFilter, activity: SidebarActivity): AgentRow[] {
  return filter === "all" ? [...rows] : rows.filter((row) => agentGroup(inboxStatus(row, activity)) === filter);
}

/**
 * The rows a typed query keeps, matched on the labels the Agents list shows (lib/sidebarFilter.ts), and kept when
 * the words the row draws (`words`: inboxWords) hold the query as typed, in any letter case: the palette's
 * subsequence match is too loose for a sentence. A blank query keeps all.
 */
export function inboxSearched(rows: readonly AgentRow[], query: string, machines: readonly Machine[], t: Translate, words: (row: AgentRow) => string | null): AgentRow[] {
  const filter = sidebarFilter(query, machines, { machineId: "", paneId: null }, t);
  if (!filter.active) return [...rows];
  const typed = query.trim().toLowerCase();
  return rows.filter((row) => machineFilter(filter, row.machine.id)?.panes.has(row.entry.pane.pane_id) === true || (words(row)?.toLowerCase().includes(typed) ?? false));
}

/** The rows in the order `held` names their keys, the rest after them in their given order. */
export function heldOrder<T>(rows: readonly T[], keyOf: (row: T) => string, held: readonly string[]): T[] {
  const place = new Map(held.map((key, index) => [key, index]));
  const rank = (row: T): number => place.get(keyOf(row)) ?? held.length;
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/** Why the list draws no row: a roster still on its way, no agent at all, or a filter or query that leaves none. */
export function inboxEmpty(machines: readonly Machine[], total: number, shown: number): "loading" | "none" | "no-match" | null {
  if (total === 0) return machines.length === 0 || machines.some((machine) => machine.state === "connected" && machine.snapshot === null) ? "loading" : "none";
  return shown === 0 ? "no-match" : null;
}

/**
 * An agent's last words as a row draws them: the one line the summary route sends (its block marks and line breaks
 * are the server's, shared/pane-summary.ts) without its inline marks (code, emphasis, a link as its text), as the
 * chat's inline reader reads them; null when nothing is left.
 */
export function plainWords(text: string): string | null {
  const bare = text.trim();
  const shown = (bare === "" ? "" : shownText(parseInline(bare, false)) ?? bare).trim();
  return shown === "" ? null : shown;
}

/** What a waiting agent asks, for its row: the question, then the first line of what it is about. */
export function questionWords(words: { question: string; body: string | null }): string {
  const first = words.body?.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  return capped([words.question.trim(), first].filter((part) => part !== "").join("\n"), 240);
}

/** The agent's own words for its row, by its state; never words borrowed from another state. */
export function inboxWords(input: { group: AgentGroup; blocked: string | null; question: string | null; plan: PlanSummary | undefined; last: string | null }): string | null {
  if (input.group === "blocked") return input.blocked ?? input.question ?? input.last;
  if (input.group === "working") return input.plan?.current?.trim() || input.last;
  return input.last;
}

/**
 * Since when a row is in its state (ms): a waiting agent since this device saw it begin to wait (`waitStart`, the
 * stamp the Agents list reads too, lib/agentStateSince.ts), else since its last message (herdr tells no time of a
 * state change: the summary's time of its last words, which a done or ready row draws too, where the Agents list says
 * none); a working agent since the user last asked it, any other since its last words.
 */
export function inboxSinceAt(group: AgentGroup, summary: RowSummary | null | undefined, waitStart: number | null): number | null {
  if (group === "blocked") return waitStart ?? summary?.at ?? null;
  if (!summary) return null;
  return group === "working" ? summary.askedAt ?? summary.at : summary.at;
}

/** Whether the inbox mode opens on its list: the address names no pane, workspace or file. */
export function inboxStartsOpen(enabled: boolean, link: AppLink | null): boolean {
  return enabled && !(link !== null && Boolean(link.pane || link.workspace || fileFromLink(link)));
}
