/**
 * The sidebar's temporary label filter (components/MachineSidebar.tsx): what a typed query keeps
 * of the PC, workspace and agent rosters. A pure projection over the snapshots as they are: it
 * answers with sets of ids, never a reordered or rewritten roster, so pins, folds, herdr's order
 * and every other reader of a snapshot (the branch inventory, read finishes, pin pruning, agent
 * counts, the selection) go on reading the unfiltered one, and clearing the query brings the
 * rows back exactly as they were.
 *
 * A row is matched by the palette's fuzzy matcher (lib/paletteSearch.ts), its membership alone
 * and never its rank, on the labels the row shows: the PC's name; a workspace's name and the
 * branch its row says; an agent row's title, its agent's kind and name, and the tab name its
 * context line says. A shell has no row of its own, so its title is not searched. Nothing hidden
 * is searched: no working directory, no transcript, no
 * environment, no token value, no id.
 *
 * A matching workspace keeps its worktrees and its panes; a matching pane or worktree keeps its
 * workspace, repository head and PC. The selected pane's row, workspace, repository head and PC
 * stay whatever the query, drawn as context rather than as matches, so the place the user is
 * never leaves the list. The idea, a row that survives when it, a header over it or a row under
 * it matches, is adapted from agent-of-empires' sidebar filter (THIRD_PARTY_NOTICES.md); its
 * substring matcher, facets and sunk/trash semantics are not.
 */
import type { Machine } from "../../shared/machines.ts";
import { paneTitle } from "../../shared/notify-policy.ts";
import type { HerdrPane, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/protocol.ts";
import { rosterPanes } from "./dagPane.ts";
import type { Translate } from "./i18n.ts";
import { matchesQuery } from "./paletteSearch.ts";
import { shortPathTitle, stripPaneChrome } from "./paneName.ts";
import { agentTabName, sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import type { WorkspaceGroup } from "./sidebarPins.ts";
import { worktreeGroups } from "./workspaceOrder.ts";

export interface SidebarSelection {
  machineId: string;
  paneId: string | null;
}

/** The branch each workspace's row says, per PC then workspace: read by the roster (useWorktreeBranches), not held in a snapshot. */
export type SidebarBranchLabels = ReadonlyMap<string, ReadonlyMap<string, string>>;

export interface MachineFilter {
  /** the PC's group is drawn: its name matched, a row under it is kept, the selection is on it, or its roster has not come (it says why) */
  shown: boolean;
  /** the PC's own name matched: every row under it is a match */
  matched: boolean;
  /** the workspace rows drawn: matches, their ancestors and descendants, and the selected pane's workspace with its repository head */
  workspaces: ReadonlySet<string>;
  /** of those, the rows that matched, by their own labels or an ancestor's; the rest are context */
  matchedWorkspaces: ReadonlySet<string>;
  /** workspaces a match sits in or under, by its own labels or a matching parent's: a folded group with one shows it, without the fold being written */
  revealedWorkspaces: ReadonlySet<string>;
  /** the agent rows drawn: matched panes, the panes of a matched workspace, and the selected pane */
  panes: ReadonlySet<string>;
  matchedPanes: ReadonlySet<string>;
}

export interface SidebarFilter {
  query: string;
  /** a blank query filters nothing: every row stays and nothing is marked, whatever `machines` says */
  active: boolean;
  machines: ReadonlyMap<string, MachineFilter>;
  /** the rows that matched by their own labels, over every PC: none, and the lists say so */
  matches: number;
}

const NO_FILTER: SidebarFilter = { query: "", active: false, machines: new Map(), matches: 0 };

/** A filter that keeps everything: the sidebar before anything is typed. */
export function inactiveSidebarFilter(): SidebarFilter {
  return NO_FILTER;
}

type FilterMachine = Pick<Machine, "id" | "name" | "snapshot">;

function nonblank(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The one title a pane's row shows for it: the name the user gave it, the agent's own title, herdr's
 * pane title, else the terminal's title shortened as the roster shortens a path (components/Sidebar.tsx
 * displayPaneTitle, AgentSidebar.tsx). Only the first of them is on the row, so only it can be found;
 * the id a nameless pane falls back to is not a name.
 */
function shownPaneTitle(pane: HerdrPane, agentTitle: string | null | undefined): string | null {
  const named = nonblank(pane.label) ?? nonblank(agentTitle) ?? nonblank(pane.title);
  if (named !== null) return named;
  const shown = shortPathTitle(stripPaneChrome(paneTitle(pane), pane.agent));
  return shown === pane.pane_id ? null : nonblank(shown);
}

/** What a workspace's row can be found by: its name (a repository's row carries the repository's) and the branch the row says. */
export function workspaceLabels(workspace: Pick<WorkspaceInfo, "label">, branch: string | null | undefined): string[] {
  return [workspace.label, branch].flatMap((label) => {
    const text = nonblank(label);
    return text === null ? [] : [text];
  });
}

/**
 * What a pane's row can be found by: the title the agent row shows (a label the user gave it, the
 * agent's own title, the pane's), the agent's kind and name as the row and its mark say them, and
 * the tab name the row's context line shows (components/AgentSidebar.tsx). A shell has only its title.
 */
export function paneLabels(pane: HerdrPane, entry: SidebarAgent | undefined, workspaceTabs: readonly TabInfo[], t: Translate): string[] {
  const agent = entry?.agent ?? null;
  const labels = [
    shownPaneTitle(pane, agent?.title),
    entry?.canonicalAgent,
    entry?.agentLabel,
    agent?.name,
    agent?.display_agent,
    pane.display_agent,
    entry ? agentTabName(entry.tab, workspaceTabs, t) : null,
  ];
  return [...new Set(labels.flatMap((label) => {
    const text = nonblank(label);
    return text === null ? [] : [text];
  }))];
}

function filterMachine(query: string, machine: FilterMachine, selection: SidebarSelection, t: Translate, branches: ReadonlyMap<string, string> | undefined, count: { matches: number }): MachineFilter {
  const matched = matchesQuery(query, machine.name);
  if (matched) count.matches += 1;
  const onThisPc = selection.machineId === machine.id;
  const workspaces = new Set<string>();
  const matchedWorkspaces = new Set<string>();
  const revealedWorkspaces = new Set<string>();
  const panes = new Set<string>();
  const matchedPanes = new Set<string>();
  const snapshot: SessionSnapshot | null = machine.snapshot;
  if (snapshot) {
    // the tree as the roster draws it: a repository's worktrees under its head (lib/workspaceOrder.ts)
    const headOf = new Map<string, string>();
    for (const group of worktreeGroups(snapshot.workspaces)) {
      for (const child of group.children) headOf.set(child.workspace_id, group.workspace.workspace_id);
    }
    const head = (workspaceId: string): string => headOf.get(workspaceId) ?? workspaceId;
    const agentByPane = new Map(sidebarAgents(snapshot).map((entry) => [entry.pane.pane_id, entry]));
    const tabsByWorkspace = new Map<string, TabInfo[]>();
    for (const tab of snapshot.tabs) tabsByWorkspace.set(tab.workspace_id, [...(tabsByWorkspace.get(tab.workspace_id) ?? []), tab]);
    const selectedPaneId = onThisPc ? selection.paneId : null;
    const roster = rosterPanes(snapshot.panes, selectedPaneId);
    const ownWorkspaces = new Set<string>();
    for (const workspace of snapshot.workspaces) {
      if (workspaceLabels(workspace, branches?.get(workspace.workspace_id)).some((label) => matchesQuery(query, label))) ownWorkspaces.add(workspace.workspace_id);
    }
    const ownPanes = new Set<string>();
    // only a pane a row draws is searched: an agent's row. A shell has no row of its own, and the title it
    // would fall back to may be its working directory's folder
    for (const pane of roster) {
      if (!agentByPane.has(pane.pane_id)) continue;
      if (paneLabels(pane, agentByPane.get(pane.pane_id), tabsByWorkspace.get(pane.workspace_id) ?? [], t).some((label) => matchesQuery(query, label))) ownPanes.add(pane.pane_id);
    }
    count.matches += ownWorkspaces.size + ownPanes.size;
    // a match keeps what is under it, and the rows it is under
    for (const workspace of snapshot.workspaces) {
      const id = workspace.workspace_id;
      if (!(matched || ownWorkspaces.has(id) || ownWorkspaces.has(head(id)))) continue;
      matchedWorkspaces.add(id);
      revealedWorkspaces.add(id);
      workspaces.add(id);
      workspaces.add(head(id));
    }
    for (const pane of roster) {
      if (!(ownPanes.has(pane.pane_id) || matchedWorkspaces.has(pane.workspace_id))) continue;
      matchedPanes.add(pane.pane_id);
      revealedWorkspaces.add(pane.workspace_id);
      panes.add(pane.pane_id);
      workspaces.add(pane.workspace_id);
      workspaces.add(head(pane.workspace_id));
    }
    // the selected pane keeps its place, as context: its row, its workspace, that one's head
    const selected = selectedPaneId === null ? undefined : snapshot.panes.find((pane) => pane.pane_id === selectedPaneId);
    if (selected) {
      panes.add(selected.pane_id);
      workspaces.add(selected.workspace_id);
      workspaces.add(head(selected.workspace_id));
    }
  }
  // a PC whose roster has not come (connecting, unreachable) cannot be searched: it stays, as context, with its state
  return { shown: matched || onThisPc || workspaces.size > 0 || panes.size > 0 || snapshot === null, matched, workspaces, matchedWorkspaces, revealedWorkspaces, panes, matchedPanes };
}

/**
 * The filter `query` makes over `machines`, as the sidebar lists them. `branches` adds the branch
 * each workspace's row says; `t` names a tab the way the agent row does ("Tab 2"). The machines
 * and their snapshots are read, never written.
 */
export function sidebarFilter(query: string, machines: readonly FilterMachine[], selection: SidebarSelection, t: Translate, branches: SidebarBranchLabels = new Map()): SidebarFilter {
  if (query.trim().length === 0) return query === "" ? NO_FILTER : { ...NO_FILTER, query };
  const count = { matches: 0 };
  const byMachine = new Map<string, MachineFilter>();
  for (const machine of machines) byMachine.set(machine.id, filterMachine(query, machine, selection, t, branches.get(machine.id), count));
  return { query, active: true, machines: byMachine, matches: count.matches };
}

/**
 * What the field offers as it is typed in (the browser's suggestions under it): the names the rows show, as
 * the filter finds them, each once, in the roster's order. PC names, workspace names and the branches their
 * rows say, and the title each agent row shows; never a path, a transcript or an id.
 */
export function filterSuggestions(machines: readonly FilterMachine[], branches: SidebarBranchLabels = new Map()): string[] {
  const labels = new Set<string>();
  for (const machine of machines) {
    labels.add(machine.name);
    for (const workspace of machine.snapshot?.workspaces ?? []) for (const label of workspaceLabels(workspace, branches.get(machine.id)?.get(workspace.workspace_id))) labels.add(label);
    for (const entry of sidebarAgents(machine.snapshot)) {
      const title = shownPaneTitle(entry.pane, entry.agent?.title);
      if (title !== null) labels.add(title);
    }
  }
  return [...labels].filter((label) => label.trim() !== "");
}

/** The PC's part of the filter while one is active; null while none is, so a caller keeps every row without looking further. */
export function machineFilter(filter: SidebarFilter, machineId: string): MachineFilter | null {
  if (!filter.active) return null;
  return filter.machines.get(machineId) ?? { shown: false, matched: false, workspaces: new Set(), matchedWorkspaces: new Set(), revealedWorkspaces: new Set(), panes: new Set(), matchedPanes: new Set() };
}

/**
 * The groups the roster draws under a filter: each kept group with its kept worktrees, in the
 * order given. A group is not reordered, a kept worktree never changes its head, and a group
 * whose head is not kept goes with its worktrees (a kept worktree keeps its head, so that never
 * loses a match).
 */
export function filterWorkspaceGroups<W extends Pick<WorkspaceInfo, "workspace_id">>(groups: readonly WorkspaceGroup<W>[], kept: ReadonlySet<string>): WorkspaceGroup<W>[] {
  // a kept worktree stays under the head it is drawn under, which the filter may not have kept: a
  // reorder draws its own order until herdr's catches up. That head is then drawn as context
  return groups.flatMap((group) => {
    const children = group.children.filter((child) => kept.has(child.workspace_id));
    return kept.has(group.workspace.workspace_id) || children.length > 0 ? [{ workspace: group.workspace, children }] : [];
  });
}
