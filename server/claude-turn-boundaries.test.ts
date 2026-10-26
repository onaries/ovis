import { describe, expect, it } from "bun:test";
import { parseClaudeTranscript } from "./conversation.ts";
import { splitTurn } from "../src/lib/workBlocks.ts";

const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
const reply = (text: string, timestamp: string) => ({ type: "assistant", timestamp, message: { content: [{ type: "text", text }], stop_reason: "end_turn" } });

describe("Claude completed turns", () => {
  for (const [name, content] of [
    ["Stop hook feedback", "Stop hook feedback: Verify the fictional catalog."],
    ["hook additional context", [{ type: "text", text: "<system-reminder>Additional hook context: verify the fictional catalog.</system-reminder>" }]],
    ["task notification", "<task-notification><task-id>catalog</task-id><status>completed</status><summary>Catalog check finished.</summary></task-notification>"],
  ] as const) {
    it(`keeps a completed answer separate when ${name} resumes tool work`, () => {
      const turns = parseClaudeTranscript(jsonl(
        { type: "user", message: { content: "Check the fictional library." } },
        { type: "assistant", message: { content: [{ type: "text", text: "Checking the catalog." }, { type: "tool_use", id: "read", name: "Read", input: { file_path: "catalog.txt" } }], stop_reason: "tool_use" } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "Three books" }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "The library has three books." }, { type: "text", text: "Two are available." }], stop_reason: "end_turn" } },
        { type: "user", isMeta: true, userType: "external", message: { role: "user", content } },
        { type: "system", subtype: "stop_hook_summary" },
        { type: "assistant", message: { content: [{ type: "text", text: "Verifying the catalog." }, { type: "tool_use", id: "verify", name: "Read", input: { file_path: "catalog.txt" } }], stop_reason: "tool_use" } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "verify", content: "Three books confirmed" }] } },
        reply("Verified.", "2026-01-01T12:02:00Z"),
      ));
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "assistant"]);
      expect(turns.slice(1).map((turn) => splitTurn(turn.parts).answer.map((part) => part.text))).toEqual([
        ["Checking the catalog.", "The library has three books.", "Two are available."],
        ["Verifying the catalog.", "Verified."],
      ]);
      expect(turns.slice(1).map((turn) => splitTurn(turn.parts).work.map((part) => part.kind))).toEqual([["tool"], ["tool"]]);
      expect(turns.slice(1).flatMap((turn) => turn.parts.filter((part) => part.kind === "tool").map((part) => part.output))).toEqual(["Three books", "Three books confirmed"]);
    });
  }

  it("keeps replies and their times separate across background notifications", () => {
    const turns = parseClaudeTranscript(jsonl(
      reply("The catalog has three books.", "2026-01-01T12:00:00Z"),
      { type: "user", message: { content: "<task-notification><task-id>catalog</task-id><status>completed</status><summary>Catalog check finished.</summary></task-notification>" } },
      { type: "assistant", timestamp: "2026-01-01T12:01:00Z", message: { content: [{ type: "text", text: "Checking availability." }, { type: "tool_use", id: "check", name: "Bash", input: { command: "true" } }], stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "check", content: "Two available" }] } },
      reply("Two books are available.", "2026-01-01T12:02:00Z"),
      { type: "user", isMeta: true, userType: "external", message: { content: "Background command catalog-check failed with exit code 124" } },
      reply("The background check timed out.", "2026-01-01T12:03:00Z"),
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["assistant", "assistant", "assistant"]);
    expect(turns.map((turn) => splitTurn(turn.parts).answer.map((part) => part.text))).toEqual([
      ["The catalog has three books."], ["Checking availability.", "Two books are available."], ["The background check timed out."],
    ]);
    expect(turns.map((turn) => turn.end_ts)).toEqual(["2026-01-01T12:00:00Z", "2026-01-01T12:02:00Z", "2026-01-01T12:03:00Z"]);
    expect(splitTurn(turns[1]!.parts).work.map((part) => part.kind)).toEqual(["tool"]);
    expect(splitTurn(turns[1]!.parts).work.find((part) => part.kind === "tool")).toMatchObject({ output: "Two available" });
  });
});
