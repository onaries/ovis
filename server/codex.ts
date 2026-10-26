/** Native Codex rollouts contain both display events and model context. Only
 * conversation records belong in chat; developer prompts and terminal chrome do not. */
import { Database } from "bun:sqlite";
import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import nodePath, { isAbsolute, join, type PlatformPath } from "node:path";
import type { ConversationPart, ConversationTurn, HerdrPane } from "../shared/protocol.ts";
import { patchFiles, patchText } from "../shared/patch.ts";
import { execSummary, execToolSummary } from "../shared/execSummary.ts";
import { codexSubagentCalls, codexSubagentNotification } from "./codex-subagents.ts";
import { processStartedAt, processStartLowerBound } from "./process-start.ts";
import { CODEX_TOOL_IMAGE_REF, codexImageParts, codexOutputPictures } from "./codex-images.ts";
import { codexReadCall, codexReadSkills, selectedSkill } from "./skill-activity.ts";
import { trimOutput } from "./tool-output.ts";
import type { TranscriptParser } from "./transcript-records.ts";
import type { AgentInfo } from "../shared/herdr-api.generated.ts";
import { agentGet, paneProcessInfo, paneRead, sessionSnapshot } from "./herdr/client.ts";
import { resolveAgent } from "./pane-context.ts";
import { codexStartScreenUnused } from "./start-screen.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function contextOnly(text: string): boolean {
  const value = text.trim();
  return (/^# AGENTS\.md instructions(?: for [^\r\n]+)?\r?\n\s*<INSTRUCTIONS>[\s\S]*<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?$/.test(value))
    || /^<(environment_context|permissions instructions|turn_aborted)>[\s\S]*<\/\1>$/.test(value);
}

/**
 * An answer to Codex's queued questions (request_user_input_async) reaches the model as
 * a user message: a JSON list of {answer, question, questionItemId} inside
 * `<send_user_message_question_reply>`. The chat shows what was answered, not the envelope.
 */
function questionReply(text: string): string | null {
  const match = text.trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
  if (!match) return null;
  try {
    const items: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(items)) return null;
    const answers = items.map((item) => string(record(item).answer).trim()).filter(Boolean);
    return answers.length > 0 ? answers.join("\n") : null;
  } catch {
    return null;
  }
}

/** The questions of a request_user_input(_async) call: `title` (async) or `question` (plan mode). */
function questionTitles(args: RecordValue): string[] {
  return Array.isArray(args.questions)
    ? args.questions.map((question) => string(record(question).title) || string(record(question).question)).filter(Boolean)
    : [];
}

/** A tool call's output as Codex recorded it, as text. */
export function codexOutputText(value: unknown): string {
  return contentText(value);
}

function contentText(value: unknown, user = false): string {
  if (typeof value === "string") return user && contextOnly(value) ? "" : value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((raw, index) => {
    const part = record(raw);
    const previousType = string(record(value[index - 1]).type);
    const nextType = string(record(value[index + 1]).type);
    const text = string(part.text);
    const imageEnvelope = user && part.type === "input_text"
      && ((/^<image name=\[Image #\d+\](?: path="[^"\r\n]+")?>$/.test(text) && ["input_image", "local_image"].includes(nextType))
        || (text === "</image>" && ["input_image", "local_image"].includes(previousType)));
    if (imageEnvelope) return [];
    return ["input_text", "output_text", "text", "summary_text"].includes(string(part.type))
      && typeof part.text === "string" && !(user && contextOnly(part.text)) ? [part.text] : [];
  }).join("\n");
}

function entries(text: string): RecordValue[] {
  return text.split("\n").flatMap((line) => {
    try { return [record(JSON.parse(line))]; } catch { return []; }
  });
}

/** Memory blocks are metadata unless the answer quotes them in Markdown code. */
function withoutMemoryCitations(text: string): string {
  const opening = "<oai-mem-citation>";
  const closing = "</oai-mem-citation>";
  if (!text.includes(opening)) return text.trimEnd();

  type Line = { kind: "line"; index: number; quoteDepth: number; indent: number; listIndent?: number; blank: boolean };
  type Token = Line | { kind: "fence"; index: number; marker: string; info: string; line: Line }
    | { kind: "ticks"; index: number; size: number } | { kind: "citation"; index: number };
  const tokens: Token[] = [];
  const quote = /[ \t]*>[ \t]?/y;
  for (const match of text.matchAll(/([^\r\n]*)(?:\r\n?|\n|$)/g)) {
    const source = match[1]!;
    let offset = 0;
    let quoteDepth = 0;
    quote.lastIndex = 0;
    while (quote.exec(source)) { offset = quote.lastIndex; quoteDepth++; }
    const indent = /^[ \t]*/.exec(source.slice(offset))![0].length;
    const content = source.slice(offset + indent);
    const list = /^(?:[-+*]|\d+[.)])[ \t]+/.exec(content);
    const line: Line = { kind: "line", index: match.index!, quoteDepth, indent,
      ...(list ? { listIndent: indent + list[0].length } : {}), blank: content.trim() === "" };
    tokens.push(line);
    const body = content.slice(list?.[0].length ?? 0);
    const marker = /^(`{3,}|~{3,})/.exec(body)?.[0];
    const info = marker ? body.slice(marker.length) : "";
    // A backtick fence's info string cannot contain backticks.
    if (marker && (marker[0] !== "`" || !info.includes("`"))) tokens.push({ kind: "fence",
      index: match.index! + offset + indent + (list?.[0].length ?? 0), marker, info, line });
    for (const token of source.matchAll(/`+|<oai-mem-citation>/g)) {
      tokens.push(token[0] === opening ? { kind: "citation", index: match.index! + token.index! }
        : { kind: "ticks", index: match.index! + token.index!, size: token[0].length });
    }
  }
  const closes = new Map<number, number>();
  const pairs: number[] = [];
  // Index matching runs once: unmatched delimiters must not repeatedly scan the tail.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (token.kind !== "ticks") {
      if (token.kind === "line") closes.clear();
      continue;
    }
    let backslashes = 0;
    for (let at = token.index - 1; at >= 0 && text[at] === "\\"; at--) backslashes++;
    const length = token.size - (backslashes % 2);
    pairs[i] = length > 0 ? closes.get(length) ?? -1 : -1;
    // Inside a code span a backslash does not escape its closing backticks.
    closes.set(token.size, i);
  }
  const parts: string[] = [];
  const listIndents: number[] = [];
  let quoteDepth = 0;
  let kept = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "line") {
      if (token.quoteDepth !== quoteDepth) { listIndents.length = 0; quoteDepth = token.quoteDepth; }
      if (token.blank) continue;
      while (listIndents.length > 0 && listIndents.at(-1)! > token.indent) listIndents.pop();
      if (token.listIndent !== undefined) listIndents.push(token.listIndent);
      continue;
    }
    if (token.kind === "fence") {
      const within = token.line.listIndent ?? listIndents.at(-1) ?? 0;
      const indent = token.line.listIndent === undefined ? token.line.indent - within : 0;
      if (indent < 0 || indent > 3) continue;
      // An unfinished fence remains code until its quote/list container ends.
      for (i++; i < tokens.length; i++) {
        const end = tokens[i]!;
        if (end.kind === "line" && (end.quoteDepth < token.line.quoteDepth
          || (within > 0 && end.quoteDepth === token.line.quoteDepth && !end.blank && end.indent < within))) { i--; break; }
        if (end.kind === "fence" && end.line.quoteDepth === token.line.quoteDepth && end.marker[0] === token.marker[0]
          && end.marker.length >= token.marker.length && /^[ \t]*$/.test(end.info)) {
          // Skip the closing line's raw backtick/citation tokens too.
          while (i + 1 < tokens.length && tokens[i + 1]!.kind !== "line") i++;
          break;
        }
      }
      continue;
    }
    const pair = pairs[i];
    if (pair !== undefined && pair >= 0) { i = pair; continue; }
    if (token.kind !== "citation") continue;
    parts.push(text.slice(kept, token.index));
    const close = text.indexOf(closing, token.index + opening.length);
    kept = close === -1 ? text.length : close + closing.length;
    // Metadata contents cannot open code spans or fences in the surrounding answer.
    while (i + 1 < tokens.length && tokens[i + 1]!.index < kept) i++;
  }
  parts.push(text.slice(kept));
  return parts.join("").trimEnd();
}


/**
 * Whether a Codex tool output says the call failed. Codex records no flag: its command
 * runner writes the exit code into the output, and a script or patch its own verdict. A
 * script that completed is judged as a whole, however its commands went.
 */
export function codexCallFailed(output: string): boolean {
  const head = output.slice(0, 2000);
  if (/^Script completed\b/m.test(head)) return false;
  if (/^Script failed\b/m.test(head) || /apply_patch verification failed/.test(head)) return true;
  const code = /^(?:Process exited with code|Exit code:) (\d+)$/m.exec(head) ?? /"exit_code":\s*(\d+)/.exec(head);
  return code !== null && code[1] !== "0";
}

interface CodexParseState {
  turns: ConversationTurn[];
  tools: Map<string, Extract<ConversationPart, { kind: "tool" }>>;
  messages: { role: string; text: string; source: string; ts: string; paired: boolean; part: ConversationPart; turn: ConversationTurn }[];
  agentCells?: Map<string, Extract<ConversationPart, { kind: "tool" }>>;
  startedAt?: string;
  skillEvents?: Set<string>;
  activeTurnId?: string;
}

/** Complete records are folded once; snapshots detach mutable tools from prior HTTP answers. */
export function createCodexTranscriptParser(state: CodexParseState = { turns: [], tools: new Map(), messages: [] }): TranscriptParser {
  const { turns, tools, messages } = state;
  const assistant = (ts: string): ConversationTurn => {
    let turn = turns.at(-1);
    if (turn?.role !== "assistant") {
      turn = { role: "assistant", ts: state.startedAt || ts || null, parts: [] };
      turns.push(turn);
    }
    if (ts) turn.end_ts = ts;
    return turn;
  };
  const message = (role: "user" | "assistant", text: string, source: string, ts: string, phase?: "commentary" | "final_answer", images: ConversationPart[] = []): void => {
    const notification = role === "user" && text.trim().startsWith("<subagent_notification>")
      ? codexSubagentNotification(text, turns.slice(-100).flatMap((turn) => turn.parts.flatMap((part) => part.kind === "tool" ? part.codex_subagents ?? [] : [])).slice(-256)) : null;
    const body = role === "user" ? questionReply(text) ?? text
      : withoutMemoryCitations(text);
    if (!body.trim() && images.length === 0) return;
    const duplicate = messages.slice(-8).reverse().find((other) => !other.paired && other.role === role && other.text === body
      && other.source !== source && (other.ts === ts || Math.abs(Date.parse(other.ts) - Date.parse(ts)) <= 1000));
    if (duplicate) {
      duplicate.paired = true;
      if (phase && duplicate.part.kind === "text") duplicate.part.phase = phase;
      // Prefer the event's local paths over a response's inline copies of the same images.
      if (images.length > 0 && (source === "event" || !duplicate.turn.parts.some((part) => part.kind === "image"))) {
        duplicate.turn.parts = [...images, ...duplicate.turn.parts.filter((part) => part.kind !== "image")];
      }
      return;
    }
    const part: ConversationPart = notification ?? { kind: "text", text: body, ...(phase ? { phase } : {}) };
    const turn = role === "user" ? { role, ts: ts || null, parts: [...images, ...(body.trim() ? [part] : [])] } : assistant(ts);
    if (role === "user") turns.push(turn);
    else turn.parts.push(part);
    messages.push({ role, text: body, source, ts, paired: false, part, turn });
    if (messages.length > 8) messages.shift();
  };

  const write = (text: string): void => {
    for (const entry of entries(text)) {
      const payload = record(entry.payload);
      const ts = string(entry.timestamp);
      if (entry.type === "event_msg") {
        if (payload.type === "item_completed" && (!state.activeTurnId || !payload.turn_id || payload.turn_id === state.activeTurnId)) {
          const item = record(payload.item);
          const id = string(item.id);
          const skills = codexReadSkills(item);
          if (id && skills.length > 0 && !state.skillEvents?.has(id)) {
            (state.skillEvents ??= new Set()).add(id);
            if (state.skillEvents.size > 512) state.skillEvents.delete(state.skillEvents.values().next().value!);
            for (const skill of skills) {
              const turn = assistant(ts);
              const existing = [...turn.parts].reverse().find((part) => part.kind === "tool" && part.skill?.path === skill.path);
              if (existing?.kind === "tool" && existing.skill) existing.skill.status = skill.status;
              else turn.parts.push({ kind: "skill", skill });
            }
          }
        }
        if (payload.type === "task_started") {
          state.startedAt = string(payload.started_at) || ts;
          state.activeTurnId = string(payload.turn_id) || undefined;
        }
        if (payload.type === "task_complete" || payload.type === "turn_aborted") {
          const turn = turns.at(-1);
          if (turn?.role === "assistant" && ts) turn.end_ts = ts;
          state.startedAt = undefined;
        }
        if (payload.type === "user_message" && (!payload.kind || payload.kind === "plain")) {
          message("user", contentText(payload.message, true), "event", ts, undefined, codexImageParts(entry));
        }
        if (payload.type === "agent_message") {
          message("assistant", contentText(payload.message), "event", ts,
            payload.phase === "commentary" || payload.phase === "final_answer" ? payload.phase : undefined);
        }
        continue;
      }
      if (entry.type !== "response_item") continue;
      if (payload.type === "message") {
        if (payload.role === "user") {
          const content = Array.isArray(payload.content) ? payload.content : [{ type: "input_text", text: payload.content }];
          const skills = content.flatMap((block) => {
            const skill = selectedSkill(string(record(block).text));
            return skill ? [skill] : [];
          });
          const visible = content.filter((block) => !selectedSkill(string(record(block).text)));
          message("user", contentText(visible, true), "response", ts, undefined, codexImageParts(entry));
          for (const skill of skills) {
            const turn = assistant(ts);
            if (!turn.parts.some((part) => part.kind === "skill" && part.skill.name === skill.name && part.skill.path === skill.path)) turn.parts.push({ kind: "skill", skill });
          }
        } else if (payload.role === "assistant") {
          const body = contentText(payload.content);
          if (payload.channel === "analysis") {
            if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
          } else if (!payload.recipient || payload.recipient === "all") {
            message("assistant", body, "response", ts,
              payload.phase === "commentary" || payload.phase === "final_answer" ? payload.phase : undefined);
          }
        }
      } else if (payload.type === "reasoning") {
        const body = contentText(payload.summary);
        if (body.trim()) assistant(ts).parts.push({ kind: "thinking", text: body });
      } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
        const name = string(payload.name) || "tool";
        const raw = payload.type === "function_call" ? payload.arguments : payload.input;
        let args = record(raw);
        if (typeof raw === "string") { try { args = record(JSON.parse(raw)); } catch { /* Freeform tool input. */ } }
        // a patch, bare or in an exec script, is summed up by the files it touches
        const patch = typeof raw === "string" ? patchText(raw) : null;
        const summary = patch !== null && patchFiles(patch).length > 0 ? patchFiles(patch).join(", ")
          : /^request_user_input/.test(name) && questionTitles(args).length > 0
          ? questionTitles(args).join(" · ")
          : [args.cmd, args.command, args.file_path, args.path, args.pattern, args.description, args.url].find((v) => typeof v === "string")
            ?? (name === "exec" && typeof raw === "string" ? execSummary(raw) ?? execToolSummary(raw) : null);
        const part: Extract<ConversationPart, { kind: "tool" }> = {
          kind: "tool", name, summary: (string(summary) || name).slice(0, 120),
          input: Object.keys(args).length ? JSON.stringify(args, null, 2) : string(raw), output: "",
        };
        const agents = codexSubagentCalls(name, part.input);
        if (agents.length > 0) part.codex_subagents = agents;
        const origin = name === "wait" ? state.agentCells?.get(`cell:${string(args.cell_id)}`) : undefined;
        if (origin && typeof payload.call_id === "string") state.agentCells?.set(`call:${payload.call_id}`, origin);
        const skill = codexReadCall(name, args);
        if (skill) part.skill = skill;
        // the native id, and pending until an output record answers it
        if (typeof payload.call_id === "string" && payload.call_id.length > 0) { part.call_id = payload.call_id; part.state = "pending"; }
        assistant(ts).parts.push(part);
        if (typeof payload.call_id === "string") tools.set(payload.call_id, part);
      } else if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const callId = string(payload.call_id);
        const continuation = state.agentCells?.get(`call:${callId}`);
        const tool = tools.get(callId) ?? continuation;
        if (!tool) continue;
        const output = contentText(payload.output);
        const origin = continuation ?? tool;
        const agents = codexSubagentCalls(origin.name, origin.input, output || payload.output);
        if (agents.length > 0) origin.codex_subagents = agents.map((agent, index) => {
          const prior = origin.codex_subagents?.[index];
          if (!prior || prior.operation !== agent.operation || (agent.agent_id !== null && agent.agent_id !== prior.agent_id)) return agent;
          return { ...agent, agent_id: agent.agent_id ?? prior.agent_id, nickname: agent.nickname ?? prior.nickname, status: agent.status ?? prior.status };
        });
        const cell = /^Script running with cell ID ([^\s]+)/m.exec(output)?.[1];
        if (cell && origin.codex_subagents) {
          const cells = state.agentCells ??= new Map();
          cells.set(`cell:${cell}`, origin);
          cells.set(`call:${callId}`, origin);
          while (cells.size > 256) { const first = cells.keys().next().value; if (first === undefined) break; cells.delete(first); }
        } else if (state.agentCells) {
          state.agentCells.delete(`call:${callId}`);
          for (const [key, owner] of state.agentCells) if (owner === origin && key.startsWith("cell:")) state.agentCells.delete(key);
        }
        trimOutput(tool, output, string(payload.call_id));
        if (codexCallFailed(output)) tool.error = true;
        // the pictures it returned (view_image, an image generation, a screenshot a command read), named by
        // the call this output answers and fetched only when shown; the generation event's copy is not read
        const pictures = codexOutputPictures(payload.output).map(({ mediaType }, index) => ({ media_type: mediaType, ref: `codex-tool:${string(payload.call_id)}:${index}` }))
          .filter(({ ref }) => CODEX_TOOL_IMAGE_REF.test(ref));
        if (pictures.length > 0) tool.images = pictures;
        if (tool.skill) tool.skill.status = tool.error ? "failed" : "loaded";
        // done, outcome unknown: Codex records no failure flag, and the output text is no verdict
        delete tool.state;
        tools.delete(string(payload.call_id));
        const turn = turns.at(-1);
        if (turn?.role === "assistant" && ts) turn.end_ts = ts;
      }
    }
  };
  return {
    write,
    snapshot(tail = ""): ConversationTurn[] {
      // A valid final line without a newline is visible now, but is not committed:
      // the writer can still extend it before the next poll.
      if (tail.trim()) {
        const preview = createCodexTranscriptParser(structuredClone(state));
        preview.write(tail);
        return preview.snapshot();
      }
      return structuredClone(turns.filter((turn) => turn.parts.length > 0));
    },
  };
}

export function parseCodexTranscript(text: string, maxTurns = 100): ConversationTurn[] {
  const parser = createCodexTranscriptParser();
  parser.write(text);
  return parser.snapshot().slice(-maxTurns);
}

export const defaultCodexHome = (): string => process.env["CODEX_HOME"] || join(homedir(), ".codex");

/** What processCodexHome found, by pid and argv, and when (PROCESS_HOME_TTL_MS). */
const processHomes = new Map<string, { home: string | null; at: number }>();
/**
 * A visible chat reads its conversation up to every 2 s while the transcript changes, the
 * conversation monitor re-resolves its file every 5 s, and macOS reads the environment with
 * a `ps` spawn: a process's environment does not change, so its answer is kept. A pid
 * reused by another process carries other arguments or comes after this; ponytail: a
 * reused pid with the same argv inside it reads the old store until it runs out.
 */
const PROCESS_HOME_TTL_MS = 30_000;

/**
 * The CODEX_HOME in a process's environment: /proc on Linux, `ps -E` (same user only) on macOS,
 * kept for PROCESS_HOME_TTL_MS under the process's pid and argv.
 */
export async function processCodexHome(pid: number, argv: readonly string[] = []): Promise<string | null> {
  const key = `${pid}\0${argv.join("\0")}`;
  const known = processHomes.get(key);
  if (known && Date.now() - known.at < PROCESS_HOME_TTL_MS) return known.home;
  const home = await readProcessCodexHome(pid);
  processHomes.delete(key);
  processHomes.set(key, { home, at: Date.now() });
  if (processHomes.size > 256) processHomes.delete(processHomes.keys().next().value!);
  return home;
}

async function readProcessCodexHome(pid: number): Promise<string | null> {
  let home: string | null = null;
  try {
    if (process.platform === "linux") {
      home = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").find((entry) => entry.startsWith("CODEX_HOME="))?.slice(11) || null;
    } else if (process.platform === "darwin") {
      // the environment follows the arguments, space-separated: the last match is the
      // environment's, and its value runs to the next `NAME=` (a path may hold spaces).
      // ponytail: a value holding ` NAME=` is cut there, and with none in the environment an
      // argument spelled CODEX_HOME=/path would be taken. /proc on Linux has neither problem
      home = codexHomeInPsLine((await psEnvironmentLine(pid)) ?? "");
    }
  } catch { home = null; }
  return home !== null && (await isCodexHomeDir(home)) ? home : null;
}

/** A process's `ps -E` line on macOS: its arguments, then its environment when it is this user's. Null when ps fails. */
async function psEnvironmentLine(pid: number): Promise<string | null> {
  const child = Bun.spawn(["/bin/ps", "-E", "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    const text = await new Response(child.stdout).text();
    return (await child.exited) === 0 ? text : null;
  } finally { clearTimeout(timer); }
}

/**
 * The store a process's Codex writes to, only as far as its environment tells it for certain
 * (#1191): the CODEX_HOME directory it names, else .codex in the HOME it names, or null. Null
 * covers an environment that cannot be read (another user's process, a gone one, Windows), a
 * CODEX_HOME that is relative or no directory (Codex places one itself, while paneCodexHome falls
 * back to the default store for it), no HOME or a relative one, and on macOS a command line that
 * spells CODEX_HOME= or HOME= itself, which `ps -E` cannot tell from the environment. Never this
 * server's own home: the pane's Codex may run with another HOME.
 */
async function certainProcessCodexHome(pid: number, argv: readonly string[]): Promise<string | null> {
  let named: string | null = null;
  let home: string | null = null;
  try {
    if (process.platform === "linux") {
      const environment = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
      named = environment.find((entry) => entry.startsWith("CODEX_HOME="))?.slice(11) ?? "";
      home = environment.find((entry) => entry.startsWith("HOME="))?.slice(5) ?? null;
    } else if (process.platform === "darwin" && !argv.some((word) => word.includes("HOME="))) {
      // ps draws another user's process without its environment, and then names no HOME either
      const line = await psEnvironmentLine(pid);
      if (line !== null) {
        named = codexHomeInPsLine(line) ?? "";
        home = [...line.matchAll(/(?:^|\s)HOME=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/g)].at(-1)?.[1] ?? null;
      }
    }
  } catch { return null; }
  if (named === null) return null;
  // Codex reads an empty CODEX_HOME as none, and then keeps its store in the HOME it runs with
  if (named === "") return home !== null && isAbsolute(home) ? join(home, ".codex") : null;
  return (await isCodexHomeDir(named)) ? named : null;
}

/** An absolute path to a directory that is there: `ps` cannot tell an argument from the environment, a store can be checked. */
async function isCodexHomeDir(home: string): Promise<boolean> {
  if (!isAbsolute(home)) return false;
  try { return (await stat(home)).isDirectory(); } catch { return false; }
}

/**
 * CODEX_HOME in one `ps -E -o command=` line: the environment follows the arguments,
 * space-separated, so the last assignment is taken and its value runs to the next `NAME=`
 * (a path may hold spaces). A value holding ` NAME=` is cut there; an argument spelled
 * `CODEX_HOME=/path` is taken when the environment has none, which the directory check above
 * narrows. /proc on Linux has neither problem.
 */
export function codexHomeInPsLine(text: string): string | null {
  return [...text.matchAll(/(?:^|\s)CODEX_HOME=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|\s*$)/g)].at(-1)?.[1] || null;
}

/**
 * The store a pane's Codex writes to. A launcher can start Codex with its own CODEX_HOME (a
 * harness keeps one per profile), so a single store for the whole server misses those panes:
 * an explicit `configured` store wins, then the pane's Codex process's own, then the default.
 */
export async function paneCodexHome(paneId: string, configured?: string): Promise<string> {
  if (configured) return configured;
  try {
    // the first Codex listed decides, with or without a home of its own: a child or wrapper it
    // started with another CODEX_HOME writes to a store that is not this pane's conversation
    const [first] = (await codexProcessesOf(paneId)).list;
    if (first !== undefined) return (await processCodexHome(first.pid, first.argv)) ?? defaultCodexHome();
  } catch { /* herdr busy: the default store */ }
  return defaultCodexHome();
}

/**
 * A rollout's first line, parsed, when it is a session_meta; null when the file is not a rollout.
 * Throws when that line is not JSON, or when it does not end within the read (no newline in a
 * full read): what it holds past the read cannot be checked, even when the part read parses.
 */
function rolloutMetaLine(path: string): RecordValue | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, length).indexOf(0x0a);
    if (end === -1 && length === buffer.length) throw new Error("rollout header longer than the read");
    const header = record(JSON.parse(buffer.subarray(0, end === -1 ? length : end).toString("utf8")));
    return header.type === "session_meta" ? header : null;
  } finally { closeSync(fd); }
}

/** The session_meta payload on a rollout's first line, or null when the file is not a rollout. */
function rolloutHeader(path: string): RecordValue | null {
  const header = rolloutMetaLine(path);
  return header === null ? null : record(header.payload);
}

/**
 * The thread UUID a canonical rollout name carries: `rollout-<time>-<thread>.jsonl`, or a
 * paginated rollout's `rollout-<time>-<thread>_<segment>.jsonl` (Codex 0.156).
 */
const ROLLOUT_NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.jsonl$/i;

/**
 * Whether a rollout's session_meta payload makes it an interactive conversation of its own: the
 * one rule the live chat (codexRolloutPath) and the session history apply. Interactive is a TUI's
 * (`cli`) or an editor's (`vscode`) thread; an older Codex wrote no source, thread_source or
 * session_id, and such a header still counts. A child names its parent (`parent_thread_id`, a
 * subagent source object, `thread_source` other than `user`, `agent_role`) and is never one, even
 * when its own id matches its file.
 *
 * `id` and `session_id` (the root session, which is the thread itself unless it is a child,
 * openai/codex#29327), when present (null included), must be strings that name the same thread, and with a
 * canonical file name that file's UUID, in any letter case. This proves the file is the thread it
 * says, not that a self-consistent child is a parent. A name without a UUID, or a header without
 * ids, has nothing to contradict.
 */
export function interactiveCodexRollout(payload: unknown, fileName: string): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const meta = payload as RecordValue;
  const present = (value: unknown) => value !== undefined && value !== null;
  if (present(meta.source) && meta.source !== "cli" && meta.source !== "vscode") return false;
  if (present(meta.thread_source) && meta.thread_source !== "user") return false;
  if (present(meta.parent_thread_id) || present(meta.agent_role)) return false;
  // a child marker may be null; an identity that is there must name a thread
  const ids = [meta.id, meta.session_id].filter((id) => id !== undefined);
  if (ids.some((id) => typeof id !== "string")) return false;
  const key = (id: string) => UUID.test(id) ? id.toLowerCase() : id;
  const named = ROLLOUT_NAME.exec(fileName)?.[1]?.toLowerCase();
  return (ids as string[]).every((id) => key(id) === (named ?? key(ids[0] as string)));
}

/**
 * A Windows path without the `\\?\` prefix that Codex on Windows stores in `threads` (`cwd`,
 * `rollout_path`), as Rust's canonical paths carry it: `\\?\D:\x` is `D:\x` and
 * `\\?\UNC\host\share` is `\\host\share` (#518). Any other path, `\\?\Volume{…}\` included, is
 * returned as it is: without its prefix it would read as a relative path.
 */
export function withoutVerbatimPrefix(path: string): string {
  if (!path.startsWith("\\\\?\\")) return path;
  const rest = path.slice(4);
  if (/^UNC\\/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return /^[A-Za-z]:\\/.test(rest) ? rest : path;
}

/** The `cwd` values Codex may have stored for a directory: as given, and on Windows also with `\\?\`. */
export function storedCwds(cwd: string): [string, string] {
  const plain = withoutVerbatimPrefix(cwd);
  if (/^[A-Za-z]:\\/.test(plain)) return [plain, `\\\\?\\${plain}`];
  if (/^\\\\[^\\?.]/.test(plain)) return [plain, `\\\\?\\UNC\\${plain.slice(2)}`];
  return [cwd, cwd];
}

/**
 * A Windows cwd in one spelling for every way Codex and herdr may write it: without `\\?\` and
 * with an upper-case drive letter (`d:\work` and `\\?\D:\work` are `D:\work`). The rest is
 * compared as it is: a Windows directory can be case-sensitive, and nothing short of the file
 * system tells `app` from `App`, so a cwd stored in another letter case finds nothing (#587).
 */
export function directoryKey(cwd: string): string {
  const plain = withoutVerbatimPrefix(cwd);
  return /^[a-z]:\\/.test(plain) ? plain[0]!.toUpperCase() + plain.slice(1) : plain;
}

/** Whether two cwds are one directory by `directoryKey`; POSIX ones only when they are equal. */
export function sameDirectory(left: string, right: string): boolean {
  if (directoryKey(left) === directoryKey(right)) return true;
  if (process.platform !== "win32") return false;
  try {
    // bigint: a Windows file ID is 64-bit, and two of them can round to one number
    const a = statSync(left, { bigint: true });
    const b = statSync(right, { bigint: true });
    return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

/** The other Codex panes herdr shows in this pane's directory, in any spelling `sameDirectory` takes. */
export function codexPeersIn(panes: readonly HerdrPane[], paneId: string, cwd: string): HerdrPane[] {
  // the agent first: sameDirectory can ask the file system, and only Codex panes need it
  return panes.filter((pane) => pane.pane_id !== paneId && resolveAgent(pane).agent === "codex"
    && pane.cwd != null && sameDirectory(pane.cwd, cwd));
}

/**
 * Codex's `WHERE` condition for the threads of a directory, and its parameters: each spelling
 * `storedCwds` gives, with the drive letter in either case. Exact comparisons, so the lookup
 * stays on Codex's own binary cwd index.
 */
export function storedCwdCondition(cwd: string): { where: string; params: string[] } {
  // Windows resolves an existing directory to its on-disk casing. Herdr may report the
  // shell's spelling while Codex stores the canonical spelling in its binary cwd index.
  // Keep both: the original is needed when Codex recorded it before a rename or via a link.
  let canonical = cwd;
  if (process.platform === "win32") {
    try { canonical = realpathSync.native(cwd); } catch { /* A removed cwd still has its reported spelling. */ }
  }
  const params = [...new Set([cwd, canonical].flatMap((path) => storedCwds(path)).flatMap((spelling) => {
    const drive = /^((?:\\\\\?\\)?)([A-Za-z])(:\\.*)$/s.exec(spelling);
    return drive ? [`${drive[1]}${drive[2]!.toUpperCase()}${drive[3]}`, `${drive[1]}${drive[2]!.toLowerCase()}${drive[3]}`] : [spelling];
  }))];
  return { where: `cwd IN (${params.map(() => "?").join(", ")})`, params };
}

/**
 * Whether the canonical `file` lies inside the canonical store `root`. Either may carry the
 * Windows `\\?\` prefix without the other (a prefixed CODEX_HOME, #587), or its drive letter in
 * another case: it is not another root. Past the drive letter the comparison is exact, as
 * `directoryKey` has it: a case-sensitive directory's `Sessions` is not `sessions`.
 */
export function rolloutInsideStore(root: string, file: string, paths: PlatformPath = nodePath): boolean {
  const key = (path: string) => directoryKey(paths.normalize(withoutVerbatimPrefix(path)));
  const base = key(root);
  const inside = base.endsWith(paths.sep) ? base : `${base}${paths.sep}`;
  const path = key(file);
  return path.length > inside.length && path.startsWith(inside);
}

/** A rollout file of the store, as its canonical path, whatever conversation it is; null for anything else. */
function storeRolloutPath(path: string, codexHome: string): string | null {
  try {
    const canonical = realpathSync(withoutVerbatimPrefix(path));
    if (!rolloutInsideStore(realpathSync(join(codexHome, "sessions")), canonical) || !canonical.endsWith(".jsonl")) return null;
    return statSync(canonical).isFile() ? canonical : null;
  } catch { return null; }
}

/** File access is constrained by canonical paths, including symlink targets. */
export function codexRolloutPath(path: string, codexHome: string): string | null {
  try {
    const canonical = storeRolloutPath(path, codexHome);
    if (canonical === null) return null;
    const header = rolloutMetaLine(canonical);
    // A child Codex can be in the foreground process group too. Its rollout
    // is not the conversation of the parent TUI.
    if (header === null || !interactiveCodexRollout(header.payload, nodePath.basename(canonical))) return null;
    return canonical;
  } catch { return null; }
}

/** Bytes [start, end) of a file as text; a cut first line is dropped. */
export function readRange(path: string, start: number, end: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, length).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { closeSync(fd); }
}

/** A question Codex queued with request_user_input_async; `options` is empty for a free-form one. */
export interface QueuedQuestion { key: string; title: string; options: string[] }

const QUESTION_SCAN_BYTES = 4 * 1024 * 1024;
/** Per rollout: how far it was read, the questions asked and the ones answered since. */
const questionScans = new Map<string, { ino: number; size: number; cut: boolean; asked: QueuedQuestion[]; answered: Set<string> }>();

/**
 * The questions a rollout asked with request_user_input_async and holds no answer for,
 * oldest first. A question skipped in the TUI leaves no record, so a caller takes as
 * many of the newest as the TUI shows waiting. Only bytes appended since the last call
 * are read (the first call reads the last 4MB, without blocking), and only lines naming
 * the tool parsed.
 */
export function unansweredCodexQuestions(path: string): Promise<QueuedQuestion[]> {
  // two viewers polling, or a poll overlapping an answer: one scan per file at a time
  const running = questionScansInFlight.get(path);
  if (running) return running;
  const scan = scanQuestions(path).finally(() => questionScansInFlight.delete(path));
  questionScansInFlight.set(path, scan);
  return scan;
}

const questionScansInFlight = new Map<string, Promise<QueuedQuestion[]>>();

async function scanQuestions(path: string): Promise<QueuedQuestion[]> {
  const stat = statSync(path);
  const known = questionScans.get(path);
  // the scan is built on a copy and kept only once complete
  const scan = known && known.ino === stat.ino && stat.size >= known.size
    ? { ...known, asked: [...known.asked], answered: new Set(known.answered) }
    : { ino: stat.ino, size: Math.max(0, stat.size - QUESTION_SCAN_BYTES), cut: stat.size > QUESTION_SCAN_BYTES, asked: [] as QueuedQuestion[], answered: new Set<string>() };
  if (stat.size > scan.size) {
    const bytes = Buffer.from(await Bun.file(path).slice(scan.size, stat.size).arrayBuffer());
    // whole lines only: a line still being written is read again next time
    const end = bytes.lastIndexOf(0x0a) + 1;
    let text = bytes.subarray(0, end).toString("utf8");
    if (scan.cut && end > 0) { text = text.slice(text.indexOf("\n") + 1); scan.cut = false; }
    for (const line of text.split("\n")) {
      if (!line.includes("request_user_input_async")) continue;
      let entry: RecordValue;
      try { entry = record(JSON.parse(line)); } catch { continue; }
      if (entry.type !== "response_item") continue;
      const payload = record(entry.payload);
      if (payload.type === "function_call" && payload.name === "request_user_input_async") {
        let args: RecordValue = {};
        try { args = record(JSON.parse(string(payload.arguments))); } catch { continue; }
        const questions = Array.isArray(args.questions) ? args.questions.map(record) : [];
        questions.forEach((question, index) => scan.asked.push({
          key: `${string(payload.call_id)}:${index}`,
          title: string(question.title) || string(question.question),
          options: Array.isArray(question.options)
            ? question.options.map((option) => typeof option === "string" ? option : string(record(option).label)).filter(Boolean)
            : [],
        }));
      } else if (payload.type === "message" && payload.role === "user") {
        const reply = contentText(payload.content).trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
        let items: unknown = [];
        try { items = JSON.parse(reply?.[1] ?? "[]"); } catch { continue; }
        for (const item of Array.isArray(items) ? items : []) {
          // questionItemId: ["request_user_input_async", call id, question index]
          let id: unknown;
          try { id = JSON.parse(string(record(item).questionItemId)); } catch { continue; }
          if (Array.isArray(id) && typeof id[1] === "string" && Number.isInteger(id[2])) scan.answered.add(`${id[1]}:${id[2]}`);
        }
      }
    }
    scan.size += end;
  }
  questionScans.delete(path);
  questionScans.set(path, scan);
  if (questionScans.size > 16) questionScans.delete(questionScans.keys().next().value!);
  return scan.asked.filter((question) => !scan.answered.has(question.key));
}

const readdir = (path: string): string[] => { try { return readdirSync(path); } catch { return []; } };

/** A byte range of rollout history: the file's first `end` bytes. */
export interface HistorySegment { path: string; end: number }

/**
 * Chains per rollout, newest first. A header never changes, so a complete chain is
 * kept for good; one that stops at a cut no file holds yet is kept a short while,
 * so every append does not walk sessions/ again, and then looked up afresh.
 */
const historyChains = new Map<string, { chain: HistorySegment[]; complete: boolean; at: number }>();
const INCOMPLETE_CHAIN_MS = 30_000;

/** Drops every remembered chain: the next read resolves each one again. */
export function forgetHistoryChains(): void {
  historyChains.clear();
}

/** Drops one rollout's remembered chain: its next read resolves it again. */
export function forgetHistoryChain(path: string): void {
  historyChains.delete(path);
}

/** Everything remembered about one rollout: its chain, its question scan and any scan in flight. */
export function forgetCodexStateFor(path: string): void {
  historyChains.delete(path);
  questionScans.delete(path);
  questionScansInFlight.delete(path);
}

/** Every remembered chain and question scan: the next read resolves each one again. */
export function forgetAllCodexState(): void {
  historyChains.clear();
  questionScans.clear();
  questionScansInFlight.clear();
  linesBeforeCut.clear();
}

/** Lines before a cut, per file identity and cut: the bytes before a cut never change. */
const linesBeforeCut = new Map<string, number>();

function countLines(path: string, end: number): number {
  const stat = statSync(path);
  const key = `${stat.dev}:${stat.ino}:${end}`;
  const known = linesBeforeCut.get(key);
  if (known !== undefined) return known;
  const fd = openSync(path, "r");
  let lines = 0;
  try {
    const buffer = Buffer.alloc(16 * 1024 * 1024);
    for (let offset = 0; offset < end;) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (length === 0) break;
      for (let index = buffer.indexOf(0x0a, 0); index !== -1 && index < length; index = buffer.indexOf(0x0a, index + 1)) lines += 1;
      offset += length;
    }
  } finally { closeSync(fd); }
  linesBeforeCut.set(key, lines);
  if (linesBeforeCut.size > 256) linesBeforeCut.delete(linesBeforeCut.keys().next().value!);
  return lines;
}

function byteAt(path: string, offset: number): number | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1);
    return readSync(fd, buffer, 0, 1, offset) === 1 ? buffer[0]! : null;
  } finally { closeSync(fd); }
}

/** A rollout's first ordinal: where the history it continues ends, 0 for a whole history. */
function firstOrdinal(header: RecordValue): number {
  const ordinal = record(header.history_base).end_ordinal_exclusive;
  return typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : 0;
}

/**
 * Does `path` hold a cut at (ordinal, byte)? Every record is one line and a rollout's
 * ordinals start at its own first ordinal, so the cut must end a line with exactly
 * `ordinal - first` lines before it (checked on a three-rollout Codex 0.156 chain
 * against the turn offsets in its thread_history_1.sqlite).
 */
function holdsCut(path: string, ordinal: number, end: number): boolean {
  let header: RecordValue | null;
  try { header = rolloutHeader(path); } catch { return false; }
  if (header === null) return false;
  const lines = ordinal - firstOrdinal(header);
  if (lines <= 0 || (statSync(path, { throwIfNoEntry: false })?.size ?? 0) < end || byteAt(path, end - 1) !== 0x0a) return false;
  return countLines(path, end) === lines;
}

/** Every rollout of a thread: rollout-<time>-<thread>.jsonl and its rollout-<time>-<thread>_<segment>.jsonl. */
function threadRollouts(home: string, threadId: string): string[] {
  const sessions = join(home, "sessions");
  return readdir(sessions).flatMap((year) => readdir(join(sessions, year)).flatMap((month) =>
    readdir(join(sessions, year, month)).flatMap((day) => readdir(join(sessions, year, month, day))
      .filter((name) => name.endsWith(`-${threadId}.jsonl`) || name.includes(`-${threadId}_`))
      .map((name) => join(sessions, year, month, day, name)))));
}

/**
 * Paginated rollouts (Codex 0.156) do not copy history. A backtrack or fork starts
 * a new file whose session_meta.history_base names what it continues by thread,
 * ordinal and byte: the same thread before a backtrack, the parent after a fork.
 * The bytes past that cut are the turns the backtrack discarded. A thread can have
 * several rollouts (one per backtrack) and a later backtrack can cut into any of
 * them, so the one that continues is the one that holds the cut (holdsCut), never
 * guessed from names or sizes. A chain that stops at a cut no file holds shows
 * less history rather than the wrong one, and is looked up again next time.
 */
function historyChain(path: string, home: string): HistorySegment[] {
  const cached = historyChains.get(path);
  if (cached && (cached.complete || Date.now() - cached.at < INCOMPLETE_CHAIN_MS)) return cached.chain;
  const remember = (chain: HistorySegment[], complete: boolean): HistorySegment[] => {
    historyChains.delete(path);
    historyChains.set(path, { chain, complete, at: Date.now() });
    if (historyChains.size > 64) historyChains.delete(historyChains.keys().next().value!);
    return chain;
  };
  const chain: HistorySegment[] = [];
  let current = path;
  for (let depth = 0; depth < 32; depth++) {
    let base: RecordValue;
    try { base = record(rolloutHeader(current)?.history_base); } catch { return remember(chain, false); }
    const threadId = string(base.thread_id);
    const ordinal = base.end_ordinal_exclusive;
    const end = base.end_byte_offset;
    if (Object.keys(base).length === 0) return remember(chain, true);
    if (!UUID.test(threadId) || typeof ordinal !== "number" || !Number.isSafeInteger(ordinal)
      || typeof end !== "number" || !Number.isSafeInteger(end) || end <= 0) return remember(chain, false);
    const holders = threadRollouts(home, threadId).flatMap((candidate) => {
      const resolved = codexRolloutPath(candidate, home);
      return resolved !== null && resolved !== current && !chain.some((segment) => segment.path === resolved)
        && holdsCut(resolved, ordinal, end) ? [resolved] : [];
    });
    if (holders.length !== 1) return remember(chain, false);
    chain.push({ path: holders[0]!, end });
    current = holders[0]!;
  }
  return remember(chain, false);
}

/**
 * historyChain, for reading now: a remembered chain can outlive its files (a parent
 * archived since, moved out of sessions/). Then it is looked up again and comes back
 * shorter, so the stream's id changes and a cursor into the old chain answers 409 once.
 */
function liveChain(path: string, home: string): HistorySegment[] {
  const chain = historyChain(path, home);
  if (chain.every((segment) => statSync(segment.path, { throwIfNoEntry: false }))) return chain;
  forgetHistoryChain(path);
  return historyChain(path, home);
}

/** Whether every earlier rollout a conversation continues was found (historyChain), as of now. */
function chainComplete(path: string, home: string): boolean {
  liveChain(path, home);
  return historyChains.get(path)?.complete === true;
}

/** A Codex conversation's files oldest first, each with how many of its bytes belong to it. */
export function codexHistorySegments(path: string, home = defaultCodexHome()): HistorySegment[] {
  return [...liveChain(path, home)].reverse().concat({ path, end: statSync(path).size });
}

/**
 * The last `budget` bytes of a Codex conversation, across the earlier rollouts a
 * paginated one continues. A rollout can reach hundreds of MB while the chat
 * shows only its latest turns, so nothing before the budget is read.
 */
export function codexHistoryTail(path: string, budget: number, home = defaultCodexHome()): string {
  const chunks: string[] = [];
  let remaining = budget;
  for (const segment of [{ path, end: statSync(path).size }, ...liveChain(path, home)]) {
    if (remaining <= 0) break;
    const start = Math.max(0, segment.end - remaining);
    chunks.unshift(readRange(segment.path, start, segment.end));
    remaining -= segment.end - start;
  }
  return chunks.join("\n");
}

const normalizeDisplay = (text: string): string => text.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * What of an answer to look for on screen: its last 160 letters and digits. Codex shows a
 * markdown link as its label and the target relative to the cwd ("label (docs/x.md)" for
 * `[label](/repo/docs/x.md)`), so the text is cut at link targets, and the anchor is the end of
 * the last piece long enough. Without links, that is the end of the whole text. With the words
 * it is made of, for what another conversation's screen may show of it (mayShowWords).
 */
function answerAnchor(text: string): Anchor | null {
  const pieces = text.split(/\]\([^)\s]*\)/);
  for (let index = pieces.length - 1; index >= 0; index--) {
    const anchor = normalizeDisplay(pieces[index]!).slice(-160);
    if (anchor.length >= 64 && new Set(anchor).size >= 12) return { anchor, words: wordsEnding(pieces[index]!, anchor.length) };
  }
  return null;
}

interface Anchor { anchor: string; words: string[] }

/** The words a text ends with (runs of letters and digits), as many as make up its last `length` of them, the first cut to fit. */
function wordsEnding(text: string, length: number): string[] {
  const words = text.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const taken: string[] = [];
  for (let index = words.length - 1, left = length; index >= 0 && left > 0; index--) {
    const word = words[index]!;
    taken.push(word.length > left ? word.slice(-left) : word);
    left -= word.length;
  }
  return taken.reverse();
}

/** Shared app-server TUIs do not hold rollout descriptors. For read-only display,
 * require a unique substantial assistant-message match in this pane's output.
 * Directory recency alone is never evidence: multiple panes can share a cwd.
 * A `scrutinized` candidate (one only a title offered, from another folder) counts only on an
 * answer no other candidate ever gave, however long ago: one the others gave too is no proof the
 * pane shows it, and leaves the choice open rather than letting another win by elimination.
 * `said`: what candidates ever said, for those of which every word counts against the others
 * (loadedConversation), in place of their answers. `blocks`: the screen is shownAnswers', and an
 * answer counts only inside one of its blocks: Codex shows one answer as one block, so text that
 * runs across blocks is answers side by side, another conversation's. */
export function matchCodexTranscript(screen: string, candidates: { path: string; text: string }[], scrutinized: ReadonlySet<string> = new Set(), said: ReadonlyMap<string, Said> = new Map(), blocks = false): string | null {
  const lastHeader = screen.lastIndexOf("OpenAI Codex (v");
  const displays = blocks ? screen.split(/\n(?=\u2022)/).map(normalizeDisplay) : [normalizeDisplay(lastHeader >= 0 ? screen.slice(lastHeader) : screen)];
  const answersOf = (turns: ConversationTurn[]) => turns.filter((turn) => turn.role === "assistant")
    .flatMap((turn) => turn.parts).filter((part) => part.kind === "text").map((part) => part.text);
  const parsed = candidates.map((candidate) => parseCodexTranscript(candidate.text, Infinity));
  // every answer each candidate gave, as answerAnchor reads one (cut at link targets), read once
  let shown: Said[] | undefined;
  const givenElsewhere = (index: number, { anchor, words }: Anchor) => (shown ??= parsed.map((turns, at) =>
    said.get(candidates[at]!.path) ?? { text: answersOf(turns).flatMap(saidText).join(""), ends: [] }))
    .some((given, at) => at !== index && (given.text.includes(anchor) || mayShowWords(words, given)));
  const matching = new Set<string>();
  let open = false;
  for (const [index, candidate] of candidates.entries()) {
    const anchors = answersOf(parsed[index]!.slice(-100)).slice(-8).map(answerAnchor)
      .filter((found): found is Anchor => found !== null && displays.some((display) => display.includes(found.anchor)));
    if (anchors.length === 0) continue;
    if (!scrutinized.has(candidate.path) || anchors.some((anchor) => !givenElsewhere(index, anchor))) matching.add(candidate.path);
    else open = true;
  }
  return !open && matching.size === 1 ? [...matching][0]! : null;
}

/** Text as an answer's anchor is looked for in it (answerAnchor): cut at link targets, each piece letters and digits. */
function saidText(text: string): string[] {
  return text.split(LINK_TARGET).map(normalizeDisplay);
}

/** A markdown link's target, as answerAnchor cuts a text at it. */
const LINK_TARGET = /\]\([^)\s]*\)/;

/**
 * What a conversation said, as saidText reads it, joined, and where each of its records ends in it
 * (`ends`; for one of which every word counts against the others, loadedConversation).
 */
interface Said { text: string; ends: readonly number[] }

/** More records than this to weigh an anchor's words in, or more text, and a conversation may show it (mayShowWords). */
const WORD_CHECKS = 2048;
const WORD_BUDGET = 1 << 23;

/**
 * Whether another conversation's screen may show an answer made of these words (an anchor's).
 * Codex renders an answer's markdown, so a screen may show its words in another order (a table's
 * rows as records), without what it leaves out or decodes (a link's folder, a query, an entity)
 * and with words joined (emphasis inside a word), but each word it shows of a record is in that
 * record's text: it may when one of its records holds every word. Past WORD_CHECKS records that
 * hold each of its longest three words, or WORD_BUDGET letters and digits weighed, it may.
 */
function mayShowWords(words: readonly string[], { text, ends }: Said): boolean {
  const last = ends.at(-1);
  if (last === undefined || words.length === 0) return false;
  // longest first: likeliest missing from a record that does not hold them all
  const longest = [...new Set(words)].sort((one, other) => other.length - one.length);
  // a record with a named entity may show a word only through it (ENTITY): weighed whatever else it holds
  const entities = text.lastIndexOf(ENTITY, last - 1) >= 0;
  // looked for at the rarest of the longest three: a record without one of them holds not all
  let rarest: string | null = longest[0]!;
  let fewest = Infinity;
  for (const word of longest.slice(0, 3)) {
    let count = 0;
    for (let at = text.indexOf(word); at >= 0 && at < last && count <= WORD_CHECKS; at = text.indexOf(word, at + 1)) count++;
    if (count === 0) {
      if (!entities) return false;
      rarest = null;
      break;
    }
    if (count < fewest) {
      fewest = count;
      rarest = word;
    }
  }
  if (rarest !== null && fewest > WORD_CHECKS) return true;
  const weighedRecords = new Set<number>();
  let weighed = 0;
  const steps = { left: ENTITY_STEPS };
  for (const needle of [rarest, entities ? ENTITY : null]) {
    if (needle === null) continue;
    for (let at = text.indexOf(needle); at >= 0 && at < last;) {
      // the record it is in: the first to end past it
      let record = 0;
      for (let high = ends.length - 1; record < high;) {
        const middle = (record + high) >> 1;
        if (ends[middle]! > at) high = middle;
        else record = middle + 1;
      }
      at = text.indexOf(needle, ends[record]!);
      if (weighedRecords.has(record)) continue;
      weighedRecords.add(record);
      const said = text.slice(record > 0 ? ends[record - 1]! : 0, ends[record]!);
      weighed += said.length;
      if (weighedRecords.size > WORD_CHECKS || weighed > WORD_BUDGET) return true;
      if (longest.every((word) => said.includes(word) || (said.includes(ENTITY) && throughEntities(said, word, steps)))) return true;
    }
  }
  return false;
}

/**
 * Where a record's text has a named entity (`&eacute;`), the form readSaid keeps of it has this in
 * its place: Codex shows it as up to a few letters (a ligature, an accented letter) or none.
 */
const ENTITY = "\uE000";

/** Steps of ENTITY matching (throughEntities) one weighing may take; past them, a record may show the word. */
const ENTITY_STEPS = 1 << 20;

/**
 * Whether `text` holds `word`, each ENTITY in it standing for up to three of its letters or none;
 * also once `steps` run out.
 */
function throughEntities(text: string, word: string, steps: { left: number }): boolean {
  for (let entity = text.indexOf(ENTITY); entity >= 0; entity = text.indexOf(ENTITY, entity + 1)) {
    // a match through this entity begins at most a word's length before it
    for (let start = Math.max(0, entity - word.length); start <= entity; start++) {
      let reached = new Set([0]);
      for (let at = start; at < text.length && reached.size > 0 && at - start <= 4 * word.length; at++) {
        if (--steps.left < 0) return true;
        const next = new Set<number>();
        for (const done of reached) {
          if (text[at] === ENTITY) for (let more = 0; more <= 3 && done + more <= word.length; more++) next.add(done + more);
          else if (word[done] === text[at]) next.add(done + 1);
        }
        if (next.has(word.length)) return true;
        reached = next;
      }
    }
  }
  return false;
}

/** A text with each named entity as ENTITY and the rest as normalizeDisplay reads it, or "" for one without any. */
function entityForm(text: string): string {
  const pieces = text.split(/&[A-Za-z][A-Za-z0-9]{1,31};/);
  return pieces.length > 1 ? pieces.map(normalizeDisplay).join(ENTITY) : "";
}

/**
 * A text cut at its markdown link targets: each stretch of text with the target that follows it
 * ("" after the last). A scan, not a split at /\]\([^)\s]*\)/: that rescans to the end of the
 * text from every "](" no ")" closes, quadratic in a text full of them.
 */
function cutAtLinkTargets(text: string): { text: string; target: string }[] {
  const pieces: { text: string; target: string }[] = [];
  let start = 0;
  let search = 0;
  for (let at = text.indexOf("](", search); at >= 0; at = text.indexOf("](", search)) {
    let end = at + 2;
    while (end < text.length && text[end] !== ")" && !/\s/.test(text[end]!)) end++;
    // unclosed: no "](" before `end` is closed either, so all of it stays text
    if (text[end] !== ")") { search = end; continue; }
    pieces.push({ text: text.slice(start, at), target: text.slice(at + 2, end) });
    start = search = end + 1;
  }
  pieces.push({ text: text.slice(start), target: "" });
  return pieces;
}

/**
 * An answer as the screen shows it, for matchShortCodexAnswers: its last 160 letters and digits.
 * null for one with a link: Codex shows `[label](target)` as "label (target)" with the target its
 * own way, so the answer is not one run of text there, and its pieces alone are short common words.
 */
function shownAnswer(text: string): string | null {
  return cutAtLinkTargets(text).length > 1 ? null : normalizeDisplay(text).slice(-160);
}

/**
 * A rollout's newest answers on screen, newest lowest: whole answers taken from the end of the
 * rollout one after another (the very newest may be skipped: it may not be rendered yet, or hold
 * a link), each at least 16 letters and digits, found bottom-up in order, until at least two of
 * them hold 64 with 12 distinct. The answers that did, or null. A gap ends the run: an answer of
 * the rollout not on screen means the screen is not showing this rollout's end.
 */
function newestAnswersShown(display: string, answers: string[]): string[] | null {
  const newest = answers.slice(-5).map(shownAnswer).reverse();
  for (const skip of [0, 1]) {
    let before = display.length;
    const shown: string[] = [];
    for (const answer of newest.slice(skip, skip + 4)) {
      const at = answer === null || answer.length < 16 || answer.length > before ? -1 : display.lastIndexOf(answer, before - answer.length);
      if (at < 0) break;
      before = at;
      shown.push(answer!);
      const joined = shown.join("");
      if (shown.length >= 2 && joined.length >= 64 && new Set(joined).size >= 12) return shown;
    }
  }
  return null;
}

/**
 * The last resort for a pane nothing else ties to a rollout (codexTranscriptPath): a session
 * whose answers are all short never has an anchor for matchCodexTranscript, yet its newest
 * answers on screen together say as much as one long one (#283). Weaker evidence, so it gives
 * up readily: every candidate must have been read whole (none `cut`: past the read budget, or
 * continuing another rollout, whose answers it shares), only one may show that way, and no other
 * may have said any of the answers it showed, alone or inside a longer one.
 */
export function matchShortCodexAnswers(screen: string, candidates: { path: string; text: string; cut?: boolean }[]): string | null {
  if (candidates.some((candidate) => candidate.cut)) return null;
  const lastHeader = screen.lastIndexOf("OpenAI Codex (v");
  const display = normalizeDisplay(lastHeader >= 0 ? screen.slice(lastHeader) : screen);
  // every turn of what was read, not the newest 100: an answer said long ago is said
  const answers = candidates.map((candidate) => parseCodexTranscript(candidate.text, Infinity).filter((turn) => turn.role === "assistant")
    .flatMap((turn) => turn.parts).flatMap((part) => part.kind === "text" ? [part.text] : []));
  let found: { index: number; shown: string[] } | null = null;
  for (const [index, own] of answers.entries()) {
    const shown = newestAnswersShown(display, own);
    if (shown === null) continue;
    if (found !== null) return null;
    found = { index, shown };
  }
  if (found === null) return null;
  const { index: only, shown } = found;
  for (const [index, other] of answers.entries()) {
    if (index === only) continue;
    const said = normalizeDisplay(other.join("\n"));
    if (shown.some((answer) => said.includes(answer))) return null;
    // an answer of the other with links shows as its text around them, the targets Codex's own
    // way: when that text is all in a shown answer, in order, the screen may be showing the other
    // every such answer of what was read, however short its text or many its links: one left
    // unchecked is one the screen may be showing
    for (const text of other) {
      const pieces = cutAtLinkTargets(text);
      if (pieces.length < 2) continue;
      const around = pieces.map((piece) => normalizeDisplay(piece.text)).filter((piece) => piece !== "");
      if (around.length === 0) continue;
      if (shown.some((answer) => { let from = 0; return around.every((piece) => { const at = answer.indexOf(piece, from); from = at + piece.length; return at >= 0; }); })) return null;
    }
  }
  return candidates[only]!.path;
}

interface CodexExchange { user: string; assistant: string }
interface CodexFirstExchangeCandidate {
  path: string;
  text: string;
  firstUserMessage?: string | null;
  createdAtMs?: number;
}

const normalizePrompt = (text: string): string => text.trim().replace(/\s+/g, " ");

/** User/assistant exchanges as recorded, retaining later prompts as competing evidence. */
function codexExchanges(text: string): CodexExchange[] {
  const turns = parseCodexTranscript(text, Infinity);
  const exchanges: CodexExchange[] = [];
  let user: string | null = null;
  let assistant: string[] = [];
  const finish = () => {
    if (user !== null) exchanges.push({ user, assistant: assistant.join("\n") });
  };
  for (const turn of turns) {
    if (turn.role === "user" && turn.parts.every((part) => part.kind === "task_result" || part.kind === "notice")) continue;
    const prose = turn.parts.flatMap((part) => part.kind === "text" ? [part.text] : []).join("\n");
    if (turn.role === "user") {
      finish();
      user = prose;
      assistant = [];
    } else if (user !== null && prose !== "") assistant.push(prose);
  }
  finish();
  return exchanges;
}

/** The first top-level prompt and its following assistant output, after this TUI's header. */
function displayedFirstExchange(screen: string, keepCompletionFooter = false): CodexExchange | null {
  const header = screen.lastIndexOf("OpenAI Codex (v");
  if (header < 0) return null;
  const lines = screen.slice(header).split(/\r?\n/);
  let promptAt = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^• (?:Model changed|Unrecognized command|Working directory changed)(?:[ \t]|$)/.test(line)) continue;
    if (/^•(?:[ \t]|$)/.test(line)) return null;
    if (/^›[ \t]+/.test(line)) { promptAt = index; break; }
  }
  if (promptAt < 0) return null;
  let answerAt = -1;
  for (let index = promptAt + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (/^›[ \t]+/.test(line)) return null;
    if (/^•(?:[ \t]|$)/.test(line)) { answerAt = index; break; }
  }
  if (answerAt < 0) return null;
  const user = lines.slice(promptAt, answerAt).map((line, index) => index === 0 ? line.slice(1) : line).join("\n");
  const nextPrompt = lines.findIndex((line, index) => index > answerAt && /^›(?:[ \t]|$)/.test(line));
  const responseLines = lines.slice(answerAt, nextPrompt < 0 ? undefined : nextPrompt);
  // Codex's completed-turn footer is terminal chrome, after a blank line and before the composer.
  const footer = responseLines.findIndex((line, index) => index > 0 && responseLines[index - 1]!.trim() === ""
    && /^[ \t]*Worked for <?\d+(?:ms|s|m|h)(?: \d+(?:ms|s|m|h))*(?: • \d{1,2}:\d{2}(?: [AP]M)?)?[ \t]*$/.test(line)
    && responseLines.slice(index + 1).every((after) => after.trim() === ""));
  const response = (footer < 0 || keepCompletionFooter ? responseLines : responseLines.slice(0, footer))
    .map((line) => /^•/.test(line) ? line.slice(1) : line).join("\n");
  return { user, assistant: response };
}

function matchingCodexExchanges(screen: string, candidates: readonly CodexFirstExchangeCandidate[], answerFloor: number): { candidate: CodexFirstExchangeCandidate; index: number }[] {
  const shown = displayedFirstExchange(screen);
  if (shown === null) return [];
  const prompt = normalizePrompt(shown.user);
  const answer = normalizePrompt(shown.assistant);
  if (prompt === "" || normalizeDisplay(answer).length < answerFloor) return [];
  const matches: { candidate: CodexFirstExchangeCandidate; index: number }[] = [];
  for (const candidate of candidates) {
    for (const [index, exchange] of codexExchanges(candidate.text).entries()) {
      const recordedPrompt = normalizePrompt(exchange.user);
      const recordedAnswer = normalizePrompt(exchange.assistant);
      if (recordedPrompt === prompt && recordedAnswer !== ""
        && (answer.includes(recordedAnswer) || recordedAnswer.includes(answer))) {
        matches.push({ candidate, index });
      }
    }
  }
  return matches;
}

/**
 * Match a submitted first prompt and its answer only when no competing exchange explains it.
 * `excluded`: threads other panes hold by stronger evidence, not begun here: they still
 * compete as exchanges, and are never the answer.
 */
export function matchCodexFirstExchange(
  screen: string,
  candidates: readonly CodexFirstExchangeCandidate[],
  startedAtMs: number,
  excluded: ReadonlySet<string> = new Set(),
): string | null {
  if (!Number.isFinite(startedAtMs)) return null;
  if (candidates.filter((candidate) => typeof candidate.createdAtMs === "number"
    && candidate.createdAtMs >= startedAtMs && !excluded.has(candidate.path)).length !== 1) return null;
  const matches = matchingCodexExchanges(screen, candidates, 1);
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const first = codexExchanges(match.candidate.text)[0];
  const storedPrompt = normalizePrompt(match.candidate.firstUserMessage ?? "");
  const shown = displayedFirstExchange(screen);
  const shownWithFooter = displayedFirstExchange(screen, true);
  if (match.index !== 0 || first === undefined || shown === null || shownWithFooter === null
    || storedPrompt === ""
    || normalizePrompt(first.user) !== storedPrompt
    || (normalizePrompt(first.assistant) !== normalizePrompt(shown.assistant)
      && normalizePrompt(first.assistant) !== normalizePrompt(shownWithFooter.assistant))
    || typeof match.candidate.createdAtMs !== "number"
    || !Number.isFinite(match.candidate.createdAtMs) || match.candidate.createdAtMs < startedAtMs
    || excluded.has(match.candidate.path)) return null;
  return match.candidate.path;
}

/** Codex's thread-id title item as 0.163.0 shows it: the whole id, or its first 29 characters and "...". */
const TITLE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-(?:[0-9a-f]{12}|[0-9a-f]{5}\.\.\.))$/i;

/**
 * The thread id, or the start of one, that Codex's opt-in `thread-id` title item ("Current thread
 * identifier", [tui].terminal_title) shows in a Codex TUI's terminal title as herdr reports it. Codex
 * joins its items with " | ", the activity spinner first with a space: only an item that is exactly a
 * whole id or Codex's shortened form counts, and only one such item; an id inside other text is a name.
 */
export function titledThread(title: string | null | undefined): string | null {
  const ids = (title ?? "").split(" | ").flatMap((item, index) =>
    TITLE_ID.exec((index === 0 ? item.replace(/^[\u2800-\u28ff]\s+/, "") : item).trim())?.[1] ?? []);
  return ids.length === 1 ? ids[0]!.toLowerCase().replace(/\.\.\.$/, "") : null;
}

/**
 * What Codex drops from a terminal title (codex-rs rust-v0.163.0, tui/src/terminal_title.rs,
 * is_disallowed_terminal_title_char): control characters and invisible or bidi formatting ones.
 * Whitespace among them is not dropped but turned into a space, as Codex looks at it first.
 */
const TITLE_DROPPED = /(?!\p{White_Space})[\p{Cc}\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u{1BCA0}-\u{1BCA3}\u{E0100}-\u{E01EF}]/gu;

/** What Codex writes under GNU Screen (STY) for the activity spinner and its dot; any other non-ASCII character is "?". */
const SCREEN_TITLE: Readonly<Record<string, string>> = {
  "\u280b": "|", "\u283c": "|", "\u2807": "|", "\u2819": "/", "\u2834": "/", "\u280f": "/",
  "\u2839": "-", "\u2826": "-", "\u2838": "\\", "\u2827": "\\", "\u25cf": "*",
};

/**
 * Text as Codex writes it into a terminal title (sanitize_terminal_title, the same file): those
 * characters dropped, whitespace runs one space; under GNU Screen, printable ASCII only.
 */
export function asCodexTitle(text: string, screen = false): string {
  const shown = text.replace(TITLE_DROPPED, "").replace(/\p{White_Space}+/gu, " ").trim();
  return screen ? shown.replace(/[^\x00-\x7f]/gu, (character) => SCREEN_TITLE[character] ?? "?") : shown;
}

/**
 * The rollout of the one unarchived thread the store holds under the id (or the start of one) a
 * Codex pane's title shows (titledThread), while a Codex process runs in the pane. Unlike the
 * command line, the title follows /new and a resume through the picker, from any folder (#896).
 * It is only a candidate for the screen to match, never taken on the title alone. The same text in
 * the pane's folders, or in any stored thread's folder or name, as Codex writes them into the title
 * (asCodexTitle), may be its project or thread name rather than its thread-id item (a folder named
 * after a thread): then the title tells nothing.
 */
function titledCandidate(agent: Pick<AgentInfo, "terminal_title" | "terminal_title_stripped" | "cwd" | "foreground_cwd">, codexProcesses: readonly unknown[], db: Database, home: string): string | null {
  const id = titledThread(agent.terminal_title_stripped ?? agent.terminal_title);
  if (id === null || codexProcesses.length === 0) return null;
  // as Codex writes it, under GNU Screen too (STY), where some of its characters become "-"; without
  // its spaces, as at its 240-character cap Codex drops a space before the last character it writes
  const shows = (text: string | null | undefined) => typeof text === "string"
    && [false, true].some((screen) => asCodexTitle(text, screen).replaceAll(" ", "").toLowerCase().includes(id));
  if ([agent.cwd, agent.foreground_cwd].some(shows)) return null;
  const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('threads')").all().map((column) => column.name));
  const named = ["cwd", "name", "title"].filter((column) => columns.has(column));
  // the text itself without its spaces, or any text with a character outside printable ASCII (all
  // Codex drops or turns into "-" is), which is then read as Codex would write it; SQLite's text
  // functions stop at a NUL, so that one is looked for in the bytes
  const texts = named.length === 0 ? [] : db.query<Record<string, string | null>, string[]>(
    `SELECT ${named.join(", ")} FROM threads WHERE ${named.map((column) =>
      `instr(lower(replace(${column}, ' ', '')), ?) > 0 OR ${column} GLOB '*[^ -~]*' OR instr(CAST(${column} AS BLOB), X'00') > 0`).join(" OR ")}`,
  ).all(...named.map(() => id));
  if (texts.some((row) => named.some((column) => shows(row[column])))) return null;
  // ids are lowercase hex and dashes, all before "g": the range is every id that starts with this one
  const rows = db.query<{ rollout_path: string }, [string, string]>(
    "SELECT rollout_path FROM threads WHERE id >= ? AND id < ? AND archived = 0 LIMIT 2",
  ).all(id, `${id}g`);
  return rows.length === 1 ? codexRolloutPath(rows[0]!.rollout_path, home) : null;
}

/**
 * The history id of the conversation a Codex started in a terminal has not begun, or null unless
 * every fact says it has begun none (#1191). This server did not start it (launched-agents.ts),
 * herdr reports no session for it, and nothing was matched to it; what tells instead:
 *
 * - its screen is its start screen with nothing said yet (codexStartScreenUnused);
 * - its processes were started on no conversation: no `resume` or `fork` on their command lines,
 *   since the picker either opens shows a conversation that exists;
 * - its store holds no interactive thread of its folder with a first message, begun or written
 *   since it started (no later than its start: processStartLowerBound), so no first message of
 *   its own and no conversation it resumed and wrote to. One another pane began there since
 *   counts too: which pane's it is cannot be told here. A thread with no message yet holds no
 *   conversation, whoever made it. That store is an explicit one (`configured`), else the one
 *   its own environment names for certain (certainProcessCodexHome), on every platform.
 *
 * A start time, a home or a store that cannot be read says nothing, and then neither does this. The id
 * names the pane and its processes, never a time: a start read on macOS moves between reads.
 */
export async function codexFreshSession(paneId: string, cwds: readonly string[], configured: string | undefined, screen: string): Promise<string | null> {
  if (!codexStartScreenUnused(screen)) return null;
  const { list, key } = await codexProcessesOf(paneId).catch(() => ({ list: [], key: "" }));
  if (list.length === 0 || list.some((codex) => (codex.argv ?? []).some((word) => word === "resume" || word === "fork"))) return null;
  // an explicit store wins, as in paneCodexHome. Else every Codex's home must be placed for
  // certain, and the first decides: one paneCodexHome cannot place (a relative CODEX_HOME) falls
  // back to the default store, where this pane's conversation is not
  let home = configured;
  if (home === undefined) {
    const homes = await Promise.all(list.map((codex) => certainProcessCodexHome(codex.pid, codex.argv ?? [])));
    const [first] = homes;
    if (first == null || homes.some((known) => known === null)) return null;
    home = first;
  }
  const starts = list.map((codex) => processStartLowerBound(codex.pid));
  if (starts.some((started) => started === null)) return null;
  // whole seconds, and one more: a start read anew may land in the second before
  const since = Math.floor(Math.min(...(starts as number[])) / 1000) - 1;
  const store = join(home, "state_5.sqlite");
  let db: Database | undefined;
  try {
    // a store Codex has not made yet holds no thread
    if (statSync(store, { throwIfNoEntry: false }) !== undefined) {
      db = new Database(store, { readonly: true, create: false });
      // each folder the pane names (its shell's, its foreground process's), as given and as it
      // resolves: Codex may have stored any of them
      const named = cwds.filter((cwd) => cwd.length > 0);
      if (named.length === 0) return null;
      const folders = [...new Set(named.flatMap((cwd) => {
        try { return [cwd, realpathSync(cwd)]; } catch { return [cwd]; }
      }))].map((folder) => storedCwdCondition(folder));
      const said = db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'first_user_message'").get() !== null ? " AND COALESCE(first_user_message, '') <> ''" : "";
      const begun = db.query<unknown, (string | number)[]>(
        `SELECT 1 FROM threads WHERE (${folders.map((folder) => folder.where).join(" OR ")}) AND archived = 0 AND agent_role IS NULL${interactive(db)}${said} AND max(COALESCE(created_at, 0), COALESCE(updated_at, 0)) >= ? LIMIT 1`,
      ).get(...folders.flatMap((folder) => folder.params), since);
      if (begun !== null) return null;
    }
  } catch { return null; }
  finally { db?.close(); }
  return `unwritten:codex:${paneId}:${key}`;
}

/** `codex resume <thread>`: the thread a TUI was started on, straight from its command line. */
export function resumedThread(argvs: readonly (readonly string[])[]): string | null {
  for (const argv of argvs) {
    const at = argv.indexOf("resume");
    const thread = at < 0 ? undefined : argv[at + 1];
    if (thread !== undefined && UUID.test(thread)) return thread;
  }
  return null;
}

/** A lock Codex takes for a thread it loads to write: `<thread>.lock` in `thread-writer-locks`. */
const WRITER_LOCK = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
/** More threads loaded at once than this, and none of them is offered (loadedRollouts). */
const HELD_THREAD_LIMIT = 32;

/**
 * The ids of the threads a Codex process of this store has loaded right now, each with when it was
 * loaded. Codex creates and locks `thread-writer-locks/<thread>.lock` for each thread it loads to
 * write, keeps the lock while the thread stays loaded and removes the file when it unloads it
 * (codex-rs rust-v0.163.0, rollout/src/writer_lock.rs), so the file's change time is when it was
 * loaded (or earlier, for one a crash left behind); the shared app-server daemon holds it for every
 * TUI it serves, so the conversation a TUI shows is always among them. `exec` when only `codex
 * exec` runs hold it (execRun): exec runs its app server in its own process (exec/src/lib.rs).
 * On Linux a lock counts when the kernel's lock table (/proc/locks) has a write flock on the
 * file's inode by a process that has that very file open; on macOS, a file a process has open
 * there (lsof). null where neither can be read (Windows).
 */
async function heldThreadIds(home: string): Promise<Map<string, { loadedAt: number; exec: boolean }> | null> {
  if (process.platform !== "linux" && process.platform !== "darwin") return null;
  let folder: string;
  try { folder = realpathSync(join(home, "thread-writer-locks")); } catch { return new Map(); }
  const held = new Map<string, { loadedAt: number; exec: boolean }>();
  const hold = (id: string, loadedAt: number, exec: boolean) => held.set(id, { loadedAt, exec: exec && (held.get(id)?.exec ?? true) });
  if (process.platform === "darwin") {
    // no -b here (openRollouts has it): +d must stat the folder, which -b forbids (lsof 4.91)
    const child = Bun.spawn(["/usr/sbin/lsof", "-nPw", "-Fn", "+d", folder], { stdout: "pipe", stderr: "ignore" });
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, 3000);
    const holders: { id: string; born: number; pid: string }[] = [];
    try {
      const text = await new Response(child.stdout).text();
      // lsof exits 1 when no process has a file open there; a list cut short leaves a thread out
      if (await child.exited > 1 || killed) return null;
      let pid = "";
      for (const line of text.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        const id = line.startsWith("n") && nodePath.dirname(line.slice(1)) === folder ? WRITER_LOCK.exec(nodePath.basename(line))?.[1] : undefined;
        if (id === undefined) continue;
        let born = 0;
        try { born = statSync(line.slice(1)).ctimeMs; } catch { /* unloaded meanwhile: loaded at the earliest */ }
        holders.push({ id: id.toLowerCase(), born, pid });
      }
    } finally { clearTimeout(timer); }
    const runs = await execRuns(holders.map((holder) => holder.pid));
    for (const { id, born, pid } of holders) hold(id, born, runs.has(pid));
    return held;
  }
  const named = new Map<string, string>();
  const born = new Map<string, number>();
  for (const name of readdirSync(folder)) {
    if (!WRITER_LOCK.test(name)) continue;
    try {
      const file = statSync(join(folder, name), { bigint: true });
      named.set(file.ino.toString(), name);
      born.set(name, Number(file.ctimeMs));
    } catch { /* unlocked and removed meanwhile */ }
  }
  if (named.size === 0) return held;
  let table: string;
  try { table = readFileSync("/proc/locks", "utf8"); } catch { return null; }
  // the lock files each holder has open: inode numbers are only unique within a file system
  const openBy = new Map<string, Set<string>>();
  for (const line of table.split("\n")) {
    // a held write flock: one a process waits for reads "N: -> FLOCK ..."
    const lock = /^\d+:\s+FLOCK\s+\S+\s+WRITE\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/.exec(line);
    const name = lock ? named.get(lock[2]!) : undefined;
    if (lock === null || name === undefined) continue;
    let names = openBy.get(lock[1]!);
    if (names === undefined) {
      names = new Set();
      openBy.set(lock[1]!, names);
      try {
        for (const descriptor of readdirSync(`/proc/${lock[1]}/fd`)) {
          try {
            const target = readlinkSync(`/proc/${lock[1]}/fd/${descriptor}`);
            if (nodePath.dirname(target) === folder) names.add(nodePath.basename(target));
          } catch { /* closed while listing */ }
        }
      } catch (error) {
        // gone, and its lock with it; another user's process: what it holds cannot be told, and a
        // thread left out could be the one a pane shows
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
    }
    if (names.has(name)) hold(name.slice(0, -".lock".length).toLowerCase(), born.get(name) ?? 0, execRun(readArgv(lock[1]!)));
  }
  return held;
}

/** A process's arguments on Linux, none when they cannot be read. */
function readArgv(pid: string): string[] {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0"); } catch { return []; }
}

/**
 * Which of these processes are `codex exec` runs (execRun), on macOS: `ps` joins the arguments with
 * spaces, so a binary whose path holds one is not taken for one.
 */
async function execRuns(pids: readonly string[]): Promise<Set<string>> {
  const runs = new Set<string>();
  const listed = [...new Set(pids)].filter((pid) => /^\d+$/.test(pid));
  if (listed.length === 0) return runs;
  const child = Bun.spawn(["/bin/ps", "-ww", "-o", "pid=,command=", "-p", listed.join(",")], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => child.kill(), 3000);
  try {
    const text = await new Response(child.stdout).text();
    await child.exited;
    for (const line of text.split("\n")) {
      const [pid, ...argv] = line.trim().split(/\s+/);
      if (pid !== undefined && execRun(argv)) runs.add(pid);
    }
  } catch { /* none taken for one */ }
  finally { clearTimeout(timer); }
  return runs;
}

/**
 * A `codex exec` run's process, which shows an answer only once it has written it: `exec` (or its
 * alias `e`) the first argument of Codex's binary, the only process that holds its locks. Not the
 * thread's `source`: the picker resumes an exec run's thread in a TUI too
 * (`--include-non-interactive`), and its row still says exec.
 */
const execRun = (argv: readonly string[]) => argv[1] === "exec" || argv[1] === "e";

/** A thread a Codex process has loaded (loadedRollouts). */
interface LoadedThread {
  /** whether a pane may be showing it */
  offered: boolean;
  /** the files its history is in (codexHistorySegments), found whole */
  segments: HistorySegment[];
  /** held by a `codex exec` run (execRun), which shows an answer only once it has written it */
  exec: boolean;
  /** when it was loaded (heldThreadIds) */
  loadedAt: number;
}

/**
 * The rollouts of every thread a Codex process of this store has loaded right now (heldThreadIds),
 * each with the files its history is in (codexHistorySegments) and whether a pane may be showing it: an interactive, unarchived conversation, where a
 * subagent's or a `codex exec` run's thread only competes. Codex has locked threads so since before
 * its shared app-server daemon (rust-v0.155.0; the daemon came in 0.157), so the conversation a TUI
 * shows is always one of them, from any folder, the one a resume through the picker opened included
 * (#896). null when that cannot be read, when one of them has no row or no rollout in the store, or
 * misses an earlier rollout it continues, or when more than 32 are loaded: one left out, or what it
 * said, could be the one a pane shows, and another would then win by elimination.
 */
async function loadedRollouts(home: string): Promise<Map<string, LoadedThread> | null> {
  const ids = await heldThreadIds(home);
  if (ids === null || ids.size > HELD_THREAD_LIMIT) return null;
  const loaded = new Map<string, LoadedThread>();
  if (ids.size === 0) return loaded;
  let db: Database | undefined;
  try {
    db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
    const list = [...ids.keys()];
    const rows = db.query<{ id: string; rollout_path: string; offered: number }, string[]>(
      `SELECT id, rollout_path, (archived = 0 AND agent_role IS NULL${interactive(db)}) AS offered FROM threads WHERE lower(id) IN (${list.map(() => "?").join(", ")})`,
    ).all(...list);
    if (new Set(rows.map((row) => row.id.toLowerCase())).size !== ids.size) return null;
    for (const row of rows) {
      const path = storeRolloutPath(row.rollout_path, home);
      if (path === null) return null;
      // the files its history is read from, every earlier rollout it continues among them: one gone
      // would leave out what it said there
      const segments = codexHistorySegments(path, home);
      if (!chainComplete(path, home)) return null;
      const holder = ids.get(row.id.toLowerCase());
      loaded.set(path, {
        offered: row.offered === 1 && codexRolloutPath(path, home) !== null,
        segments,
        exec: holder?.exec ?? false,
        loadedAt: holder?.loadedAt ?? 0,
      });
    }
    return loaded;
  } catch { return null; }
  finally { db?.close(); }
}

/**
 * The record types a rollout keeps what it said in (messages, tool calls, reasoning, completed items)
 * and its turns in, as Codex writes them, looked for before a line is parsed.
 */
const SAID_RECORDS = ['"type":"message"', '"type":"user_message"', '"type":"agent_message"', '"type":"item_completed"',
  '_call"', '"type":"reasoning"', '"type":"agent_reasoning', '"type":"task_started"', '"type":"task_complete"',
  '"type":"turn_started"', '"type":"turn_complete"', '"type":"turn_aborted"']
  .map((marker) => Buffer.from(marker));
/**
 * What a rollout file said up to `offset` (whole lines), joined in `text`, each record with where its
 * line ends in the file and where it ends in `text`; and its turns as far as read (turnAfter).
 */
interface SaidScan {
  ino: number;
  offset: number;
  said: { end: number; at: number }[];
  text: string;
  /** a turn begun and not ended */
  running: boolean;
  /** when its last turn interrupted or failed ended, 0 for none */
  abortedAt: number;
}
const saidScans = new Map<string, SaidScan>();

/** Every string in a value, however deep. */
const stringsIn = (value: unknown): string[] => typeof value === "string" ? [value]
  : value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsIn) : [];

/**
 * Every string of every record in what was read of a rollout (codexHistoryTail), whole, as saidText
 * reads it: a tool's output and a command as much as a message. The chat's own reading of them
 * shortens a long output, which another conversation's screen may show the end of.
 */
function tailSaid(text: string): string {
  return text.split("\n").flatMap((line) => deepStrings(parseJson(line)).flatMap(saidText)).join("");
}

const parseJson = (json: string): unknown => { try { return JSON.parse(json); } catch { return undefined; } };

/**
 * Every string in a value, however deep, and those of JSON a string holds: a tool call's arguments
 * are JSON in a string, whose escapes (a "\n") would read as letters.
 */
const deepStrings = (value: unknown): string[] => stringsIn(value)
  .flatMap((string) => /^\s*[[{]/.test(string) ? [string, ...deepStrings(parseJson(string))] : [string]);

/** What a completed item holds of its output, which a screen shows below an indented "\u2514 " if at all. */
const ITEM_OUTPUTS = new Set(["aggregated_output", "formatted_output", "output", "result", "stdout", "stderr", "model_context"]);

/**
 * What one rollout line said: a message, with the forms the chat shows it in too, a tool call or
 * reasoning; never a tool's output.
 */
function lineForms(value: unknown): string[] {
  return lineTexts(value).flatMap((text) => [...new Set([text, withoutMemoryCitations(text), questionReply(text) ?? "", decoded(text), shownMarkup(text)])]);
}

/**
 * A text with markdown a screen does not show as written: a reference link's `[name]` and its
 * definition left out (which would split a word of a script without spaces), and a `#L12C3` or
 * `#L12-L34` location as the numbers Codex shows for it (`:12:3`, `:12-34`).
 */
function shownMarkup(text: string): string {
  return text.replace(/^ {0,3}\[[^\]\n]+\]:[^\n]*$/gm, "").replace(/\]\[[^\]\n]*\]/g, "]")
    .replace(/#L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?/g, (_location, ...numbers: (string | undefined)[]) =>
      `:${numbers.slice(0, 4).filter((number) => number !== undefined).join(":")}`);
}

/**
 * A text with the escapes a screen shows as letters or digits decoded: numeric HTML entities
 * ("&#101;") and percent escapes ("%65"). The named entities markdown text holds (`&amp;`) show as
 * punctuation, which normalizeDisplay leaves out.
 */
function decoded(text: string): string {
  return text.replace(/&#(\d{1,7});|&#[xX]([0-9A-Fa-f]{1,6});/g, (entity, decimal: string | undefined, hex: string | undefined) => {
    const code = decimal === undefined ? Number.parseInt(hex!, 16) : Number(decimal);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  }).replace(/(?:%[0-9A-Fa-f]{2})+/g, (escaped) => { try { return decodeURIComponent(escaped); } catch { return escaped; } });
}

/** The texts of one rollout line, before lineForms adds the forms the chat shows them in. */
function lineTexts(value: unknown): string[] {
  const entry = record(value);
  const payload = record(entry.payload);
  const texts: string[] = [];
  if (entry.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message")) {
    texts.push(contentText(payload.message), ...stringsIn(payload.message));
  } else if (entry.type === "event_msg" && payload.type === "item_completed" && ["UserMessage", "AgentMessage"].includes(string(record(payload.item).type))) {
    texts.push(...stringsIn(payload.item));
  } else if (entry.type === "event_msg" && payload.type === "item_completed") {
    // any other completed item, as a screen shows it above its output: a command as it ran (code
    // mode keeps it only here), a search, a patch, arguments
    texts.push(...deepStrings(Object.entries(record(payload.item)).filter(([key]) => !ITEM_OUTPUTS.has(key))));
  } else if (entry.type === "response_item" && payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
    texts.push(contentText(payload.content), ...stringsIn(payload.content));
  } else if (entry.type === "response_item" && typeof payload.type === "string" && payload.type.endsWith("_call")) {
    // a tool call, as a screen shows it above its output: a command, a patch, a search, arguments
    texts.push(...deepStrings(payload));
  } else if (entry.type === "response_item" && payload.type === "reasoning") {
    texts.push(...deepStrings([payload.summary, payload.content]));
  } else if (entry.type === "event_msg" && (payload.type === "agent_reasoning" || payload.type === "agent_reasoning_raw_content")) {
    texts.push(...deepStrings(payload.text));
  }
  return texts;
}

/**
 * A rollout's turns after one of its lines: Codex writes `task_started` when a turn begins and
 * `task_complete` when it ends (with an `error` when it failed), or `turn_aborted` when it is
 * interrupted. An answer it streams is written only once it is complete: one an interrupted or
 * failed turn streamed never is, though a screen keeps what it showed of it (codex-rs
 * rust-v0.163.0, core/src/tasks/mod.rs; tui chatwidget/streaming.rs).
 */
function turnAfter(scan: SaidScan, value: unknown): void {
  const entry = record(value);
  const payload = record(entry.payload);
  if (entry.type !== "event_msg") return;
  if (payload.type === "task_started" || payload.type === "turn_started") scan.running = true;
  else if (payload.type === "task_complete" || payload.type === "turn_complete" || payload.type === "turn_aborted") {
    scan.running = false;
    if (payload.type !== "turn_aborted" && (payload.error === undefined || payload.error === null)) return;
    // without a time it could have ended at any time
    const at = Date.parse(string(entry.timestamp));
    scan.abortedAt = Math.max(scan.abortedAt, Number.isNaN(at) ? Infinity : at);
  }
}

/** The read of each rollout file under way: two at once would both read from the same offset and keep its messages twice. */
const saidQueue = new Map<string, Promise<void>>();

/**
 * The messages of a rollout file, read from where the last read stopped up to `upTo` (a cut an
 * earlier rollout is continued at; what follows it is no conversation's history there), one read of
 * a file at a time.
 */
async function scanSaid(path: string, upTo = Infinity): Promise<SaidScan> {
  const before = saidQueue.get(path);
  let done!: () => void;
  const mine = new Promise<void>((resolve) => { done = resolve; });
  saidQueue.set(path, mine);
  try {
    await before;
    return await readSaid(path, upTo);
  } finally {
    done();
    if (saidQueue.get(path) === mine) saidQueue.delete(path);
  }
}

/** The messages of a rollout file, read from where the last read stopped (a rollout only grows), up to `upTo`. */
async function readSaid(path: string, upTo: number): Promise<SaidScan> {
  const { ino, size: whole } = await stat(path);
  let scan = saidScans.get(path);
  if (scan === undefined || scan.ino !== ino || whole < scan.offset) scan = { ino, offset: 0, said: [], text: "", running: false, abortedAt: 0 };
  const size = Math.min(whole, upTo);
  saidScans.delete(path);
  saidScans.set(path, scan);
  if (size <= scan.offset) return keptWhole(path, scan);
  const fd = await open(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let pending: Buffer[] = [];
    let position = scan.offset;
    let lineStart = scan.offset;
    while (position < size) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let start = 0;
      for (let newline = chunk.indexOf(10); newline >= 0; newline = chunk.indexOf(10, start)) {
        const line = pending.length === 0 ? chunk.subarray(start, newline) : Buffer.concat([...pending, chunk.subarray(start, newline)]);
        pending = [];
        const end = position + newline + 1;
        if (SAID_RECORDS.some((marker) => line.includes(marker))) {
          const entry = parseJson(line.toString("utf8"));
          const forms = lineForms(entry);
          // cut at link targets, and whole too: a screen may show a target's words (mayShowWords); and
          // with its named entities as such (entityForm)
          const text = forms.flatMap((form) => {
            const pieces = saidText(form);
            return [...pieces, ...pieces.length > 1 ? [normalizeDisplay(form)] : [], entityForm(form)];
          }).join("");
          if (text !== "") {
            scan.text += text;
            scan.said.push({ end, at: scan.text.length });
            keptWhole(path, scan);
          }
          turnAfter(scan, entry);
        }
        lineStart = end;
        start = newline + 1;
      }
      if (start < bytesRead) pending.push(Buffer.from(chunk.subarray(start)));
      position += bytesRead;
    }
    scan.offset = lineStart;
  } finally { await fd.close(); }
  // the text kept, up to HISTORY_TEXT (twice the bytes one read of the loaded histories may take), so
  // the next poll reads none of them again; 32 loaded threads of 33 files each are far fewer files
  // than SAID_SCANS
  let kept = 0;
  for (const read of saidScans.values()) kept += read.text.length;
  for (const [oldest, read] of saidScans) {
    if (oldest === path || (saidScans.size <= SAID_SCANS && kept <= HISTORY_TEXT)) break;
    saidScans.delete(oldest);
    kept -= read.text.length;
  }
  return scan;
}

/** More bytes than this in the histories of the loaded threads, and none of them is weighed (loadedConversation). */
let HISTORY_BYTES = 128 * 1024 * 1024;
/** More text than this kept of the histories read (readSaid), and none of them is weighed. */
let HISTORY_TEXT = 2 * HISTORY_BYTES;

/** Other limits for HISTORY_BYTES and HISTORY_TEXT, for tests; none for Codex's own. */
export function limitCodexHistoryForTests(bytes = 128 * 1024 * 1024, text = 2 * bytes): void {
  HISTORY_BYTES = bytes;
  HISTORY_TEXT = text;
}

/** A file's read, unless it keeps more text than all reads may (HISTORY_TEXT): then it is dropped, and none is weighed. */
function keptWhole(path: string, scan: SaidScan): SaidScan {
  if (scan.text.length <= HISTORY_TEXT) return scan;
  saidScans.delete(path);
  throw new Error(`${path} keeps more text than is kept`);
}
/** The most rollout files whose reads are kept (readSaid). */
const SAID_SCANS = 4096;

/**
 * Every message a conversation ever had, user's and agent's alike, in the files its history is in
 * (`segments`, as loadedRollouts found them whole), each as readSaid keeps it, joined, with where
 * each ends: what matchCodexTranscript weighs another candidate's answers against (mayShowWords
 * too), beyond the last 1 MiB it reads of each. Its own file is read as far as it has
 * been written, and its turns (turnAfter) as far as that too. A file gone meanwhile throws rather
 * than leave out what it said.
 */
async function everSaid(segments: readonly HistorySegment[]): Promise<{ said: string; ends: number[]; running: boolean; abortedAt: number }> {
  const texts: string[] = [];
  const ends: number[] = [];
  let length = 0;
  let turns = { running: false, abortedAt: 0 };
  for (const [index, segment] of segments.entries()) {
    const own = index === segments.length - 1;
    const scan = await scanSaid(segment.path, own ? Infinity : segment.end);
    // an earlier rollout up to where this conversation continued it
    let count = scan.said.length;
    if (!own) while (count > 0 && scan.said[count - 1]!.end > segment.end) count--;
    const text = count === 0 ? "" : scan.text.slice(0, scan.said[count - 1]!.at);
    for (let record = 0; record < count; record++) ends.push(length + scan.said[record]!.at);
    texts.push(text);
    length += text.length;
    if (own) turns = { running: scan.running, abortedAt: scan.abortedAt };
  }
  return { said: texts.join(""), ends, ...turns };
}

/**
 * Codex's live status row while a turn runs: its spinner, a headline (a summary of reasoning no
 * rollout holds yet), how long it has run and how to interrupt it (status_indicator_widget.rs),
 * then maybe " · " and a message; or all of it cut with "…" where the line is narrow.
 */
const STATUS_ROW = /^[\u2022\u25e6] (?:.* \((?:\d+h )?(?:\d+m )?\d+s(?: \u2022 .* to interrupt)?\)(?: \u00b7 .*)?|.*\u2026)$/;

/**
 * What a Codex TUI's screen shows of its conversation since its last header, answers only: each
 * block a line starting with "•" begins (an answer, a tool's call), through the indented lines
 * below it. Prompts ("›", with their indented lines), the input box and the picker's rows are
 * left out: a pane may quote another conversation there before its own is loaded, or show the
 * picker with none. So are Codex's status row (STATUS_ROW) and what hangs below an indented "└ " (a
 * tool's output, which a rollout may keep only in part), "↳ " (a message queued to be sent, which
 * no rollout holds yet) or "answer: " / "note: " (what the user answered a question with).
 */
function shownAnswers(screen: string): string {
  let kept: string[] = [];
  let answer = false;
  for (const line of screen.split("\n")) {
    if (line.includes("OpenAI Codex (v")) {
      kept = [];
      answer = false;
    } else if (/^\S/.test(line)) answer = line.startsWith("\u2022") && !STATUS_ROW.test(line.trimEnd());
    else if (/^\s+(?:[\u2514\u21b3](?:\s|$)|answer: |note: )/.test(line)) answer = false;
    if (answer) kept.push(line);
  }
  return kept.join("\n");
}

/**
 * The conversation a pane's screen shows among those a Codex process of the store has loaded
 * (loadedRollouts): the last resort for a pane nothing else ties to a rollout, as a resume through
 * the picker from another folder leaves one (#896). Each of them is a candidate, and only one this
 * folder's lookup did not already weigh (`weighed`) may be the answer. As the pane's conversation is
 * always among them once it is loaded, a candidate counts only on an answer the screen shows as one
 * (shownAnswers) that none of the others ever said: no message in its whole history (everSaid), a
 * prompt too, and nothing in its last 1 MiB (tailSaid), a tool's output too: matchCodexTranscript's
 * `scrutinized` with `said`. Whole histories are read only once one that may be the answer shows an
 * answer there. Codex writes an answer only once it is complete, so nothing is offered while
 * another of them may show text it has not written: a turn running, or one interrupted or failed
 * since it was loaded (`codex exec` shows an answer only once written). Never
 * remembered as a binding: the next read asks the screen again, so the chat follows the TUI to
 * another conversation.
 */
async function loadedConversation(screen: string, weighed: readonly string[], home: string): Promise<string | null> {
  const shown = shownAnswers(screen);
  // no answer that long on screen (a fresh TUI, the picker): no lock need be read
  if (normalizeDisplay(shown).length < 64) return null;
  try {
    const loaded = await loadedRollouts(home);
    if (loaded === null) return null;
    const offered = [...loaded].flatMap(([path, { offered: may }]) => may && !weighed.includes(path) ? [path] : []);
    const tails = new Map<string, string>();
    const tail = (path: string) => {
      const text = tails.get(path) ?? codexHistoryTail(path, 1024 * 1024, home);
      tails.set(path, text);
      return text;
    };
    if (!offered.some((path) => matchCodexTranscript(shown, [{ path, text: tail(path) }], new Set(), new Map(), true) !== null)) return null;
    // the whole histories, within budget: past it, what is left unread could be the one that tells
    const files = new Map<string, number>();
    for (const { segments } of loaded.values()) for (const { path, end } of segments) files.set(path, Math.max(end, files.get(path) ?? 0));
    if ([...files.values()].reduce((sum, end) => sum + end, 0) > HISTORY_BYTES) return null;
    const candidates = [...loaded.keys()].map((path) => ({ path, text: tail(path) }));
    const said = new Map<string, Said>();
    const unwritten = new Set<string>();
    for (const { path, text } of candidates) {
      const thread = loaded.get(path)!;
      const ever = await everSaid(thread.segments);
      said.set(path, { text: ever.said + tailSaid(text), ends: ever.ends });
      // a turn running, or one interrupted or failed since it was loaded, may show text it has not written
      if (!thread.exec && (ever.running || ever.abortedAt >= thread.loadedAt)) unwritten.add(path);
    }
    // offered: one that passed the check above shows an answer here too, so it is matched (two
    // would be none) or left open (none), and a thread not offered never wins alone
    const found = matchCodexTranscript(shown, candidates, new Set(loaded.keys()), said, true);
    if (found === null) return null;
    // what another may be showing without having written it is in no `said`, to count against this one
    // on any screen, this one's too
    return [...unwritten].some((path) => path !== found) ? null : found;
  } catch { return null; }
}

/**
 * The rollout each pane's Codex was last matched to on screen, the processes that were running it, and
 * when; `titled` when it was the conversation only the title offered, which then holds only while the
 * title still names it (the picker may have opened another since).
 */
const boundRollouts = new Map<string, { processes: string; path: string; at: number; titled?: boolean }>();

/**
 * Threads begun in this cwd since `since` (seconds) that this pane's Codex may have moved
 * on to (/new), as their rollouts. Only interactive threads count: subagents (often with
 * a NULL agent_role) and `codex exec` runs share their parent's cwd but never replace the
 * TUI's conversation. A thread another pane is bound to is that pane's (theirs).
 */
function newerThreads(db: Database, cwd: string, since: number, except: string | null, paneId: string, home: string, firsts?: Map<string, string>): string[] {
  const first = db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'first_user_message'").get() !== null ? ", first_user_message" : "";
  const { where, params } = storedCwdCondition(cwd);
  const rows = db.query<{ id: string; rollout_path: string; first_user_message?: string | null }, (string | number)[]>(
    `SELECT id, rollout_path${first} FROM threads WHERE ${where} AND archived = 0 AND agent_role IS NULL${interactive(db)} AND created_at >= ?`,
  ).all(...params, since);
  return theirs(rows.flatMap((row) => {
    if (row.id === except) return [];
    const path = codexRolloutPath(row.rollout_path, home) ?? row.rollout_path;
    if (typeof row.first_user_message === "string") firsts?.set(path, row.first_user_message);
    return [path];
  }), paneId);
}

/**
 * Interactive threads only, where the store says (`source`): subagents (often with a NULL
 * agent_role) and `codex exec` runs share a TUI's cwd but are never its conversation.
 */
function interactive(db: Database): string {
  return db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'source'").get() !== null
    ? " AND source IN ('cli', 'vscode')" : "";
}

/** The rollouts no other pane is bound to. */
function theirs(rollouts: string[], paneId: string, claimed: ReadonlySet<string> = new Set()): string[] {
  const elsewhere = new Set([...boundRollouts].flatMap(([pane, binding]) => pane === paneId ? [] : [binding.path]));
  return rollouts.filter((rollout) => !elsewhere.has(rollout) && !claimed.has(rollout));
}

/** Interpreter options that run code or load a module: whatever follows is not the script. */
const CODE_OPTIONS = new Set(["eval", "print", "require", "import", "loader", "experimental-loader", "input-type"]);
/** Interpreter and shell options that take no value, so the script may follow them directly. */
const VALUELESS_OPTIONS = new Set([
  "", "no-warnings", "no-deprecation", "trace-warnings", "trace-deprecation", "pending-deprecation", "throw-deprecation",
  "enable-source-maps", "preserve-symlinks", "preserve-symlinks-main", "expose-gc", "abort-on-uncaught-exception",
  "experimental-strip-types", "experimental-transform-types", "experimental-vm-modules", "experimental-require-module",
  "no-experimental-fetch", "harmony", "bun", "smol", "hot", "watch", "noprofile", "norc", "posix", "login",
]);

/** A pane's Codex executables (or interpreter scripts), and their pids as one key. */
/** The pane's first Codex process (the one paneCodexHome decides by), or null when there is none. */
export async function paneCodexProcess(paneId: string): Promise<{ pid: number; argv?: string[] } | null> {
  return (await codexProcessesOf(paneId)).list[0] ?? null;
}

async function codexProcessesOf(paneId: string): Promise<{ list: { pid: number; argv?: string[] }[]; key: string }> {
  const processInfo = await paneProcessInfo(paneId);
  // herdr's schema allows `argv: null`; this reader has always read argv as absent or a list
  // (the cast is the inline result type herdrRpc was given before the typed seam)
  const list = ((processInfo?.foreground_processes ?? []) as { pid: number; argv?: string[] }[])
    .map((foreground) => {
      if (foreground.argv?.length || process.platform !== "linux") return foreground;
      // herdr can report only pid/name. Read this process, never infer argv from
      // its name; an exited or inaccessible process provides no binding evidence.
      try {
        return { ...foreground, argv: readFileSync(`/proc/${foreground.pid}/cmdline`, "utf8").split("\0") };
      } catch { return foreground; }
    })
    .filter(({ argv = [] }) => {
      const executable = argv[0] ?? "";
      const codex = /(?:^|[\\/])codex(?:\.js|\.exe|\.opencodex-real)?$/;
      if (codex.test(executable)) return true;
      // `node codex.js` and shell shebangs name the script after the interpreter and its
      // `--flag` options (`node --no-warnings codex.js`). Only options known to take no
      // value may precede the script, plus `--name=value` forms that do not run code: an
      // option that takes the next argument (`--title x`, `-e`, `-c`) or one that evaluates
      // code or loads a module ends the search, since what follows it is not the script.
      // Later arguments (echo, etc.) are not executables.
      if (!/(?:^|[\\/])(?:node|bun|sh|bash|dash|zsh)(?:\.exe)?$/.test(executable)) return false;
      let script = 1;
      for (; argv[script]?.startsWith("--"); script++) {
        const option = argv[script] ?? "";
        const name = option.slice(2, option.includes("=") ? option.indexOf("=") : undefined);
        if (CODE_OPTIONS.has(name)) return false;
        if (!option.includes("=") && !VALUELESS_OPTIONS.has(name)) return false;
      }
      return codex.test(argv[script] ?? "");
    });
  return { list, key: list.map((process) => process.pid).sort((left, right) => left - right).join(",") };
}

/** Native queue keys belong only to the interactive CLI, never its headless subcommands. */
export async function paneRunsCodex(paneId: string): Promise<boolean> {
  return (await codexProcessesOf(paneId)).list.some(({ argv = [] }) =>
    !argv.some((arg) => /^(?:exec|e|review|app-server|mcp|mcp-server|login|logout|queue|help|completion)$/.test(arg)));
}

/** When each pane last looked at the other Codex panes for a set of threads, and which panes those were. */
const claimChecks = new Map<string, { panes: string; at: number }>();
const CLAIM_CHECK_MS = 5000;

/**
 * Which of `threads` (rollouts) another Codex pane in this cwd shows, as its own: a pane
 * claims a thread when its screen shows the thread's first message (typed there) and an
 * answer of it, and the match is unique against this pane's threads and that pane's
 * binding too. A pane that shows one is bound to it, whether or not anyone opened its
 * chat, and that thread is theirs, not a /new of this pane. The same threads and panes are
 * looked at again at most every 5s: a pane whose answer is not on screen yet is tried then.
 *
 * Trade-off: the first message must still be in that pane's last 400 lines and read as at
 * least 8 letters or digits. After a long session with this chat closed, or for a first
 * message like "hi", the thread is never claimed, and this pane says it cannot tell while
 * its own answer is off screen, until that pane's chat binds it. Never another conversation.
 */
async function claimedByOtherPanes(paneId: string, cwd: string, threads: string[], own: string[], firsts: ReadonlyMap<string, string>, home: string, sessionPanes?: HerdrPane[]): Promise<Set<string>> {
  const claimed = new Set<string>();
  const key = `${paneId}\0${[...threads].sort().join("\0")}`;
  const panes = codexPeersIn(sessionPanes ?? (await sessionSnapshot()).panes, paneId, cwd).slice(0, 8);
  // a pane that appeared since is looked at at once
  const last = claimChecks.get(key);
  const seen = panes.map((pane) => pane.pane_id).join();
  if (panes.length === 0 || (last !== undefined && last.panes === seen && Date.now() - last.at < CLAIM_CHECK_MS)) return claimed;
  claimChecks.set(key, { panes: seen, at: Date.now() });
  if (claimChecks.size > 64) claimChecks.delete(claimChecks.keys().next().value!);
  const tail = (path: string) => { try { return [{ path, text: codexHistoryTail(path, 1024 * 1024, home) }]; } catch { return []; } };
  const candidates = threads.flatMap(tail);
  if (candidates.length === 0) return claimed;
  // a screen is matched against this pane's own threads and that pane's too, not only the
  // new ones: an answer of this pane quoted over there is then not unique, and claims nothing
  const known = [...new Set(own)].flatMap(tail);
  for (const pane of panes) {
    try {
      const theirsNow = boundRollouts.get(pane.pane_id)?.path;
      const screen = await paneRead({ paneId: pane.pane_id, source: "recent", lines: 400, stripAnsi: true });
      const possible = [...new Map([...candidates, ...known, ...(theirsNow && !threads.includes(theirsNow) && !own.includes(theirsNow) ? tail(theirsNow) : [])]
        .map((candidate) => [candidate.path, candidate])).values()];
      const shown = matchCodexTranscript(screen.text, possible);
      if (shown === null || !threads.includes(shown)) continue;
      // and the thread's first message shows there too: typed in that pane, not only its answer
      // quoted or pasted there (a thread whose first message is gone from that screen stays unclaimed)
      const first = normalizeDisplay(firsts.get(shown) ?? "").slice(0, 48);
      if (firsts.has(shown) && (first.length < 8 || !normalizeDisplay(screen.text).includes(first))) continue;
      claimed.add(shown);
      const processes = (await codexProcessesOf(pane.pane_id)).key;
      if (processes !== "") {
        boundRollouts.delete(pane.pane_id);
        boundRollouts.set(pane.pane_id, { processes, path: shown, at: Date.now() });
        if (boundRollouts.size > 64) boundRollouts.delete(boundRollouts.keys().next().value!);
      }
    } catch { /* a pane closed meanwhile */ }
  }
  return claimed;
}

/** Whether another Codex pane in this cwd was started as `codex resume <thread>`. */
async function resumedElsewhere(paneId: string, cwd: string, thread: string, sessionPanes?: HerdrPane[]): Promise<boolean> {
  const panes = codexPeersIn(sessionPanes ?? (await sessionSnapshot()).panes, paneId, cwd);
  for (const pane of panes) {
    try {
      if (resumedThread((await codexProcessesOf(pane.pane_id)).list.map((process) => process.argv ?? [])) === thread) return true;
    } catch { /* a pane closed meanwhile */ }
  }
  return false;
}

interface CodexThreadRow {
  rolloutPath: string;
  firstUserMessage: string | null;
  createdAtMs: number;
}

const SHORT_THREAD_LIMIT = 32;
const SHORT_ROLLOUT_LIMIT = 1024 * 1024;
/** How far a rollout was validated: `offset` bytes of whole lines; `dead` once a line can never pass. */
interface ShortScan { offset: number; retained: number; text: string; dead: boolean }

// A chat polls every 2 s and nothing binds a short match. Rollouts only grow, so an unchanged
// one is not read again and a grown one is read from where the last read stopped.
const shortScans = new Map<string, { ino: number; size: number; mtimeMs: number; scan: ShortScan }>();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Validate every record, retaining only messages: tool output cannot identify a conversation. */
async function scanShortText(path: string, size: number, from: ShortScan): Promise<ShortScan> {
  const fd = await open(path, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let { offset, retained, text } = from;
  let carry = Buffer.alloc(0), position = offset;
  const dead = (): ShortScan => ({ offset, retained, text, dead: true });
  try {
    while (position < size) {
      const { bytesRead: length } = await fd.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (length === 0) break;
      position += length;
      carry = Buffer.concat([carry, buffer.subarray(0, length)]);
      let start = 0, newline: number;
      while ((newline = carry.indexOf(10, start)) >= 0) {
        if (newline - start > SHORT_ROLLOUT_LIMIT) return dead();
        let line: string, entry: Record<string, unknown>;
        try {
          line = strictUtf8.decode(carry.subarray(start, newline));
          entry = record(JSON.parse(line));
        } catch { return dead(); }
        const payload = record(entry.payload);
        if (entry.type === "response_item" && payload.type === "message"
          || entry.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message")) {
          retained += newline - start + 1;
          if (retained > SHORT_ROLLOUT_LIMIT) return dead();
          text += line + "\n";
        }
        offset += newline - start + 1;
        start = newline + 1;
      }
      carry = carry.subarray(start);
      if (carry.length > SHORT_ROLLOUT_LIMIT) return dead();
    }
    return { offset, retained, text, dead: false };
  } finally { await fd.close(); }
}

/** Short matching needs every competing exchange, so incomplete or unsafe rows disable it. */
async function safeShortThreads(rows: readonly CodexThreadRow[], home: string): Promise<CodexFirstExchangeCandidate[] | null> {
  if (rows.length === 0 || rows.length > SHORT_THREAD_LIMIT) return null;
  const candidates: CodexFirstExchangeCandidate[] = [];
  for (const row of rows) {
    const path = codexRolloutPath(row.rolloutPath, home);
    if (path === null) return null;
    try {
      const stat = statSync(path);
      const header = rolloutHeader(path);
      if (!stat.isFile() || stat.size <= 0 || header === null
        || Object.keys(record(header.history_base)).length > 0) return null;
      const cached = shortScans.get(path);
      const sameFile = cached !== undefined && cached.ino === stat.ino;
      let scan: ShortScan;
      if (sameFile && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        scan = cached.scan;
      } else {
        const grown = sameFile && stat.size > cached.size;
        scan = grown && cached.scan.dead ? cached.scan
          : await scanShortText(path, stat.size, grown ? cached.scan : { offset: 0, retained: 0, text: "", dead: false });
        const after = statSync(path);
        if (after.size !== stat.size || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs) return null;
        shortScans.delete(path);
        shortScans.set(path, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, scan });
        if (shortScans.size > 128) shortScans.delete(shortScans.keys().next().value!);
      }
      // a line still being written leaves the rollout unread to its end
      if (scan.dead || scan.offset !== stat.size) return null;
      const text = scan.text;
      const exchanges = codexExchanges(text);
      const stored = normalizePrompt(row.firstUserMessage ?? "");
      if (stored !== "" && (exchanges[0] === undefined || normalizePrompt(exchanges[0].user) !== stored)) return null;
      candidates.push({
        path,
        text,
        firstUserMessage: row.firstUserMessage,
        createdAtMs: row.createdAtMs,
      });
    } catch { return null; }
  }
  return candidates;
}

/**
 * Of `threads`, those another Codex pane of the cwd holds by stronger evidence than a short
 * answer: the rollout herdr reports for that pane, and one whose long answer that pane
 * shows below the first prompt that began it (claimedByOtherPanes, which binds the pane to it,
 * so the next poll finds it bound there). Panes bound elsewhere already are left to theirs().
 */
async function heldByOtherPanes(
  paneId: string, cwd: string, threads: string[], rows: readonly CodexThreadRow[], home: string, panes: HerdrPane[],
  rolloutOf: (row: CodexThreadRow) => string,
): Promise<Set<string>> {
  const held = new Set<string>();
  for (const pane of codexPeersIn(panes, paneId, cwd)) {
    const session = pane.agent_session;
    if (session?.kind === "path" && session.value) {
      const reported = codexRolloutPath(session.value, home);
      if (reported !== null) held.add(reported);
    }
  }
  const firsts = new Map(rows.flatMap((row) => typeof row.firstUserMessage === "string" ? [[rolloutOf(row), row.firstUserMessage] as const] : []));
  for (const claimed of await claimedByOtherPanes(paneId, cwd, threads, [], firsts, home, panes)) held.add(claimed);
  return held;
}

/**
 * The threads other Codex panes of the cwd show as their own first exchange, each matched the
 * way this pane's is (matchCodexFirstExchange, from that pane's own start bound), leaving out
 * those already found: the pane that started last tells first, and an earlier one in turn. A
 * pane started first never tells by its own start, since every later pane's thread began after
 * it too; that pane's first exchange, begun after it started and the only such one there, is
 * its conversation by the evidence that would bind it there. One this pane shows as well stays
 * open; null when another pane shows a thread one pane took: something is not as it seems.
 * Nothing here binds: a first exchange is read again each time.
 */
async function peersFirstExchanges(
  own: string, candidates: readonly CodexFirstExchangeCandidate[], peers: readonly HerdrPane[], screens: readonly string[],
  excluded: ReadonlySet<string>,
): Promise<Set<string> | null> {
  const starts = await Promise.all(peers.map(async (peer) => {
    const { list } = await codexProcessesOf(peer.pane_id);
    const bounds = list.map(({ pid }) => processStartLowerBound(pid));
    return bounds.length === 0 || bounds.some((bound) => bound === null) ? null : Math.min(...bounds as number[]);
  }));
  const owners = new Map<string, number>();
  for (let found = true; found;) {
    found = false;
    peers.forEach((_, index) => {
      const start = starts[index];
      if (start === null || start === undefined || [...owners.values()].includes(index)) return;
      const path = matchCodexFirstExchange(screens[index]!, candidates, start, new Set([...excluded, ...owners.keys()]));
      if (path === null) return;
      // this pane's screen shows that exchange too: whose it is stays open
      if (matchingCodexExchanges(own, candidates.filter((candidate) => candidate.path === path), 1).length > 0) return;
      owners.set(path, index);
      found = true;
    });
  }
  for (const [path, owner] of owners) {
    const thread = candidates.filter((candidate) => candidate.path === path);
    if (screens.some((screen, index) => index !== owner && matchingCodexExchanges(screen, thread, 1).length > 0)) return null;
  }
  return new Set(owners.keys());
}

/**
 * The prompt is not ownership evidence on its own. Require its submitted answer,
 * compare older conversations and other same-directory panes too. A peer showing the
 * same exchange leaves ownership ambiguous. No weak binding survives a poll.
 */
async function shortThreadFromProcess(
  paneId: string, cwd: string, home: string, screen: string,
  processes: readonly { pid: number }[], panes?: HerdrPane[],
): Promise<string | null> {
  // no later than the process started: Codex 0.163 makes its thread in that same second
  const starts = processes.map(({ pid }) => processStartLowerBound(pid));
  if (starts.length === 0 || starts.some((start) => start === null || !Number.isFinite(start))) return null;
  const notBefore = Math.min(...starts as number[]);
  let db: Database | undefined;
  try {
    const peers = panes ?? (await sessionSnapshot()).panes;
    if (peers.some((pane) => pane.pane_id !== paneId
      && resolveAgent(pane).agent === "codex" && pane.cwd == null)) return null;
    db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
    const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('threads')").all().map((column) => column.name));
    if (!columns.has("first_user_message") || !columns.has("source")) return null;
    // a time in whole seconds as the last millisecond of that second: compared with the start's
    // lower bound, a thread made in its process's second still counts as begun since
    const created = columns.has("created_at_ms") ? "COALESCE(created_at_ms, created_at * 1000 + 999)" : "created_at * 1000 + 999";
    // The 33rd row disables this bounded lookup, never establishes uniqueness.
    const { where, params } = storedCwdCondition(cwd);
    const rows = db.query<CodexThreadRow, string[]>(
      `SELECT rollout_path AS rolloutPath, first_user_message AS firstUserMessage, ${created} AS createdAtMs
       FROM threads WHERE ${where} AND archived = 0 AND agent_role IS NULL${interactive(db)} LIMIT 33`,
    ).all(...params);
    if (rows.length > SHORT_THREAD_LIMIT || rows.some((row) => !Number.isFinite(row.createdAtMs))) return null;
    // Only a thread created after this process's start bound may be its new first exchange, and
    // not one another pane holds by stronger evidence: after A's /new, B's one word still tells
    const rolloutOf = (row: CodexThreadRow) => codexRolloutPath(row.rolloutPath, home) ?? row.rolloutPath;
    const since = rows.filter((row) => row.createdAtMs >= notBefore);
    // one thread begun since may be another pane's too: herdr reports it for that pane, or that pane shows its long answer
    const held = since.length > 0 ? await heldByOtherPanes(paneId, cwd, since.map(rolloutOf), rows, home, peers, rolloutOf) : new Set<string>();
    // bound to another pane, or held by it: still competing exchanges, never this pane's
    const elsewhere = new Set(since.map(rolloutOf).filter((rollout) => theirs([rollout], paneId, held).length === 0));
    const begun = since.filter((row) => !elsewhere.has(rolloutOf(row)));
    if (begun.length === 0) return null;
    const candidates = await safeShortThreads(rows, home);
    if (candidates === null) return null;
    const peerPanes = codexPeersIn(peers, paneId, cwd);
    const peerScreens = await Promise.all(peerPanes.map((peer) =>
      paneRead({ paneId: peer.pane_id, source: "recent", lines: 400, stripAnsi: true })));
    // a pane that started first sees every later pane's thread begun since too: those panes show
    // them as their own first exchange, and say so first
    let excluded = elsewhere;
    if (begun.length > 1) {
      const shown = await peersFirstExchanges(screen, candidates, peerPanes, peerScreens.map((peer) => peer.text), excluded);
      if (shown === null) return null;
      excluded = new Set([...excluded, ...shown]);
    }
    const path = matchCodexFirstExchange(screen, candidates, notBefore, excluded);
    if (path === null || theirs([path], paneId, held).length !== 1) return null;
    const own = candidates.filter((candidate) => candidate.path === path);
    for (const peer of peerScreens) {
      // Headerless exchanges can disprove ownership, but never establish it.
      const screens = peer.text.includes("OpenAI Codex (v") ? [peer.text]
        : peer.text.split(/(?=^›[ \t]+)/m).map((text) => `OpenAI Codex (v\n${text}`);
      if (screens.some((text) => matchingCodexExchanges(text, own, 1).length > 0)) return null;
      // A missing header is unknown, not evidence of a different conversation.
      if (displayedFirstExchange(peer.text) === null) {
        const matched = matchCodexTranscript(peer.text, candidates);
        if (matched === null || matched === path) return null;
      }
    }
    return path;
  } catch { return null; }
  finally { db?.close(); }
}

/** The pane's Codex processes, and the rollouts they hold open (lsof on macOS, /proc elsewhere): one alone is the pane's. */
async function openRollouts(paneId: string, home: string): Promise<{ codexProcesses: Awaited<ReturnType<typeof codexProcessesOf>>["list"]; processes: string; open: Set<string> }> {
  const { list: codexProcesses, key: processes } = await codexProcessesOf(paneId);
  const open = new Set<string>();
  if (globalThis.process.platform === "darwin" && codexProcesses.length > 0) {
    // lsof is available on macOS, where /proc does not exist. Keep the same
    // canonical-store and unambiguous-open-file checks as the Linux path. One run
    // for every Codex process of the pane (a wrapper and the binary are two), and
    // -b keeps lsof off the stat calls it does not need for a name: a chat reads this up
    // to every 2 s while its transcript changes, the conversation monitor every 5 s, and
    // each run costs about 20 ms of process start and kernel walk
    const child = Bun.spawn(["/usr/sbin/lsof", "-nPbw", "-a", "-p", codexProcesses.map((process) => process.pid).join(","), "-Fn"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(), 3000);
    try {
      const text = await new Response(child.stdout).text();
      await child.exited;
      for (const line of text.split("\n")) {
        if (!line.startsWith("n") || !line.endsWith(".jsonl")) continue;
        const path = codexRolloutPath(line.slice(1), home);
        if (path) open.add(path);
      }
    } finally { clearTimeout(timer); }
  }
  for (const process of codexProcesses) {
    if (globalThis.process.platform === "darwin") continue;
    let descriptors: string[];
    try { descriptors = readdirSync(`/proc/${process.pid}/fd`); } catch { continue; }
    for (const descriptor of descriptors.slice(0, 512)) {
      try {
        const target = readlinkSync(`/proc/${process.pid}/fd/${descriptor}`);
        if (!target.endsWith(".jsonl")) continue;
        const path = codexRolloutPath(target, home);
        if (path) open.add(path);
      } catch { /* A descriptor may close while enumerating it. */ }
    }
  }
  return { codexProcesses, processes, open };
}

/**
 * The rollout a pane's Codex writes when that is certain without reading its screen: the path
 * herdr reports, the one rollout its processes hold open, or the one a chat read last matched to
 * the same processes while no thread begun in `cwd` since may have replaced it (/new). Nothing is
 * matched or bound here, so a reader in the background (the session plan, server/session-plan.ts)
 * never changes what codexTranscriptPath decides for the chat. Unlike the chat it does not ask the
 * other panes' screens whose a newer thread is: such a thread leaves it unsure until a chat read
 * matches the pane again.
 */
export async function codexOpenRollout(paneId: string, cwd: string | null | undefined, home = defaultCodexHome()): Promise<string | null> {
  const agent = await agentGet(paneId);
  const session = agent.agent_session;
  if (session?.kind === "path" && session.value) return codexRolloutPath(session.value, home);
  const { codexProcesses, processes, open } = await openRollouts(paneId, home);
  if (open.size === 1) return [...open][0]!;
  const bound = boundRollouts.get(paneId);
  if (bound === undefined || bound.processes !== processes || processes === "" || !cwd || codexRolloutPath(bound.path, home) === null) return null;
  let db: Database | undefined;
  try {
    db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
    if (bound.titled === true && titledCandidate(agent, codexProcesses, db, home) !== bound.path) return null;
    return newerThreads(db, cwd, Math.floor(bound.at / 1000), null, paneId, home).length === 0 ? bound.path : null;
  } catch {
    // no store to ask, as codexTranscriptPath then keeps its binding too; one the title made cannot be checked
    return bound.titled === true ? null : bound.path;
  } finally { db?.close(); }
}

/**
 * The rollout a pane's Codex writes, or null when nothing tells. `panes`: the session's
 * panes, when the caller has them (saves a snapshot, and closed panes' bindings go).
 *
 * The thread id herdr has for a Codex pane is a hint, not proof: Codex's SessionStart
 * hook reports it, and since Codex 0.157 that hook runs in the app-server daemon every
 * Codex TUI shares. The daemon keeps the environment of the TUI that started it, so each
 * TUI's thread is reported to that first pane (live-verified 2026-09-26 with Codex
 * 0.157.1: a pane resumed on thread A left the daemon's own pane holding A). What
 * shows on screen decides first; the id is used only when nothing does and no other
 * pane owns that thread.
 *
 * A resume through the picker leaves no id anywhere, and may open a thread of another folder
 * (#896). What still ties it to the pane is that Codex keeps it loaded, as it does every
 * conversation a TUI shows: when nothing of this folder tells, the screen is matched against
 * all of them (loadedConversation).
 */
export async function codexTranscriptPath(paneId: string, cwd: string, home = defaultCodexHome(), panes?: HerdrPane[], rememberMatch = true): Promise<string | null> {
  if (panes !== undefined) {
    const open = new Set(panes.map((pane) => pane.pane_id));
    for (const pane of [...boundRollouts.keys()]) if (!open.has(pane)) boundRollouts.delete(pane);
  }
  const agent = await agentGet(paneId);
  const session = agent.agent_session;
  if (session?.kind === "path" && session.value) return codexRolloutPath(session.value, home);

  const { codexProcesses, processes, open } = await openRollouts(paneId, home);
  if (open.size === 1) return [...open][0]!;
  const resumed = resumedThread(codexProcesses.map((process) => process.argv ?? []));

  let db: Database | undefined;
  let paths: string[] = [...open];
  let resumedPath: string | null = null;
  let resumedNewer: string[] = [];
  /** the first message of each newer thread, when the store keeps it */
  const firsts = new Map<string, string>();
  const bound = boundRollouts.get(paneId);
  let boundHere = bound !== undefined && bound.processes === processes && processes !== "" ? bound : undefined;
  let boundNewer: string[] = [];
  /** the rollout of the thread herdr has for this pane */
  let reported: string | null = null;
  /** whether every interactive thread in this cwd is among the candidates */
  let listed = false;
  /** the conversation only the title offers (titledCandidate), from another folder */
  let titledElsewhere: string | null = null;
  try {
    db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
    if (session?.value && UUID.test(session.value)) {
      const first = db.query("SELECT 1 FROM pragma_table_info('threads') WHERE name = 'first_user_message'").get() !== null ? ", first_user_message" : "";
      const row = db.query<{ rollout_path: string; first_user_message?: string | null }, [string]>(`SELECT rollout_path${first} FROM threads WHERE id = ?`).get(session.value);
      reported = row ? codexRolloutPath(row.rollout_path, home) : null;
      if (reported !== null && typeof row?.first_user_message === "string") firsts.set(reported, row.first_user_message);
    }
    if (resumed !== null) {
      const row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id = ?").get(resumed);
      // After /new the command line still names the resumed thread. Trust it only while
      // no other interactive thread in this cwd began after this Codex did (newerThreads;
      // one no other pane shows counts too: then the chat says it cannot tell, rather
      // than show the wrong conversation). Without a start time, since the resumed
      // thread was last updated.
      const startedAt = Math.min(...codexProcesses.map((process) => processStartedAt(process.pid) ?? Infinity));
      const since = Number.isFinite(startedAt)
        ? Math.floor(startedAt / 1000)
        : (db.query<{ updated_at: number }, [string]>("SELECT updated_at FROM threads WHERE id = ?").get(resumed)?.updated_at ?? 0);
      resumedPath = row ? codexRolloutPath(row.rollout_path, home) : null;
      resumedNewer = newerThreads(db, cwd, since, resumed, paneId, home, firsts);
    }
    // the same guard for a match: after /new the process writes a thread begun since
    // (created_at has whole seconds, so one begun in the match's second counts too)
    if (boundHere !== undefined) boundNewer = newerThreads(db, cwd, Math.floor(boundHere.at / 1000), null, paneId, home, firsts);
    const { where, params } = storedCwdCondition(cwd);
    const rows = db.query<{ rollout_path: string }, string[]>(
      // a burst of `codex exec` runs must not push the pane's own thread out of the 32
      `SELECT rollout_path FROM threads WHERE ${where} AND archived = 0 AND agent_role IS NULL${interactive(db)} ORDER BY updated_at DESC LIMIT 33`,
    ).all(...params);
    const rollouts = rows.slice(0, 32).map((row) => codexRolloutPath(row.rollout_path, home));
    // a thread whose rollout is gone or outside the store is still a conversation of this cwd
    listed = rows.length <= 32 && !rollouts.includes(null);
    // since Codex 0.157 the shared app-server daemon, not the TUI, holds the rollout open, and a resume
    // through the picker leaves no id on the command line: the title may name a thread of another folder
    paths = [...new Set([...paths, ...(reported !== null ? [reported] : []), ...rollouts.filter((path): path is string => path !== null)])];
    const titled = titledCandidate(agent, codexProcesses, db, home);
    if (titled !== null && !paths.includes(titled)) { titledElsewhere = titled; paths.push(titled); }
  } catch { /* Older installations can still resolve their open descriptors. */ }
  finally { db?.close(); }
  // a binding the title made holds only while the title still names that thread
  if (boundHere?.titled === true && titledElsewhere !== boundHere.path) {
    boundRollouts.delete(paneId);
    boundHere = undefined;
    boundNewer = [];
  }
  const screen = paths.length ? await paneRead({ paneId, source: "recent", lines: 400, stripAnsi: true }) : null;
  const candidates = paths.flatMap((path) => {
    try { return [{ path, text: codexHistoryTail(path, 1024 * 1024, home) }]; } catch { return []; }
  });
  const matched = screen ? matchCodexTranscript(screen.text, candidates, new Set(titledElsewhere === null ? [] : [titledElsewhere])) : null;
  if (matched !== null) {
    if (!rememberMatch) return matched;
    boundRollouts.delete(paneId);
    boundRollouts.set(paneId, { processes, path: matched, at: Date.now(), ...(matched === titledElsewhere ? { titled: true } : {}) });
    if (boundRollouts.size > 64) boundRollouts.delete(boundRollouts.keys().next().value!);
    return matched;
  }
  // Nothing on screen tells: a long run of tool output pushed the last answer out of
  // the read, or nothing is answered yet. The same Codex process still writes the
  // rollout it was last matched to, while no thread begun since in this cwd leaves it
  // unsure: one another Codex pane here shows is that pane's. The binding is kept even
  // when unsure, so it holds again once that thread turns out to be another pane's.
  // Failing that, the thread herdr has for this pane, unless another pane shows it, is
  // bound to it, or was resumed on it. Failing that, the thread it was resumed on, under
  // the same rule as the binding.
  const unsure = [...new Set([...boundNewer, ...(resumedPath !== null ? resumedNewer : []), ...(reported !== null ? [reported] : [])])];
  if (unsure.length > 0) {
    const own = [boundHere?.path, resumedPath].filter((path): path is string => typeof path === "string");
    const claimed = await claimedByOtherPanes(paneId, cwd, unsure, own, firsts, home, panes);
    boundNewer = theirs(boundNewer, paneId, claimed);
    resumedNewer = theirs(resumedNewer, paneId, claimed);
    if (reported !== null && (theirs([reported], paneId, claimed).length === 0 || await resumedElsewhere(paneId, cwd, session!.value!, panes))) reported = null;
  }
  if (boundHere !== undefined && boundNewer.length === 0 && codexRolloutPath(boundHere.path, home) !== null) {
    // a pane in use stays among the kept ones
    boundRollouts.delete(paneId);
    boundRollouts.set(paneId, boundHere);
    return boundHere.path;
  }
  if (reported !== null) return reported;
  if (resumed !== null) return resumedNewer.length === 0 ? resumedPath : null;
  // Nothing ties this pane to a rollout at all: no session herdr names, no resume, no match by a
  // long answer for this process, and so no /new to be unsure about. Short answers on screen may
  // tell (#283). Never remembered as a binding: what it shows is read again each time, and only a
  // long answer binds the pane for when its screen no longer tells.
  if (session?.value || boundHere !== undefined) return null;
  const short = screen === null ? null : await (async () => {
    // and only against every conversation this pane may be running, read whole: one left out of
    // the 32 or one whose rollout is gone may be what said the same short lines
    if (!listed || candidates.length !== paths.length) return null;
    // read from each rollout itself, nothing remembered: one that continues another (a fork, a
    // backtrack) shares that one's answers, and one past the budget was not read whole
    let cut: boolean[];
    try {
      cut = candidates.map((candidate) => Object.keys(record(rolloutHeader(candidate.path)?.history_base)).length > 0 || statSync(candidate.path).size > 1024 * 1024);
    } catch { return null; }
    const found = matchShortCodexAnswers(screen.text, candidates.map((candidate, index) => ({ ...candidate, cut: cut[index] })));
    if (found !== null) return found;
    // it weighs this folder's threads only: beside a conversation the title offers from another
    // folder, the same short exchange there would be left out of the choice
    if (titledElsewhere !== null) return null;
    return shortThreadFromProcess(paneId, cwd, home, screen.text, codexProcesses, panes);
  })();
  if (short !== null) return short;
  // Last, after all of this folder's ways: the conversations a Codex process of the store has
  // loaded, from any folder (#896). Not for a TUI of an app server elsewhere (--remote), which has
  // its conversation loaded there, nor for one holding rollouts open itself.
  if (codexProcesses.length === 0 || open.size > 0
    || codexProcesses.some(({ argv = [] }) => argv.some((arg) => arg === "--remote" || arg.startsWith("--remote=")))) return null;
  return loadedConversation((screen ?? await paneRead({ paneId, source: "recent", lines: 400, stripAnsi: true })).text, paths, home);
}
