import type { ConversationMetadata, PlanStep } from "../shared/protocol.ts";
import { parseTodoAnswer, type TodoStatus } from "../shared/todos.ts";
import { plain, readLines, remember } from "./claude-subagents.ts";
import { withoutPictureBytes } from "./claude-transcript.ts";
import { contextOf, parseConversationMetadata } from "./conversation-metadata.ts";
import { isContextClear } from "./transcript-records.ts";
import { claudeCommandEchoRecord, opensTurn } from "./transcript-turns.ts";

/**
 * The plan an agent keeps for its session, read back from the session's transcript, for the
 * sidebar's progress and the plan panel. Nothing new is asked of the agent: Claude Code's task
 * list (`TaskCreate`/`TaskUpdate`, whose `blockedBy` gives the flow) and Codex's `update_plan`
 * checklist are already written there.
 *
 * Claude: a task is taken when its tool call is answered without an error, with the id Claude
 * gave it. Claude empties its list once every task in it is done, and so does this: the first
 * task created after that starts a new plan. A teammate of an agent team that changes a task
 * writes that in its own transcript, which is not read here.
 *
 * Codex: each explicit `update_plan` call sends the whole checklist, so the last one is the plan.
 * Code inside an `exec` call may quote a plan without calling the tool, and is ignored.
 * OmO: the last complete `todo` tool answer replaces the plan; an empty list clears it.
 * Dropped tasks are omitted, blocked tasks stay pending, and no dependency edges are invented.
 *
 * A transcript is read from its start, PLAN_BUDGET bytes per call, then only what was appended;
 * until the first read has reached the end, no plan is told.
 *
 * The same read follows how much of its context a Claude Code or Codex session's last request
 * filled, for the sidebar's ring: the lines that can say it are folded as the chat's metadata folds them.
 * A Claude rewind leaves the answers it went back over in the file, and the next prompt hangs from
 * the record it went back to (followClaudeBranch, which the chat follows). A prompt that hangs from
 * a record before the last answer forks the session. The chat then leaves out every record written
 * after the one the prompt hangs from up to the prompt, so the figure goes back to the one the branch
 * had at that record (none when its place is not known), and later requests are folded onto it. Only
 * the records since the last answer are kept to tell a fork, and the places of the last MAX_PLACES
 * records and the last MAX_FIGURES figures to go back to.
 */
export const PLAN_BUDGET = 32 * 1024 * 1024;
const LINE_BUDGET = 8 * 1024 * 1024;
const MAX_STEPS = 200;
const MAX_FILES = 256;

export type PlanSource = "claude-transcript" | "codex-transcript" | "omo-session";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : null;
const words = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 300) : null;
const idOf = (value: unknown): string | null => words(typeof value === "number" ? String(value) : value);
const stamp = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const STATUSES = new Set<PlanStep["status"]>(["pending", "in_progress", "completed"]);

interface Read {
  id: string;
  offset: number;
  skipping: boolean;
  /** the first read has not reached the end of what was written yet */
  catching: boolean;
  /** the last read stopped for its budget: what follows has not been read */
  behind: boolean;
  steps: Map<string, PlanStep>;
  /** Claude's task calls still waiting for their answer, by tool_use id */
  calls: Map<string, { name: string; input: Row }>;
  /** the model and the context the lines read so far report */
  metadata: ConversationMetadata;
  claude?: ClaudeChain;
}

/** a Claude record longer than this, its pictures' bytes left out, is not read for its links (as the chat's branch reader) */
const CHAIN_LINE = 1024 * 1024;
/** the most records since an answer (or hanging from a held echo) that are kept: past it, as after a record too long to read, no fork is told until the next answer (a held echo forks) */
const MAX_SINCE = 10_000;
/** the most records whose place is kept, for a fork that hangs from one of them: a fork from farther back starts with no figure */
const MAX_PLACES = 2_000;
/** the most figures kept to go back to: a fork from before the oldest starts with none */
const MAX_FIGURES = 2_000;
/** a uuid longer than this (Claude Code writes 36 characters) gets no place */
const MAX_UUID = 64;

/** the figure on a branch from the record at `at` (its place in the file) on */
interface Figure { at: number; context: ConversationMetadata["context"] }

interface ClaudeChain {
  /** the uuids of the main chain's records since its last answer (null: the start), or null when one of them could not be read */
  since: Set<string | null> | null;
  /** since a rewind, or a line too long to read (which may have been one): the context of the requests made after it */
  forked: { context?: ConversationMetadata["context"] } | null;
  /** the last record on the chain, null when one could not be read */
  last: string | null;
  /**
   * a command's echo that hangs from before the last answer, the records hanging from it so far, and
   * the context of the requests made after it: as the chat's branch reader, it forks the session once
   * a prompt hangs from one of them, and while the chain's tip is one of them; a prompt hanging from
   * anywhere else drops it
   */
  echo?: { line: Set<string>; forked: { context?: ConversationMetadata["context"] }; figures: Figure[] };
  /** how many records were followed: the place of the next one */
  count: number;
  /** the place of each of the last records followed, by uuid */
  places: Map<string, number>;
  /** each figure the branch had, in order: a fork leaves out the ones from after the record it hangs from, as the chat leaves out their requests */
  figures: Figure[];
}
const reads = new Map<string, Read>();

/**
 * The plan in `path` now: its steps in the order they were made, null when there is none (or it
 * is still being read). `budget`: the bytes this read may take, shared by every read of one poll.
 */
export function readPlan(source: PlanSource, path: string, budget = { left: PLAN_BUDGET }): PlanStep[] | null {
  return planState(source, path, budget).steps;
}

export function planState(source: PlanSource, path: string, budget: { left: number }): { steps: PlanStep[] | null; behind: boolean; metadata: ConversationMetadata | null } {
  const stat = plain(path);
  if (stat === null) return { steps: null, behind: false, metadata: null };
  const key = `${source}\0${path}`;
  let state = reads.get(key);
  if (!state || state.id !== stat.id || state.offset > stat.size) {
    state = { id: stat.id, offset: 0, skipping: false, catching: true, behind: true, steps: new Map(), calls: new Map(), metadata: { model: null, reasoning_effort: null } };
    if (source === "claude-transcript") state.claude = { since: new Set([null]), forked: null, last: null, count: 0, places: new Map(), figures: [] };
  }
  remember(reads, key, state, MAX_FILES);
  const read = state;
  const readers = { "claude-transcript": claudeLine, "codex-transcript": codexLine, "omo-session": omoLine } satisfies Record<PlanSource, (read: Read, line: string) => void>;
  const each = (line: string) => { readers[source](read, line); contextLine(read, source, line); };
  read.behind = read.offset < stat.size;
  while (read.offset < stat.size && budget.left > 0) {
    const done = readLines(path, read.offset, stat, LINE_BUDGET, each, read.skipping);
    // a line given up may have been a prompt that forked the session
    if (done.skipping && read.claude) read.claude = { since: null, forked: {}, last: null, count: 0, places: new Map(), figures: [] };
    // the file could not be read this time (gone, out of descriptors): not caught up, tried again at the next poll
    if (done.failed) { read.behind = true; break; }
    const consumed = done.offset - read.offset;
    read.offset = done.offset;
    read.skipping = done.skipping;
    read.behind = done.more;
    budget.left -= consumed;
    // what is left is a line still being written: the next read takes it whole
    if (consumed === 0 || !done.more) break;
  }
  if (!read.behind) read.catching = false;
  return { steps: read.catching || read.steps.size === 0 ? null : [...read.steps.values()].map((step) => ({ ...step, blocked_by: [...step.blocked_by] })), behind: read.behind, metadata: read.catching ? null : onBranch(read) };
}

/** The metadata, its context the fork's when a Claude session forked: the branch's at the record it hangs from, with the requests made since folded onto it. */
function onBranch(read: Read): ConversationMetadata {
  const forked = forkOf(read.claude);
  if (!forked) return read.metadata;
  const { context: _, ...metadata } = read.metadata;
  return forked.context === undefined ? metadata : { ...metadata, context: forked.context };
}

/** The fork the chain's tip is on: a held echo's while the tip hangs from it. */
function forkOf(chain: ClaudeChain | undefined): ClaudeChain["forked"] {
  return chain?.echo && chain.last !== null && chain.echo.line.has(chain.last) ? chain.echo.forked : chain?.forked ?? null;
}

/**
 * Follows a Claude record on the session's chain: a prompt that hangs from before the last answer
 * forks it, and a command's echo that does is held until the conversation goes on from it. Either
 * starts with the figure the branch had at the record it hangs from. The record's place, when it is
 * on the chain.
 */
function followChain(chain: ClaudeChain, line: string): number | null {
  if (!line.includes('"uuid"')) return null;
  const text = line.length > CHAIN_LINE ? withoutPictureBytes(line) : line;
  let entry: Row | null = null;
  if (text.length <= CHAIN_LINE) try { entry = row(JSON.parse(text)); } catch { /* not a record: its uuid is not known */ }
  if (entry === null) { chain.since = null; chain.last = null; return null; }
  const uuid = entry["uuid"];
  if (typeof uuid !== "string" || entry["isSidechain"] === true) return null;
  chain.last = uuid;
  const place = chain.count++;
  if (isContextClear(entry, "claude-transcript")) { chain.since = new Set([null, uuid]); chain.forked = null; chain.echo = undefined; chain.places.clear(); chain.figures = []; return place; }
  if (uuid.length <= MAX_UUID) remember(chain.places, uuid, place, MAX_PLACES);
  // a compaction's boundary starts a chain of its own, and names the record it continues
  const parent = entry["parentUuid"] === null ? typeof entry["logicalParentUuid"] === "string" ? entry["logicalParentUuid"] : null
    : typeof entry["parentUuid"] === "string" ? entry["parentUuid"] : undefined;
  const answer = entry["type"] === "assistant";
  const offChain = !answer && parent !== undefined && chain.since !== null && !chain.since.has(parent);
  const echo = chain.echo;
  const prompt = !answer && (echo !== undefined || offChain) && opensTurn("claude-transcript", text, null) !== false;
  if (echo && typeof parent === "string" && echo.line.has(parent)) {
    // past the bound the echo is taken as the fork it may become, as a line too long to read is
    if (prompt || echo.line.add(uuid).size > MAX_SINCE) { chain.forked = echo.forked; chain.figures = echo.figures; chain.echo = undefined; }
  } else if (prompt) chain.echo = undefined;
  if (offChain && (prompt || claudeCommandEchoRecord(entry))) {
    // a parent of null (before the first message), or one whose place is not kept: no figure yet
    const at = typeof parent === "string" ? chain.places.get(parent) : undefined;
    const figures = at === undefined ? [] : chain.figures.filter((figure) => figure.at <= at);
    const forked = { context: figures.at(-1)?.context };
    if (prompt) { chain.forked = forked; chain.figures = figures; } else chain.echo = { line: new Set([uuid]), forked, figures };
  }
  if (answer) chain.since = new Set([uuid]);
  else if (chain.since !== null) {
    chain.since.add(uuid);
    if (chain.since.size > MAX_SINCE) chain.since = null;
  }
  return place;
}

/** Keeps `context` as the branch's figure from the record at `at` on, when it changed. */
function note(figures: Figure[], at: number, context: ConversationMetadata["context"]): void {
  if (figures.at(-1)?.context === context) return;
  figures.push({ at, context });
  if (figures.length > MAX_FIGURES) figures.shift();
}

/** The lines that can say what a request filled, or reset or change the model: only these are parsed for the context. */
const CONTEXT_MARKS: Record<PlanSource, readonly string[]> = {
  "claude-transcript": ['"usage"', "command-name>", "local-command-stdout>"],
  "codex-transcript": ['"token_count"', '"turn_context"', '"session_meta"'],
  // OmO's figure has no window: the ring would draw nothing
  "omo-session": [],
};

function contextLine(read: Read, source: PlanSource, line: string): void {
  const chain = read.claude;
  const place = chain ? followChain(chain, line) : null;
  if (source !== "omo-session" && CONTEXT_MARKS[source].some((mark) => line.includes(mark))) {
    const before = read.metadata.context;
    read.metadata = parseConversationMetadata(line, source, read.metadata);
    // a new figure is a request: after a fork (or a held echo) it is folded onto the fork's, not onto the answers it left
    const { context, model } = read.metadata;
    if (context !== undefined && context !== before) for (const forked of [chain?.forked, chain?.echo?.forked]) if (forked) forked.context = contextOf(context.used, model, null, forked.context);
  }
  if (chain && place !== null) {
    note(chain.figures, place, chain.forked ? chain.forked.context : read.metadata.context);
    if (chain.echo) note(chain.echo.figures, place, chain.echo.forked.context);
  }
}

/** Forgets every read (tests). */
export function forgetPlans(): void {
  reads.clear();
}

function claudeLine(read: Read, line: string): void {
  const calling = line.includes('"name":"TaskCreate"') || line.includes('"name":"TaskUpdate"');
  const answering = read.calls.size > 0 && line.includes('"tool_result"');
  if (!calling && !answering) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  const content = row(entry?.["message"])?.["content"];
  if (entry === null || !Array.isArray(content)) return;
  for (const value of content) {
    const block = row(value);
    if (block === null) continue;
    if (block["type"] === "tool_use" && (block["name"] === "TaskCreate" || block["name"] === "TaskUpdate") && typeof block["id"] === "string") {
      read.calls.set(block["id"], { name: block["name"], input: row(block["input"]) ?? {} });
      continue;
    }
    if (block["type"] !== "tool_result" || typeof block["tool_use_id"] !== "string") continue;
    const call = read.calls.get(block["tool_use_id"]);
    if (call === undefined) continue;
    read.calls.delete(block["tool_use_id"]);
    if (block["is_error"] === true) continue;
    const answer = row(entry["toolUseResult"]);
    const at = stamp(entry["timestamp"]);
    if (call.name === "TaskCreate") created(read, call.input, answer, block["content"]);
    else updated(read, call.input, answer, at);
  }
  if (read.calls.size > MAX_STEPS) read.calls.clear();
}

function created(read: Read, input: Row, answer: Row | null, content: unknown): void {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => row(part)?.["text"]).filter((part) => typeof part === "string").join("") : "";
  const id = idOf(row(answer?.["task"])?.["id"]) ?? text.match(/^Task #(\S+) created/)?.[1] ?? null;
  if (id === null) return;
  // Claude empties a list whose tasks are all done: the next task begins another plan
  if ([...read.steps.values()].every((step) => step.status === "completed")) read.steps.clear();
  if (read.steps.size >= MAX_STEPS) return;
  read.steps.set(id, { id, label: words(input["subject"]) ?? `#${id}`, active: words(input["activeForm"]), status: "pending", blocked_by: [], owner: null, started_at: null, ended_at: null });
}

function updated(read: Read, input: Row, answer: Row | null, at: string | null): void {
  if (answer?.["success"] === false) return;
  const id = idOf(input["taskId"]);
  const step = id === null ? undefined : read.steps.get(id);
  if (id === null || step === undefined) return;
  const status = input["status"];
  if (status === "deleted") {
    read.steps.delete(id);
    for (const other of read.steps.values()) other.blocked_by = other.blocked_by.filter((before) => before !== id);
    return;
  }
  if (typeof status === "string" && STATUSES.has(status as PlanStep["status"]) && status !== step.status) {
    step.status = status as PlanStep["status"];
    if (step.status === "in_progress") { step.started_at ??= at; step.ended_at = null; }
    if (step.status === "completed") step.ended_at = at;
    if (step.status === "pending") step.ended_at = null;
  }
  step.label = words(input["subject"]) ?? step.label;
  step.active = words(input["activeForm"]) ?? step.active;
  if (typeof input["owner"] === "string") step.owner = words(input["owner"]);
  const ids = (value: unknown): string[] => Array.isArray(value) ? value.flatMap((item) => { const other = idOf(item); return other !== null && other !== id && read.steps.has(other) ? [other] : []; }) : [];
  for (const before of ids(input["addBlockedBy"])) if (!step.blocked_by.includes(before)) step.blocked_by.push(before);
  for (const after of ids(input["addBlocks"])) {
    const other = read.steps.get(after)!;
    if (!other.blocked_by.includes(id)) other.blocked_by.push(id);
  }
}

function codexLine(read: Read, line: string): void {
  if (!line.includes("update_plan")) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch { return; }
  const payload = row(entry?.["payload"]);
  if (entry === null || payload === null) return;
  if (payload["type"] !== "function_call" || payload["name"] !== "update_plan" || typeof payload["arguments"] !== "string") return;
  let args: unknown;
  try { args = JSON.parse(payload["arguments"]); } catch { return; }
  const items = row(args)?.["plan"];
  if (!Array.isArray(items)) return;
  const at = stamp(entry["timestamp"]);
  // a step keeps the times it had in the checklists before, found by its words
  const before = new Map([...read.steps.values()].map((step) => [step.label, step]));
  read.steps.clear();
  for (const item of items.slice(0, MAX_STEPS)) {
    const label = words(row(item)?.["step"]);
    const raw = row(item)?.["status"];
    if (label === null) continue;
    const status: PlanStep["status"] = typeof raw === "string" && STATUSES.has(raw as PlanStep["status"]) ? raw as PlanStep["status"] : "pending";
    const known = before.get(label);
    const id = String(read.steps.size + 1);
    const started = status === "pending" ? null : known?.started_at ?? at;
    read.steps.set(id, {
      id, label, active: null, status, owner: null,
      blocked_by: read.steps.size > 0 ? [String(read.steps.size)] : [],
      started_at: started,
      ended_at: status === "completed" ? known?.ended_at ?? at : null,
    });
  }
}

/** Dropped work is no longer part of the plan; blocked work remains pending, never done. */
const OMO_STATUSES = {
  pending: "pending", in_progress: "in_progress", completed: "completed", blocked: "pending", dropped: null,
} as const satisfies Record<TodoStatus, PlanStep["status"] | null>;

function omoLine(read: Read, line: string): void {
  if (!line.includes('"todo"')) return;
  let entry: Row | null;
  try { entry = row(JSON.parse(line)); } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
  const message = row(entry?.["message"]);
  if (entry?.["type"] !== "message" || message?.["role"] !== "toolResult" || message["toolName"] !== "todo" || message["isError"] === true) return;
  const content = message["content"];
  if (!Array.isArray(content)) return;
  const output = content.flatMap((part: unknown) => {
    const block = row(part);
    return block?.["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : [];
  }).join("\n");
  const items = parseTodoAnswer(output);
  if (items === null) return;
  const before = new Map([...read.steps.values()].map((step) => [step.label, step]));
  const at = stamp(entry["timestamp"]);
  read.steps.clear();
  for (const item of items) {
    const status = OMO_STATUSES[item.status];
    if (status === null) continue;
    if (read.steps.size >= MAX_STEPS) break;
    const known = before.get(item.label);
    const id = String(read.steps.size + 1);
    read.steps.set(id, {
      id, label: item.label, active: null, status, owner: null, blocked_by: [],
      started_at: status === "pending" ? null : known?.started_at ?? at,
      ended_at: status === "completed" ? known?.ended_at ?? at : null,
    });
  }
}
