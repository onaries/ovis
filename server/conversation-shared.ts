import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync } from "node:fs";

import type { ConversationMetadata, ConversationTurn } from "../shared/protocol.ts";

/**
 * A transcript is read a page at a time, the newest page re-read on every append
 * while an agent works: Codex rollouts reach hundreds of MB (a 400MB one took 1.1s
 * and 1.7GB of memory to parse whole). 16MB still holds dozens of turns of a
 * tool-heavy session; the chat asks for the pages before it as the reader scrolls up.
 */
export const TRANSCRIPT_WINDOW_BYTES = 16 * 1024 * 1024;

export const COPILOT_STORE_DIAGNOSTICS = [
  "copilot_store_unproved", "copilot_process_unproved", "copilot_reader_capacity",
  "copilot_log_unreadable", "copilot_log_missing", "copilot_log_ambiguous", "copilot_log_replaced",
  "copilot_log_truncated", "copilot_log_gap", "copilot_log_metadata_changed", "copilot_log_rewritten",
  "copilot_log_limit", "copilot_log_read_raced", "copilot_log_partial", "copilot_session_unregistered",
  "copilot_marker_unreadable", "copilot_marker_missing", "copilot_marker_ambiguous",
  "copilot_session_directory_unproved",
] as const;
export const COPILOT_UNAVAILABLE_REASONS = [
  ...COPILOT_STORE_DIAGNOSTICS,
  "copilot_report_invalid", "copilot_process_lookup_failed", "copilot_process_set_unproved",
  "copilot_peer_process_replaced", "copilot_handoff_unproved", "copilot_peer_conflict",
  "copilot_foreground_unproved", "copilot_resume_unproved",
  "copilot_report_missing", "copilot_report_mismatch", "copilot_transcript_unreadable",
  "copilot_api_unsupported_platform", "copilot_api_process_unproved", "copilot_api_endpoint_unproved",
  "copilot_api_process_changed", "copilot_api_rpc_failed", "copilot_api_rpc_timeout",
  "copilot_api_malformed_rpc", "copilot_api_rpc_rejected", "copilot_api_unsupported_protocol",
  "copilot_api_foreground_changed", "copilot_api_no_foreground", "copilot_api_transcript_unproved",
] as const;
/** Copilot evidence that the pane's conversation ended or moved on; any other rejection may be waited out. */
const COPILOT_SETTLED = new Set<string>(["copilot_session_unregistered", "copilot_peer_conflict", "copilot_report_mismatch",
  // the --ui-server API answered that no session, or another one, holds the foreground
  "copilot_api_no_foreground", "copilot_api_foreground_changed"]);
export const copilotRecoverable = (diagnostic: string | undefined): boolean =>
  diagnostic !== undefined && diagnostic.startsWith("copilot_") && !COPILOT_SETTLED.has(diagnostic);
/** Fixed stages a diagnostic may name: Copilot's rejections, and an agent pane herdr gives no folder. */
export const UNAVAILABLE_DIAGNOSTICS = [...COPILOT_UNAVAILABLE_REASONS, "agent_cwd_missing", "devin_current_session_unverified"] as const;

export class ConversationUnavailable extends Error {
  /** `screen`: the model and effort the agent's own live status line states (start-screen.ts), for the scrollback standing in */
  /** `hint`: what the user could change for the pane to be read (ConversationResponse.hint) */
  constructor(reason: string, readonly screen?: ConversationMetadata, readonly diagnostic?: typeof UNAVAILABLE_DIAGNOSTICS[number], readonly hint?: "copilot_ui_server") {
    super(reason);
    this.name = "ConversationUnavailable";
  }
}

/** A read failed, but the pane still proves the same current conversation: retain the view and retry. */
export class ConversationReadPending extends Error {
  constructor() {
    super("The conversation could not be read; try again shortly.");
    this.name = "ConversationReadPending";
  }
}

/**
 * A file as it was authorized: its device and inode, exact (bigint, as a bigint stat gives them) or as numbers,
 * which round 64-bit file indexes (Windows') and so tell only as much as a number stat does.
 */
export interface FileIdentity { dev: number | bigint; ino: number | bigint }

/** Whether `opened` is the file `identity` names: exactly where both are bigint, else as numbers. */
function sameFile(identity: FileIdentity, opened: FileIdentity): boolean {
  const same = (a: number | bigint, b: number | bigint) => typeof a === "bigint" && typeof b === "bigint" ? a === b : Number(a) === Number(b);
  return same(identity.dev, opened.dev) && same(identity.ino, opened.ino);
}

/**
 * The files the synchronous read in progress is bound to, by path, each as it was authorized. An open of
 * one that finds another file there (a folder swapped in around that open alone) is refused, so no bytes
 * behind an answer come from a file nobody authorized (#3382). Null outside readBound.
 */
let boundFiles: Map<string, FileIdentity> | null = null;

/** `read` with `files` bound (boundFiles) until it returns; a path an enclosing read bound keeps its binding. */
export function readBound<T>(files: readonly (readonly [string, FileIdentity])[], read: () => T): T {
  const outer = boundFiles;
  boundFiles = new Map(outer ?? []);
  for (const [path, identity] of files) bindFile(path, identity);
  try { return read(); } finally { boundFiles = outer; }
}

/**
 * `steps`, a reader that awaits between its steps, with `files` bound as readBound binds them through every
 * step, after each await too; a file one step binds (bindFile) stays bound for the steps after it.
 */
export function* boundSteps<T>(files: readonly (readonly [string, FileIdentity])[], steps: Generator<void | Promise<void>, T, void>): Generator<void | Promise<void>, T, void> {
  // the map readBound builds: the enclosing bindings and `files`
  const bound = readBound(files, () => boundFiles!);
  let failed: { error: unknown } | undefined;
  for (;;) {
    const outer = boundFiles;
    boundFiles = bound;
    let step: IteratorResult<void | Promise<void>, T>;
    try { step = failed === undefined ? steps.next() : steps.throw(failed.error); }
    finally { boundFiles = outer; }
    failed = undefined;
    if (step.done) return step.value;
    // a read that fails fails where the steps wait for it, so their own cleanup runs
    try { yield step.value; } catch (error) { failed = { error }; }
  }
}

/** Binds `path` for the rest of the enclosing readBound, unless it is bound already; nothing outside one. */
export function bindFile(path: string, identity: FileIdentity): void {
  if (boundFiles !== null && !boundFiles.has(path)) boundFiles.set(path, { dev: identity.dev, ino: identity.ino });
}

/** Refuses `fd`, opened from `path`, when `path` is bound to another file: the read is pending. */
export function checkBound(path: string, fd: number): void {
  if (boundFiles?.has(path) === true) checkBoundFile(path, fstatSync(fd, { bigint: true }));
}

/** Refuses `opened`, a file opened from `path` (its stats), when `path` is bound to another file: the read is pending. */
export function checkBoundFile(path: string, opened: FileIdentity): void {
  const identity = boundFiles?.get(path);
  if (identity !== undefined && !sameFile(identity, opened)) throw new ConversationReadPending();
}

/**
 * openSync of `path`, closed and refused where it is bound to another file (checkBound). O_NONBLOCK: a FIFO
 * put there is opened at once, for the check to refuse, never waited on.
 */
export function openBound(path: string, flags: number | string = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)): number {
  const fd = openSync(path, flags);
  try { checkBound(path, fd); } catch (error) { closeSync(fd); throw error; }
  return fd;
}

/** The pane's agent holds a session it has not written yet: a conversation with no turns, not a missing one. */
export class ConversationNotStarted extends ConversationUnavailable {
  constructor(readonly sessionId: string, readonly source: RecognizedConversation["source"] = "omo-transcript", readonly identity: string = sessionId) {
    super("session_not_written");
    this.name = "ConversationNotStarted";
  }
}

/** A cursor from another transcript: the pane started a new session, or a Codex backtrack replaced the file. */
export class HistoryChanged extends Error {
  constructor() {
    super("the conversation's transcript changed; reload it from its newest turns");
    this.name = "HistoryChanged";
  }
}

/** What paneConversation resolved: which store the turns came from, and where they start. */
export type RecognizedConversation = {
  manual_session_id?: string;
  activity?: "thinking" | "working" | "idle";
  source: "dsh-transcript" | "kiro-transcript" | "copilot-transcript" | "grok-transcript" | "agy-transcript" | "muse-transcript" | "letta-transcript" | "kimi-transcript" | "claude-transcript" | "omp-transcript" | "omo-transcript" | "gjc-transcript" | "pi-transcript" | "cmd-transcript" | "codex-transcript" | "devin-transcript" | "opencode-transcript" | "hermes-transcript";
  turns: ConversationTurn[];
  metadata: ConversationMetadata;
  /** `metadata` was read off the agent's own screen (ConversationResponse.screen) */
  screen?: true;
  /** the first turn's position, for the page before it; null at the conversation's beginning */
  cursor: string | null;
  /**
   * Turns the file holds on paths a `/tree` walked away from, which no page of this conversation
   * can reach; absent for every agent that keeps no entry tree. pi moves its leaf without writing
   * anything, so the chat would otherwise drop those turns with no sign they were ever there.
   */
  abandoned?: { count: number; branches: number; summary: string | null };
  /** the transcript file's size in bytes (ConversationResponse.transcript_bytes) */
  transcript_bytes?: number;
  history_id: string;
  /** changes whenever the answer could: the route's ETag, so an unchanged poll costs no body */
  version: string;
};

/** The stores read as one append-only file: OpenCode's and Devin's databases are paged by opencode.ts and devin.ts. */
export type StreamSource = Exclude<RecognizedConversation["source"], "opencode-transcript" | "devin-transcript" | "hermes-transcript" | "dsh-transcript" | "kiro-transcript">;

/** A restart may parse the same files differently: its answers never match an earlier ETag. */
const PROCESS_VERSION = randomUUID();

export function answerVersion(key: string, signature: string): string {
  return createHash("sha256").update(`${PROCESS_VERSION}\0${key}\0${signature}`).digest("base64url").slice(0, 22);
}

/**
 * Which turns: without `before`, the newest page (with `from`, from that held start
 * while it is still inside the newest page); with `before`, the page ending there,
 * never reaching back past `since`.
 */
export type ConversationPage = {
  before?: string; since?: string; from?: string; history_id?: string;
  /** Prompts per page, when the reader asks for a page size (bounded by the server's own cap). */
  prompts?: number;
};
