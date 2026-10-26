import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { invokedSkill } from "./skill-activity.ts";
import { claudeCommandEcho } from "./skill-invocations/claude.ts";
import { agentTaskResult, claudePeerId, claudePeerNotice, isContextClear, MAX_TURNS, toolSummary, type TranscriptParser } from "./transcript-records.ts";
import { taskNotification, type SubagentDetail } from "./claude-subagents.ts";
import { trimOutput } from "./tool-output.ts";
import { base64Size, inlineImageType, MAX_IMAGE_BYTES } from "./codex-images.ts";

/** Slash-command and bookkeeping entries Claude logs as user turns — not conversations. */
export function isCommandEntry(text: string): boolean {
  if (claudeCommandEcho(text)) return false;
  return text.startsWith("<command-") || text.startsWith("<local-command") || text.startsWith("<task-");
}

/**
 * What a slash command printed, from the `local_command` entry Claude Code records it in. The
 * command's echo (`<command-name>…`) is a separate entry with no output tag, and reads as nothing.
 */
/** A command's answer is a notice, not a log: the rest of a long one stays in the terminal. */
const LOCAL_COMMAND_MAX_CHARS = 4000;

function localCommandOutput(content: unknown): string {
  if (typeof content !== "string") return "";
  // the whole entry is the output, one stream after another: a tag quoted inside an echo's
  // arguments is not an answer
  const streams: string[] = [];
  let at = 0;
  for (;;) {
    while (at < content.length && /\s/.test(content[at]!)) at++;
    if (at === content.length) break;
    const stream = content.startsWith("<local-command-stdout>", at) ? "stdout" : content.startsWith("<local-command-stderr>", at) ? "stderr" : null;
    if (stream === null) return "";
    const start = at + `<local-command-${stream}>`.length;
    // a closing tag the output prints itself ends nothing: the stream's own one is at the end of
    // the entry or before the next stream. Each candidate looks only at the whitespace after it.
    const close = `</local-command-${stream}>`;
    let end = content.indexOf(close, start);
    let next = 0;
    while (end !== -1) {
      next = end + close.length;
      while (next < content.length && /\s/.test(content[next]!)) next++;
      if (next === content.length || content.startsWith("<local-command-stdout>", next) || content.startsWith("<local-command-stderr>", next)) break;
      end = content.indexOf(close, end + close.length);
    }
    if (end === -1) return "";
    const text = stripTerminalControls(content.slice(start, end)).trim();
    if (text.length > 0) streams.push(text);
    at = next;
  }
  return capNotice(streams.join("\n"));
}

/** Lines of one notice Claude Code writes as separate entries, a moment apart. */
const NOTICE_JOIN_MS = 1000;

/** A notice is not a log: past the cap the rest stays in the terminal, also for lines joined into one. */
function capNotice(text: string): string {
  return text.length > LOCAL_COMMAND_MAX_CHARS ? `${text.slice(0, LOCAL_COMMAND_MAX_CHARS)}\u2026` : text;
}

/** The notice a turn is, when it is nothing else. */
function loneNotice(turn: ConversationTurn | undefined): Extract<ConversationPart, { kind: "notice" }> | null {
  const part = turn?.parts.length === 1 ? turn.parts[0] : undefined;
  return part?.kind === "notice" ? part : null;
}

/** Were these two entries written together? Never when either has no readable time. */
function writtenTogether(a: string | null | undefined, b: string | null | undefined): boolean {
  return a != null && b != null && Math.abs(Date.parse(a) - Date.parse(b)) <= NOTICE_JOIN_MS;
}

/**
 * Claude Code versions differ in where a refused command goes: a `local_command` answer, an
 * `informational` entry, and nothing says one never writes both. The same words from the other
 * kind, written together, are one answer; a notice repeating its own kind is kept.
 */
function saidByOtherKind(turn: ConversationTurn | undefined, text: string, ts: string | null, kind: "local-command" | "informational"): boolean {
  const said = loneNotice(turn);
  if (said === null || said.source === kind || (said.source !== "local-command" && said.source !== "informational")) return false;
  return writtenTogether(turn?.ts, ts) && (said.text === text || said.text.split("\n").includes(text));
}

/**
 * The text of terminal output without its escape codes (colours, links, cursor moves, charset
 * switches) and other controls, in one pass: a sequence cut off by the end swallows the rest,
 * and malformed input never makes it rescan what follows.
 */
function stripTerminalControls(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code !== 0x1b) {
      // tab and newline are text; every other C0 control and DEL is not
      if (code === 0x09 || code === 0x0a || (code >= 0x20 && code !== 0x7f)) out += input[i];
      i++;
      continue;
    }
    const kind = input[i + 1];
    if (kind === "]" || kind === "P" || kind === "X" || kind === "^" || kind === "_") {
      // a string (OSC, DCS, SOS, PM, APC) ends at BEL or ST; another ESC ends it too
      i += 2;
      while (i < input.length && input.charCodeAt(i) !== 0x07 && input.charCodeAt(i) !== 0x1b) i++;
      if (input.charCodeAt(i) === 0x07) i++;
      else if (input[i + 1] === "\\") i += 2;
    } else if (kind === "[") {
      // CSI: parameters, intermediates, one final byte
      i += 2;
      while (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x3f) i++;
      while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
      if (i < input.length && input.charCodeAt(i) >= 0x40 && input.charCodeAt(i) <= 0x7e) i++;
    } else {
      // ESC, intermediates (as in ESC ( B), then one final byte
      i++;
      while (i < input.length && input.charCodeAt(i) >= 0x20 && input.charCodeAt(i) <= 0x2f) i++;
      if (i < input.length && input.charCodeAt(i) >= 0x30 && input.charCodeAt(i) <= 0x7e) i++;
    }
  }
  return out;
}

/**
 * Claude Code wraps a long paste in `<pasted_content id="…">` tags so the model can
 * tell it from typed text; its own TUI shows only the text, and so does the chat.
 */
export function unwrapPastes(text: string): string {
  let changed = false;
  const visible = text.replace(/<pasted_content id="([^"\r\n]+)">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="([^"\r\n]+)">/g,
    (whole: string, opening: string, body: string, closing: string) => {
      if (opening !== closing || opening.length > 64 || !/^[\w-]+$/.test(opening)) return whole;
      changed = true;
      return body;
    });
  return changed ? visible.replace(/^\n+|\n+$/g, "") : text;
}

/** A parsed JSONL line's message shape (only the fields we read). */
export interface TranscriptEntry {
  type?: string;
  subtype?: string;
  operation?: string;
  /** a `system` entry's own text; a message's is under `message` */
  content?: unknown;
  timestamp?: string;
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  /** "updates": Claude Code shows the entry's thinking text as a progress message, not as reasoning */
  thinkingDisplay?: unknown;
  message?: { role?: string; content?: unknown; stop_reason?: unknown };
  attachment?: { type?: unknown; prompt?: unknown; commandMode?: unknown; origin?: { kind?: unknown } };
}

export function claudeResultText(output: unknown): string {
  return typeof output === "string" ? output
    : Array.isArray(output) ? output.map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : "")).join("")
      : "";
}

/**
 * A Claude image's ref: the entry, the block, and for a picture a tool returned its place in the
 * result. The parser names only what transcriptImage can read back by it.
 */
export const CLAUDE_IMAGE_REF = /^([0-9a-f-]{8,64}):(\d{1,3})(?::(\d{1,3}))?$/i;

/**
 * The type of a picture Claude Code holds inline (pasted into a prompt, or a Read of an image
 * file), by its leading bytes: a raster the chat shows, within the size the image endpoint serves.
 * Null for anything else, so the page and the endpoint agree on what is a picture.
 */
export function claudeImageType(block: unknown): string | null {
  const image = block as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | null | undefined;
  if (image?.type !== "image" || image.source?.type !== "base64") return null;
  return inlineImageType(image.source.media_type, image.source.data);
}

/**
 * A record with its inline pictures cut to what claudeImageType reads of them: their first bytes,
 * or none past the size the endpoint serves. A screenshot can make a prompt megabytes long, and its
 * bytes say nothing of where the record hangs in the session.
 */
export function withoutPictureBytes(text: string): string {
  return text.replace(/("(?:data|base64)"\s*:\s*")([A-Za-z0-9+/]*={0,2})"/g,
    (_whole: string, key: string, data: string) => `${key}${base64Size(data) > MAX_IMAGE_BYTES ? "" : data.slice(0, 16)}"`);
}

function claudeImageRef(uuid: unknown, ...at: number[]): string | null {
  if (typeof uuid !== "string") return null;
  const ref = [uuid, ...at].join(":");
  return CLAUDE_IMAGE_REF.test(ref) ? ref : null;
}

/**
 * The pictures among blocks, each named by the entry, the places that lead to the blocks (none for a
 * prompt's own, the result's for a tool's) and its own: named here, fetched only when shown.
 */
export function claudeImages(uuid: unknown, blocks: readonly unknown[], ...at: number[]): { media_type: string; ref: string }[] {
  return blocks.flatMap((block, index) => {
    const mediaType = claudeImageType(block);
    const ref = mediaType === null ? null : claudeImageRef(uuid, ...at, index);
    return mediaType === null || ref === null ? [] : [{ media_type: mediaType, ref }];
  });
}

interface ClaudeTranscriptOptions {
  subagents?: ReadonlyMap<string, SubagentDetail>;
  noticed?: Set<string>;
}

interface ClaudeParseState {
  turns: ConversationTurn[];
  /** Tool parts still waiting for their result, by tool_use id. */
  pending: Map<string, Extract<ConversationPart, { kind: "tool" }>>;
  /** The agent's last entry called a tool: its turn is not over. */
  atWork: boolean;
  /** Injected feedback can resume the model after a completed reply. */
  completed: boolean;
  noticed: Set<string>;
  lastPrompt: { turn: ConversationTurn; parent: string | null | undefined; answered: boolean } | null;
  peersSeen: Set<string>;
}

function claudeParseState(options: ClaudeTranscriptOptions): ClaudeParseState {
  return {
    turns: [], pending: new Map(), atWork: false, completed: false,
    noticed: options.noticed ?? new Set(), lastPrompt: null, peersSeen: new Set(),
  };
}

/**
 * Incrementally splits one transcript file's contents into turns. Adjacent assistant entries
 * merge into a single turn (text parts + tool parts); each tool_use is followed
 * by a user tool_result entry, which is folded into the tool part it answers.
 *
 * A subagent that ended (its `<task-notification>`) is drawn as a task_result in the user's seat,
 * once however many records carry it; `options.subagents` holds what the subagents' own files say
 * of them, by agent id, since the parser reads no files. Other notifications stay hidden.
 */
export function createClaudeTranscriptParser(options: ClaudeTranscriptOptions = {}): TranscriptParser {
  return claudeTranscriptParser(options, claudeParseState(options));
}

function claudeTranscriptParser(options: ClaudeTranscriptOptions, state: ClaudeParseState): TranscriptParser {
  const { turns, pending, noticed, peersSeen } = state;
  /** Where a notice goes: before the turn at work it was written in, else at the end. */
  const noticeAt = (): number => state.atWork && turns.at(-1)?.role === "assistant" ? turns.length - 1 : turns.length;
  /** True when the block was a notification (shown or not): it is no turn of anyone's typing. */
  const notified = (block: string, ts: string | null): boolean => {
    const notice = taskNotification(block);
    if (notice === null) return false;
    const key = `${notice.taskId}\0${notice.toolUseId ?? ""}`;
    if (notice.agent && !noticed.has(key)) {
      noticed.add(key);
      turns.splice(noticeAt(), 0, { role: "user", ts, parts: [{ kind: "task_result", tasks: [agentTaskResult(notice, options.subagents?.get(notice.taskId))] }] });
    }
    return true;
  };

  const assistantTurn = (ts?: string): ConversationTurn => {
    const last = turns[turns.length - 1];
    if (last !== undefined && last.role === "assistant" && !state.completed) return last;
    const turn: ConversationTurn = { role: "assistant", ts: ts ?? null, parts: [] };
    turns.push(turn);
    return turn;
  };

  /** the last human prompt and the entry it hangs from: a send Claude Code cancelled before
   *  any reply is re-sent as a sibling of it, and its own screen shows only the re-send */
  const pushPrompt = (turn: ConversationTurn, entry: TranscriptEntry): void => {
    const { lastPrompt } = state;
    if (lastPrompt !== null && !lastPrompt.answered && typeof entry.parentUuid === "string" && entry.parentUuid === lastPrompt.parent) {
      const index = turns.indexOf(lastPrompt.turn);
      if (index !== -1) turns.splice(index, 1);
    }
    turns.push(turn);
    state.lastPrompt = { turn, parent: entry.parentUuid, answered: false };
  };
  const markPromptAnswered = (): void => {
    if (state.lastPrompt !== null) state.lastPrompt.answered = true;
  };

  const fold = (entry: TranscriptEntry): void => {
    // another session's message: its own turn, so the work it started is not appended to the answer before it
    const peer = claudePeerNotice(entry);
    if (peer !== null) {
      const id = claudePeerId(entry);
      if (id !== null) { if (peersSeen.has(id)) return; peersSeen.add(id); }
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [peer] });
      return;
    }
    if (entry.isMeta) return;
    if (isContextClear(entry, "claude-transcript")) { turns.length = 0; pending.clear(); state.lastPrompt = null; return; }
    const content = entry.message?.content;
    // a compaction's summary marks where the conversation was folded, readable on request
    if (entry.isCompactSummary) {
      const summary = typeof content === "string" ? content
        : Array.isArray(content) ? content.map((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "").join("\n") : "";
      turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "compact", text: summary }] });
      return;
    }

    // A message sent while Claude is working is no `user` entry: it is queued, then recorded
    // as this attachment when the turn takes it in. Background task notices and other agents'
    // messages use the same record, so only a person's prompt counts. The `queue-operation`
    // lines around a prompt repeat it; a task completion can arrive only in its enqueue.
    if (entry.type === "queue-operation" && entry.operation === "enqueue" && typeof entry.content === "string" && notified(entry.content, entry.timestamp ?? null)) return;
    const queued = entry.type === "attachment" ? entry.attachment : undefined;
    if (queued?.commandMode === "task-notification" && typeof queued.prompt === "string" && notified(queued.prompt, entry.timestamp ?? null)) return;
    if (queued?.type === "queued_command" && queued.commandMode === "prompt" && queued.origin?.kind === "human") {
      if (typeof queued.prompt === "string" && queued.prompt.trim() && !isCommandEntry(queued.prompt.trim())) {
        turns.push({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(queued.prompt) }] });
      }
      return;
    }

    // A slash command answers in the terminal, not through the model: a refused /goal says why
    // only here. It is the runtime speaking in the user's seat, so it reads as a notice.
    if (entry.type === "system" && entry.subtype === "local_command") {
      const output = localCommandOutput(entry.content);
      const at = noticeAt();
      if (output.length > 0 && !saidByOtherKind(turns[at - 1], output, entry.timestamp ?? null, "local-command")) turns.splice(at, 0, { role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "notice", text: output, source: "local-command" }] });
      return;
    }

    // Claude Code's own notices: an unknown slash command and the arguments it dropped (2.1.29x
    // writes these here, not as a local_command), a usage limit reached or reset. The message
    // that drew one is not recorded, so without it a refused command just vanished from the chat.
    // Lines written together read as one notice.
    // Claude Code also writes them while the agent works (a message another session held, a
    // stopped response): about half of the real ones. Such a notice does not end the turn: it
    // goes before the turn it was written in, so the turn stays whole and stays the last one,
    // which is what the chat reads as the turn still running.
    if (entry.type === "system" && entry.subtype === "informational") {
      const text = typeof entry.content === "string" ? capNotice(stripTerminalControls(entry.content).trim()) : "";
      if (text.length === 0) return;
      const ts = entry.timestamp ?? null;
      const at = noticeAt();
      const before = turns[at - 1];
      if (saidByOtherKind(before, text, ts, "informational")) return;
      const said = loneNotice(before);
      if (before && said?.source === "informational" && writtenTogether(before.ts, ts)) turns[at - 1] = { ...before, parts: [{ ...said, text: capNotice(`${said.text}\n${text}`) }] };
      else turns.splice(at, 0, { role: "user", ts, parts: [{ kind: "notice", text, source: "informational" }] });
      return;
    }

    if (entry.type === "user" && typeof content === "string") {
      if (notified(content, entry.timestamp ?? null)) return;
      const invocation = claudeCommandEcho(content);
      if (invocation) {
        pushPrompt({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: invocation.text }, { kind: "skill", skill: invocation.skill }] }, entry);
        return;
      }
      if (isCommandEntry(content)) return;
      pushPrompt({ role: "user", ts: entry.timestamp ?? null, parts: [{ kind: "text", text: unwrapPastes(content) }] }, entry);
      return;
    }

    if (entry.type === "user" && Array.isArray(content)) {
      const invocations: ConversationPart[] = [];
      const prompt = content.flatMap((block: unknown) => {
        if (block === null || typeof block !== "object") return [];
        const part = block as { type?: string; text?: unknown };
        // a notice can share an entry with a tool's result
        if (part.type === "text" && typeof part.text === "string" && notified(part.text, entry.timestamp ?? null)) return [];
        const invocation = part.type === "text" && typeof part.text === "string" ? claudeCommandEcho(part.text) : null;
        if (invocation) {
          invocations.push({ kind: "skill", skill: invocation.skill });
          return [invocation.text];
        }
        return part.type === "text" && typeof part.text === "string" && !isCommandEntry(part.text.trim()) ? [part.text] : [];
      }).join("\n");
      for (const [index, block] of content.entries()) {
        if (typeof block !== "object" || block === null) continue;
        const result = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: unknown };
        if (result.type !== "tool_result" || typeof result.tool_use_id !== "string") continue;
        const tool = pending.get(result.tool_use_id);
        if (tool === undefined) continue;
        pending.delete(result.tool_use_id);
        trimOutput(tool, claudeResultText(result.content), result.tool_use_id);
        if (result.is_error === true) tool.error = true;
        // the result's flag, and only it, says how the call went: an empty result is still a success
        if (tool.call_id !== undefined) tool.state = result.is_error === true ? "error" : "ok";
        if (tool.skill) tool.skill.status = result.is_error === true ? "failed" : "loaded";
        // a picture the tool returned (a Read of an image file) sits inside its result
        const pictures = Array.isArray(result.content) ? claudeImages(entry.uuid, result.content, index) : [];
        if (pictures.length > 0) tool.images = pictures;
      }
      const images = claudeImages(entry.uuid, content).map((image) => ({ kind: "image" as const, ...image }));
      if (prompt.trim() || images.length > 0) pushPrompt({ role: "user", ts: entry.timestamp ?? null, parts: [...images, ...(prompt.trim() ? [{ kind: "text" as const, text: unwrapPastes(prompt) }] : []), ...invocations] }, entry);
      return;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      markPromptAnswered();
      const turn = assistantTurn(entry.timestamp);
      // an entry that names no stop reason is still at work when it calls a tool
      const stop = entry.message?.stop_reason;
      state.completed = stop === "end_turn";
      state.atWork = stop === "tool_use" || (stop == null && content.some((block: unknown) => typeof block === "object" && block !== null && "type" in block && block.type === "tool_use"));
      if (entry.timestamp) turn.end_ts = entry.timestamp;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as { type?: string; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          turn.parts.push({ kind: "text", text: b.text, ...(state.completed ? { phase: "final_answer" as const } : {}) });
        } else if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : typeof b.text === "string" ? b.text : "";
          // the terminal prints an "updates" entry's thinking as narration between the tools, so it
          // is read as that: commentary keeps it in the work block, never taken for the answer
          if (thinking.trim().length > 0 && entry.thinkingDisplay === "updates") turn.parts.push({ kind: "text", text: thinking, phase: "commentary" });
          else if (thinking.length > 0) turn.parts.push({ kind: "thinking", text: thinking });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const input = (typeof b.input === "object" && b.input !== null ? b.input : {}) as Record<string, unknown>;
          const part: Extract<ConversationPart, { kind: "tool" }> = {
            kind: "tool",
            name: b.name,
            summary: toolSummary(b.name, input),
            input: JSON.stringify(input, null, 2),
            output: "",
          };
          const skill = invokedSkill(b.name, input);
          if (skill) { part.skill = skill; part.summary = skill.name; }
          const id = (block as { id?: unknown }).id;
          // the native id, and pending until a tool_result answers it
          if (typeof id === "string" && id.length > 0) { part.call_id = id; part.state = "pending"; }
          turn.parts.push(part);
          pending.set(String(id ?? ""), part);
        }
        // unsupported transcript blocks are intentionally ignored
      }
    }
  };

  const write = (text: string): void => {
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue; // a torn tail line while Claude is mid-append
      }
      if (entry !== null && typeof entry === "object") fold(entry);
    }
  };
  return {
    write,
    snapshot(tail = ""): ConversationTurn[] {
      // Preview a valid final record without committing tools, prompt resends or dedup ids.
      // Clone the whole graph so pending tools and lastPrompt still refer to the cloned turns.
      if (tail.trim()) {
        const preview = structuredClone(state);
        claudeTranscriptParser(options, preview).write(tail);
        return preview.turns.filter((turn) => turn.parts.length > 0);
      }
      return structuredClone(turns.filter((turn) => turn.parts.length > 0));
    },
  };
}

/** The one-shot API uses the same record fold as the live reader. */
export function parseClaudeTranscript(text: string, maxTurns = MAX_TURNS, options: ClaudeTranscriptOptions = {}): ConversationTurn[] {
  const state = claudeParseState(options);
  claudeTranscriptParser(options, state).write(text);
  // No writer survives this call, so its owned turns need no detached snapshot.
  return state.turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

