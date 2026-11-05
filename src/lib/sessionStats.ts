import { useSyncExternalStore } from "react";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { formatBytes } from "./bridgeProgress.ts";
import { formatGoalTime, turnGoal, type GoalState, type GoalStatus } from "./goals.ts";
import { t } from "./i18n.ts";

/**
 * A chat session's totals for the header (#2017): how long the agent has worked, how large its
 * transcript is, and the goal it works toward. Worked time is the sum of the agent turns' own
 * durations (each turn's first to last recorded activity, as its "Worked for" says), not the wall
 * time since the session began: idle time between turns is not work. The chat pages its turns, so
 * until the beginning is loaded the sum covers only the turns read and is said as "at least"; so is
 * a sum that leaves out a settled turn whose span the transcript does not record.
 */
export interface SessionStats {
  workedSeconds: number | null;
  /** the turns reach back to the conversation's beginning and every settled one has a span: the sum is the whole session's */
  complete: boolean;
  /** the transcript file's size (ConversationResponse.transcript_bytes); null when the store is not one file */
  bytes: number | null;
  /** the goal the latest omo goal call left in the turns read */
  goal: GoalState | null;
}

export function sessionStats(turns: readonly ConversationTurn[], complete: boolean, bytes: number | null): SessionStats {
  let worked: number | null = null;
  let unknown = false;
  const last = turns.at(-1);
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    const ms = turn.ts === null || turn.end_ts === undefined ? NaN : Date.parse(turn.end_ts) - Date.parse(turn.ts);
    if (Number.isFinite(ms) && ms >= 0) worked = (worked ?? 0) + ms;
    // the running turn may not have written its end yet
    else if (turn !== last) unknown = true;
  }
  return {
    workedSeconds: worked === null ? null : Math.round(worked / 1000),
    complete: complete && !unknown,
    bytes,
    goal: turnGoal(turns.flatMap((turn) => turn.role === "assistant" ? turn.parts : [])),
  };
}

const sameGoal = (a: GoalState | null, b: GoalState | null): boolean => a === b || (a !== null && b !== null
  && a.objective === b.objective && a.status === b.status && a.tokensUsed === b.tokensUsed && a.timeUsedSeconds === b.timeUsedSeconds && a.blockedReason === b.blockedReason);

const same = (a: SessionStats | undefined, b: SessionStats | null): boolean => a === undefined ? b === null
  : b !== null && a.workedSeconds === b.workedSeconds && a.complete === b.complete && a.bytes === b.bytes && sameGoal(a.goal, b.goal);

// each chat view publishes its own, under its pane; two views of one pane (a split) each keep theirs,
// and the header reads the one published last
const published = new Map<string, Map<symbol, SessionStats>>();
const listeners = new Set<() => void>();
const keyOf = (machineId: string, paneId: string): string => `${machineId}\0${paneId}`;

function current(key: string): SessionStats | null {
  return [...published.get(key)?.values() ?? []].at(-1) ?? null;
}

/** `stats` null: this view shows no conversation (any more). Tells readers only on a change. */
export function publishSessionStats(machineId: string, paneId: string, view: symbol, stats: SessionStats | null): void {
  const key = keyOf(machineId, paneId);
  const views = published.get(key) ?? new Map<symbol, SessionStats>();
  if (same(views.get(view), stats)) return;
  const before = current(key);
  views.delete(view);
  if (stats !== null) views.set(view, stats);
  if (views.size === 0) published.delete(key);
  else published.set(key, views);
  if (current(key) !== before) for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSessionStats(machineId: string, paneId: string | null): SessionStats | null {
  return useSyncExternalStore(subscribe, () => paneId === null ? null : current(keyOf(machineId, paneId)));
}

const STATUS_WORDS: Record<GoalStatus, string> = {
  active: "in progress", paused: "paused", blocked: "blocked", complete: "complete", budget_limited: "out of budget",
};

export function goalStatusWord(status: GoalStatus): string {
  return t(STATUS_WORDS[status]);
}

/** "Worked 2h 5m", "Worked at least 40m" while earlier turns are not loaded, or null when unknown. */
export function workedWords(stats: SessionStats): string | null {
  if (stats.workedSeconds === null) return null;
  const duration = formatGoalTime(stats.workedSeconds);
  return stats.complete ? t("Worked {duration}", { duration }) : t("Worked at least {duration}", { duration });
}

export function sizeWords(stats: SessionStats): string | null {
  return stats.bytes === null ? null : formatBytes(stats.bytes);
}

/** The More menu's lines: totals (an unknown one said so), then the goal and its time. */
export function sessionMenuLines(stats: SessionStats): { totals: string; goal: string | null } {
  const totals = [
    workedWords(stats) ?? t("Work time unknown"),
    stats.bytes === null ? t("Transcript size unknown") : t("Transcript {size}", { size: formatBytes(stats.bytes) }),
  ].join(" · ");
  const goal = stats.goal;
  if (goal === null) return { totals, goal: null };
  const spent = goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 ? [formatGoalTime(goal.timeUsedSeconds)] : [];
  return { totals, goal: [t("Goal: {objective}", { objective: goal.objective }), goalStatusWord(goal.status), ...spent].join(" · ") };
}
