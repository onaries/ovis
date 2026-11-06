import type { WorkspaceMoved } from "../../shared/protocol.ts";
import { isBackgroundRole, ROLE_TOKEN } from "../../shared/pane-tokens.ts";
import { movedTabOrder } from "./tabOrder.ts";

/**
 * One herdr `workspace.move`. Like `tab.move`, its `insert_index` counts insertion boundaries
 * before the workspace is taken out, and it moves only the workspace it names: a repository's
 * worktree workspaces stay where they were (live-verified, herdr 0.9.3).
 */
export interface WorkspaceMove {
  workspaceId: string;
  insertIndex: number;
}

/**
 * The moves, in order, that turn herdr's `current` order into `next` (the same workspaces). The
 * longest run of `next` already in order stays put; every other workspace goes right after the
 * one before it in `next`, so a group moved past a single workspace costs one move, not one per member.
 */
export function workspaceMoves(current: readonly string[], next: readonly string[]): WorkspaceMove[] {
  const position = new Map(current.map((id, index) => [id, index]));
  const ranks = next.map((id) => position.get(id) ?? -1);
  const runLength = ranks.map(() => 1);
  const before = ranks.map(() => -1);
  let end = -1;
  for (let i = 0; i < ranks.length; i++) {
    for (let j = 0; j < i; j++) {
      if (ranks[j]! < ranks[i]! && runLength[j]! + 1 > runLength[i]!) { runLength[i] = runLength[j]! + 1; before[i] = j; }
    }
    if (end < 0 || runLength[i]! > runLength[end]!) end = i;
  }
  const kept = new Set<string>();
  for (let i = end; i >= 0; i = before[i]!) kept.add(next[i]!);
  let order = [...current];
  const moves: WorkspaceMove[] = [];
  next.forEach((id, index) => {
    if (kept.has(id)) return;
    const insertIndex = index === 0 ? 0 : order.indexOf(next[index - 1]!) + 1;
    const moved = movedTabOrder(order, id, insertIndex);
    if (!moved) return;
    moves.push({ workspaceId: id, insertIndex });
    order = moved;
  });
  return moves;
}

interface GroupedWorkspace {
  workspace_id: string;
  worktree?: { is_linked_worktree: boolean; repo_key: string } | null;
}

/**
 * The sidebar's tree: a repository's worktree workspaces hang under a workspace on its main checkout. With
 * more than one open on that checkout, each worktree takes the nearest one before it, else the first;
 * a worktree whose repository has none open stays at the top level, in its own place.
 */
export function worktreeGroups<W extends GroupedWorkspace>(ordered: readonly W[]): { workspace: W; children: W[] }[] {
  const firstByRepo = new Map<string, W>();
  for (const workspace of ordered) {
    if (workspace.worktree && !workspace.worktree.is_linked_worktree && !firstByRepo.has(workspace.worktree.repo_key)) firstByRepo.set(workspace.worktree.repo_key, workspace);
  }
  const nearestByRepo = new Map<string, W>();
  const childrenOf = new Map<string, W[]>();
  const top: W[] = [];
  for (const workspace of ordered) {
    const worktree = workspace.worktree;
    if (worktree && !worktree.is_linked_worktree) nearestByRepo.set(worktree.repo_key, workspace);
    const parent = worktree?.is_linked_worktree ? nearestByRepo.get(worktree.repo_key) ?? firstByRepo.get(worktree.repo_key) : undefined;
    if (!parent) { top.push(workspace); continue; }
    const children = childrenOf.get(parent.workspace_id) ?? [];
    children.push(workspace);
    childrenOf.set(parent.workspace_id, children);
  }
  return top.map((workspace) => ({ workspace, children: childrenOf.get(workspace.workspace_id) ?? [] }));
}

/**
 * A workspace a launcher tagged `role=background` (`herdr workspace report-metadata --token`, any case),
 * as a pane is tagged for the Agents list's background part (shared/pane-tokens.ts). herdr's fact, never a guess.
 */
export function isBackgroundWorkspace(workspace: { tokens?: Record<string, unknown> }): boolean {
  return isBackgroundRole(workspace.tokens?.[ROLE_TOKEN]);
}

/**
 * Settings → Background workspaces apart: the groups whose head is tagged stand after the others, in
 * the same order. A tagged worktree stays under its repository's workspace, where its fold already is,
 * and with its repository's part when a pin has set it apart as a row of its own: `worktreeIds`, the
 * worktrees the repository tree (`worktreeGroups`) hangs under another workspace, never file a group.
 */
export function splitBackgroundGroups<G extends { workspace: { workspace_id: string; tokens?: Record<string, unknown> } }>(groups: readonly G[], worktreeIds: ReadonlySet<string> = new Set()): { people: G[]; background: G[] } {
  const background = (group: G): boolean => isBackgroundWorkspace(group.workspace) && !worktreeIds.has(group.workspace.workspace_id);
  return { people: groups.filter((group) => !background(group)), background: groups.filter(background) };
}

/** `base`'s order for the workspaces `ids` still has; the ones it lacks follow, in `ids`' order. */
export function mergeOrder(base: readonly string[], ids: readonly string[]): string[] {
  const live = new Set(ids);
  const kept = base.filter((id) => live.has(id));
  const known = new Set(kept);
  return [...kept, ...ids.filter((id) => !known.has(id))];
}

/** A PC's roster entry as the order reads it: its full snapshot's workspaces and the read's order evidence. */
export interface OrderRosterEntry {
  id: string;
  snapshot: { workspaces: readonly { workspace_id: string }[]; order_epoch?: string; read_seq?: number } | null;
}
/** Where a full roster came from: an App load, with the number loadStarted() gave it, or the SSE stream. */
export type RosterSource = { kind: "load"; started: number } | { kind: "event" };
/** api.verifySourceBoot: the roster with the boot id of the PC's server, proved during that request; null proves nothing. */
export type SourceProofQuery = (machineId: string, signal: AbortSignal) => Promise<{ machines: OrderRosterEntry[]; boot_id: string } | null>;

interface Evidence { epoch: string; seq: number }
const evidenceOf = (snapshot: OrderRosterEntry["snapshot"]): Evidence | null =>
  snapshot && typeof snapshot.order_epoch === "string" && snapshot.order_epoch !== "" && Number.isSafeInteger(snapshot.read_seq) && snapshot.read_seq! >= 0
    ? { epoch: snapshot.order_epoch, seq: snapshot.read_seq! } : null;

/** What keeps a PC's dragged order on screen until a roster read after its moves arrives. */
interface Hold {
  /** the epoch of this hold's latest receipt; null before any, or after that epoch was proved gone */
  epoch: string | null;
  receipts: number;
  /** a receipt without evidence (an older server): released by a load started after settlement */
  legacy: boolean;
  /** loadStarted()'s count when the last claim settled; null while one is pending */
  settleMark: number | null;
}
interface PcOrder {
  /** the order last taken from a roster (or kept from a drag once its epoch was proved gone) */
  shown: string[] | null;
  /** the latest full roster's order and evidence, whatever it was allowed to change */
  last: { ids: string[]; evidence: Evidence | null } | null;
  generation: number;
  pending: Set<number>;
  /** the newest dragged order, shown while the hold lasts */
  desired: string[] | null;
  hold: Hold | null;
  /** per order epoch, the largest moved_seq acknowledged in it: kept after the hold is released */
  floors: Map<string, number>;
  /** the epoch the floor or guard protects now */
  protectedEpoch: string | null;
  /** the server epoch a correlated verification proved, kept until a later one proves another */
  guard: { epoch: string; version: number } | null;
  retired: Set<string>;
  /** bumped by every reorder and receipt: a verification asked before one proves nothing after it */
  receipts: number;
  /** the PC's move batches, one after another */
  chain: Promise<void>;
  failed: boolean;
  /** batches waiting, after a failed one, for a roster they may build on */
  waiters: { generation: number; resolve: (ids: string[]) => void; reject: (error: Error) => void }[];
  /** the PC left the roster: its claims settle, its protection stays in case it comes back */
  gone: boolean;
  check: { key: string; abort: AbortController } | null;
}

/**
 * The sidebar's workspace order for every PC, owned by App so a remount, a PC switch or an old
 * operation's end cannot lose it. A drag shows its order at once and holds it while its moves run;
 * every move's receipt names the server's order epoch and the move's number in it, and the hold ends
 * with the first full roster of that epoch read at or after the last number (`read_seq >= moved_seq`),
 * whatever order it shows, from an App load or the SSE stream. Until then, and below that number after
 * it, a roster changes membership, names and status but not the order of the workspaces it keeps.
 * Numbers compare within one epoch only. A roster of another epoch asks the PC's server, after the
 * receipt, which boot answers now (verifySourceBoot); only that answer retires the old epoch.
 * A server too old to send receipts with evidence is trusted again from a load started after the moves
 * settled. No clock decides anything here.
 */
export class ReorderCoordinator {
  private pcs = new Map<string, PcOrder>();
  private listeners = new Set<() => void>();
  private changes = 0;
  private loads = 0;

  constructor(private options: { verify?: SourceProofQuery; onSettled?: (machineId: string) => void } = {}) {}

  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  version = (): number => this.changes;
  private notify(): void { this.changes++; for (const listener of this.listeners) listener(); }
  private pc(id: string): PcOrder {
    let pc = this.pcs.get(id);
    if (!pc) {
      pc = { shown: null, last: null, generation: 0, pending: new Set(), desired: null, hold: null, floors: new Map(), protectedEpoch: null, guard: null, retired: new Set(), receipts: 0, chain: Promise.resolve(), failed: false, waiters: [], gone: false, check: null };
      this.pcs.set(id, pc);
    }
    return pc;
  }

  /** an App load starts: the number its roster is committed with */
  loadStarted(): number { return ++this.loads; }

  /** The order the sidebar draws for `machineId`, given the workspaces its roster lists now. */
  order(machineId: string, ids: readonly string[]): string[] {
    const pc = this.pcs.get(machineId);
    const base = pc?.hold ? pc.desired ?? pc.shown : pc?.shown;
    return base ? mergeOrder(base, ids) : [...ids];
  }

  /** what a test or the browser regression reads of a PC: never used to decide */
  state(machineId: string) {
    const pc = this.pcs.get(machineId);
    return { pending: pc?.pending.size ?? 0, held: !!pc?.hold, floors: Object.fromEntries(pc?.floors ?? []), guard: pc?.guard ?? null, retired: [...pc?.retired ?? []], checking: !!pc?.check };
  }

  /** A full roster App commits (never a pane patch): every registered PC, so one it lacks has left. */
  roster(entries: readonly OrderRosterEntry[], source: RosterSource): void {
    const listed = new Set(entries.map((entry) => entry.id));
    for (const [id, pc] of this.pcs) {
      if (listed.has(id)) pc.gone = false;
      else this.depart(pc);
    }
    for (const entry of entries) if (entry.snapshot) this.full(entry.id, entry.snapshot, source);
    this.notify();
  }

  /** A PC left the roster: no roster of it can come, so its waiting batches fail and its hold ends. */
  private depart(pc: PcOrder): void {
    if (pc.gone) return;
    pc.gone = true;
    this.invalidateCheck(pc);
    // a waiting batch's claim ends now; one whose move is in flight ends when that move answers
    for (const waiter of pc.waiters.splice(0)) { pc.pending.delete(waiter.generation); waiter.reject(new Error("This PC was removed")); }
    if (pc.pending.size === 0) { pc.hold = null; pc.desired = null; }
  }

  private qualifies(pc: PcOrder, evidence: Evidence | null): boolean {
    if (pc.protectedEpoch === null) return true;
    return !!evidence && evidence.epoch === pc.protectedEpoch && evidence.seq >= (pc.floors.get(evidence.epoch) ?? 0);
  }

  private full(id: string, snapshot: NonNullable<OrderRosterEntry["snapshot"]>, source: RosterSource): void {
    const pc = this.pc(id);
    const ids = snapshot.workspaces.map((workspace) => workspace.workspace_id);
    const evidence = evidenceOf(snapshot);
    pc.last = { ids, evidence };
    if (evidence && pc.retired.has(evidence.epoch)) return;
    if (pc.waiters.length > 0 && this.qualifies(pc, evidence)) for (const waiter of pc.waiters.splice(0)) waiter.resolve(ids);
    if (pc.pending.size > 0 || pc.hold) {
      if (pc.pending.size === 0 && this.releases(pc, evidence, source)) { pc.hold = null; pc.desired = null; pc.shown = ids; return; }
      // the dragged order stays on screen; a roster it may trust is what a failed drag falls back to
      if (this.qualifies(pc, evidence)) pc.shown = ids;
      else this.mismatch(id, pc, evidence);
      return;
    }
    if (pc.protectedEpoch === null || (evidence && evidence.epoch === pc.protectedEpoch)) {
      if (this.qualifies(pc, evidence)) pc.shown = ids;
      return;
    }
    this.mismatch(id, pc, evidence);
  }

  private releases(pc: PcOrder, evidence: Evidence | null, source: RosterSource): boolean {
    const hold = pc.hold!;
    if (hold.epoch === null && !hold.legacy) return false;
    if (hold.epoch !== null && !(evidence && evidence.epoch === hold.epoch && evidence.seq >= pc.floors.get(hold.epoch)!)) return false;
    // a receipt without evidence (an older server), even beside evidenced ones: the first roster of a load
    // started after the moves settled; while a floor or guard protects the PC, only if that roster also
    // qualifies for it (a missing pair never lifts one)
    return !hold.legacy || (hold.settleMark !== null && source.kind === "load" && source.started > hold.settleMark
      && (pc.protectedEpoch === null || this.qualifies(pc, evidence)));
  }

  /** A roster of another epoch than the protected one: ask the PC's server which boot answers now. */
  private mismatch(id: string, pc: PcOrder, evidence: Evidence | null): void {
    const verify = this.options.verify;
    if (!verify || !evidence || pc.protectedEpoch === null || evidence.epoch === pc.protectedEpoch) return;
    const key = `${pc.receipts}:${pc.guard?.version ?? 0}:${pc.generation}:${pc.protectedEpoch}`;
    if (pc.check?.key === key) return;
    pc.check?.abort.abort();
    const check = { key, abort: new AbortController() };
    pc.check = check;
    void verify(id, check.abort.signal).then((answer) => {
      if (pc.check !== check) return;
      pc.check = null;
      // a failure keeps every protection; the next poll, reconnect or mismatch asks again
      if (answer && !check.abort.signal.aborted && key === `${pc.receipts}:${pc.guard?.version ?? 0}:${pc.generation}:${pc.protectedEpoch}`) this.proved(id, pc, answer);
    }, () => { if (pc.check === check) pc.check = null; });
  }

  private invalidateCheck(pc: PcOrder): void {
    pc.check?.abort.abort();
    pc.check = null;
  }

  /** A verification asked after the protection was set came back: the boot id of the PC's server now. */
  private proved(id: string, pc: PcOrder, answer: { machines: OrderRosterEntry[]; boot_id: string }): void {
    const boot = answer.boot_id;
    const old = pc.protectedEpoch;
    if (old === null || boot === old || pc.retired.has(boot)) return;
    pc.retired.add(old);
    pc.floors.delete(old);
    if (pc.hold?.epoch === old) {
      if (pc.pending.size === 0) { pc.shown = pc.desired ?? pc.shown; pc.hold = null; pc.desired = null; }
      else pc.hold.epoch = null;
    }
    pc.guard = { epoch: boot, version: (pc.guard?.version ?? 0) + 1 };
    pc.protectedEpoch = boot;
    // the answer may carry that server's own roster; proof alone applies no other epoch's order
    const entry = answer.machines.find((machine) => machine.id === id);
    const evidence = entry?.snapshot ? evidenceOf(entry.snapshot) : null;
    if (entry?.snapshot && evidence?.epoch === boot && pc.pending.size === 0 && !pc.hold) pc.shown = entry.snapshot.workspaces.map((workspace) => workspace.workspace_id);
    this.notify();
  }

  /**
   * A drag's new order: shown now, and herdr moved to it after the PC's earlier batches. Settles with
   * the moves; rejects only when this is still the newest reorder of the PC (an older one's failure is
   * the newer one's to repair).
   */
  reorder(machineId: string, current: readonly string[], next: readonly string[], move: (step: WorkspaceMove) => Promise<WorkspaceMoved | void>): Promise<void> {
    if (workspaceMoves(current, next).length === 0) return Promise.resolve();
    const pc = this.pc(machineId);
    const generation = ++pc.generation;
    pc.pending.add(generation);
    pc.desired = [...next];
    if (pc.shown === null) pc.shown = [...current];
    if (pc.hold) pc.hold.settleMark = null;
    else pc.hold = { epoch: null, receipts: 0, legacy: false, settleMark: null };
    pc.receipts++;
    this.invalidateCheck(pc);
    this.notify();
    const run = pc.chain.then(async () => {
      // after a failed batch, herdr's order is what a roster read after its receipts says
      const base = pc.failed ? await this.qualifiedBase(pc, generation) : [...current];
      pc.failed = false;
      for (const step of workspaceMoves(base, mergeOrder(next, base))) this.acknowledge(pc, await move(step));
    });
    pc.chain = run.catch(() => { pc.failed = true; });
    return run.then(() => this.settle(machineId, pc, generation, null), (error: unknown) => this.settle(machineId, pc, generation, error));
  }

  private qualifiedBase(pc: PcOrder, generation: number): Promise<string[]> {
    if (pc.last && this.qualifies(pc, pc.last.evidence)) return Promise.resolve(pc.last.ids);
    if (pc.gone) return Promise.reject(new Error("This PC was removed"));
    return new Promise((resolve, reject) => pc.waiters.push({ generation, resolve, reject }));
  }

  private acknowledge(pc: PcOrder, receipt: WorkspaceMoved | void): void {
    pc.receipts++;
    this.invalidateCheck(pc);
    const hold = pc.hold!;
    hold.receipts++;
    const epoch = receipt?.order_epoch;
    const seq = receipt?.moved_seq;
    if (typeof epoch !== "string" || epoch === "" || !Number.isSafeInteger(seq) || seq! < 1) { hold.legacy = true; return; }
    // a retired epoch never comes back, not even through a receipt
    if (pc.retired.has(epoch)) return;
    pc.floors.set(epoch, Math.max(pc.floors.get(epoch) ?? 0, seq!));
    pc.protectedEpoch = epoch;
    hold.epoch = epoch;
  }

  private settle(machineId: string, pc: PcOrder, generation: number, error: unknown): void {
    pc.pending.delete(generation);
    const latest = generation === pc.generation;
    // the newest order did not land: what herdr confirmed shows once a roster says so
    if (error !== null && latest) pc.desired = null;
    const hold = pc.hold;
    if (pc.pending.size === 0 && hold && pc.gone) { pc.hold = null; pc.desired = null; }
    else if (pc.pending.size === 0 && hold) {
      if (hold.receipts === 0 || (hold.epoch === null && !hold.legacy)) {
        // nothing moved, or only in an epoch proved gone: no roster to wait for
        if (pc.desired) pc.shown = pc.desired;
        pc.hold = null; pc.desired = null;
      } else {
        hold.settleMark = this.loads;
        this.options.onSettled?.(machineId);
      }
    }
    this.notify();
    if (error !== null && latest) throw error;
  }
}

/** `order` with `block` (one workspace, or a repository's workspace and its worktrees) put back before or after the workspaces of `around`. */
export function placeBlock(order: readonly string[], block: readonly string[], around: readonly string[], side: "before" | "after"): string[] {
  const rest = order.filter((id) => !block.includes(id));
  const at = around.map((id) => rest.indexOf(id)).filter((index) => index >= 0);
  if (at.length === 0) return [...order];
  const edge = side === "before" ? Math.min(...at) : Math.max(...at) + 1;
  return [...rest.slice(0, edge), ...block, ...rest.slice(edge)];
}
