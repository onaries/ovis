import type { Machine } from "../../shared/machines.ts";
import { isBackgroundRole, ROLE_TOKEN } from "../../shared/pane-tokens.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import type { AgentGroupSort } from "./settings.ts";
import { activityOrder } from "./sidebarOrder.ts";
import { knownStatus } from "./status.ts";
import { sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  byActivity: boolean;
  seqs(machineId: string): ReadonlyMap<string, number>;
  pinned: readonly string[];
}

/**
 * A PC's rows with each helper right under the agent that started it (herdr-core's `parent_pane_id`),
 * after that agent's earlier helpers.
 */
export function nestHelpers(entries: readonly SidebarAgent[]): SidebarAgent[] {
  return nestRows(entries, (entry) => entry.pane.pane_id, (entry) => entry.pane.parent_pane_id);
}

function nestRows<T>(entries: readonly T[], idOf: (entry: T) => string, parentIdOf: (entry: T) => string | undefined): T[] {
  const byId = new Map(entries.map((entry) => [idOf(entry), entry]));
  const parentOf = (entry: T): T | undefined => {
    const parent = parentIdOf(entry);
    return parent === undefined || parent === idOf(entry) ? undefined : byId.get(parent);
  };
  const helpers = new Map<T, T[]>();
  for (const entry of entries) {
    const parent = parentOf(entry);
    if (parent) helpers.set(parent, [...(helpers.get(parent) ?? []), entry]);
  }
  const rootOf = (entry: T): T => {
    const passed = new Set<T>([entry]);
    let root = entry;
    for (let up = parentOf(root); up; up = parentOf(up)) {
      if (passed.has(up)) return entry;
      passed.add(up);
      root = up;
    }
    return root;
  };
  const ordered: T[] = [];
  const seen = new Set<T>();
  const add = (entry: T): void => {
    if (seen.has(entry)) return;
    seen.add(entry);
    ordered.push(entry);
    for (const helper of helpers.get(entry) ?? []) add(helper);
  };
  for (const entry of entries) add(rootOf(entry));
  for (const entry of entries) add(entry);
  return ordered;
}

export function agentRoster(machines: readonly Machine[], options: AgentRosterOptions): { pinned: AgentRow[]; rest: AgentRow[] } {
  const rows = machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    return nestHelpers(options.byActivity ? activityOrder(agents, (entry) => entry.pane, options.seqs(machine.id)) : agents).map((entry): AgentRow => ({ machine, entry }));
  });
  return splitPinnedRows(rows, options.pinned, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id));
}

/**
 * Whether a launcher tagged the pane as a background agent: `herdr pane report-metadata <pane>
 * --token role=background` (any case, spaces around it ignored).
 */
export function isBackgroundAgent({ pane, agent }: SidebarAgent): boolean {
  return isBackgroundRole((pane.tokens ?? agent?.tokens)?.[ROLE_TOKEN]);
}

export function splitBackgroundRows(rows: readonly AgentRow[], status: (row: AgentRow) => AgentStatus | undefined, all: readonly AgentRow[] = rows): { people: AgentRow[]; background: AgentRow[] } {
  const byKey = new Map(all.map((row) => [sidebarPinKey(row.machine.id, row.entry.pane.pane_id), row]));
  const tagged = (row: AgentRow): boolean => {
    const passed = new Set<AgentRow>();
    for (let up: AgentRow | undefined = row; up && !passed.has(up); up = up.entry.pane.parent_pane_id === undefined ? undefined : byKey.get(sidebarPinKey(up.machine.id, up.entry.pane.parent_pane_id))) {
      if (isBackgroundAgent(up.entry)) return true;
      passed.add(up);
    }
    return false;
  };
  const people: AgentRow[] = [];
  const background: AgentRow[] = [];
  for (const row of rows) (tagged(row) && knownStatus(status(row)) !== "blocked" ? background : people).push(row);
  const keyOf = ({ machine, entry }: AgentRow): string => sidebarPinKey(machine.id, entry.pane.pane_id);
  const nest = (part: AgentRow[]): AgentRow[] => nestRows(part, keyOf, ({ machine, entry }) => entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(machine.id, entry.pane.parent_pane_id));
  return { people: nest(people), background: nest(background) };
}

export const AGENT_GROUPS = ["blocked", "working", "done", "idle"] as const;
export type AgentGroup = (typeof AGENT_GROUPS)[number];

export function agentGroup(status: AgentStatus | undefined): AgentGroup {
  const known = knownStatus(status);
  return known === "blocked" || known === "done" ? known : known === "working" || known === "waiting" ? "working" : "idle";
}

export interface AgentGroupOptions {
  sort: AgentGroupSort;
  status(row: AgentRow): AgentStatus | undefined;
  name(row: AgentRow): string;
  seqs(machineId: string): ReadonlyMap<string, number>;
}

export function groupAgentRows(rows: readonly AgentRow[], options: AgentGroupOptions): { group: AgentGroup; rows: AgentRow[] }[] {
  const machineIndex = new Map<string, number>();
  for (const { machine } of rows) if (!machineIndex.has(machine.id)) machineIndex.set(machine.id, machineIndex.size);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const keyOf = ({ machine, entry }: AgentRow): string => sidebarPinKey(machine.id, entry.pane.pane_id);
  const keyed = rows.map((row, index) => {
    const seq = options.seqs(row.machine.id).get(row.entry.pane.pane_id);
    return { row, index, rank: AGENT_GROUPS.indexOf(agentGroup(options.status(row))), pc: machineIndex.get(row.machine.id)!, seq, name: options.sort === "name" ? options.name(row) : "" };
  });
  const bySeq = (a: number | undefined, b: number | undefined, sign: 1 | -1): number =>
    a === undefined || b === undefined ? (a === undefined ? 1 : 0) - (b === undefined ? 1 : 0) : (a - b) * sign;
  keyed.sort((a, b) => a.rank - b.rank
    || (options.sort === "name" ? collator.compare(a.name, b.name) || a.pc - b.pc : a.pc - b.pc || bySeq(a.seq, b.seq, options.sort === "wait" ? 1 : -1))
    || a.index - b.index);
  const rank = new Map(keyed.map((entry) => [entry.row, entry.rank]));
  const nested = nestRows(keyed.map((entry) => entry.row), keyOf, ({ machine, entry }) => entry.pane.parent_pane_id === undefined ? undefined : sidebarPinKey(machine.id, entry.pane.parent_pane_id));
  const byKey = new Map(nested.map((row) => [keyOf(row), row]));
  const groups: { group: AgentGroup; rows: AgentRow[] }[] = [];
  let familyRank = -1;
  const placed = new Set<AgentRow>();
  for (const row of nested) {
    const parentId = row.entry.pane.parent_pane_id;
    const parent = parentId === undefined || parentId === row.entry.pane.pane_id ? undefined : byKey.get(sidebarPinKey(row.machine.id, parentId));
    if (parent === undefined || !placed.has(parent)) familyRank = Math.min(...familyRows(nested, row, byKey).map((member) => rank.get(member)!));
    placed.add(row);
    const group = AGENT_GROUPS[familyRank]!;
    const last = groups.at(-1);
    if (last?.group === group) last.rows.push(row);
    else groups.push({ group, rows: [row] });
  }
  return groups;
}

function familyRows(nested: readonly AgentRow[], start: AgentRow, byKey: ReadonlyMap<string, AgentRow>): AgentRow[] {
  const members = new Set<AgentRow>([start]);
  for (let index = nested.indexOf(start) + 1; index < nested.length; index++) {
    const row = nested[index]!;
    const parentId = row.entry.pane.parent_pane_id;
    const parent = parentId === undefined ? undefined : byKey.get(sidebarPinKey(row.machine.id, parentId));
    if (parent === undefined || !members.has(parent)) break;
    members.add(row);
  }
  return [...members];
}
