import type { AgentStatus, HerdrPane, PaneInfo, SessionSnapshot } from "../../shared/protocol.ts";
import { knownStatus, paneStatus } from "./status.ts";

export type SeenRecord = Readonly<Record<string, number>>;

export function stateSeqs(snapshot: Pick<SessionSnapshot, "agents"> | null | undefined): Map<string, number> {
  const seqs = new Map<string, number>();
  for (const agent of snapshot?.agents ?? []) {
    const seq = agent.state_change_seq;
    if (seq !== undefined && Number.isFinite(seq)) seqs.set(agent.pane_id, seq);
  }
  return seqs;
}

export interface SeqMemory { status: Map<string, unknown>; bumped: Map<string, number>; real: Map<string, number> }
export const newSeqMemory = (): SeqMemory => ({ status: new Map(), bumped: new Map(), real: new Map() });

export function liveSeqs(snapshot: Pick<SessionSnapshot, "agents" | "panes"> | null | undefined, memory: SeqMemory): Map<string, number> {
  const seqs = stateSeqs(snapshot);
  const panes = snapshot?.panes ?? [];
  if ([...seqs].some(([id, seq]) => seq < (memory.real.get(id) ?? seq))) memory.bumped.clear();
  let top = Math.max(0, ...seqs.values(), ...memory.bumped.values());
  for (const pane of panes) {
    const changed = memory.status.has(pane.pane_id) && memory.status.get(pane.pane_id) !== pane.agent_status;
    const real = seqs.get(pane.pane_id);
    const before = memory.real.get(pane.pane_id);
    if (changed && real !== undefined) {
      if (before !== undefined && real <= before) memory.bumped.set(pane.pane_id, top += 0.001);
      else memory.bumped.delete(pane.pane_id);
    }
    memory.status.set(pane.pane_id, pane.agent_status);
  }
  memory.real = new Map(seqs);
  const open = new Set(panes.map((pane) => pane.pane_id));
  if (panes.length > 0) for (const id of memory.status.keys()) if (!open.has(id)) memory.status.delete(id);
  for (const [id, bump] of memory.bumped) {
    const real = seqs.get(id);
    if (real === undefined || real > bump) memory.bumped.delete(id);
    else seqs.set(id, bump);
  }
  return seqs;
}

type FinishPane = Pick<HerdrPane, "pane_id" | "agent_status" | "finish_id" | "background_wait">;
export function isSeenDone(pane: FinishPane, seen: SeenRecord): boolean {
  return knownStatus(pane.agent_status) === "done" && pane.finish_id !== undefined
    && pane.finish_id > 0 && (seen[pane.pane_id] ?? 0) >= pane.finish_id;
}

export function shownStatus(pane: FinishPane, seen: SeenRecord | null): AgentStatus | undefined {
  if (pane.background_wait) return paneStatus(pane);
  return seen && isSeenDone(pane, seen) ? "idle" : pane.agent_status;
}

export function activityOrder<T>(rows: readonly T[], paneOf: (row: T) => Pick<PaneInfo, "pane_id" | "agent_status">, seqs: ReadonlyMap<string, number>): T[] {
  return rows
    .map((row, index) => {
      const pane = paneOf(row);
      return { row, index, rank: knownStatus(pane.agent_status) === "blocked" ? 0 : 1, recent: seqs.get(pane.pane_id) ?? -1 };
    })
    .sort((a, b) => a.rank - b.rank || b.recent - a.recent || a.index - b.index)
    .map((entry) => entry.row);
}
