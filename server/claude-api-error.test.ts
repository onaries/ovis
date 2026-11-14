import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeTranscript } from "./claude-transcript.ts";

// Claude Code 2.1.321 at an API rate limit, as recorded: its answer entry is the error (isApiErrorMessage), the prompt before it shortened
const recorded = readFileSync(join(import.meta.dir, "fixtures", "claude-api-error-2.1.321.jsonl"), "utf8");

test("shows the API error Claude Code recorded as a failed request, not as its answer", () => {
  const turns = parseClaudeTranscript(recorded);
  expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(turns[1]!.parts).toEqual([{ kind: "text", failed: true,
    text: "API Error: Request rejected (429) · All credentials for model claude-fable-5-2 are cooling down (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.) (reset after 1m28s)" }]);
});

test("keeps an answer that only quotes an error as the answer it is", () => {
  const [user, error] = recorded.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const { isApiErrorMessage: _flag, ...answer } = error!;
  const turns = parseClaudeTranscript(`${JSON.stringify(user)}\n${JSON.stringify(answer)}\n`);
  expect(turns[1]!.parts.some((part) => part.kind === "text" && part.failed === true)).toBe(false);
});
