import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { readSync } from "node:fs";
import { MAX_TURNS, toolSummary } from "./transcript-records.ts";
import { trimOutput } from "./tool-output.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const CALL_ID = /^[A-Za-z0-9_:.-]{1,128}$/;

/** A task parent can occur on a root prompt; only agent identity marks a child. */
export function copilotRootRecord(value: unknown): boolean {
  const entry = row(value);
  return entry !== null && entry.agentId == null && row(entry.data)?.agentId == null;
}

/** Lines written by the CLI, not its ephemeral streaming updates or nested agents. */
export function copilotRecords(jsonl: string, strict = false): { type: string; data: Row; timestamp: string | null }[] {
  const records: { type: string; data: Row; timestamp: string | null }[] = [];
  const lines = jsonl.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch {
      // An unfinished final append is retried; complete unreadable records are
      // not proof of an empty conversation.
      if (strict && index < lines.length - 1) throw new ConversationUnavailable("transcript_unreadable");
      continue;
    }
    const entry = row(value);
    if (!entry || typeof entry.type !== "string") {
      if (strict) throw new ConversationUnavailable("transcript_unreadable");
      continue;
    }
    if (!copilotRootRecord(entry)) continue;
    const data = row(entry.data);
    if (data === null) {
      if (strict) throw new ConversationUnavailable("transcript_unreadable");
      continue;
    }
    records.push({ type: entry.type, data, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null });
  }
  return records;
}

/** Convert persisted Copilot CLI turns to the shared, read-only chat shape. */
export function parseCopilotTranscript(jsonl: string, maxTurns = MAX_TURNS): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pending = new Map<string, Extract<ConversationPart, { kind: "tool" }>>();
  const completionTools = new Map<string, string>();
  let finished = false;
  let completion: string | null = null;
  const flushCompletion = (): void => {
    const last = turns.at(-1);
    const lastText = last?.parts.filter((part) => part.kind === "text").at(-1);
    if (completion !== null && last?.role === "assistant") {
      if (lastText?.kind === "text" && lastText.text === completion) lastText.phase = "final_answer";
      else if (!last.parts.some((part) => part.kind === "text" && part.phase === "final_answer")) {
        last.parts.push({ kind: "text", text: completion, phase: "final_answer" });
      }
    }
    completion = null;
  };
  const assistant = (ts: string | null): ConversationTurn => {
    const last = turns.at(-1);
    if (last?.role === "assistant" && !finished) return last;
    const turn: ConversationTurn = { role: "assistant", ts, parts: [] };
    turns.push(turn);
    finished = false;
    return turn;
  };
  const addTool = (data: Row, ts: string | null, name: string, intention: string | null = null): void => {
    const id = data.toolCallId;
    if (typeof id !== "string" || !CALL_ID.test(id) || pending.has(id)) return;
    const args = row(data.arguments) ?? {};
    const part: Extract<ConversationPart, { kind: "tool" }> = {
      kind: "tool", name, summary: text(data.toolTitle) ?? intention ?? toolSummary(name, args),
      input: JSON.stringify(args, null, 2).slice(0, 16_000), output: "",
    };
    assistant(ts).parts.push(part);
    pending.set(id, part);
    const summary = text(args.summary);
    if (name === "task_complete" && summary !== null) completionTools.set(id, summary);
  };
  for (const { type, data, timestamp } of copilotRecords(jsonl, true)) {
    if (type === "user.message") {
      if (typeof data.content !== "string") throw new ConversationUnavailable("transcript_unreadable");
      const content = text(data.content);
      if (content !== null) {
        flushCompletion();
        turns.push({ role: "user", ts: timestamp, parts: [{ kind: "text", text: content }] });
        pending.clear();
        completionTools.clear();
        finished = false;
      }
    } else if (type === "assistant.message") {
      if ((data.content != null && typeof data.content !== "string")
        || (data.content == null && !Array.isArray(data.toolRequests))
        || (data.toolRequests !== undefined && !Array.isArray(data.toolRequests))) throw new ConversationUnavailable("transcript_unreadable");
      const content = text(data.content);
      const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      if (content === null && requests.length === 0) continue;
      const turn = assistant(timestamp);
      if (timestamp !== null) turn.end_ts = timestamp;
      if (content !== null) turn.parts.push({
        kind: "text", text: content,
        ...(data.phase === "final_answer" || data.phase === "commentary" ? { phase: data.phase } : {}),
      });
      for (const raw of requests) {
        const request = row(raw);
        const name = text(request?.name);
        if (request === null || typeof request.toolCallId !== "string" || !CALL_ID.test(request.toolCallId)
          || name === null || (request.arguments != null && row(request.arguments) === null)) {
          throw new ConversationUnavailable("transcript_unreadable");
        }
        addTool(request, timestamp, name, text(request.intentionSummary));
      }
      if (data.phase === "final_answer") finished = true;
    } else if (type === "tool.execution_start") {
      addTool(data, timestamp, text(data.toolName) ?? "tool");
    } else if (type === "tool.execution_complete") {
      const id = data.toolCallId;
      const part = typeof id === "string" ? pending.get(id) : undefined;
      if (!part || typeof id !== "string") continue;
      const output = text(row(data.result)?.content) ?? "";
      trimOutput(part, output, id);
      if (data.success === false) part.error = true;
      if (data.success !== false && completionTools.has(id)) completion ??= completionTools.get(id)!;
      pending.delete(id);
      completionTools.delete(id);
    } else if (type === "session.task_complete") {
      if (turns.length && turns.at(-1)?.role === "user") assistant(timestamp);
      completion = text(data.summary) ?? completion;
    } else if (type === "assistant.turn_end") {
      const last = turns.at(-1);
      if (last?.role === "assistant" && timestamp !== null) last.end_ts = timestamp;
    }
  }
  flushCompletion();
  return turns.filter((turn) => turn.parts.length > 0).slice(-maxTurns);
}

/**
 * Scan a pinned descriptor forward in 64 KiB reads, holding at most one 8 MiB record.
 * Oversized unrelated lines are discarded without parsing; an oversized line that
 * mentions the requested ID fails closed. I/O is linear up to the first result (or
 * EOF for a missing ID), capped at 32 MiB total on the server event loop.
 */
export function copilotOutput(fd: number, ref: string, outputMax: number): string | null {
  if (!CALL_ID.test(ref)) return null;
  const chunk = Buffer.alloc(64 * 1024);
  const needle = Buffer.from(JSON.stringify(ref));
  const recordMax = 8 * 1024 * 1024;
  let pieces: Buffer[] = [];
  let length = 0;
  let oversized = false;
  let mentionsRef = false;
  let overlap = Buffer.alloc(0);
  let requested = false;
  const consume = (): string | null | undefined => {
    if (oversized) return mentionsRef ? null : undefined;
    if (!mentionsRef) return undefined;
    let entry: Row | null;
    try { entry = row(JSON.parse(Buffer.concat(pieces, length).toString("utf8"))); }
    catch { return undefined; }
    if (!copilotRootRecord(entry)) return undefined;
    const data = row(entry?.data);
    if (data === null) return undefined;
    if (entry?.type === "assistant.message" && Array.isArray(data.toolRequests)) {
      requested ||= data.toolRequests.some((value) => row(value)?.toolCallId === ref);
    }
    if (entry?.type === "tool.execution_start" && data.toolCallId === ref) requested = true;
    if (entry?.type !== "tool.execution_complete" || data.toolCallId !== ref) return undefined;
    if (!requested) return null;
    const content = row(data.result)?.content;
    return typeof content === "string" ? content.length > outputMax ? `${content.slice(0, outputMax)}\n… trimmed` : content : null;
  };
  const scanMax = 32 * 1024 * 1024;
  for (let scanned = 0; scanned < scanMax;) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, scanMax - scanned), null);
    if (count === 0) return consume() ?? null;
    scanned += count;
    for (let at = 0; at < count;) {
      const newline = chunk.indexOf(0x0a, at);
      const end = newline < 0 || newline >= count ? count : newline;
      const segment = chunk.subarray(at, end);
      // Keep the needle's trailing bytes so a call ID split across reads is still detected.
      const search = overlap.length ? Buffer.concat([overlap, segment]) : segment;
      if (search.includes(needle)) mentionsRef = true;
      overlap = Buffer.from(search.subarray(Math.max(0, search.length - needle.length + 1)));
      if (!oversized && length + segment.length <= recordMax) { pieces.push(Buffer.from(segment)); length += segment.length; }
      else { oversized = true; pieces = []; length = 0; }
      if (newline < 0 || newline >= count) break;
      const result = consume();
      if (result !== undefined) return result;
      pieces = []; length = 0; oversized = false; mentionsRef = false; overlap = Buffer.alloc(0);
      at = newline + 1;
    }
  }
  // The limit can cut a record: never interpret that prefix as a complete one.
  return null;
}
