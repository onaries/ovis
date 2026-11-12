/**
 * Claude's limits as Oh My Pi recorded them. While it runs, Oh My Pi reads the limits of each account it is signed
 * in to about every five minutes and keeps every report in its store: `usage_history` in agent.db, one row per limit
 * (as Oh My Pi 18.14 to 18.19 write it, packages/ai/src/auth/sqlite-credential-store.ts):
 *   recorded_at    epoch ms the report was read; the rows of one report share it
 *   provider       "anthropic" for Claude
 *   account_key    Oh My Pi's own name for the sign-in the report was read with
 *   account_id     the Claude account's uuid, the id Claude Code's .claude.json names too
 *   email
 *   limit_id       "anthropic:5h", "anthropic:7d", "anthropic:7d:<model>", "anthropic:extra"
 *   label          "Claude 7 Day (Fable)"
 *   used_fraction  0 to 1; null when the provider stated none
 *   resets_at      epoch ms; null when the provider stated none
 *
 * That table is all this reads. The same file holds Oh My Pi's sign-ins (`auth_credentials`): nothing here names
 * that table, and the file is only read.
 */
import { Database, SQLiteError, constants } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RecordedContext, RecordedReading, RecordedSource, RecordedWindow } from "./usage-recorded.ts";

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 86400;
/** Oh My Pi reads again five minutes after its last read, give or take a quarter: three reads missed, it has stopped reading. */
const STALE_AFTER_MS = 15 * 60_000;
/** A week is the longest window read here: a row older than that, with a day to spare, records none that still runs. */
const SINCE_MS = 8 * 86_400_000;
/** A clock a little ahead of this one is no reason to drop a record; a time further ahead is not one Oh My Pi read at. */
const AHEAD_MS = 60_000;
/**
 * The newest rows looked through for each sign-in's latest report. Oh My Pi keeps a row an hour for each limit of each
 * sign-in, about a thousand in the eight days read: this is twenty sign-ins' worth, and what a stopped sign-in last
 * recorded is not pushed out by the rows of the others.
 */
const MAX_ROWS = 20_000;
/** A store in use is read through its write-ahead log without waiting; should it still be busy, this long and no longer. */
const BUSY_TIMEOUT_MS = 250;
/** Epoch milliseconds are past this since 2001; epoch seconds stay below it for millennia. */
const EPOCH_MS_FROM = 1e12;

/**
 * A row shaped as Oh My Pi writes one: a value of another type, or a name longer than any real one, leaves its row
 * out, so what comes back needs no second look. A limit recorded without a number is kept, for the time of its
 * report. `+provider` keeps each search on the index by time.
 */
const shaped = (row: string): string => `
  +${row}.provider = 'anthropic'
  AND typeof(${row}.recorded_at) = 'integer' AND (${row}.used_fraction IS NULL OR typeof(${row}.used_fraction) IN ('real', 'integer'))
  AND typeof(${row}.account_key) = 'text' AND length(${row}.account_key) <= 512
  AND typeof(${row}.account_id) = 'text' AND length(${row}.account_id) BETWEEN 1 AND 128
  AND typeof(${row}.limit_id) = 'text' AND length(${row}.limit_id) <= 128
  AND typeof(${row}.label) = 'text' AND length(${row}.label) <= 256
  AND (${row}.email IS NULL OR (typeof(${row}.email) = 'text' AND length(${row}.email) <= 320))
  AND (${row}.resets_at IS NULL OR typeof(${row}.resets_at) = 'integer')`;

/**
 * The rows of each sign-in's latest report, newest first: the time of that report is found among the newest rows of
 * the days read, of which only the sign-in and the time are taken, and then the rows recorded at it are read.
 */
const ROWS = `
  WITH latest AS (
    SELECT account_key AS series, max(recorded_at) AS at
    FROM (SELECT account_key, recorded_at FROM usage_history AS seen WHERE ${shaped("seen")} AND seen.recorded_at BETWEEN ? AND ? ORDER BY seen.recorded_at DESC LIMIT ?)
    GROUP BY account_key
  )
  SELECT report.recorded_at, report.account_key, report.account_id, report.email, report.limit_id, report.label, report.used_fraction, report.resets_at
  FROM latest JOIN usage_history AS report ON report.recorded_at = latest.at
  WHERE report.account_key = latest.series AND ${shaped("report")}
  ORDER BY report.recorded_at DESC`;

interface HistoryRow {
  readonly recorded_at: number;
  readonly account_key: string;
  readonly account_id: string;
  readonly email: string | null;
  readonly limit_id: string;
  readonly label: string;
  readonly used_fraction: number | null;
  readonly resets_at: number | null;
}

/**
 * Where Oh My Pi keeps agent.db, as it finds it itself (packages/utils/src/dirs.ts): in PI_CODING_AGENT_DIR, else in
 * $XDG_DATA_HOME/omp once that folder exists (Linux and macOS), else in ~/.omp/agent.
 */
function storePath(ctx: RecordedContext): string {
  const agentDir = ctx.env["PI_CODING_AGENT_DIR"];
  if (agentDir) return join(resolve(agentDir), "agent.db");
  const data = ctx.platform === "linux" || ctx.platform === "darwin" ? ctx.env["XDG_DATA_HOME"] : undefined;
  if (data && existsSync(join(data, "omp"))) return join(data, "omp", "agent.db");
  return join(ctx.home, ".omp", "agent", "agent.db");
}

/**
 * Opens Oh My Pi's store for reading. While Oh My Pi has it open its write-ahead log lies beside it (`-wal`, `-shm`),
 * and the store is read through that log, so a report written a moment ago is read. Otherwise the file is opened as
 * one that does not change: SQLite then makes no `-wal` and `-shm` of its own, and the folder stays as Oh My Pi left it.
 * That holds for a log left without its `-shm` too (a store copied or restored that way): SQLite would make the
 * missing file to read it, so what only that log holds is not seen until Oh My Pi opens its store again, as with an
 * agent's history (liveLog in session-history.ts).
 */
function openForReading(path: string): Database {
  if (existsSync(`${path}-wal`) && existsSync(`${path}-shm`)) return new Database(path, { readonly: true, create: false });
  return new Database(`${pathToFileURL(path).href}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
}

/** The limit a row records; null for one the meters do not show (extra usage) or do not know. */
function limitOf(row: HistoryRow): Pick<RecordedWindow, "kind" | "scope" | "seconds"> | null {
  if (row.limit_id === "anthropic:5h") return { kind: "session", scope: null, seconds: FIVE_HOURS };
  if (row.limit_id === "anthropic:7d") return { kind: "week", scope: null, seconds: SEVEN_DAYS };
  const model = /^anthropic:7d:(.+)$/.exec(row.limit_id)?.[1];
  if (model === undefined) return null;
  // the label names the model as the provider spells it: "Claude 7 Day (Fable)"
  return { kind: "week", scope: /\(([^()]+)\)\s*$/.exec(row.label)?.[1]?.trim() || model, seconds: SEVEN_DAYS };
}

/** The reset a row names; null when it names none, or a time that cannot be this window's: not epoch ms, or later than a whole window after the read. */
function resetOf(row: HistoryRow, seconds: number): number | null {
  const reset = row.resets_at;
  return reset !== null && reset >= EPOCH_MS_FROM && reset <= row.recorded_at + seconds * 1000 + AHEAD_MS ? reset : null;
}

/** The session, then the week, then each model's week by name. */
function byLength(a: RecordedWindow, b: RecordedWindow): number {
  return a.seconds - b.seconds || Number(a.scope !== null) - Number(b.scope !== null) || ((a.scope ?? "") < (b.scope ?? "") ? -1 : 1);
}

/**
 * Each account's latest report, from the rows of each sign-in's latest report (ROWS), newest first. Oh My Pi keeps a
 * series per sign-in (`account_key`), and may hold one account under two of them: the account is then given once, by
 * the series read last whose latest report holds a limit shown here, never as a mix of two. A limit the latest
 * report lacks, or records without a number, is not taken from an older one.
 */
function latestReports(rows: readonly HistoryRow[]): RecordedReading[] {
  const series = new Map<string, { accountId: string; label: string | null; readAt: number; windows: RecordedWindow[] }>();
  for (const row of rows) {
    const report = series.get(row.account_key) ?? { accountId: row.account_id, label: row.email?.trim() || null, readAt: row.recorded_at, windows: [] };
    series.set(row.account_key, report);
    if (row.used_fraction === null) continue;
    const limit = limitOf(row);
    if (limit !== null) report.windows.push({ ...limit, usedPercent: row.used_fraction * 100, resetsAt: resetOf(row, limit.seconds) });
  }
  const accounts = new Map<string, RecordedReading>();
  for (const { accountId, label, readAt, windows } of series.values()) {
    // a series whose latest report holds no limit shown here (extra usage only) stands for nothing: another one may
    if (windows.length > 0 && !accounts.has(accountId)) accounts.set(accountId, { accountId, label, readAt, windows: windows.sort(byLength) });
  }
  return [...accounts.values()];
}

export const ompRecorded: RecordedSource = {
  by: "omp",
  staleAfterMs: STALE_AFTER_MS,
  read(ctx) {
    const path = storePath(ctx);
    // only a regular file is a store: opening a FIFO left at this path would wait for a writer
    try { if (!statSync(path).isFile()) return []; } catch { return []; }
    const now = ctx.now();
    let db: Database | undefined;
    let rows: HistoryRow[];
    try {
      db = openForReading(path);
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      rows = db.query<HistoryRow, [number, number, number]>(ROWS).all(now - SINCE_MS, now + AHEAD_MS, MAX_ROWS);
    } catch (error) {
      // not a database, a store of a version without this table or one of these columns, or one still busy: no record here
      if (error instanceof SQLiteError) return [];
      throw error;
    } finally {
      db?.close();
    }
    return latestReports(rows);
  },
};
