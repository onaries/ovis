/**
 * An account's plan limits as another tool on this PC recorded them for its own sign-in. This server reads that
 * record and never that sign-in: no token of the tool is read, nothing is asked of a provider in its name, and its
 * store is only read. A tool that keeps no record of the limits gives no account here: an account only it is signed
 * in to is then one this server cannot show.
 *
 * A reader per tool (usage-recorded-omp.ts) gives what that tool's store holds of one provider as RecordedReading,
 * and belongs to that provider (UsageProvider.recorded), so a service that reads no provider reads no store. This
 * file makes each reading an account of the usage report that says who recorded it and whether that was long
 * enough ago for the numbers to have moved, so a record never passes for a reading this server made itself.
 */
import type { ProviderUsage, UsageProviderId, UsageRecorded, UsageRecorder, UsageWindow } from "../shared/protocol.ts";
import type { UsageContext } from "./usage.ts";

/** What a reader is given of this PC: where to look, and the time. */
export type RecordedContext = Pick<UsageContext, "home" | "env" | "platform" | "now">;

/** One limit as a tool recorded it. */
export interface RecordedWindow {
  readonly kind: UsageWindow["kind"];
  readonly scope: string | null;
  /** the share used, in percent as the tool recorded it: one past either end of 0 to 100 is cut to it */
  readonly usedPercent: number;
  /** epoch ms; null when the record names none */
  readonly resetsAt: number | null;
  /** the window's length */
  readonly seconds: number;
}

/** One account's limits as a tool read them at `readAt`. */
export interface RecordedReading {
  /** the id a sign-in of this account on this PC is listed by (accountKey in usage.ts), so both are one account */
  readonly accountId: string;
  /** how its owner knows the account (an email); null when the record names none */
  readonly label: string | null;
  /** epoch ms the tool read these limits */
  readonly readAt: number;
  readonly windows: readonly RecordedWindow[];
}

/** A tool that records one provider's limits, and what it recorded on this PC. */
export interface RecordedSource {
  readonly by: UsageRecorder;
  /** longer than the tool leaves between two reads while it runs: a record older than this is stale */
  readonly staleAfterMs: number;
  /** Each account's latest record; none when the tool keeps no store here or the store is not one this reader knows. */
  read(ctx: RecordedContext): RecordedReading[];
}

/** An account of the report that is a tool's record: it always says when it was read, and by which tool. */
export type RecordedUsage = ProviderUsage & { readonly checked_at: string; readonly recorded: UsageRecorded };

const percent = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

/**
 * A recorded limit as the report states it; null once its number counts a window that is over: its reset has
 * passed, or it names none and was read longer ago than the window lasts.
 */
function current(window: RecordedWindow, readAt: number, now: number): UsageWindow | null {
  const length = window.seconds * 1000;
  if (window.resetsAt === null ? now - readAt >= length : window.resetsAt <= now) return null;
  return {
    kind: window.kind, scope: window.scope, used_percent: percent(window.usedPercent),
    resets_at: window.resetsAt === null ? null : new Date(window.resetsAt).toISOString(),
    starts_at: window.resetsAt === null ? null : new Date(window.resetsAt - length).toISOString(),
  };
}

/**
 * The accounts of `provider` the tools recorded, each once: by the tool that read it last where two recorded it,
 * without the limits whose window is over, and not at all once none is left. In the order of their keys, so an
 * account keeps its place whichever was read last. A reader that fails gives no accounts: it is no failure of the report.
 * Each is given as known from its record alone (`signed_in` false): whether this PC also signs in to it is the caller's to say.
 * `read` gives what a tool's store holds: the store itself, unless the caller keeps what it read between two reports.
 */
export function recordedUsages(provider: UsageProviderId, sources: readonly RecordedSource[], ctx: RecordedContext,
  read: (source: RecordedSource) => RecordedReading[] = (source) => source.read(ctx)): RecordedUsage[] {
  const now = ctx.now();
  const latest = new Map<string, RecordedUsage>();
  for (const source of sources) {
    let readings: RecordedReading[];
    try {
      readings = read(source);
    } catch (error) {
      console.warn(`usage: ${source.by}'s record could not be read: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const reading of readings) {
      const windows = reading.windows.flatMap((window) => current(window, reading.readAt, now) ?? []);
      if (windows.length === 0) continue;
      // the key a sign-in of this account on this PC has (accountKey in usage.ts)
      const key = `${provider}:${reading.accountId}`;
      const held = latest.get(key);
      if (held && Date.parse(held.checked_at) >= reading.readAt) continue;
      latest.set(key, {
        id: provider, key, account: reading.label, plan: null, windows, problem: null,
        checked_at: new Date(reading.readAt).toISOString(), recorded: { by: source.by, stale: now - reading.readAt > source.staleAfterMs, signed_in: false },
      });
    }
  }
  return [...latest.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
