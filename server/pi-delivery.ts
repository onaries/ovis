import { createHash } from "node:crypto";
import { openSync, closeSync, readSync, statSync } from "node:fs";

import { piBranchRecordRanges, piEntryIndex } from "./pi-tree.ts";
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
  /** Exact append boundary and digest of every byte before Enter. */
  size: number;
  prefix: string;
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

type BranchEntry = { id: string; role: string; text: string; start: number; end: number };
type Snapshot = { file: string; session: string; size: number; stamp: string; prefix: string; entries: BranchEntry[] };
type SnapshotResult = { state: Snapshot | null; retry: boolean };

const fileId = (path: string): string | null => {
  try { const stat = statSync(path); return stat.isFile() ? `${stat.dev}:${stat.ino}` : null; }
  catch { return null; }
};

/** Read only Pi's bounded first JSONL record. Malformed or oversized headers do not attest a session id. */
function sessionId(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bytes = Buffer.alloc(64 * 1024);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    const newline = bytes.indexOf(0x0a, 0);
    if (newline < 0 || newline >= size) return null;
    const value = record(JSON.parse(bytes.subarray(0, newline).toString("utf8")));
    return value.type === "session" && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256 ? value.id : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const stamp = (value: NonNullable<ReturnType<typeof statSync>>): string => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
function digestPrefix(path: string, size: number, expectedStamp?: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const before = statSync(path);
    if (!before.isFile() || before.size < size || (expectedStamp !== undefined && stamp(before) !== expectedStamp)) return null;
    const hash = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < size) {
      const got = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
      if (got <= 0) return null;
      hash.update(chunk.subarray(0, got)); offset += got;
    }
    const after = statSync(path);
    if (stamp(after) !== stamp(before)) return null;
    return hash.digest("hex");
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function snapshot(path: string): SnapshotResult {
  let before: NonNullable<ReturnType<typeof statSync>>;
  try { before = statSync(path); } catch { return { state: null, retry: false }; }
  if (!before.isFile()) return { state: null, retry: false };
  const file = `${before.dev}:${before.ino}`, size = before.size, beforeStamp = stamp(before);
  const failed = (): SnapshotResult => {
    try { return { state: null, retry: stamp(statSync(path)) !== beforeStamp }; }
    catch { return { state: null, retry: false }; }
  };
  // An existing transcript is usable only when both of Pi's independent invariants are
  // positively attested. An index/read failure must never look like an empty
  // baseline, because that could let an older identical user turn satisfy a later receipt.
  const session = sessionId(path);
  if (session === null || piEntryIndex(path) === null) return failed();
  const entries: BranchEntry[] = [];
  for (const item of piBranchRecordRanges(path, size)) {
    let value: unknown;
    try { value = JSON.parse(item.line); } catch { return failed(); }
    const entry = record(value);
    if (typeof entry.id !== "string" || entry.id.length === 0) return failed();
    const message = piMessage(entry);
    const skill = skillPromptMessage(entry);
    entries.push({ id: entry.id, role: typeof message?.role === "string" ? message.role : "", text: skill?.request ?? (message ? resultText(message.content) : ""), start: item.start, end: item.end });
  }
  if (entries.length === 0) return failed();
  const prefix = digestPrefix(path, size, beforeStamp);
  if (prefix === null) return failed();
  let after: NonNullable<ReturnType<typeof statSync>>;
  try { after = statSync(path); } catch { return { state: null, retry: false }; }
  if (stamp(after) !== beforeStamp) return { state: null, retry: true };
  return { state: { file, session, size, stamp: beforeStamp, prefix, entries }, retry: false };
}

export type PiDeliveryCapture = { anchor: PiDeliveryAnchor | null; retry: boolean };

/** Try once to capture Pi's active transcript position, distinguishing a concurrent write from an unreadable transcript. */
export function capturePiDeliveryAnchorAttempt(path: string, allowMissing = false, expectedSession?: string): PiDeliveryCapture {
  const result = snapshot(path), state = result.state;
  if (state === null) return { anchor: allowMissing && expectedSession && fileId(path) === null
    ? { path, file: null, session: expectedSession, leaf: null, size: 0, prefix: createHash("sha256").digest("hex") } : null, retry: result.retry };
  if (expectedSession !== undefined && state.session !== expectedSession) return { anchor: null, retry: false };
  return { anchor: { path, file: state.file, session: state.session, leaf: state.entries.at(-1)?.id ?? null, size: state.size, prefix: state.prefix }, retry: false };
}

/** Capture the exact active Pi transcript position before Ovis types Enter. */
export function capturePiDeliveryAnchor(path: string, allowMissing = false, expectedSession?: string): PiDeliveryAnchor | null {
  return capturePiDeliveryAnchorAttempt(path, allowMissing, expectedSession).anchor;
}

/** Retry only snapshots invalidated by a concurrent write. An unreadable transcript fails at once. */
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
 * correlator: Pi does not expose a submission id in its TUI or transcript.
 */
export function matchPiDeliveries(path: string, candidates: readonly PiDeliveryCandidate[], consumedEntries = new Set<string>()): { consumed: string[]; changed: string[]; retry: boolean } {
  if (candidates.length === 0) return { consumed: [], changed: [], retry: false };
  const state = snapshot(path).state;
  if (state === null) return { consumed: [], changed: [], retry: true };
  const consumed: string[] = [], changed: string[] = [];
  const matchedEntries: string[] = [];
  const entryKey = (entry: BranchEntry): string => JSON.stringify([path, state.file, state.session, entry.id]);
  let afterMatched = -1;
  for (const candidate of candidates) {
    const { anchor } = candidate;
    if (anchor.path !== path || (anchor.file !== null && anchor.file !== state.file)
      || anchor.session !== state.session) {
      changed.push(candidate.id);
      continue;
    }
    const prefix = digestPrefix(path, anchor.size, state.stamp);
    if (prefix === null) return { consumed: [], changed: [], retry: true };
    if (prefix !== anchor.prefix) {
      changed.push(candidate.id);
      continue;
    }
    const baseline = anchor.leaf === null ? -1 : state.entries.findIndex((entry) => entry.id === anchor.leaf);
    if (anchor.leaf !== null && baseline < 0) {
      changed.push(candidate.id);
      continue;
    }
    const from = Math.max(baseline + 1, afterMatched + 1);
    const match = state.entries.findIndex((entry, index) => index >= from && entry.start >= anchor.size && entry.role === "user" && entry.text === candidate.text && !consumedEntries.has(entryKey(entry)));
    if (match < 0) break;
    consumed.push(candidate.id);
    matchedEntries.push(entryKey(state.entries[match]!));
    afterMatched = match;
  }
  for (const key of matchedEntries) consumedEntries.add(key);
  return { consumed, changed, retry: false };
}
