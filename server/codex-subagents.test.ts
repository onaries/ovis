import { expect, it } from "bun:test";
import { createCodexTranscriptParser, matchCodexFirstExchange, parseCodexTranscript } from "./codex.ts";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const item = (payload: Record<string, unknown>) => ({ type: "response_item", timestamp: "2026-10-25T12:00:00Z", payload });
const call = (name: string, args: Record<string, unknown>, callId = "spawn") => item({ type: "function_call", name, arguments: JSON.stringify(args), call_id: callId });
const output = (value: unknown, callId = "spawn") => item({ type: "function_call_output", call_id: callId, output: typeof value === "string" ? value : JSON.stringify(value) });
const lines = (...entries: Record<string, unknown>[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

it("shows the native assignment and returned identity without calling spawn completion a finished child", () => {
  const input = call("multi_agent_v1__spawn_agent", { agent_type: "explorer", message: "TASK: Inspect the parser\nReturn the cause." });
  const parser = createCodexTranscriptParser();
  parser.write(lines(input));
  const before = parser.snapshot();
  expect(before[0]?.parts[0]).toMatchObject({ codex_subagents: [{ operation: "spawn", title: "Inspect the parser", prompt: "TASK: Inspect the parser\nReturn the cause.", agent_id: null, status: null }] });
  parser.write(lines(output({ agent_id: id, nickname: "Explorer" })));
  expect(parser.snapshot()[0]?.parts[0]).toMatchObject({ name: "multi_agent_v1__spawn_agent", call_id: "spawn", codex_subagents: [{ agent_id: id, nickname: "Explorer", agent_type: "explorer", status: null }] });
  expect(before[0]?.parts[0]).toMatchObject({ codex_subagents: [{ agent_id: null }] });
  expect(parser.snapshot()).toEqual(parseCodexTranscript(lines(input, output({ agent_id: id, nickname: "Explorer" }))));
});

it("finds a code-mode assignment and its returned agent before the visible output is cut", () => {
  const script = 'await tools.multi_agent_v1__spawn_agent({agent_type:"explorer",fork_context:false,message:"TASK: Inspect the parser\\nReturn the cause."});';
  const turns = parseCodexTranscript(lines(item({ type: "custom_tool_call", name: "exec", input: script, call_id: "spawn" }), output("Script completed\nWall time 0.1 seconds\nOutput:\n" + "x".repeat(5000) + "\n" + JSON.stringify({ agent_id: id, nickname: "Explorer" }))));
  expect(turns[0]?.parts[0]).toMatchObject({ name: "exec", input: script, output_ref: "spawn", codex_subagents: [{ agent_id: id, nickname: "Explorer", title: "Inspect the parser", prompt: "TASK: Inspect the parser\nReturn the cause." }] });
});

it("reads only explicit wait states and keeps empty or unknown replies unknown", () => {
  const invoke = call("wait_agent", { targets: [id, other] }, "wait");
  const result = parseCodexTranscript(lines(invoke, output({ status: { [id]: { completed: "Found it." }, [other]: "running" }, timed_out: false }, "wait")));
  expect(result[0]?.parts[0]).toMatchObject({ codex_subagents: [{ agent_id: id, status: "completed" }, { agent_id: other, status: "running" }] });
  for (const reply of [{ status: {}, timed_out: true }, { status: { [id]: "future_state" } }, {}]) {
    expect(parseCodexTranscript(lines(invoke, output(reply, "wait")))[0]?.parts[0]).toMatchObject({ codex_subagents: [{ status: null }, { status: null }] });
  }
});

it("joins yielded code-mode output to its originating agent call through the cell id", () => {
  const script = 'await tools.multi_agent_v1__spawn_agent({message:"TASK: Inspect the parser"});';
  const text = lines(item({ type: "custom_tool_call", name: "exec", input: script, call_id: "spawn" }), output("Script running with cell ID 42"), call("wait", { cell_id: "42" }, "cell"), output("Script completed\nOutput:\n" + JSON.stringify({ agent_id: id, nickname: "Explorer" }), "cell"));
  expect(parseCodexTranscript(text)[0]?.parts[0]).toMatchObject({ codex_subagents: [{ agent_id: id, nickname: "Explorer" }] });
});

it("keeps already reported identity when the code-mode cell finishes with no further output", () => {
  const script = 'text(await tools.spawn_agent({message:"TASK: Inspect"})); await longJob();';
  const parser = createCodexTranscriptParser();
  parser.write(lines(item({ type: "custom_tool_call", name: "exec", input: script, call_id: "spawn" }), output(`Script running with cell ID 42\nOutput:\n${JSON.stringify({ agent_id: id, nickname: "Scout" })}`)));
  const before = parser.snapshot();
  parser.write(lines(call("wait", { cell_id: "42" }, "cell"), output("Script completed\nOutput:\n", "cell")));
  expect(parser.snapshot()[0]?.parts[0]).toMatchObject({ codex_subagents: [{ agent_id: id, nickname: "Scout" }] });
  expect(before[0]?.parts[0]).toMatchObject({ codex_subagents: [{ agent_id: id, nickname: "Scout" }] });
});

it("shows native completed and failed notifications once as the existing task-result cards", () => {
  const note = `<subagent_notification>\n${JSON.stringify({ agent_path: id, status: { completed: "The parser is fixed." } })}\n</subagent_notification>`;
  const text = lines(call("spawn_agent", { message: "TASK: Inspect the parser", agent_type: "explorer" }), output({ agent_id: id, nickname: "Explorer" }), { type: "event_msg", timestamp: "2026-10-25T12:00:01Z", payload: { type: "user_message", message: note } }, { ...item({ type: "message", role: "user", content: [{ type: "input_text", text: note }] }), timestamp: "2026-10-25T12:00:01Z" });
  const turns = parseCodexTranscript(text);
  const results = turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "task_result");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ tasks: [{ id, title: "Inspect the parser", agent: "explorer", status: "completed", result: "The parser is fixed.", tokens: null, duration_ms: null }] });
  const failed = `<subagent_notification>${JSON.stringify({ agent_path: other, status: { errored: "No file" } })}</subagent_notification>`;
  expect(parseCodexTranscript(lines({ type: "event_msg", payload: { type: "user_message", message: failed } }))[0]?.parts[0]).toMatchObject({ kind: "task_result", tasks: [{ id: other, status: "failed", result: "No file" }] });
});

it("preserves unfamiliar notifications and does not infer cancellation or evaluate scripts", () => {
  const note = `<subagent_notification>${JSON.stringify({ agent_path: id, status: "shutdown" })}</subagent_notification>`;
  expect(parseCodexTranscript(lines({ type: "event_msg", payload: { type: "user_message", message: note } }))[0]?.parts[0]).toMatchObject({ kind: "notice", source: "codex-subagent" });
  for (const script of ['// tools.spawn_agent({message:"fake"})', 'const text = "tools.spawn_agent({})";', 'other.tools.spawn_agent({});']) {
    expect(parseCodexTranscript(lines(item({ type: "custom_tool_call", name: "exec", input: script, call_id: "fake" })))[0]?.parts[0]).not.toHaveProperty("codex_subagents");
  }
  const text = lines(call("close_agent", { target: id }), output({ previous_status: { completed: "Old work" } }));
  expect(parseCodexTranscript(text)[0]?.parts[0]).toMatchObject({ codex_subagents: [{ operation: "close", agent_id: id, status: "completed" }] });
});

it("retains the assignment across waits and shows separate outcomes when a child is reused", () => {
  const notification = (result: Record<string, string>, timestamp: string) => ({ type: "event_msg", timestamp, payload: { type: "user_message", message: `<subagent_notification>${JSON.stringify({ agent_path: id, status: result })}</subagent_notification>` } });
  const text = lines(call("spawn_agent", { message: "TASK: First assignment", agent_type: "explorer" }), output({ agent_id: id }),
    call("wait_agent", { targets: [id] }, "wait"), output({ status: { [id]: "running" }, timed_out: true }, "wait"),
    notification({ completed: "First result" }, "2026-10-25T12:01:00Z"),
    call("followup_task", { agent_id: id, message: "TASK: Second assignment" }, "followup"), output({}, "followup"),
    notification({ errored: "x".repeat(17000) }, "2026-10-25T12:02:00Z"));
  const results = parseCodexTranscript(text).flatMap((turn) => turn.parts).filter((part) => part.kind === "task_result");
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ tasks: [{ id, title: "First assignment", agent: "explorer", status: "completed" }] });
  expect(results[1]).toMatchObject({ tasks: [{ id, title: "Second assignment", agent: "explorer", status: "failed", result_cut: true, result: "x".repeat(16000) }] });
});

it("does not pair ambiguous spawn outputs by their order", () => {
  const script = 'await Promise.all([tools.spawn_agent({message:"First"}),tools.spawn_agent({message:"Second"})]);';
  const text = lines(item({ type: "custom_tool_call", name: "exec", input: script, call_id: "spawn" }), output([{ agent_id: other }, { agent_id: id }]));
  expect(parseCodexTranscript(text)[0]?.parts[0]).toMatchObject({ codex_subagents: [{ title: "First", agent_id: null }, { title: "Second", agent_id: null }] });
});

it("keeps runtime result cards out of the user exchanges used to bind the parent session", () => {
  const prompt = "Inspect this parser";
  const answer = "The parent finished its inspection.";
  const text = lines({ type: "event_msg", payload: { type: "user_message", message: prompt } },
    { type: "event_msg", payload: { type: "user_message", message: `<subagent_notification>${JSON.stringify({ agent_path: id, status: { completed: "Child result" } })}</subagent_notification>` } },
    { type: "event_msg", payload: { type: "agent_message", message: answer } });
  const candidate = { path: "parent", text, firstUserMessage: prompt, createdAtMs: 100 };
  const screen = `OpenAI Codex (v1.0)\n\n› ${prompt}\n\n• ${answer}\n\n› `;
  expect(matchCodexFirstExchange(screen, [candidate], 99)).toBe("parent");
  expect(matchCodexFirstExchange(screen, [candidate, { ...candidate, path: "competing", createdAtMs: 1 }], 99)).toBeNull();
});
