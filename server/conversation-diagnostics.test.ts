import { expect, it, spyOn } from "bun:test";
import { ConversationDiagnostics } from "./conversation-diagnostics.ts";
import { COPILOT_UNAVAILABLE_REASONS, ConversationReadPending, ConversationUnavailable } from "./conversation-shared.ts";

function fixture() {
  let now = 0;
  const lines: string[] = [];
  const diagnostics = new ConversationDiagnostics((line) => lines.push(line), () => now);
  return { diagnostics, lines, records: () => lines.map((line) => JSON.parse(line)), advance: (ms: number) => { now += ms; } };
}

it("logs only fixed failure stages and opaque request correlation, never exception or pane contents", () => {
  const { diagnostics, records, lines } = fixture();
  const secret = "/private/session-token\ntranscript";
  const error = new ConversationUnavailable(secret, undefined, "copilot_process_lookup_failed");
  Object.assign(error, { path: secret, sessionId: secret });
  diagnostics.unavailable(secret, error, "00000000-0000-4000-8000-000000000001");
  diagnostics.unavailable("other pane", new ConversationUnavailable(secret), secret);
  expect(records()[0]).toMatchObject({
    event: "conversation.failed", operation: "conversation.copilot_process_lookup_failed",
    code: "conversation_unavailable", request_id: "00000000-0000-4000-8000-000000000001",
  });
  expect(records()[1]).toMatchObject({ operation: "conversation.unknown" });
  expect(records()[1].request_id).toBeUndefined();
  expect(lines.join("\n")).not.toContain("private");
  expect(lines.join("\n")).not.toContain("session-token");
});

it("coalesces repeated reasons and rapid recoveries without losing the episode correlation", () => {
  const { diagnostics, records, advance } = fixture();
  for (let i = 0; i < 100; i++) {
    diagnostics.unavailable("pane", new ConversationUnavailable("no_session_path"));
    diagnostics.recovered("pane");
  }
  expect(records()).toHaveLength(2);
  expect(records()[1]).toMatchObject({ event: "conversation.recovered", episode_id: records()[0].episode_id });
  advance(30_000);
  diagnostics.unavailable("pane", new ConversationReadPending());
  expect(records()[2]).toMatchObject({
    operation: "conversation.read_pending", code: "conversation_read_pending", failures: 100, suppressed: 99,
  });
});

it("bounds output even when pane keys rotate past the retained episode limit", () => {
  const { diagnostics, records, advance } = fixture();
  for (let i = 0; i < 300; i++) diagnostics.unavailable(`pane-${i}`, new ConversationUnavailable("no_session_id"));
  expect(records()).toHaveLength(16);
  advance(30_000);
  diagnostics.recovered("pane-299"); // its failure was never shown: no orphan recovery
  diagnostics.recovered("pane-0"); // retired with the oldest keys: nothing left to close
  expect(records()).toHaveLength(16);
  diagnostics.unavailable("new-pane", new ConversationUnavailable("no_session_id"));
  expect(records()).toHaveLength(17);
});

it("keeps episodes apart while the line budget is spent", () => {
  const { diagnostics, records, advance } = fixture();
  for (let i = 0; i < 16; i++) diagnostics.unavailable(`pane-${i}`, new ConversationUnavailable("no_session_path"));
  diagnostics.recovered("pane-0"); // no line left in this window, but the episode still ends
  expect(records()).toHaveLength(16);
  advance(30_000);
  diagnostics.unavailable("pane-0", new ConversationUnavailable("no_session_path"));
  expect(records()[16]).toMatchObject({ event: "conversation.failed", failures: 1 });
  expect(records()[16].episode_id).not.toBe(records()[0].episode_id);
});

it("keeps an agent pane without a folder in its failure episode", () => {
  const { diagnostics, records, advance } = fixture();
  diagnostics.unavailable("copilot", new ConversationUnavailable("no_session_path", undefined, "copilot_process_lookup_failed"));
  diagnostics.unavailable("copilot", new ConversationUnavailable("no_recognized_transcript", undefined, "agent_cwd_missing"));
  advance(30_000);
  diagnostics.unavailable("copilot", new ConversationUnavailable("no_recognized_transcript", undefined, "agent_cwd_missing"));
  expect(records().map((record) => record.event)).toEqual(["conversation.failed", "conversation.failed"]);
  expect(records()[1]).toMatchObject({ operation: "conversation.agent_cwd_missing", episode_id: records()[0].episode_id, failures: 3 });
});

it("does not count a pane without an agent conversation as a failure", () => {
  const { diagnostics, records } = fixture();
  for (let i = 0; i < 50; i++) diagnostics.unavailable(`shell-${i}`, new ConversationUnavailable("no_recognized_transcript"));
  expect(records()).toEqual([]);
  diagnostics.unavailable("copilot", new ConversationUnavailable("no_session_path", undefined, "copilot_process_lookup_failed"));
  diagnostics.unavailable("copilot", new ConversationUnavailable("no_recognized_transcript")); // its agent left: the episode ends
  expect(records().map((record) => record.event)).toEqual(["conversation.failed", "conversation.recovered"]);
});

it("keeps the logging interval monotonic across wall-clock corrections", () => {
  const { diagnostics, records, advance } = fixture();
  const wall = spyOn(Date, "now").mockReturnValue(100_000);
  try {
    diagnostics.unavailable("pane", new ConversationUnavailable("no_session_path"));
    wall.mockReturnValue(1);
    advance(29_999);
    diagnostics.unavailable("pane", new ConversationUnavailable("no_session_path"));
    expect(records()).toHaveLength(1);
    advance(1);
    diagnostics.unavailable("pane", new ConversationUnavailable("no_session_path"));
    expect(records()).toHaveLength(2);
  } finally { wall.mockRestore(); }
});

it("accepts every code-owned Copilot diagnostic without accepting a forged stage", () => {
  const { diagnostics, records } = fixture();
  for (const diagnostic of COPILOT_UNAVAILABLE_REASONS) {
    diagnostics.unavailable(diagnostic, new ConversationUnavailable("no_session_path", undefined, diagnostic));
  }
  const forged = new ConversationUnavailable("no_session_path");
  Object.defineProperty(forged, "diagnostic", { value: "private-token" });
  diagnostics.unavailable("forged", forged);
  expect(records().map((record) => record.operation)).toEqual([
    ...COPILOT_UNAVAILABLE_REASONS.map((reason) => `conversation.${reason}`), "conversation.unknown",
  ]);
});

it("does not change response handling when its writer fails", () => {
  const diagnostics = new ConversationDiagnostics(() => { throw new Error("log unavailable"); });
  expect(() => diagnostics.unavailable("pane", new ConversationReadPending())).not.toThrow();
  expect(() => diagnostics.recovered("pane")).not.toThrow();
});
