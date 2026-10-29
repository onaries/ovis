/**
 * OpenCode's own session store, read-only (2.0.24).
 *
 * OpenCode 2 keeps every session in one SQLite database, written by its background service
 * (`opencode serve --service`) rather than by the TUI in the pane: `<data dir>/opencode.db`, the
 * data dir being `$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode` (on macOS too), and
 * `OPENCODE_DB` naming another file, relative to the data dir (what `opencode debug paths` prints).
 * The service is started with the user's environment, so this server's environment finds it; the
 * pane's process environment would not. A session is a `session_v2` row and its conversation the
 * `session_message` rows of its id, ordered by `seq`, each a `type` and a JSON `data`. OpenCode 1.x
 * wrote `session`/`message`/`part` instead (2.0 copies them into `session_v2` when it migrates); a
 * store without `session_v2` is read by the 1.x reader at the foot of this file, which folds the same
 * turns, and keeps the terminal only when neither table set is there.
 *
 * herdr's OpenCode integration reports the session the TUI shows (`herdr:opencode`, kind `id`),
 * so a pane is bound by that id, never by a guess from its cwd.
 *
 * A page is a range of `seq`, so a cursor names a row and stays valid while rows are appended.
 * A row is rewritten in place while its step streams (`time_updated` moves). `/undo` hides the
 * rows from a message on (`session_v2.revert`), which changes the history id, until the next
 * prompt deletes them. `seq` is never handed out again: a row's `seq` is its event's sequence
 * number, which `Bus.publish` takes as `event_sequence.seq + 1` under a per-session lock and
 * `Bus.reserveSequence` only raises, and the revert commit deletes `session_message` rows without
 * touching `event_sequence` (read from 2.0.24). So a cursor naming a deleted row is refused, and a
 * chat holding pages from before the deletion reloads.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ConversationMetadata, ConversationPart, ConversationTurn, HerdrPane, SkillActivity } from "../shared/protocol.ts";
import { opencodeSkillInvocation } from "./skill-invocations/opencode.ts";
import { trimOutput } from "./tool-output.ts";
import { MAX_TURNS, OMO_TASK_RESULT_MAX, toolSummary } from "./transcript-records.ts";

/** A page never holds more prompts than this (each opens a user + assistant pair). */
const MAX_PAGE_PROMPTS = MAX_TURNS / 2;
/** The newest page is read on every poll while the agent works: at most this much of the store. */
export const OPENCODE_WINDOW_BYTES = 16 * 1024 * 1024;
/** A notice carries its whole text on every poll: a `!` command's output is cut here. */
const NOTICE_CHARS = 16_000;
/** The service may hold the write lock for a moment; a read waits this long, never more. */
const BUSY_TIMEOUT_MS = 250;

const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const MESSAGE_ID = /^msg_[A-Za-z0-9]{1,64}$/;
/** A tool call's whole output: the message holding it and the call's place in its content. */
export const OPENCODE_TOOL_REF = /^(msg_[A-Za-z0-9]{1,64}):(\d{1,4})$/;
/** An image in a message, by its place among that message's images. */
export const OPENCODE_IMAGE_REF = /^opencode:(msg_[A-Za-z0-9]{1,64}):(\d{1,3})$/;
/** The image types a chat shows; anything else stays out of the page. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const iso = (value: unknown): string | null => typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
/** A skill's name as the chat shows it on a chip: one short line. */
const skillName = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\r\n<>]/.test(value) ? value : null;
const cut = (value: string): string => value.length > NOTICE_CHARS ? `${value.slice(0, NOTICE_CHARS)}\n… trimmed` : value;

/** The database OpenCode writes to, by the rules it reads its own paths by; null for an in-memory one. */
export function opencodeDatabasePath(env: Record<string, string | undefined> = process.env, home = homedir()): string | null {
  const named = env["OPENCODE_DB"];
  if (named === ":memory:") return null;
  const data = join(env["XDG_DATA_HOME"] || join(home, ".local", "share"), "opencode");
  return named ? resolve(data, named) : join(data, "opencode.db");
}

/** The session herdr's OpenCode integration reported for the pane, or null for any other report. */
export function opencodeSessionId(pane: Pick<HerdrPane, "agent_session">): string | null {
  const session = pane.agent_session;
  if (session?.agent !== "opencode" || session.source !== "herdr:opencode" || session.kind !== "id" || !SESSION_ID.test(session.value)) return null;
  return session.value;
}

/** One `session_message` row as the chat needs it: no image bytes, tool outputs already cut. */
export type OpencodeRecord =
  | { role: "user"; ts: string | null; parts: ConversationPart[] }
  | { role: "assistant"; ts: string | null; end: string | null; parts: ConversationPart[]; stop: boolean }
  | { role: "idle" };

/** The images a row carries, in the order its refs count them. Only inline data: a path is never followed. */
function rowImages(type: string, data: Row): { media_type: string; data: string }[] {
  const images: { media_type: string; data: string }[] = [];
  const add = (value: unknown) => {
    const file = record(value);
    const uri = typeof file.uri === "string" ? /^data:([\w.+/-]+);base64,(.*)$/s.exec(file.uri) : null;
    const type = uri?.[1] ?? file.mime;
    const base64 = uri?.[2] ?? (record(file.source).type === "inline" ? file.data : undefined);
    if (typeof type === "string" && IMAGE_TYPES.has(type) && typeof base64 === "string" && base64.length > 0) images.push({ media_type: type, data: base64 });
  };
  if (type === "user") (Array.isArray(data.files) ? data.files : []).forEach(add);
  if (type === "assistant") {
    for (const block of (Array.isArray(data.content) ? data.content : []).map(record)) {
      if (block.type !== "tool") continue;
      for (const item of (Array.isArray(record(block.state).content) ? record(block.state).content as unknown[] : []).map(record)) if (item.type === "file") add(item);
    }
  }
  return images;
}

/** A tool's own output: its error, else the text it returned (a subagent's answer without the tag around it). */
function toolText(state: Row, name: string): string {
  if (state.status === "error") return text(record(state.error).message) ?? "";
  const output = (Array.isArray(state.content) ? state.content : []).map(record)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string).join("\n");
  return name === "subagent" ? unwrap(output) : output;
}

/** OpenCode's `skill` tool names the skill it loads by `id` (1.x: `name`). */
function toolSkill(name: string, input: Row, status: unknown): SkillActivity | null {
  if (name !== "skill") return null;
  const skill = skillName(input.id) ?? skillName(input.name);
  if (skill === null) return null;
  return { name: skill, evidence: "invocation", status: status === "completed" ? "loaded" : status === "error" ? "failed" : "requested" };
}

/** `<shell …>…</shell>` and `<subagent …>…</subagent>` wrap what OpenCode hands back to its model. */
function unwrap(body: string): string {
  const match = /^<(shell|subagent)\b[^>]*>\n?([\s\S]*?)\n*<\/\1>\s*$/.exec(body.trim());
  return (match?.[2] ?? body).trim();
}

/** One row as the chat shows it, or null for one it does not (instructions, agent switches, …). */
export function opencodeRecord(id: string, type: string, data: Row): OpencodeRecord | null {
  const time = record(data.time);
  if (type === "user") {
    const images = rowImages(type, data).map((image, index): ConversationPart => ({ kind: "image", media_type: image.media_type, ref: `opencode:${id}:${index}` }));
    const display = text(record(data.metadata).displayText);
    const raw = text(data.text);
    const prompt = display ?? (raw === null ? null : opencodeSkillInvocation(raw));
    // a skill the prompt mentions (`@name`) is loaded with it: the chip says so, the text keeps the mention
    const skills = (Array.isArray(data.skills) ? data.skills : []).map(record).flatMap((skill): ConversationPart[] => {
      const name = skillName(skill.name) ?? skillName(skill.id);
      return name === null ? [] : [{ kind: "skill", skill: { name, evidence: "instructions", status: "loaded" } }];
    });
    const parts = [...images, ...(prompt === null ? [] : [{ kind: "text" as const, text: prompt }]), ...skills];
    return parts.length === 0 ? null : { role: "user", ts: iso(time.created), parts };
  }
  if (type === "assistant") {
    const parts: ConversationPart[] = [];
    let image = 0;
    (Array.isArray(data.content) ? data.content : []).forEach((value, index) => {
      const block = record(value);
      if (block.type === "text" && text(block.text) !== null) parts.push({ kind: "text", text: block.text as string });
      else if (block.type === "reasoning" && text(block.text) !== null) parts.push({ kind: "thinking", text: block.text as string });
      else if (block.type === "tool" && typeof block.name === "string") {
        const state = record(block.state);
        const input = record(state.input);
        const skill = toolSkill(block.name, input, state.status);
        const summary = toolSummary(block.name, input);
        const part: Extract<ConversationPart, { kind: "tool" }> = {
          kind: "tool",
          name: block.name,
          // a web search names its query, which the shared summary does not look for
          summary: skill?.name ?? (summary === block.name && typeof input.query === "string" ? input.query.slice(0, 120) : summary),
          input: JSON.stringify(input, null, 2),
          output: "",
        };
        if (skill !== null) part.skill = skill;
        trimOutput(part, toolText(state, block.name), `${id}:${index}`);
        const exit = record(state.metadata).exit;
        if (state.status === "error" || (typeof exit === "number" && exit !== 0)) part.error = true;
        const files = (Array.isArray(state.content) ? state.content : []).map(record).filter((item) => item.type === "file");
        const shown = files.length === 0 ? [] : rowImages("assistant", { content: [block] });
        if (shown.length > 0) part.images = shown.map((found) => ({ media_type: found.media_type, ref: `opencode:${id}:${image++}` }));
        parts.push(part);
      }
    });
    const error = record(data.error);
    // Esc ends a step as `aborted`: the TUI says it was interrupted, not that anything failed
    if (error.type !== "aborted" && text(error.message) !== null) parts.push({ kind: "text", text: `Error: ${error.message as string}` });
    const end = iso(time.completed) ?? iso(time.streamed) ?? iso(time.created);
    return { role: "assistant", ts: iso(time.created), end, parts, stop: data.finish === "stop" };
  }
  if (type === "idle") return { role: "idle" };
  // a command the user ran with `!`: it sits in the user's seat, with what it printed
  if (type === "shell" && typeof data.command === "string") {
    const output = record(data.output).output;
    const printed = typeof output === "string" && output.length > 0 ? `\n${output.replace(/[\r\n]+$/, "")}` : "";
    return { role: "user", ts: iso(time.created), parts: [{ kind: "notice", text: cut(`$ ${data.command}${printed}`), source: "shell" }] };
  }
  // what OpenCode put in the user's seat to wake its model: a background job's or subagent's
  // result, a restart. A `!` command is echoed this way too, with no job: its shell row shows it.
  if (type === "synthetic") {
    const metadata = record(data.metadata);
    if (metadata.source === "shell" && metadata.jobID === undefined) return null;
    const body = typeof data.text === "string" ? unwrap(data.text) : "";
    const label = text(data.description)?.trim() ?? null;
    // a background subagent that ended (SubagentCompletion.deliver in 2.0.32): its card, with its answer
    if (metadata.source === "subagent") {
      const agent = text(metadata.agent)?.trim() ?? null;
      const status = metadata.state === "error" ? "failed" as const : metadata.state === "cancelled" ? "cancelled" as const : "completed" as const;
      return { role: "user", ts: iso(time.created), parts: [{ kind: "task_result", tasks: [{
        id: text(metadata.childID) ?? id, title: label ?? agent ?? "subagent", agent, model: null, status,
        duration_ms: null, turns: null, tool_calls: null, tokens: null,
        result: body.slice(0, OMO_TASK_RESULT_MAX), ...(body.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {}),
      }] }] };
    }
    const shown = label !== null && body.length > 0 && body !== label ? `${label}\n${body}` : label ?? body;
    if (shown.length === 0) return null;
    const source = text(metadata.source) ?? text(metadata.notice) ?? "synthetic";
    return { role: "user", ts: iso(time.created), parts: [{ kind: "notice", text: cut(shown), source }] };
  }
  if (type === "compaction" && data.status === "completed" && text(data.summary) !== null) {
    return { role: "user", ts: iso(time.created), parts: [{ kind: "compact", text: data.summary as string }] };
  }
  return null;
}

/**
 * Records in `seq` order -> turns. A model step is a row of its own, so consecutive steps merge
 * into one assistant turn, until the turn ends: OpenCode marks that with an `idle` row, and a step
 * that finished with `stop` is the turn's answer. Whatever woke the model after it (a background
 * result, a restart) starts a turn of its own instead of folding that answer into the next work.
 */
export function opencodeTurns(records: readonly (OpencodeRecord | null)[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let settled = false;
  for (const entry of records) {
    if (entry === null) continue;
    if (entry.role === "idle") { settled = true; continue; }
    if (entry.role === "user") { turns.push({ role: "user", ts: entry.ts, parts: [...entry.parts] }); settled = false; continue; }
    let turn = turns[turns.length - 1];
    if (turn === undefined || turn.role !== "assistant" || settled) {
      turn = { role: "assistant", ts: entry.ts, parts: [] };
      turns.push(turn);
    }
    turn.parts.push(...entry.parts.map((part, index) => entry.stop && index === entry.parts.length - 1 && part.kind === "text"
      ? { ...part, phase: "final_answer" as const } : part));
    if (entry.end !== null) turn.end_ts = entry.end;
    settled = entry.stop;
  }
  return turns.filter((turn) => turn.parts.length > 0);
}

/** One row of a page, without its data: what choosing the page's start needs. */
export interface RowMeta { id: string; seq: number; type: string; updated: number; size: number }

/**
 * Where the page ending before `rows` (newest first) starts: at the prompt `pagePrompts` back,
 * else at the earliest prompt inside the window, else at `floor` when the window reaches it. With
 * no prompt in the window the newest page starts mid-turn, at a whole row; an older page is read
 * once, so it reaches further back for one, up to four windows.
 */
export function pageStart(rows: Iterable<RowMeta>, floor: number, widen: boolean, window = OPENCODE_WINDOW_BYTES, pagePrompts = MAX_PAGE_PROMPTS): number {
  let bytes = 0;
  let prompts = 0;
  let earliest: number | undefined;
  let newer: number | undefined;
  for (const row of rows) {
    bytes += row.size;
    if (bytes > (widen && earliest === undefined ? 4 * window : window)) return earliest ?? newer ?? row.seq;
    if (row.type === "user") {
      earliest = row.seq;
      if (++prompts === pagePrompts) return row.seq;
    }
    newer = row.seq;
  }
  return floor;
}

/** The page asked for: as conversation.ts's ConversationPage. */
export type OpencodePage = { before?: string; since?: string; from?: string; prompts?: number };

/** The prompts a page keeps: the reader's choice inside MAX_PAGE_PROMPTS, else MAX_PAGE_PROMPTS. */
function pagePrompts(page: OpencodePage): number {
  const asked = page.prompts;
  return typeof asked === "number" && Number.isFinite(asked) ? Math.min(MAX_PAGE_PROMPTS, Math.max(1, Math.floor(asked))) : MAX_PAGE_PROMPTS;
}

export type OpencodeAnswer =
  | { kind: "unavailable"; reason: string }
  | { kind: "history_changed" }
  | { kind: "page"; turns: ConversationTurn[]; metadata: ConversationMetadata; cursor: string | null; history_id: string; signature: string };

/**
 * Per session: the newest page's rows as records, kept by row id while their `time_updated` and
 * size hold. Every update of a row moves its `time_updated` (OpenCode's timestamp columns are
 * `$onUpdate(Date.now)`), but two writes in one millisecond leave it where it was: the size tells
 * those apart too.
 */
const newestRecords = new Map<string, Map<string, { updated: number; size: number; record: OpencodeRecord | null }>>();
/** Per page asked for: the answer, while the session's signature holds. */
const answers = new Map<string, { signature: string; answer: Extract<OpencodeAnswer, { kind: "page" }> }>();

function remember<T>(map: Map<string, T>, key: string, value: T, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

/** Forget every answer and record kept between polls (tests compare against a cold read). */
export function forgetOpencodeState(): void {
  newestRecords.clear();
  answers.clear();
  settings.clear();
}

/** What every cache here is keyed by: a pane's chat is remembered against it (conversation.ts `rememberPaneRead`). */
export const opencodeReadKey = (path: string, sessionId: string): string => `${path}\0${sessionId}`;

/** Drop what one session's chat kept, when the last pane reading it closes; any other key is not one of these. */
export function forgetOpencodeRead(key: string): void {
  newestRecords.delete(key);
  for (const map of [answers, settings]) for (const entry of [...map.keys()]) if (entry.startsWith(`${key}\0`)) map.delete(entry);
}

/** The store, read-only; null when it cannot be opened (no file, not SQLite, not readable). */
function openStore(path: string, busyMs: number): Database | null {
  try {
    const db = new Database(path, { readonly: true, create: false });
    db.exec(`PRAGMA busy_timeout = ${busyMs}`);
    return db;
  } catch { return null; }
}

/** `busyMs`: how long a read waits on a store held by its writer; a poll that runs on the event loop waits not at all. */
export function withStore<T>(path: string, read: (db: Database) => T, busyMs = BUSY_TIMEOUT_MS): T | null {
  const db = openStore(path, busyMs);
  if (db === null) return null;
  try { return read(db); }
  finally { db.close(); }
}

/** A store this reader cannot use (1.x tables, not a database at all), as opposed to one busy for a moment. */
function unusable(error: unknown): boolean {
  return error instanceof Error && (/no such (table|column)/.test(error.message) || (error as { code?: unknown }).code === "SQLITE_NOTADB");
}

/**
 * A store held past the busy timeout. OpenCode runs its store in WAL, where a reader waits only
 * while the store recovers after a crash; a store in another journal mode waits on any writer.
 */
function busy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}

interface SessionView {
  /** one past the last row the chat shows: a staged `/undo` hides the rows from its message on */
  end: number;
  historyId: string;
  signature: string;
}

/** The session's visible extent, its history id and what any change to it changes. */
function sessionView(db: Database, sessionId: string): SessionView | null {
  const session = db.query<{ revert: string | null }, [string]>("SELECT revert FROM session_v2 WHERE id = ?").get(sessionId);
  if (session === null) return null;
  const stats = db.query<{ count: number; last: number | null; updated: number | null }, [string]>(
    "SELECT count(*) AS count, max(seq) AS last, max(time_updated) AS updated FROM session_message WHERE session_id = ?",
  ).get(sessionId)!;
  // read before the page: a row appended meanwhile waits for the next poll, whose signature names it
  let end = (stats.last ?? -1) + 1;
  let revert: unknown = null;
  try { revert = session.revert === null ? null : JSON.parse(session.revert); } catch { /* not JSON: nothing staged */ }
  const boundary = record(revert).messageID;
  if (typeof boundary === "string") {
    const row = db.query<{ seq: number }, [string, string]>("SELECT seq FROM session_message WHERE session_id = ? AND id = ?").get(sessionId, boundary);
    if (row !== null) end = row.seq;
  }
  const historyId = `opencode-${sessionId}${end > (stats.last ?? -1) ? "" : `-r${end.toString(36)}`}`;
  return { end, historyId, signature: `${historyId}:${stats.count}:${stats.last}:${stats.updated}` };
}

/** What a step or `/model` row says about the session's settings, kept while its `time_updated` and size hold. */
const settings = new Map<string, { updated: number; size: number; model: string | null; variant: string | null; tokens: Row | null; completed: boolean }>();

/**
 * Latest recorded settings at `end`, as OpenCode's own footer reads them. The rows are walked from
 * the newest and parsed here: JSON1 is not part of every SQLite Bun may run on (on macOS it uses the
 * system's own), so nothing is asked of SQL beyond the index.
 */
function sessionMetadata(db: Database, key: string, sessionId: string, end: number, measure: OpencodeRowSize): ConversationMetadata {
  const data = db.query<{ data: string }, [string, string]>("SELECT data FROM session_message WHERE id = ? AND session_id = ?");
  // asked of each row walked, not in the walk: it sorts what it selects, and the fallback reads the row
  const sizeOf = db.query<{ size: number }, [string, string]>(ROW_QUERIES[measure].size);
  let setting: { model: string | null; variant: string | null } | null = null;
  let usage: Row | null = null;
  let compacted = false;
  for (const row of db.query<{ id: string; type: string; updated: number }, [string, number]>(
    "SELECT id, type, time_updated AS updated FROM session_message WHERE session_id = ? AND type IN ('assistant', 'model-switched', 'compaction') AND seq < ? ORDER BY seq DESC",
  ).iterate(sessionId, end)) {
    let known = settings.get(`${key}\0${row.id}`);
    const size = sizeOf.get(row.id, sessionId)?.size ?? 0;
    if (known?.updated !== row.updated || known.size !== size) {
      const found = data.get(row.id, sessionId);
      const parsed = found === null ? {} : parseData(found.data);
      const model = record(parsed.model);
      known = {
        updated: row.updated,
        size,
        model: text(model.id),
        variant: text(model.variant),
        tokens: parsed.tokens === undefined ? null : record(parsed.tokens),
        completed: parsed.status === "completed",
      };
      remember(settings, `${key}\0${row.id}`, known, 256);
    }
    if (row.type === "compaction") {
      // the footer counts no step from before a compaction: its usage is gone with it
      if (known.completed && usage === null) compacted = true;
    } else {
      setting ??= { model: known.model, variant: known.variant };
      if (row.type === "assistant" && known.tokens !== null && !compacted) usage ??= known.tokens;
    }
    if (setting !== null && (usage !== null || compacted)) break;
  }
  const metadata: ConversationMetadata = {
    model: setting?.model ?? null,
    // `default` is the model's own reasoning, not a level anyone chose
    reasoning_effort: setting?.variant !== null && setting?.variant !== undefined && setting.variant !== "default" ? setting.variant : null,
  };
  if (usage !== null) {
    const cache = record(usage.cache);
    const used = count(usage.input) + count(usage.output) + count(usage.reasoning) + count(cache.read) + count(cache.write);
    if (used > 0) metadata.context = { used, window: null };
  }
  return metadata;
}

function parseData(data: string): Row {
  try { return record(JSON.parse(data)); } catch { return {}; }
}

/**
 * The row a cursor names, or null for one from another history. Every cursor is the `seq` of a
 * page's first row, and a committed `/undo` deletes every row from its message on: a chat whose
 * pages reach a deleted turn holds a cursor to a deleted row. Reading the store answers that the
 * same way after a restart, which nothing kept in memory could.
 */
function cursorOf(db: Database, sessionId: string, historyId: string, cursor: string, end: number): number | null {
  const separator = cursor.lastIndexOf(":");
  const offset = Number(cursor.slice(separator + 1));
  if (separator <= 0 || cursor.slice(0, separator) !== historyId || !Number.isSafeInteger(offset) || offset < 0 || offset > end) return null;
  if (offset === 0) return offset;
  return db.query<{ seq: number }, [string, number]>("SELECT seq FROM session_message WHERE session_id = ? AND seq = ?").get(sessionId, offset) === null ? null : offset;
}

/**
 * How a row's size in bytes is read. `octet_length` (SQLite 3.43) answers without reading the row;
 * on macOS Bun runs the system's own SQLite, which can be older, and there the bytes are counted.
 */
export const OPENCODE_ROW_SIZE = { octets: "octet_length(data)", bytes: "length(CAST(data AS BLOB))" } as const;
export type OpencodeRowSize = (typeof OPENCODE_ROW_SIZE)[keyof typeof OPENCODE_ROW_SIZE];

let supported: OpencodeRowSize | null = null;
function supportedRowSize(db: Database): OpencodeRowSize {
  if (supported === null) {
    try { db.query("SELECT octet_length('')").get(); supported = OPENCODE_ROW_SIZE.octets; }
    catch { supported = OPENCODE_ROW_SIZE.bytes; }
  }
  return supported;
}

/** The queries that read a row's size, whole for each way of measuring it: no SQL is assembled. */
const ROW_QUERIES: Record<OpencodeRowSize, { page: string; pageDescending: string; size: string }> = {
  [OPENCODE_ROW_SIZE.octets]: {
    page: "SELECT id, seq, type, time_updated AS updated, octet_length(data) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq",
    pageDescending: "SELECT id, seq, type, time_updated AS updated, octet_length(data) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq DESC",
    size: "SELECT octet_length(data) AS size FROM session_message WHERE id = ? AND session_id = ?",
  },
  [OPENCODE_ROW_SIZE.bytes]: {
    page: "SELECT id, seq, type, time_updated AS updated, length(CAST(data AS BLOB)) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq",
    pageDescending: "SELECT id, seq, type, time_updated AS updated, length(CAST(data AS BLOB)) AS size FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq DESC",
    size: "SELECT length(CAST(data AS BLOB)) AS size FROM session_message WHERE id = ? AND session_id = ?",
  },
};

/**
 * One page of the session's conversation (as conversation.ts's transcriptPage, over rows):
 * without `before` the newest page, from `from` while that start is still inside it; with
 * `before` the page ending there, never reaching back past `since`. `rowSize` is how a row is
 * measured, by default the cheapest way this SQLite has.
 */
export function opencodeConversation(path: string, sessionId: string, page: OpencodePage = {}, rowSize?: OpencodeRowSize): OpencodeAnswer {
  if (!SESSION_ID.test(sessionId)) return { kind: "unavailable", reason: "no_session_id" };
  const key = opencodeReadKey(path, sessionId);
  const cacheKey = `${key}\0${page.before ?? ""}\0${page.since ?? ""}\0${page.from ?? ""}\0${pagePrompts(page)}`;
  try {
    const answer = withStore(path, (db): OpencodeAnswer => {
      // A broken or changing 1.x store leaves the terminal as the source of the conversation.
      if (storeFlavor(db) === "v1") {
        try { return conversation1(db, cacheKey, sessionId, page); }
        catch (error) {
          if (busy(error)) return answers.get(`${cacheKey}\0v1`)?.answer ?? { kind: "unavailable", reason: "store_busy" };
          return { kind: "unavailable", reason: "transcript_missing" };
        }
      }
      const view = sessionView(db, sessionId);
      if (view === null) return { kind: "unavailable", reason: "session_not_found" };
      const cached = answers.get(cacheKey);
      if (cached?.signature === view.signature) return cached.answer;

      const end = view.end;
      const measure = rowSize ?? supportedRowSize(db);
      const descending = (from: number, to: number) => db.query<RowMeta, [string, number, number]>(ROW_QUERIES[measure].pageDescending).iterate(sessionId, from, to);
      let start: number;
      let to = end;
      if (page.before !== undefined) {
        const before = cursorOf(db, sessionId, view.historyId, page.before, end);
        const floor = page.since === undefined ? 0 : cursorOf(db, sessionId, view.historyId, page.since, end);
        if (before === null || floor === null || floor > before) return { kind: "history_changed" };
        start = before === floor ? floor : pageStart(descending(floor, before), floor, true, OPENCODE_WINDOW_BYTES, pagePrompts(page));
        to = before;
      } else {
        const held = page.from === undefined ? null : cursorOf(db, sessionId, view.historyId, page.from, end);
        if (page.from !== undefined && held === null) return { kind: "history_changed" };
        const newest = pageStart(descending(0, end), 0, false, OPENCODE_WINDOW_BYTES, pagePrompts(page));
        // a chat that shows older pages keeps every turn after its held start while they are
        // inside the newest page; once the page moved past it, it fetches the turns between
        start = held !== null && held >= newest ? held : newest;
      }

      const records: (OpencodeRecord | null)[] = [];
      if (page.before === undefined) {
        // the newest page is read on every poll while the agent works: only rows that changed are parsed again
        const known = newestRecords.get(key) ?? new Map<string, { updated: number; size: number; record: OpencodeRecord | null }>();
        const kept = new Map<string, { updated: number; size: number; record: OpencodeRecord | null }>();
        const data = db.query<{ data: string }, [string, string]>("SELECT data FROM session_message WHERE id = ? AND session_id = ?");
        for (const row of db.query<RowMeta, [string, number, number]>(ROW_QUERIES[measure].page).iterate(sessionId, start, to)) {
          let entry = known.get(row.id);
          if (entry?.updated !== row.updated || entry.size !== row.size) {
            const found = data.get(row.id, sessionId);
            entry = { updated: row.updated, size: row.size, record: found === null ? null : opencodeRecord(row.id, row.type, parseData(found.data)) };
          }
          kept.set(row.id, entry);
          records.push(entry.record);
        }
        remember(newestRecords, key, kept, 8);
      } else {
        for (const row of db.query<{ id: string; type: string; data: string }, [string, number, number]>(
          "SELECT id, type, data FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq",
        ).iterate(sessionId, start, to)) records.push(opencodeRecord(row.id, row.type, parseData(row.data)));
      }
      const result = {
        kind: "page" as const,
        turns: opencodeTurns(records),
        metadata: sessionMetadata(db, key, sessionId, to, measure),
        cursor: start > 0 ? `${view.historyId}:${start}` : null,
        history_id: view.historyId,
        signature: view.signature,
      };
      remember(answers, cacheKey, { signature: view.signature, answer: result }, 32);
      return result;
    });
    return answer ?? { kind: "unavailable", reason: "transcript_missing" };
  } catch (error) {
    // a 1.x store, or one OpenCode has not finished creating: the terminal stands in for it
    if (unusable(error)) return { kind: "unavailable", reason: "transcript_missing" };
    // a store held for a moment: the chat keeps the page it shows, or the terminal stands in
    // until the next poll, rather than an error in the chat
    if (busy(error)) return answers.get(cacheKey)?.answer ?? { kind: "unavailable", reason: "store_busy" };
    throw error;
  }
}

/** A visible row of the session by id, or null. */
function sessionRow(db: Database, sessionId: string, id: string): { type: string; data: Row } | null {
  const view = db.query<{ revert: string | null }, [string]>("SELECT revert FROM session_v2 WHERE id = ?").get(sessionId);
  if (view === null) return null;
  const row = db.query<{ seq: number; type: string; data: string }, [string, string]>("SELECT seq, type, data FROM session_message WHERE id = ? AND session_id = ?").get(id, sessionId);
  if (row === null) return null;
  // a row an /undo hid is one the chat no longer shows
  let revert: unknown = null;
  try { revert = view.revert === null ? null : JSON.parse(view.revert); } catch { /* nothing staged */ }
  const boundary = record(revert).messageID;
  if (typeof boundary === "string") {
    const hidden = db.query<{ seq: number }, [string, string]>("SELECT seq FROM session_message WHERE session_id = ? AND id = ?").get(sessionId, boundary);
    if (hidden !== null && row.seq >= hidden.seq) return null;
  }
  return { type: row.type, data: parseData(row.data) };
}

function readRow<T>(path: string, sessionId: string, id: string, read: (row: { type: string; data: Row }) => T | null): T | null {
  if (!SESSION_ID.test(sessionId) || !MESSAGE_ID.test(id)) return null;
  try {
    return withStore(path, (db) => {
      const row = storeFlavor(db) === "v1" ? sessionRow1(db, sessionId, id) : sessionRow(db, sessionId, id);
      return row === null ? null : read(row);
    });
  } catch (error) {
    // a store held for a moment has no answer now: the next request finds it, where a failure would stick
    if (unusable(error) || busy(error)) return null;
    throw error;
  }
}

/** The whole output of a tool call whose page output was cut (ref `<message id>:<place in its content>`). */
export function opencodeToolOutput(path: string, sessionId: string, ref: string): string | null {
  const match = OPENCODE_TOOL_REF.exec(ref);
  if (match === null) return null;
  return readRow(path, sessionId, match[1]!, (row) => {
    if (row.type !== "assistant" || !Array.isArray(row.data.content)) return null;
    const block = record(row.data.content[Number(match[2])]);
    return block.type === "tool" && typeof block.name === "string" ? toolText(record(block.state), block.name) : null;
  });
}

/** An image a page named by its ref (`opencode:<message id>:<nth image>`), decoded. */
export function opencodeImage(path: string, sessionId: string, ref: string): { mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const match = OPENCODE_IMAGE_REF.exec(ref);
  if (match === null) return null;
  return readRow(path, sessionId, match[1]!, (row) => {
    const image = rowImages(row.type, row.data)[Number(match[2])];
    return image === undefined ? null : { mediaType: image.media_type, bytes: new Uint8Array(Buffer.from(image.data, "base64")) };
  });
}

/** The OpenCode version that wrote this session (its `version` column, 2.x or 1.x store); null when unknown. */
export function opencodeSessionVersion(path: string, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  try {
    return withStore(path, (db) => {
      const flavor = storeFlavor(db);
      if (flavor === "unknown") return null;
      const table = flavor === "v1" ? "session" : "session_v2";
      const row = db.query<{ version: unknown }, [string]>(`SELECT version FROM ${table} WHERE id = ?`).get(sessionId);
      return typeof row?.version === "string" && row.version !== "" ? row.version : null;
    });
  } catch (error) {
    if (unusable(error) || busy(error)) return null;
    throw error;
  }
}

/* -------------------------------------------------------------------------------------------------
 * OpenCode 1.x: session / message / part
 *
 * Before the 2.x store (2.0.24), OpenCode kept the same conversation in three tables: `session`, and
 * one `message` and several `part` rows per step. 2.0 copies them into `session_v2`/`session_message`
 * when it migrates; a store with no `session_v2` is still 1.x, which the 2.x reader refused (its
 * `session_v2` queries throw `no such table` and the chat fell back to the terminal). This reader
 * reads the same turns from those tables, adapting each message to the row shape `opencodeRecord`
 * already understands so the folding, tool trimming and image refs are the 2.x ones.
 *
 * `message.data.role` is `user` or `assistant`; an assistant step keeps the model (`modelID`) and its
 * usage (`tokens`) on the message and its `text`/`reasoning`/`tool` blocks in `part` rows. There is no
 * `seq`: a message is ordered by `(time_created, id)`, and a page cursor names a message by its place
 * in that order. A `/undo` is `session.revert` (a `{ messageID }`), hiding the rows from it on; the
 * revert commit deletes that suffix, leaving the earlier places unchanged. Read-only, per `session_id`.
 * ----------------------------------------------------------------------------------------------- */

type StoreFlavor = "v2" | "v1" | "unknown";
// The 1.x adapter eagerly joins messages and parts; leave larger stores to the terminal view.
const MAX_V1_ROWS = 10_000;
const MAX_V1_BYTES = 4 * OPENCODE_WINDOW_BYTES;

/** 2.x (`session_v2`), 1.x (`session`/`message`/`part`), or a file this reader cannot page. */
function storeFlavor(db: Database): StoreFlavor {
  const table = (name: string) => db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
  if (table("session_v2")) return "v2";
  if (table("session") && table("message") && table("part")) return "v1";
  return "unknown";
}

/** One 1.x message with its parts, in the order the page reads them. */
interface Message1 {
  id: string;
  data: Row;
  parts: Row[];
  updated: number;
  size: number;
}

/** Every message of a 1.x session with its parts, ordered by `(time_created, id)`: one query per table. */
function loadSession1(db: Database, sessionId: string): Message1[] {
  const parts = new Map<string, Row[]>();
  // the stored bytes are what a page counts, as the 2.x reader counts `octet_length(data)`: parsing
  // each part only to re-serialize it back to JSON for its length is the same number, for nothing
  const partBytes = new Map<string, number>();
  for (const row of db.query<{ message_id: string; data: string }, [string]>(
    "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id",
  ).iterate(sessionId)) {
    const list = parts.get(row.message_id) ?? [];
    list.push(parseData(row.data));
    parts.set(row.message_id, list);
    partBytes.set(row.message_id, (partBytes.get(row.message_id) ?? 0) + Buffer.byteLength(row.data, "utf8"));
  }
  const messages: Message1[] = [];
  for (const row of db.query<{ id: string; updated: number; data: string }, [string]>(
    "SELECT id, time_updated AS updated, data FROM message WHERE session_id = ? ORDER BY time_created, id",
  ).iterate(sessionId)) {
    const own = parts.get(row.id) ?? [];
    const size = Buffer.byteLength(row.data, "utf8") + (partBytes.get(row.id) ?? 0);
    messages.push({ id: row.id, data: parseData(row.data), parts: own, updated: row.updated, size });
  }
  return messages;
}

/** A 1.x message's error (a name plus a `data.message`) as the `type`/`message` the 2.x reader shows. */
function adaptMessageError1(value: unknown): Row | undefined {
  const error = record(value);
  if (Object.keys(error).length === 0) return undefined;
  const name = typeof error.name === "string" ? error.name : "";
  const message = text(record(error.data).message) ?? text(error.message);
  return { type: /abort/i.test(name) ? "aborted" : name || "error", message: message ?? "" };
}

/** A 1.x tool error (a plain string) as the `{ message }` the 2.x writer carries. */
const adaptToolError1 = (value: unknown): unknown => typeof value === "string" && value.length > 0 ? { message: value } : value;

/** A 1.x message and its parts as the 2.x row shape `opencodeRecord` reads, or null for one it shows nothing of. */
function adaptMessage1(message: Message1): { type: string; data: Row } | null {
  const role = message.data.role;
  if (role === "user") {
    const prompt = message.parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n");
    // a picture pasted in the prompt is a `file` part: its 1.x `url` is the 2.x `uri` `rowImages` reads
    const files = message.parts.filter((part) => part.type === "file" && typeof part.url === "string")
      .map((part) => ({ type: "file", uri: part.url, mime: part.mime }));
    return { type: "user", data: { time: message.data.time, text: prompt, files, skills: [] } };
  }
  if (role !== "assistant") return null;
  const content: Row[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
    else if (part.type === "reasoning" && typeof part.text === "string") content.push({ type: "reasoning", text: part.text });
    else if (part.type === "tool" && typeof part.tool === "string") {
      const state = record(part.state);
      const metadata = record(state.metadata);
      const printed = typeof state.output === "string" && state.output.length > 0 ? state.output : typeof metadata.output === "string" ? metadata.output : "";
      const result: Row[] = printed.length === 0 ? [] : [{ type: "text", text: printed }];
      for (const value of (Array.isArray(state.attachments) ? state.attachments : []).map(record)) {
        if (value.type === "file") result.push({ type: "file", uri: value.url, mime: value.mime });
      }
      content.push({ type: "tool", name: part.tool, state: { status: state.status, input: state.input, content: result, error: adaptToolError1(state.error), metadata: state.metadata } });
    }
  }
  return { type: "assistant", data: { time: message.data.time, content, finish: message.data.finish, error: adaptMessageError1(message.data.error), tokens: message.data.tokens } };
}

/** The 1.x session's own view: what a `/undo` hides, and what any change to the store changes. */
function sessionView1(db: Database, sessionId: string): (SessionView & { rows: number }) | null {
  const session = db.query<{ revert: string | null }, [string]>("SELECT revert FROM session WHERE id = ?").get(sessionId);
  if (session === null) return null;
  const stats = db.query<{ count: number; updated: number | null; parts: number; partUpdated: number | null }, [string, string, string, string]>(
    "SELECT (SELECT count(*) FROM message WHERE session_id = ?) AS count, (SELECT max(time_updated) FROM message WHERE session_id = ?) AS updated, (SELECT count(*) FROM part WHERE session_id = ?) AS parts, (SELECT max(time_updated) FROM part WHERE session_id = ?) AS partUpdated",
  ).get(sessionId, sessionId, sessionId, sessionId)!;
  let end = stats.count;
  let revert: unknown = null;
  try { revert = session.revert === null ? null : JSON.parse(session.revert); } catch { /* not JSON: nothing staged */ }
  const boundary = record(revert).messageID;
  if (typeof boundary === "string") {
    const row = db.query<{ time_created: number }, [string, string]>("SELECT time_created FROM message WHERE id = ? AND session_id = ?").get(boundary, sessionId);
    if (row !== null) {
      end = db.query<{ count: number }, [string, number, number, string]>(
        "SELECT count(*) AS count FROM message WHERE session_id = ? AND (time_created < ? OR (time_created = ? AND id < ?))",
      ).get(sessionId, row.time_created, row.time_created, boundary)!.count;
    }
  }
  const historyId = `opencode-${sessionId}${end === stats.count ? "" : `-r${end.toString(36)}`}`;
  return { end, historyId, signature: `${historyId}:${stats.count}:${stats.updated}:${stats.parts}:${stats.partUpdated}`, rows: stats.count + stats.parts };
}

/** The settings OpenCode's footer shows for a 1.x session: the latest step's model and usage at `end`. */
function sessionMetadata1(messages: readonly Message1[], end: number): ConversationMetadata {
  let model: string | null = null;
  let usage: Row | null = null;
  for (let index = end - 1; index >= 0; index--) {
    const data = messages[index]!.data;
    if (data.role !== "assistant") continue;
    if (model === null) model = text(data.modelID);
    if (usage === null && data.tokens !== undefined) usage = record(data.tokens);
    if (model !== null && usage !== null) break;
  }
  const metadata: ConversationMetadata = { model, reasoning_effort: null };
  if (usage !== null) {
    const cache = record(usage.cache);
    const used = count(usage.input) + count(usage.output) + count(usage.reasoning) + count(cache.read) + count(cache.write);
    if (used > 0) metadata.context = { used, window: null };
  }
  return metadata;
}

/** One page of a 1.x session, keyed by the message's place in `(time_created, id)` order. */
function conversation1(db: Database, cacheKey: string, sessionId: string, page: OpencodePage): OpencodeAnswer {
  const view = sessionView1(db, sessionId);
  if (view === null) return { kind: "unavailable", reason: "session_not_found" };
  if (view.rows > MAX_V1_ROWS) return { kind: "unavailable", reason: "transcript_missing" };
  const key = `${cacheKey}\0v1`;
  const cached = answers.get(key);
  if (cached?.signature === view.signature) return cached.answer;

  const bytes = db.query<{ messages: number | null; parts: number | null }, [string, string]>(
    "SELECT (SELECT sum(length(CAST(data AS BLOB))) FROM message WHERE session_id = ?) AS messages, (SELECT sum(length(CAST(data AS BLOB))) FROM part WHERE session_id = ?) AS parts",
  ).get(sessionId, sessionId)!;
  if ((bytes.messages ?? 0) + (bytes.parts ?? 0) > MAX_V1_BYTES) return { kind: "unavailable", reason: "transcript_missing" };

  const messages = loadSession1(db, sessionId);
  // a revert commit between the view and the load deletes a suffix: never page past what was read
  const end = Math.min(view.end, messages.length);
  const cursorOf = (cursor: string): number | null => {
    const separator = cursor.lastIndexOf(":");
    const offset = Number(cursor.slice(separator + 1));
    if (separator <= 0 || cursor.slice(0, separator) !== view.historyId || !Number.isSafeInteger(offset) || offset < 0 || offset > end) return null;
    if (offset === 0) return 0;
    return offset < end ? offset : null;
  };
  const descending = (from: number, to: number): RowMeta[] => {
    const rows: RowMeta[] = [];
    for (let index = to - 1; index >= from; index--) {
      const message = messages[index]!;
      rows.push({ id: message.id, seq: index, type: typeof message.data.role === "string" ? message.data.role : "", updated: message.updated, size: message.size });
    }
    return rows;
  };

  let start: number;
  let to = end;
  if (page.before !== undefined) {
    const before = cursorOf(page.before);
    const floor = page.since === undefined ? 0 : cursorOf(page.since);
    if (before === null || floor === null || floor > before) return { kind: "history_changed" };
    start = before === floor ? floor : pageStart(descending(floor, before), floor, true, OPENCODE_WINDOW_BYTES, pagePrompts(page));
    to = before;
  } else {
    const held = page.from === undefined ? null : cursorOf(page.from);
    if (page.from !== undefined && held === null) return { kind: "history_changed" };
    const newest = pageStart(descending(0, end), 0, false, OPENCODE_WINDOW_BYTES, pagePrompts(page));
    start = held !== null && held >= newest ? held : newest;
  }

  const records: (OpencodeRecord | null)[] = [];
  for (let index = start; index < to; index++) {
    const adapted = adaptMessage1(messages[index]!);
    records.push(adapted === null ? null : opencodeRecord(messages[index]!.id, adapted.type, adapted.data));
  }
  const result = {
    kind: "page" as const,
    turns: opencodeTurns(records),
    metadata: sessionMetadata1(messages, to),
    cursor: start > 0 ? `${view.historyId}:${start}` : null,
    history_id: view.historyId,
    signature: view.signature,
  };
  remember(answers, key, { signature: view.signature, answer: result }, 32);
  return result;
}

/** A visible 1.x message by id, as the 2.x `(type, data)` shape the tool-output and image readers use. */
function sessionRow1(db: Database, sessionId: string, id: string): { type: string; data: Row } | null {
  const view = db.query<{ revert: string | null }, [string]>("SELECT revert FROM session WHERE id = ?").get(sessionId);
  if (view === null) return null;
  const row = db.query<{ time_created: number; data: string }, [string, string]>("SELECT time_created, data FROM message WHERE id = ? AND session_id = ?").get(id, sessionId);
  if (row === null) return null;
  let revert: unknown = null;
  try { revert = view.revert === null ? null : JSON.parse(view.revert); } catch { /* nothing staged */ }
  const boundary = record(revert).messageID;
  if (typeof boundary === "string") {
    const hidden = db.query<{ time_created: number }, [string, string]>("SELECT time_created FROM message WHERE id = ? AND session_id = ?").get(boundary, sessionId);
    if (hidden !== null && (row.time_created > hidden.time_created || (row.time_created === hidden.time_created && id >= boundary))) return null;
  }
  const parts = db.query<{ data: string }, [string]>("SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id").all(id).map((part) => parseData(part.data));
  return adaptMessage1({ id, data: parseData(row.data), parts, updated: 0, size: 0 });
}
