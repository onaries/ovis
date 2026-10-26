import type { HerdrPane, PlanStep, PlanSummary } from "../shared/protocol.ts";
import { plain } from "./claude-subagents.ts";
import { PLAN_BUDGET, planState, readPlan, type PlanSource } from "./session-plan-reader.ts";
export { forgetPlans, readPlan, type PlanSource } from "./session-plan-reader.ts";

/** What the sidebar shows of a plan. */
export function planSummary(steps: readonly PlanStep[] | null): PlanSummary | null {
  if (steps === null || steps.length === 0) return null;
  const current = steps.find((step) => step.status === "in_progress");
  return { done: steps.filter((step) => step.status === "completed").length, total: steps.length, current: current ? current.active ?? current.label : null };
}

export interface SessionPlanDeps {
  /** a Claude pane's transcript as the subagent tracker found it (a lookup that costs nothing), null when not known yet */
  claudePath: (paneId: string) => string | null;
  /** an OmO pane's native session already resolved by its status tracker */
  omoPath?: (paneId: string) => string | null;
  /** a Codex pane's rollout: this costs process calls, so it is asked once per session and again every `relocateMs` */
  codexPath: (pane: HerdrPane) => Promise<string | null>;
  /** a pane's summary changed (null: it has no plan now) */
  onChange: (paneId: string, summary: PlanSummary | null) => void;
  onCodexTranscript?: (paneId: string, path: string | null) => void;
  now?: () => number;
  /** how soon a Codex pane whose rollout was not found is looked up again */
  retryMs?: number;
  /** how often a found rollout is checked (a new conversation in the same Codex writes another) */
  relocateMs?: number;
  pollMs?: number;
}

interface Tracked {
  key: string;
  at: number;
  where: { source: PlanSource; path: string } | null;
  /** the file's size and identity when it was last read: an unchanged file is not read again */
  sig: string | null;
  summary: PlanSummary | null;
}

/**
 * The plans of every Claude Code, Codex and OmO pane, for the sidebar. A pane's transcript is looked
 * up once per session (and again now and then while it is not found); a poll reads only a
 * transcript that grew, and tells a pane whose summary changed.
 */
export class SessionPlans {
  private readonly panes = new Map<string, Tracked>();
  /** supported panes of the last snapshot, by the session each runs: a lookup that ends after its pane left is dropped */
  private readonly wanted = new Map<string, string>();
  /** a snapshot has been seen: before one, a pane asked for by the endpoint is taken as it is */
  private refreshed = false;
  private readonly looking = new Map<string, { key: string; work: Promise<void> }>();
  private readonly latest = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SessionPlanDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.latest.clear();
  }

  summaryOf(paneId: string): PlanSummary | null {
    return this.panes.get(paneId)?.summary ?? null;
  }

  /**
   * The plan of the pane as herdr has it now (undefined: herdr did not say), as the poll last read it: null when it has
   * none, or its transcript is not known for the session it runs, or not read to its end yet.
   */
  planOf(pane: HerdrPane | undefined): PlanStep[] | null {
    const where = pane !== undefined && this.known(pane) ? this.panes.get(pane.pane_id)?.where : null;
    // a request reads nothing itself, however much was written since: the poll reads, in its shared budget
    return where ? readPlan(where.source, where.path, { left: 0 }) : null;
  }

  /** The pane's transcript is known, and was found for the session the pane runs now. */
  known(pane: HerdrPane): boolean {
    const tracked = this.panes.get(pane.pane_id);
    return tracked?.where != null && tracked.key === keyOf(pane);
  }

  codexPathOf(pane: HerdrPane): string | null {
    const where = this.known(pane) ? this.panes.get(pane.pane_id)?.where : null;
    return pane.agent === "codex" && where?.source === "codex-transcript" ? where.path : null;
  }

  /**
   * Follows supported panes of a snapshot; a pane that runs another agent now has
   * no plan. Nothing is read here: snapshots can come several times a second, reads come with the poll.
   */
  async refresh(panes: HerdrPane[]): Promise<void> {
    this.wanted.clear();
    this.refreshed = true;
    for (const pane of panes) if (pane.agent === "claude" || pane.agent === "codex" || pane.agent === "omo") this.wanted.set(pane.pane_id, keyOf(pane));
    for (const paneId of this.latest.keys()) if (!this.wanted.has(paneId)) this.latest.delete(paneId);
    for (const [paneId, tracked] of this.panes) {
      if (this.wanted.has(paneId)) continue;
      this.panes.delete(paneId);
      this.deps.onCodexTranscript?.(paneId, null);
      if (tracked.summary !== null) this.deps.onChange(paneId, null);
    }
    await Promise.all(panes.map((pane) => this.ensure(pane)));
  }

  /**
   * One pane's transcript, looked up now if it is not known (or not known to be this session's).
   * `asked`: a request names the pane from a snapshot of its own, which the last refresh may not have seen yet.
   */
  async ensure(pane: HerdrPane, asked = false): Promise<void> {
    if (pane.agent !== "claude" && pane.agent !== "codex" && pane.agent !== "omo") return;
    const key = keyOf(pane);
    this.latest.set(pane.pane_id, key);
    if (pane.agent === "omo") {
      const path = this.deps.omoPath?.(pane.pane_id) ?? null;
      this.track(pane.pane_id, key, path === null ? null : { source: "omo-session", path });
      return;
    }
    if (pane.agent === "claude") {
      const path = this.deps.claudePath(pane.pane_id);
      this.track(pane.pane_id, key, path === null ? null : { source: "claude-transcript", path });
      return;
    }
    const tracked = this.panes.get(pane.pane_id);
    const due = !tracked || tracked.key !== key || this.now() - tracked.at >= (tracked.where === null ? this.deps.retryMs ?? 15_000 : this.deps.relocateMs ?? 30_000);
    if (tracked?.key !== key) {
      if (tracked) { tracked.where = null; tracked.sig = null; }
      this.deps.onCodexTranscript?.(pane.pane_id, null);
    }
    const pending = this.looking.get(pane.pane_id);
    if (pending) { if (pending.key === key) await pending.work; return; }
    if (!due) return;
    const work = (async () => { try {
      const path = await this.deps.codexPath(pane).catch(() => null);
      if (this.latest.get(pane.pane_id) !== key) return;
      // the pane left, or runs another session, while it was looked up: what was found is not its
      if (!asked && this.refreshed && this.wanted.get(pane.pane_id) !== key) return;
      this.track(pane.pane_id, key, path === null ? null : { source: "codex-transcript", path });
    } finally {
      this.looking.delete(pane.pane_id);
    } })();
    this.looking.set(pane.pane_id, { key, work });
    await work;
  }

  /** Where a pane's plan is now; what was read of the same file stands. */
  private track(paneId: string, key: string, where: { source: PlanSource; path: string } | null): void {
    const current = this.panes.get(paneId);
    const same = current !== undefined && current.where?.path === where?.path && current.where?.source === where?.source;
    this.panes.set(paneId, { key, at: this.now(), where, sig: same ? current.sig : null, summary: current?.summary ?? null });
    if (!same) this.deps.onCodexTranscript?.(paneId, null);
  }

  /** Reads the transcripts that grew, PLAN_BUDGET bytes in all; a pane whose summary changed is told. */
  poll(): void {
    // ponytail: the budget goes to panes in the order they were first followed, so while a very large
    // transcript catches up the panes after it wait about size / PLAN_BUDGET polls; start each poll
    // where the last one stopped if that ever shows
    const budget = { left: PLAN_BUDGET };
    for (const [paneId, tracked] of this.panes) {
      this.deps.onCodexTranscript?.(paneId, tracked.where?.source === "codex-transcript" ? tracked.where.path : null);
      let summary: PlanSummary | null = null;
      if (tracked.where !== null) {
        const stat = plain(tracked.where.path);
        const sig = stat === null ? null : `${stat.id}:${stat.size}`;
        if (sig !== null && sig === tracked.sig) continue;
        const read = planState(tracked.where.source, tracked.where.path, budget);
        // a file read only in part is read on at the next poll: its size is not taken as seen
        if (!read.behind) tracked.sig = sig;
        // still on its first read: what it shows is not known yet
        if (read.steps === null && read.behind) continue;
        summary = planSummary(read.steps);
      }
      if (JSON.stringify(summary) === JSON.stringify(tracked.summary)) continue;
      tracked.summary = summary;
      this.deps.onChange(paneId, summary);
    }
  }
}

const keyOf = (pane: HerdrPane): string => `${pane.agent}\0${pane.agent_session?.value ?? ""}\0${pane.cwd ?? ""}`;
