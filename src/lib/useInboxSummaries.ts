/**
 * Each inbox row's last words and their time (components/InboxList.tsx), read through GET
 * /api/pane/summary a batch per PC at a time. Nothing is stored past the page; a row that leaves the
 * list leaves its summary behind.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { PANE_SUMMARY_MAX_IDS } from "../../shared/pane-summary.ts";
import type { PaneSummaries, PaneSummary } from "../../shared/protocol.ts";
import { inboxKey, inboxStatus } from "./agentInbox.ts";
import type { AgentRow } from "./agentRoster.ts";
import { fetchPaneSummaries } from "./api.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";

/** Rows whose summary is read, from the top of the list. */
export const SUMMARY_ROWS = 60;
/** How long after an answer that left a pane out, or a failed request, it is asked for again, and how many times. */
export const SUMMARY_RETRY_MS = 2000;
export const SUMMARY_RETRIES = 3;

/** A row's last words; times are this device's clock in ms, the server's offset taken out. */
export interface RowSummary {
  role: "assistant" | "user";
  text: string;
  /** when the words were said: the turn's end, else its start */
  at: number | null;
  /** the time of the newest turn the user wrote; null when there is none */
  askedAt: number | null;
  /** the words are a request the agent recorded as failed */
  failed: boolean;
}

/**
 * A row whose summary is read: a new `stamp` (herdr lifetime, finish, activity or shown state changed) reads it again,
 * and once more after its first answer under that stamp, whatever it says (its agent may not have written the turn
 * yet, or the answer came from a read begun before the change). `lifetime` is the PC's herdr lifetime, also in the stamp
 * ("" while unproven): words answered under another known one leave the row at once.
 */
export interface SummaryTarget { key: string; machineId: string; paneId: string; stamp: string; lifetime: string }

/** The first SUMMARY_ROWS rows of a PC in reach, in the given order. */
export function summaryTargets(rows: readonly AgentRow[], activity: SidebarActivity): SummaryTarget[] {
  return rows.filter((row) => row.machine.state === "connected").slice(0, SUMMARY_ROWS).map((row) => {
    const pane = row.entry.pane;
    const seq = activity.seqs(row.machine.id).get(pane.pane_id) ?? 0;
    const status = inboxStatus(row, activity);
    // a replaced herdr can reuse a pane id with the same finish, counter and state
    const lifetime = row.machine.snapshot?.herdr_lifetime ?? "";
    return { key: inboxKey(row), machineId: row.machine.id, paneId: pane.pane_id, stamp: `${lifetime}:${pane.finish_id ?? ""}:${seq}:${status ?? ""}`, lifetime };
  });
}

export type SummaryRead = (machineId: string, paneIds: readonly string[]) => Promise<PaneSummaries | null>;
export type SummaryWait = (run: () => void, ms: number) => () => void;

export const NO_SUMMARIES: ReadonlyMap<string, RowSummary> = new Map();
const readOf = (target: SummaryTarget): string => `${target.key}\n${target.stamp}`;

function timeOf(stamp: string | null, offset: number): number | null {
  if (stamp === null) return null;
  const ms = Date.parse(stamp) - offset;
  // a corrected time a Date cannot hold is no time
  return Number.isNaN(new Date(ms).getTime()) ? null : ms;
}

const stampOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
/** An answer's summary as the wire types it: another PC's comes through the proxy unchecked. */
function wellFormed(value: unknown): value is PaneSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return (summary.role === "assistant" || summary.role === "user") && typeof summary.text === "string"
    && stampOrNull(summary.at) && stampOrNull(summary.asked_at);
}

/**
 * Each target's summary, read once per key and stamp: batches of at most PANE_SUMMARY_MAX_IDS per PC, one
 * request in flight per PC. A pane the answer left out, or a request that failed, is asked again after
 * SUMMARY_RETRY_MS, at most SUMMARY_RETRIES times per key and stamp, the first pane an answer left out behind the
 * others it left out, so no pane heads every retry. A target under a stamp that replaced an earlier one is asked
 * once more SUMMARY_RETRY_MS after its first answer under it, whatever that answer says; a key's first stamp on the
 * page is not. A PC whose bridge has no route (null) is not asked again until a sync
 * holds none of its targets (it went away, and may come back updated). A summary of the wrong shape counts as
 * none. A key's words outlive a stamp change within one herdr lifetime until the new read settles, without their failed mark (it held for the
 * state they were answered for): replaced or removed by an answer naming the pane, removed when the read gives up. An answer for a target gone or moved on since
 * is dropped, and a key that leaves the targets loses its summary. Made once per page, it never stops and
 * assumes no subscriber.
 */
export class SummaryReads {
  private readonly listeners = new Set<() => void>();
  private current: ReadonlyMap<string, RowSummary> = NO_SUMMARIES;
  private targets = new Map<string, SummaryTarget>();
  /** the key-and-stamp reads queued, in flight or answered, and how many times each was asked again */
  private readonly started = new Set<string>();
  private readonly retries = new Map<string, number>();
  private readonly waits = new Map<string, () => void>();
  private readonly queues = new Map<string, SummaryTarget[]>();
  private readonly busy = new Set<string>();
  private readonly missing = new Set<string>();
  /** the stamp and herdr lifetime each key's words were answered for, and the key-and-stamp reads already asked once more */
  private readonly answeredFor = new Map<string, string>();
  private readonly answeredIn = new Map<string, string>();
  private readonly rechecked = new Set<string>();
  /** the key-and-stamp reads whose stamp replaced an earlier one of the key: asked once more after their first answer */
  private readonly replacing = new Set<string>();
  /** each key's words as the answer gave them, before the clock correction: an answer that matches them changes no row */
  private readonly sources = new Map<string, string>();

  constructor(private readonly read: SummaryRead,
    private readonly wait: SummaryWait = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
    private readonly now: () => number = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The same object until a summary is added, replaced or removed. */
  summaries = (): ReadonlyMap<string, RowSummary> => this.current;

  sync(targets: readonly SummaryTarget[]): void {
    const earlier = this.targets;
    this.targets = new Map(targets.map((target) => [target.key, target]));
    const live = new Set(targets.map(readOf));
    const machines = new Set(targets.map((target) => target.machineId));
    for (const machineId of [...this.missing]) if (!machines.has(machineId)) this.missing.delete(machineId);
    for (const read of [...this.started]) {
      if (live.has(read)) continue;
      this.started.delete(read);
      this.retries.delete(read);
      this.rechecked.delete(read);
      this.replacing.delete(read);
      this.waits.get(read)?.();
      this.waits.delete(read);
    }
    for (const [machineId, queue] of this.queues) this.queues.set(machineId, queue.filter((target) => this.isCurrent(target)));
    const gone = [...this.current.keys()].filter((key) => !this.targets.has(key));
    for (const key of [...this.answeredFor.keys()]) if (!this.targets.has(key)) this.answeredFor.delete(key);
    for (const key of [...this.answeredIn.keys()]) if (!this.targets.has(key)) this.answeredIn.delete(key);
    // words answered under another herdr lifetime are another pane's: they go at once; a lifetime absent on either side
    // was only unproven (a snapshot names it once proved), so those words stay until the new read settles
    const replaced = [...this.current.keys()].filter((key) => {
      const was = this.answeredIn.get(key);
      const now = this.targets.get(key)?.lifetime;
      return Boolean(was) && Boolean(now) && was !== now;
    });
    if (replaced.length > 0) this.change((summaries) => { for (const key of replaced) { summaries.delete(key); this.sources.delete(key); } });
    for (const key of [...this.sources.keys()]) if (!this.targets.has(key)) this.sources.delete(key);
    // words carried to a new stamp until its read settles are carried without their failed mark, which held for the old state
    const unfailed = [...this.current].filter(([key, row]) => row.failed && this.answeredFor.get(key) !== this.targets.get(key)?.stamp).map(([key]) => key);
    if (unfailed.length > 0) this.change((summaries) => { for (const key of unfailed) summaries.set(key, { ...summaries.get(key)!, failed: false }); });
    if (gone.length > 0) this.change((summaries) => { for (const key of gone) summaries.delete(key); });
    for (const target of targets) {
      const read = readOf(target);
      if (this.started.has(read) || this.missing.has(target.machineId)) continue;
      this.started.add(read);
      const before = earlier.get(target.key)?.stamp;
      if (before !== undefined && before !== target.stamp) this.replacing.add(read);
      this.enqueue(target);
    }
    for (const machineId of [...this.queues.keys()]) this.pump(machineId);
  }

  private isCurrent(target: SummaryTarget): boolean {
    const now = this.targets.get(target.key);
    return now?.stamp === target.stamp && now.machineId === target.machineId && now.paneId === target.paneId;
  }

  private enqueue(target: SummaryTarget): void {
    const queue = this.queues.get(target.machineId);
    if (queue) queue.push(target); else this.queues.set(target.machineId, [target]);
  }

  private change(edit: (summaries: Map<string, RowSummary>) => void): void {
    const next = new Map(this.current);
    edit(next);
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }

  private pump(machineId: string): void {
    if (this.busy.has(machineId) || this.missing.has(machineId)) return;
    const queue = (this.queues.get(machineId) ?? []).filter((target) => this.isCurrent(target));
    const batch = queue.splice(0, PANE_SUMMARY_MAX_IDS);
    this.queues.set(machineId, queue);
    if (batch.length === 0) return;
    this.busy.add(machineId);
    const failed = () => {
      this.busy.delete(machineId);
      for (const target of batch) if (this.isCurrent(target)) this.again(target);
      this.pump(machineId);
    };
    this.read(machineId, batch.map((target) => target.paneId)).then((answer) => {
      try {
        if (answer === null) {
          this.missing.add(machineId);
          this.queues.delete(machineId);
        } else {
          this.take(batch, answer);
        }
      } catch {
        failed();
        return;
      }
      this.busy.delete(machineId);
      this.pump(machineId);
    }, failed);
  }

  private take(batch: readonly SummaryTarget[], answer: PaneSummaries): void {
    const serverNow = Date.parse(answer.server_time);
    const offset = Number.isNaN(serverNow) ? 0 : serverNow - this.now();
    const set = new Map<string, RowSummary>();
    const cleared: string[] = [];
    const left: SummaryTarget[] = [];
    for (const target of batch) {
      if (!this.isCurrent(target)) continue;
      if (!Object.hasOwn(answer.summaries, target.paneId)) { left.push(target); continue; }
      const summary: unknown = answer.summaries[target.paneId];
      this.answeredFor.set(target.key, target.stamp);
      this.answeredIn.set(target.key, target.lifetime);
      // under a stamp that replaced another, the first answer may come from a read begun before the change
      if (this.replacing.has(readOf(target))) this.recheck(target);
      if (!wellFormed(summary)) { if (this.current.has(target.key)) cleared.push(target.key); continue; }
      const row: RowSummary = { role: summary.role, text: summary.text, at: timeOf(summary.at, offset), askedAt: timeOf(summary.asked_at, offset), failed: summary.failed === true };
      // sameness is the answer's own values: two answers' clock corrections differ by the time between them
      const source = JSON.stringify([summary.role, summary.text, summary.at, summary.asked_at, row.failed]);
      const kept = this.current.get(target.key);
      const repeated = kept !== undefined && this.sources.get(target.key) === source;
      this.sources.set(target.key, source);
      // words carried to a new stamp lost their failed mark: a repeat gives it back
      if (!repeated || kept.failed !== row.failed) set.set(target.key, row);
    }
    // the first pane left out is likeliest the one the PC was still reading: it goes behind the others
    for (const target of [...left.slice(1), ...left.slice(0, 1)]) this.again(target);
    if (set.size > 0 || cleared.length > 0) this.change((summaries) => {
      for (const key of cleared) summaries.delete(key);
      for (const [key, row] of set) summaries.set(key, row);
    });
  }

  /** Asks a target once more after the wait, once per key and stamp: its first answer under a new stamp may be from before the change. */
  private recheck(target: SummaryTarget): void {
    const read = readOf(target);
    if (this.rechecked.has(read)) return;
    this.rechecked.add(read);
    this.waits.set(read, this.wait(() => {
      this.waits.delete(read);
      if (!this.isCurrent(target)) return;
      this.enqueue(target);
      this.pump(target.machineId);
    }, SUMMARY_RETRY_MS));
  }

  /** Asks the target again after the wait; once its retries are used, removes words kept from an earlier stamp. */
  private again(target: SummaryTarget): void {
    const read = readOf(target);
    const tried = this.retries.get(read) ?? 0;
    if (tried >= SUMMARY_RETRIES) {
      // words answered for the current stamp stay: only its once-more read failed
      if (this.current.has(target.key) && this.answeredFor.get(target.key) !== target.stamp) this.change((summaries) => { summaries.delete(target.key); });
      return;
    }
    this.retries.set(read, tried + 1);
    this.waits.set(read, this.wait(() => {
      this.waits.delete(read);
      if (!this.isCurrent(target)) return;
      this.enqueue(target);
      this.pump(target.machineId);
    }, SUMMARY_RETRY_MS));
  }
}

/** The page's reader: made once beside the list's other state (lib/useInbox.ts), so it outlives each mount of the list. */
export const newSummaryReads = (): SummaryReads => new SummaryReads(fetchPaneSummaries);

/** Each target's last words by its key, from the page's reader. */
export function useInboxSummaries(reads: SummaryReads, targets: readonly SummaryTarget[]): ReadonlyMap<string, RowSummary> {
  const targetsRef = useRef(targets); targetsRef.current = targets;
  const signature = targets.map((target) => `${target.key}:${target.machineId}:${target.paneId}:${target.stamp}`).join("\n");
  useEffect(() => { reads.sync(targetsRef.current); }, [reads, signature]);
  return useSyncExternalStore(reads.subscribe, reads.summaries, reads.summaries);
}
