import { createHash } from "node:crypto";
import { openSync, closeSync, readSync, statSync, fstatSync } from "node:fs";

import { MAX_PI_ENTRY_BYTES, MAX_PI_INDEX_ENTRIES } from "./pi-tree.ts";
import { skillPromptMessage } from "./skill-activity.ts";
import { piMessage, record, resultText } from "./transcript-records.ts";

export interface PiDeliveryAnchor {
  /** Exact path resolved from the live Pi session. */
  path: string;
  /** Device/inode of an already-written session, or null while Pi has not created it yet. */
  file: string | null;
  /** Pi session-header id, where the file already has one. */
  session: string | null;
  /** Active leaf immediately before Ovis pressed Enter. */
  leaf: string | null;
  /** Exact complete-line append boundary and a digest of its bounded, byte-exact tail. */
  size: number;
  prefix: string;
  /** Wall-clock time of this capture, taken before Ovis pressed Enter. Pi stamps a user message
   * when it is submitted, so a record stamped earlier was submitted by someone else, or the clock
   * was set back in between. */
  at: number;
}

export interface PiDeliveryCandidate {
  id: string;
  text: string;
  anchor: PiDeliveryAnchor;
}

export type PiReceiptReservation<Owner extends object> = { readonly owner: Owner; active: boolean };

/** Per-connection retained receipts and synchronous reservations across every pane. */
export class PiReceiptCapacity<Owner extends object> {
  private readonly retained = new Map<Owner, number>();
  private readonly reserved = new Map<Owner, number>();
  constructor(private readonly limit: number) {}

  reserve(owner: Owner): PiReceiptReservation<Owner> | null {
    if ((this.retained.get(owner) ?? 0) + (this.reserved.get(owner) ?? 0) >= this.limit) return null;
    this.reserved.set(owner, (this.reserved.get(owner) ?? 0) + 1);
    return { owner, active: true };
  }

  release(reservation: PiReceiptReservation<Owner> | null | undefined): void {
    if (!reservation?.active) return;
    reservation.active = false;
    const count = this.reserved.get(reservation.owner) ?? 0;
    if (count <= 1) this.reserved.delete(reservation.owner); else this.reserved.set(reservation.owner, count - 1);
  }

  retain(owner: Owner, reservation?: PiReceiptReservation<Owner> | null): boolean {
    if (reservation && reservation.owner !== owner) { this.release(reservation); return false; }
    this.release(reservation);
    if ((this.retained.get(owner) ?? 0) + (this.reserved.get(owner) ?? 0) >= this.limit) return false;
    this.retained.set(owner, (this.retained.get(owner) ?? 0) + 1);
    return true;
  }

  remove(owner: Owner, count = 1): void {
    const next = Math.max(0, (this.retained.get(owner) ?? 0) - count);
    if (next === 0) this.retained.delete(owner); else this.retained.set(owner, next);
  }
}

/** `at`: Pi's own submission time of a user message, or null where the record carries none. */
type BranchEntry = { id: string; parent: string | null; role: string; text: string; at: number | null; start: number; end: number };
const TAIL_BYTES = 64 * 1024;
const MAX_APPEND_BYTES = 32 * 1024 * 1024;
/** Permanent for this anchor: retrying cannot shrink its append or retained history. */
class PiDeliveryBudgetExceeded extends Error {}
/** A writer may pause between chunks without changing stat during this capture attempt. */
class PiDeliveryIncomplete extends Error {}
const identity = (stat: NonNullable<ReturnType<typeof statSync>>): string => `${stat.dev}:${stat.ino}`;
const fileId = (path: string): string | null => {
  try { const stat = statSync(path); return stat.isFile() ? identity(stat) : null; }
  catch { return null; }
};

/** Positioned reads are bounded independently of the transcript's cumulative size.
 * Pi owns an append-only log: inode, header, exact boundary tails and parent links attest
 * continuation. This is not an integrity checksum for arbitrary edits to older history. */
function bytesAt(fd: number, start: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const got = readSync(fd, bytes, offset, length - offset, start + offset);
    if (got <= 0) throw new Error("Short Pi transcript read");
    offset += got;
  }
  return bytes;
}
/** A short digest of the bounded tail, so a waiting receipt does not hold the tail's bytes. */
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const EMPTY_TAIL = digest(Buffer.alloc(0));
function tailAt(fd: number, end: number): string {
  const start = Math.max(0, end - TAIL_BYTES);
  return digest(bytesAt(fd, start, end - start));
}
/** Both the opened descriptor and the path must still name the captured append-only prefix.
 * Growth after the snapshot is harmless; replacement/truncation or a changed boundary is not. */
function stable(fd: number, path: string, file: string, size: number, tail: string): boolean {
  const current = fstatSync(fd), named = statSync(path);
  return identity(current) === file && identity(named) === file
    && current.size >= size && named.size >= size && tailAt(fd, size) === tail;
}
function sessionId(fd: number, size: number): string | null {
  const bytes = bytesAt(fd, 0, Math.min(size, TAIL_BYTES));
  const newline = bytes.indexOf(0x0a);
  if (newline < 0) return null;
  const value = record(JSON.parse(bytes.subarray(0, newline).toString("utf8")));
  return value.type === "session" && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256 ? value.id : null;
}
function parseEntry(bytes: Buffer, start: number, end: number): BranchEntry {
  const entry = record(JSON.parse(bytes.toString("utf8")));
  if (typeof entry.id !== "string" || !entry.id || entry.id.length > 256
    || (entry.parentId !== undefined && entry.parentId !== null && (typeof entry.parentId !== "string" || entry.parentId.length > 256))) throw new Error("Invalid Pi entry");
  const message = piMessage(entry), user = message?.role === "user";
  const skill = user ? skillPromptMessage(entry) : null;
  const at = user && typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : null;
  return { id: entry.id, parent: typeof entry.parentId === "string" ? entry.parentId : null,
    role: typeof message?.role === "string" ? message.role : "",
    text: user ? skill?.request ?? resultText(message.content) : "", at, start, end };
}

/** Read just the final complete record, not the old branch or the shared tree index. */
function lastEntry(fd: number, size: number): BranchEntry {
  if (size === 0 || bytesAt(fd, size - 1, 1)[0] !== 0x0a) throw new PiDeliveryIncomplete("Partial Pi entry");
  let start = size - 1;
  const parts: Buffer[] = [];
  while (start > 0) {
    const from = Math.max(0, start - TAIL_BYTES);
    const part = bytesAt(fd, from, start - from);
    const newline = part.lastIndexOf(0x0a);
    parts.unshift(part.subarray(newline + 1));
    if (size - (from + newline + 1) > MAX_PI_ENTRY_BYTES + 1) throw new Error("Pi entry exceeds limit");
    if (newline >= 0 || from === 0) return parseEntry(Buffer.concat(parts), from + newline + 1, size);
    start = from;
  }
  throw new Error("Empty Pi entry");
}

type AppendState = { scanned: number; tail: string; entries: BranchEntry[] };
const appends = new WeakMap<PiDeliveryAnchor, AppendState>();
/** Only new complete records are parsed. A torn final line waits for its newline. */
function appended(fd: number, size: number, anchor: PiDeliveryAnchor): AppendState {
  const previous = appends.get(anchor) ?? { scanned: anchor.size, tail: anchor.prefix, entries: [] };
  if (size < previous.scanned || tailAt(fd, previous.scanned) !== previous.tail) throw new Error("Pi append changed");
  if (size - previous.scanned > MAX_APPEND_BYTES) throw new PiDeliveryBudgetExceeded("Pi append budget exceeded");
  const bytes = bytesAt(fd, previous.scanned, size - previous.scanned);
  const entries = [...previous.entries];
  let offset = 0;
  for (let newline = bytes.indexOf(0x0a); newline !== -1; newline = bytes.indexOf(0x0a, offset)) {
    if (newline - offset > MAX_PI_ENTRY_BYTES || entries.length >= MAX_PI_INDEX_ENTRIES) throw new PiDeliveryBudgetExceeded("Pi append budget exceeded");
    const entry = parseEntry(bytes.subarray(offset, newline), previous.scanned + offset, previous.scanned + newline + 1);
    // A first-file session header attests the session, not a user turn or a tree parent.
    if (!(anchor.size === 0 && entry.start === 0)) entries.push(entry);
    offset = newline + 1;
  }
  if (bytes.length - offset > MAX_PI_ENTRY_BYTES) throw new PiDeliveryBudgetExceeded("Partial Pi entry exceeds limit");
  const scanned = previous.scanned + offset;
  if (entries.reduce((bytes, entry) => bytes + 192 + 2 * (entry.id.length + (entry.parent?.length ?? 0) + entry.text.length), 0) > MAX_APPEND_BYTES) throw new PiDeliveryBudgetExceeded("Pi append retention budget exceeded");
  if (tailAt(fd, previous.scanned) !== previous.tail) throw new Error("Pi append changed during read");
  return { scanned, tail: tailAt(fd, scanned), entries };
}

export type PiDeliveryCapture = { anchor: PiDeliveryAnchor | null; retry: boolean };

/** Try once to capture Pi's active transcript position, distinguishing a concurrent write from an unreadable transcript. */
export function capturePiDeliveryAnchorAttempt(path: string, allowMissing = false, expectedSession?: string): PiDeliveryCapture {
  const at = Date.now();
  let fd: number | undefined;
  let before: ReturnType<typeof statSync> | undefined;
  try {
    fd = openSync(path, "r");
    before = fstatSync(fd);
    if (!before.isFile()) return { anchor: null, retry: false };
    const session = sessionId(fd, before.size), leaf = lastEntry(fd, before.size);
    if (session === null || expectedSession !== undefined && session !== expectedSession) return { anchor: null, retry: false };
    const prefix = tailAt(fd, before.size), file = identity(before);
    if (!stable(fd, path, file, before.size, prefix)) return { anchor: null, retry: true };
    return { anchor: { path, file, session, leaf: leaf.start === 0 ? null : leaf.id, size: before.size, prefix, at }, retry: false };
  } catch (error) {
    const current = (() => { try { return statSync(path); } catch { return null; } })();
    const retry = error instanceof PiDeliveryIncomplete || before !== undefined && current !== null && (identity(current) !== identity(before) || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs);
    return { anchor: allowMissing && expectedSession && before === undefined && fileId(path) === null
      ? { path, file: null, session: expectedSession, leaf: null, size: 0, prefix: EMPTY_TAIL, at } : null, retry };
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Capture the exact active Pi transcript position before Ovis types Enter. */
export function capturePiDeliveryAnchor(path: string, allowMissing = false, expectedSession?: string): PiDeliveryAnchor | null {
  return capturePiDeliveryAnchorAttempt(path, allowMissing, expectedSession).anchor;
}

/** Retry incomplete records and snapshots invalidated by a concurrent write. Unreadable transcripts fail at once. */
export async function capturePiDeliveryAnchorRetrying(path: string, allowMissing = false, expectedSession?: string,
  capture: typeof capturePiDeliveryAnchorAttempt = capturePiDeliveryAnchorAttempt,
  // fixed wait: bounded backoff lets an in-flight Pi append settle before retrying its snapshot
  wait: (milliseconds: number) => Promise<unknown> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))): Promise<PiDeliveryAnchor | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = capture(path, allowMissing, expectedSession);
    if (!result.retry || attempt === 2) return result.anchor;
    await wait(20);
  }
  return null;
}

/**
 * Match Ovis-origin typed receipts to durable user records on the active Pi branch.
 * Candidates and matching entries are both FIFO. Unrelated user records are skipped, while a
 * later Ovis receipt may not cross an earlier unmatched one. Content is only a bounded scoped
 * correlator: Pi does not expose a submission id in its TUI or transcript. A record stamped no
 * earlier than the receipt's capture confirms it. Where the only such text was stamped earlier,
 * either someone else submitted it before Ovis's Enter or the wall clock was set back, so the
 * receipt is `ambiguous`: neither confirmed nor left waiting for a record that may never come.
 * The same text submitted elsewhere after that Enter, or staged by Pi during compaction (stamped
 * only when the stage drains), remains indistinguishable.
 */
export function matchPiDeliveries(path: string, candidates: readonly PiDeliveryCandidate[], consumedEntries = new Set<string>()): { consumed: string[]; changed: string[]; ambiguous?: string[]; unavailable?: string[]; retry: boolean } {
  if (candidates.length === 0) return { consumed: [], changed: [], retry: false };
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const before = fstatSync(fd), file = identity(before), size = before.size;
    const session = sessionId(fd, size), tail = tailAt(fd, size);
    if (session === null) return { consumed: [], changed: [], retry: true };
    const consumed: string[] = [], changed: string[] = [], ambiguous: string[] = [], matchedEntries: string[] = [];
    const updates = new Map<PiDeliveryAnchor, AppendState>();
    let afterMatched = -1;
    for (const [index, candidate] of candidates.entries()) {
      const { anchor } = candidate;
      if (anchor.path !== path || anchor.file !== null && anchor.file !== file || anchor.session !== session
        || size < anchor.size || tailAt(fd, anchor.size) !== anchor.prefix) {
        changed.push(candidate.id); continue;
      }
      const state = updates.get(anchor) ?? appended(fd, size, anchor);
      updates.set(anchor, state);
      const byId = new Map(state.entries.map((entry) => [entry.id, entry]));
      const chain: BranchEntry[] = [], seen = new Set<string>();
      let next = state.entries.at(-1), parent = anchor.leaf;
      while (next) {
        if (seen.has(next.id)) throw new Error("Cyclic Pi branch");
        seen.add(next.id); chain.push(next); parent = next.parent;
        if (parent === anchor.leaf) break;
        next = parent === null ? undefined : byId.get(parent);
      }
      if (parent !== anchor.leaf) { changed.push(candidate.id); continue; }
      const key = (entry: BranchEntry): string => JSON.stringify([path, file, session, entry.id]);
      const same = chain.reverse().filter((entry) => entry.start > afterMatched && entry.role === "user"
        && entry.text === candidate.text && !consumedEntries.has(key(entry)));
      const match = same.find((entry) => entry.at === null || entry.at >= anchor.at);
      const earlier = match ? undefined : same[0];
      if (match) consumed.push(candidate.id);
      else if (earlier) ambiguous.push(candidate.id);
      else break;
      const used = (match ?? earlier)!;
      // Earlier-stamped copies a match passes over are accounted for by it: they cannot make a
      // later receipt ambiguous in a later reconciliation, whose scan starts over. One stamped no
      // earlier than a later same-text receipt's capture (a clock set back between captures) may be
      // that receipt's own record, so it stays.
      const laterCapture = Math.min(...candidates.slice(index + 1)
        .filter((later) => later.text === candidate.text).map((later) => later.anchor.at));
      for (const entry of same) {
        if (entry === used || entry.start < used.start && entry.at !== null && entry.at < laterCapture) matchedEntries.push(key(entry));
      }
      afterMatched = used.start;
    }
    if (!stable(fd, path, file, size, tail)) return { consumed: [], changed: [], retry: true };
    for (const [anchor, state] of updates) {
      if (tailAt(fd, anchor.size) !== anchor.prefix || tailAt(fd, state.scanned) !== state.tail) return { consumed: [], changed: [], retry: true };
    }
    for (const [anchor, state] of updates) appends.set(anchor, state);
    for (const key of matchedEntries) consumedEntries.add(key);
    return { consumed, changed, ...(ambiguous.length ? { ambiguous } : {}), retry: false };
  } catch (error) {
    // No partial matches were committed. Conservatively settle the whole candidate batch:
    // FIFO correlation cannot safely cross the receipt whose bounded history is unavailable.
    if (error instanceof PiDeliveryBudgetExceeded) return { consumed: [], changed: [], unavailable: candidates.map((candidate) => candidate.id), retry: false };
    return { consumed: [], changed: [], retry: true };
  }
  finally { if (fd !== undefined) closeSync(fd); }
}
