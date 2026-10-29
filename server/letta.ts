/**
 * Letta Code's conversation transcript, read into turns. The TUI appends each turn when it ends
 * (`end_turn`) to `<transcripts>/<agent>/<conversation>/transcript.jsonl`, on the cloud and the
 * local backend alike (letta-code 0.34.27, `appendTranscriptDeltaJsonl`). A line is one entry:
 * - `{ kind: "user" | "assistant" | "reasoning" | "error", text, captured_at }`;
 * - `{ kind: "tool_call", name?, argsText?, resultText?, resultOk?, captured_at }`, the call and its
 *   result in one entry.
 * Each also names a `source_line_id` (unique in the file) and may name a `source_message_id`. Every
 * entry of one turn has the same `captured_at`. A turn that was cancelled or failed is not written,
 * and a turn still running is written only when it ends. A whole line that does not parse or is in
 * another shape throws LettaUnavailable: Chat then uses Terminal rather than show part of it.
 */
import { closeSync, openSync, readSync } from "node:fs";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import { trimOutput } from "./tool-output.ts";
import { toolSummary } from "./transcript-records.ts";

type Row = Record<string, unknown>;
type Tool = Extract<ConversationPart, { kind: "tool" }>;
const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const optional = (value: unknown, type: "string" | "boolean"): boolean => value === undefined || typeof value === type;

export class LettaUnavailable extends Error {
  constructor() { super("Letta transcript is in a shape the reader does not know"); this.name = "LettaUnavailable"; }
}

/** The fields letta-code 0.34.27 writes, by kind: an entry with any other could carry words the reader would drop. */
const FIELDS = new Set(["kind", "text", "captured_at", "source_line_id", "source_message_id"]);
const TOOL_FIELDS = new Set(["kind", "name", "argsText", "resultText", "resultOk", "captured_at", "source_line_id", "source_message_id"]);
/** The refs GET /api/pane/conversation/tool-output takes (TOOL_REF in conversation.ts). */
const TOOL_REF = /^[A-Za-z0-9_:.-]{1,128}$/;

/** Whether a line is an entry letta-code 0.34.27 writes, in the shape the reader takes. */
function known(entry: Row): boolean {
  if (!Object.keys(entry).every((key) => (entry.kind === "tool_call" ? TOOL_FIELDS : FIELDS).has(key))) return false;
  if (typeof entry.captured_at !== "string" || !optional(entry.source_line_id, "string") || !optional(entry.source_message_id, "string")) return false;
  if (entry.kind === "tool_call") {
    return optional(entry.name, "string") && optional(entry.argsText, "string") && optional(entry.resultText, "string") && optional(entry.resultOk, "boolean");
  }
  return (entry.kind === "user" || entry.kind === "assistant" || entry.kind === "reasoning" || entry.kind === "error") && typeof entry.text === "string";
}

/** The words of a user entry, or null when the line is none: a page starts at such a line. */
export function lettaPrompt(entry: Row): string | null {
  return entry.kind === "user" && typeof entry.text === "string" && entry.text.trim() !== "" ? entry.text : null;
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function parseLettaTranscript(text: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const answer = (ts: string | null, part: ConversationPart): void => {
    const last = turns.at(-1);
    if (last?.role === "assistant") { last.parts.push(part); if (ts !== null) last.end_ts = ts; }
    else turns.push({ role: "assistant", ts, ...(ts === null ? {} : { end_ts: ts }), parts: [part] });
  };
  const lines = text.split("\n");
  for (const [at, line] of lines.entries()) {
    if (line === "") continue;
    let entry: unknown;
    // the last line can be one Letta is still writing
    try { entry = JSON.parse(line); } catch { if (at < lines.length - 1) throw new LettaUnavailable(); continue; }
    if (!isRow(entry) || !known(entry)) throw new LettaUnavailable();
    const ts = iso(entry.captured_at);
    const prompt = lettaPrompt(entry);
    if (prompt !== null) { turns.push({ role: "user", ts, parts: [{ kind: "text", text: prompt }] }); continue; }
    const words = typeof entry.text === "string" ? entry.text : "";
    if (entry.kind === "assistant" && words.trim() !== "") answer(ts, { kind: "text", text: words });
    else if (entry.kind === "reasoning" && words.trim() !== "") answer(ts, { kind: "thinking", text: words });
    else if (entry.kind === "error" && words.trim() !== "") answer(ts, { kind: "notice", text: words, source: "error" });
    else if (entry.kind === "tool_call") {
      const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : "tool";
      const input = typeof entry.argsText === "string" ? entry.argsText : "";
      let args: Row = {};
      try { const parsed: unknown = JSON.parse(input); if (isRow(parsed)) args = parsed; } catch { /* summarized by name */ }
      const part: Tool = { kind: "tool", name, summary: toolSummary(name, args), input, output: "" };
      const ref = typeof entry.source_line_id === "string" && TOOL_REF.test(entry.source_line_id) ? entry.source_line_id : "";
      trimOutput(part, typeof entry.resultText === "string" ? entry.resultText : "", ref);
      // an entry without an id the output route takes has no ref to fetch the rest by
      if (ref === "") { delete part.output_ref; delete part.output_size; }
      if (entry.resultOk === false) part.error = true;
      answer(ts, part);
    }
  }
  return turns;
}

/**
 * The whole result of one call, by the `source_line_id` of its entry. ponytail: reads the
 * transcript from the start on each request; read backwards from the end if they grow large.
 */
export function lettaToolOutput(path: string, ref: string): string | null {
  const id = JSON.stringify(ref);
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = Buffer.alloc(0);
    for (let position = 0, got = 0; (got = readSync(fd, chunk, 0, chunk.length, position)) > 0; position += got) {
      const bytes = Buffer.concat([carry, chunk.subarray(0, got)]);
      const end = bytes.lastIndexOf(0x0a) + 1;
      carry = Buffer.from(bytes.subarray(end));
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.includes(id) || !line.includes('"tool_call"')) continue;
        let entry: unknown;
        try { entry = JSON.parse(line); } catch { continue; }
        if (isRow(entry) && entry.kind === "tool_call" && entry.source_line_id === ref) return typeof entry.resultText === "string" ? entry.resultText : "";
      }
    }
    return null;
  } catch { return null; } finally { closeSync(fd); }
}
