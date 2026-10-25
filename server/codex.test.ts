import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { Database } from "bun:sqlite";
import { codexCallFailed, codexHistoryTail, codexHomeInPsLine, codexRolloutPath, interactiveCodexRollout, processCodexHome, forgetHistoryChains, matchCodexFirstExchange, matchCodexTranscript, matchShortCodexAnswers, parseCodexTranscript, codexPeersIn, resumedThread, rolloutInsideStore, sameDirectory, storedCwdCondition, storedCwds, unansweredCodexQuestions, withoutVerbatimPrefix } from "./codex.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { splitTurn } from "../src/lib/workBlocks.ts";
import rolloutHeaders from "./fixtures/codex-rollout-headers.json";

const ts = "2026-09-22T01:00:00.000Z";
const item = (payload: unknown, timestamp = ts) => ({ type: "response_item", timestamp, payload });
const event = (payload: unknown, timestamp = ts) => ({ type: "event_msg", timestamp, payload });
const message = (role: string, text: string, phase?: string) => item({
  type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...(phase ? { phase } : {}),
});
const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

describe("a Codex process's own store", () => {
  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("reads CODEX_HOME from the process's environment, and nothing from one without it", async () => {
    // not a system binary: macOS shows no environment of those (Codex is not one)
    const sleeper = (env: Record<string, string | undefined>) =>
      Bun.spawn([process.execPath, "-e", "console.log('up'); await Bun.sleep(5000)"], { env, stdout: "pipe" });
    // the stores are directories that are there: a value that names none is no store (macOS reads it from `ps`)
    const withHome = sleeper({ ...process.env, CODEX_HOME: tmpdir() });
    const without = sleeper(Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CODEX_HOME")));
    // a macOS home folder can hold a space; a variable after it ends the value
    const spaced = sleeper({ ...process.env, CODEX_HOME: join(tmpdir(), "harness codex test"), AFTER_CODEX_HOME: "x" });
    mkdirSync(join(tmpdir(), "harness codex test"), { recursive: true });
    try {
      // all have started (exec'd) before their environment is read
      for (const child of [withHome, without, spaced]) await child.stdout.getReader().read();
      expect(await processCodexHome(withHome.pid)).toBe(tmpdir());
      expect(await processCodexHome(without.pid)).toBeNull();
      expect(await processCodexHome(spaced.pid)).toBe(join(tmpdir(), "harness codex test"));
    } finally { withHome.kill(); without.kill(); spaced.kill(); }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("keeps a process's store under its pid and argv, and reads it again for other arguments", async () => {
    const home = mkdtempSync(join(tmpdir(), "herdr-codex-home-"));
    const child = Bun.spawn([process.execPath, "-e", "console.log('up'); await Bun.sleep(5000)"], { env: { ...process.env, CODEX_HOME: home }, stdout: "pipe" });
    try {
      await child.stdout.getReader().read();
      expect(await processCodexHome(child.pid, ["codex", "--first"])).toBe(home);
      // the store goes away: the same pid and argv are answered from what was read, without reading again
      rmSync(home, { recursive: true, force: true });
      expect(await processCodexHome(child.pid, ["codex", "--first"])).toBe(home);
      // other arguments under that pid are another process as far as the cache knows: read again
      expect(await processCodexHome(child.pid, ["codex", "--second"])).toBeNull();
      // Even matching pid/argv must be re-read at the deadline, without a real 30-second sleep.
      const expiredAt = Date.now() + 30_001;
      const clock = spyOn(Date, "now").mockReturnValue(expiredAt);
      try {
        expect(await processCodexHome(child.pid, ["codex", "--first"])).toBeNull();
      } finally { clock.mockRestore(); }
    } finally { child.kill(); rmSync(home, { recursive: true, force: true }); }
  });
});

describe("CODEX_HOME in a ps -E line", () => {
  it("takes the last assignment, keeps spaces in it, and ends it at the next variable", () => {
    expect(codexHomeInPsLine("node /opt/codex/bin/codex.js --model x PATH=/usr/bin CODEX_HOME=/Users/alice/Codex Profiles/work TERM=xterm")).toBe("/Users/alice/Codex Profiles/work");
    expect(codexHomeInPsLine("codex CODEX_HOME=/tmp/arg HOME=/Users/alice CODEX_HOME=/Users/alice/.codex-work")).toBe("/Users/alice/.codex-work");
    expect(codexHomeInPsLine("codex exec HOME=/Users/alice TERM=xterm")).toBeNull();
    expect(codexHomeInPsLine("codex CODEX_HOME= HOME=/Users/alice")).toBeNull();
  });
});

describe("Codex conversation records", () => {
  it("hides memory citations before pairing display/model answers in either order", () => {
    const citation = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[context]\n</citation_entries>\n<rollout_ids>\nthread-id\n</rollout_ids>\n</oai-mem-citation>";
    for (const reverse of [false, true]) {
      const pair = [message("assistant", `Done\n${citation}`, "final_answer"), event({ type: "agent_message", message: "Done" })];
      if (reverse) pair.reverse();
      expect(parseCodexTranscript(jsonl(...pair))).toEqual([
        { role: "assistant", ts, end_ts: ts, parts: [{ kind: "text", text: "Done", phase: "final_answer" }] },
      ]);
    }
  });

  it("hides multiple and unfinished memory blocks without dropping surrounding prose", () => {
    expect(parseCodexTranscript(jsonl(
      message("assistant", "Before<oai-mem-citation>one</oai-mem-citation> after<oai-mem-citation>two</oai-mem-citation>", "final_answer"),
      event({ type: "agent_message", message: "Next\n<oai-mem-citation>unfinished" }),
      message("assistant", "<oai-mem-citation>metadata only</oai-mem-citation>"),
    ))[0]?.parts).toEqual([
      { kind: "text", text: "Before after", phase: "final_answer" },
      { kind: "text", text: "Next" },
    ]);
    expect(parseCodexTranscript(jsonl(message("assistant", "<oai-mem-citation>unfinished")))).toEqual([]);
  });

  it("preserves memory markup quoted by a user or returned by a tool", () => {
    const text = "<oai-mem-citation>quoted metadata</oai-mem-citation>";
    const turns = parseCodexTranscript(jsonl(
      message("user", text),
      item({ type: "function_call", call_id: "read", name: "read", arguments: "{}" }),
      item({ type: "function_call_output", call_id: "read", output: text }),
    ));
    expect(turns[0]?.parts).toEqual([{ kind: "text", text }]);
    expect(turns[1]?.parts[0]).toMatchObject({ kind: "tool", output: text });
  });

  it("preserves literal memory tags in inline code and code fences", () => {
    const examples = [
      "Match the literal tag `<oai-mem-citation>` in the parser.\nKeep this explanatory paragraph.",
      "The block is `<oai-mem-citation>sample</oai-mem-citation>`.",
      "Use `` `<oai-mem-citation>` `` to quote the tag.",
      "A backslash inside code is literal: `<oai-mem-citation>\\` and prose follows.",
      "Example:\n```xml\n<oai-mem-citation>sample</oai-mem-citation>\n```\nExplanation follows.",
      "Example:\n  ~~~~xml\n<oai-mem-citation>sample</oai-mem-citation>\n  ~~~\nStill code.\n  ~~~~~\nExplanation follows.",
      "Example:\n````xml\n<oai-mem-citation>sample</oai-mem-citation>\n```\nStill code.\n````\nExplanation follows.",
      "An unfinished example:\n```xml\n<oai-mem-citation>literal tag",
      "An unfinished example:\n~~~xml\n<oai-mem-citation>literal tag",
    ];
    for (const text of examples) {
      expect(parseCodexTranscript(jsonl(message("assistant", text, "final_answer")))[0]?.parts).toEqual([
        { kind: "text", text, phase: "final_answer" },
      ]);
    }
  });

  it("removes metadata around code examples before pairing their display records", () => {
    const example = "Before `<oai-mem-citation>` after\n~~~xml\n<oai-mem-citation>sample</oai-mem-citation>\n~~~\nDone";
    const response = "<oai-mem-citation>first</oai-mem-citation>" + example + "\n<oai-mem-citation>unfinished";
    for (const reverse of [false, true]) {
      const pair = [message("assistant", response, "final_answer"), event({ type: "agent_message", message: example })];
      if (reverse) pair.reverse();
      expect(parseCodexTranscript(jsonl(...pair))[0]?.parts).toEqual([
        { kind: "text", text: example, phase: "final_answer" },
      ]);
    }
    const mixed = "Before\n<oai-mem-citation>hidden</oai-mem-citation>\n```xml\n<oai-mem-citation>literal</oai-mem-citation>\n```\n<oai-mem-citation>also hidden</oai-mem-citation>\nAfter";
    expect(parseCodexTranscript(jsonl(message("assistant", mixed)))[0]?.parts).toEqual([
      { kind: "text", text: "Before\n\n```xml\n<oai-mem-citation>literal</oai-mem-citation>\n```\n\nAfter" },
    ]);
    const payload = "Before<oai-mem-citation>\n~~~xml\n`unclosed\n</oai-mem-citation>After\n<oai-mem-citation>hidden too</oai-mem-citation>";
    expect(parseCodexTranscript(jsonl(message("assistant", payload)))[0]?.parts).toEqual([{ kind: "text", text: "BeforeAfter" }]);
  });

  it("preserves fences inside quotes and lists only within their containers", () => {
    const hidden = "<oai-mem-citation>actual metadata</oai-mem-citation>";
    const examples = [
      "> ```xml\n> <oai-mem-citation>literal tag\n> explanation",
      "> > ~~~xml\n> > <oai-mem-citation>literal tag\n> > explanation",
      "> > ```xml\n> > <oai-mem-citation>literal tag\n> > ```\n> Quote continues.",
      "- Example:\n  ```xml\n  <oai-mem-citation>literal tag\n  explanation",
      "- ~~~xml\n  <oai-mem-citation>literal tag\n  ~~~\n  Item continues.",
      "1. Example:\n   - ```xml\n     <oai-mem-citation>literal tag\n     explanation",
      "> - Example:\n>   ```xml\n>   <oai-mem-citation>literal tag\n>   explanation",
    ];
    for (const example of examples) {
      const text = `${example}\nOutside\n${hidden}`;
      expect(parseCodexTranscript(jsonl(message("assistant", text)))[0]?.parts).toEqual([{ kind: "text", text: `${example}\nOutside` }]);
    }
    const nested = "> > ```xml\n> > <oai-mem-citation>literal tag\n> Parent quote\n> " + hidden;
    expect(parseCodexTranscript(jsonl(message("assistant", nested)))[0]?.parts).toEqual([
      { kind: "text", text: "> > ```xml\n> > <oai-mem-citation>literal tag\n> Parent quote\n>" },
    ]);
    const crlf = "> ```xml\r\n> <oai-mem-citation>literal tag\r\nOutside\r\n" + hidden;
    expect(parseCodexTranscript(jsonl(message("assistant", crlf)))[0]?.parts).toEqual([
      { kind: "text", text: "> ```xml\r\n> <oai-mem-citation>literal tag\r\nOutside" },
    ]);
  });

  it("does not let escaped, unmatched or cross-paragraph backticks hide metadata", () => {
    for (const text of [
      "An unmatched ` delimiter.\n<oai-mem-citation>hidden</oai-mem-citation>",
      "An escaped \\` delimiter.\n<oai-mem-citation>hidden</oai-mem-citation>\nA second \\` delimiter.",
      "First `\n\n<oai-mem-citation>hidden</oai-mem-citation>\n\nSecond `",
    ]) {
      const expected = text.replace("<oai-mem-citation>hidden</oai-mem-citation>", "").trimEnd();
      expect(parseCodexTranscript(jsonl(message("assistant", text)))[0]?.parts).toEqual([{ kind: "text", text: expected }]);
    }
  });

  it("bounds citation parsing with many unmatched backtick lengths", () => {
    const text = "Unmatched delimiters: " + Array.from({ length: 1000 }, (_, i) => "`".repeat(i + 1) + " x ").join("");
    const transcript = jsonl(message("assistant", `${text}<oai-mem-citation>hidden</oai-mem-citation>`));
    const started = performance.now();
    expect(parseCodexTranscript(transcript)[0]?.parts).toEqual([{ kind: "text", text: text.trimEnd() }]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("hides injected context, metadata and developer messages while preserving the real request", () => {
    const turns = parseCodexTranscript(jsonl(
      { type: "session_meta", payload: { base_instructions: "internal system prompt" } },
      message("developer", "internal developer prompt"),
      message("user", "# AGENTS.md instructions for /project\n<INSTRUCTIONS>internal rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>"),
      message("user", "<environment_context>cwd</environment_context>"),
      item({ type: "message", role: "user", content: [null, { type: "input_text", text: "<environment_context>cwd</environment_context>" }, { type: "input_text", text: "Fix chat" }] }),
      event({ type: "user_message", kind: "internal", message: "injected reminder" }),
      event({ type: "token_count", info: { total: 10 } }),
      message("assistant", "Fixed", "final_answer"),
    ));
    expect(turns).toHaveLength(2);
    expect(turns[0]?.parts).toEqual([{ kind: "text", text: "Fix chat" }]);
    expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Fixed", phase: "final_answer" }]);
  });

  it("hides complete directory-less AGENTS envelopes in event and model records", () => {
    for (const newline of ["\n", "\r\n"]) {
      const injected = ["# AGENTS.md instructions", "", "<INSTRUCTIONS>", "Synthetic rules", "</INSTRUCTIONS>"].join(newline);
      const turns = parseCodexTranscript(jsonl(
        message("user", injected), event({ type: "user_message", message: injected }),
        message("user", "Check fixture"), message("assistant", "Ready", "final_answer"),
      ));
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
      expect(turns[0]?.parts).toEqual([{ kind: "text", text: "Check fixture" }]);
    }
  });

  it("preserves incomplete, similar and user-extended AGENTS messages", () => {
    for (const text of [
      "# AGENTS.md instructions\nExplain this",
      "# AGENTS.md instructions-extra\n<INSTRUCTIONS>example</INSTRUCTIONS>",
      "# AGENTS.md instructions\nexample</INSTRUCTIONS>",
      "# AGENTS.md instructions\n<INSTRUCTIONS>example</INSTRUCTIONS>\nPlease explain why this rule is wrong.",
      "# AGENTS.md instructions for /project\n<INSTRUCTIONS>example</INSTRUCTIONS>\nPlease explain.",
    ]) {
      for (const record of [message("user", text), event({ type: "user_message", message: text })]) {
        expect(parseCodexTranscript(jsonl(record))[0]?.parts).toEqual([{ kind: "text", text }]);
      }
    }
  });

  it("pairs duplicate display/model records in either order but keeps genuine repeated prompts", () => {
    for (const reverse of [false, true]) {
      const pair = [message("user", "continue"), event({ type: "user_message", message: "continue" })];
      if (reverse) pair.reverse();
      const turns = parseCodexTranscript(jsonl(
        ...pair,
        event({ type: "agent_message", message: "Done" }), message("assistant", "Done", "final_answer"),
        message("user", "continue"), message("user", "continue"),
      ));
      expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "user"]);
      expect(turns[1]?.parts).toEqual([{ kind: "text", text: "Done", phase: "final_answer" }]);
    }
  });

  it("does not deduplicate identical messages in separate turns", () => {
    expect(parseCodexTranscript(jsonl(
      message("user", "continue"),
      event({ type: "user_message", message: "continue" }, "2026-09-22T01:00:02.000Z"),
    ))).toHaveLength(2);
  });

  it("folds matched function/freeform tool output and commentary, keeping only the final answer outside", () => {
    const turns = parseCodexTranscript(jsonl(
      message("user", "Check"),
      message("assistant", "Checking", "commentary"),
      item({ type: "function_call", call_id: "read", name: "exec_command", arguments: '{"cmd":"git status"}' }),
      item({ type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }),
      item({ type: "custom_tool_call_output", call_id: "patch", output: "applied" }),
      item({ type: "function_call_output", call_id: "read", output: [{ type: "text", text: "clean" }] }),
      item({ type: "function_call_output", call_id: "unknown", output: "not a chat message" }),
      message("assistant", "Verifying", "commentary"),
      message("assistant", "All fixed", "final_answer"),
    ));
    const split = splitTurn(turns[1]!.parts);
    expect(split.work.map((part) => part.kind)).toEqual(["text", "tool", "tool", "text"]);
    expect(split.work[1]).toMatchObject({ summary: "git status", output: "clean" });
    expect(split.work[2]).toMatchObject({ name: "apply_patch", output: "applied" });
    expect(split.answer).toEqual([{ kind: "text", text: "All fixed", phase: "final_answer" }]);
  });

  it("retains reasoning summaries as thinking without decoding encrypted context", () => {
    const turns = parseCodexTranscript(jsonl(
      item({ type: "reasoning", summary: [{ type: "summary_text", text: "Considering options" }], encrypted_content: "secret" }),
      item({ type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "Analysis text" }] }),
      message("assistant", "Answer", "final_answer"),
    ));
    expect(turns[0]?.parts.map((part) => part.kind)).toEqual(["thinking", "thinking", "text"]);
    expect(JSON.stringify(turns)).not.toContain("secret");
  });

  it("uses task timestamps rather than idle time before the next user prompt", () => {
    const turns = parseCodexTranscript(jsonl(
      event({ type: "task_started", started_at: ts }),
      message("user", "Check"),
      item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }], phase: "final_answer" }, "2026-09-22T01:00:06.000Z"),
      event({ type: "task_complete" }, "2026-09-22T01:00:07.000Z"),
      event({ type: "user_message", message: "Next" }, "2026-09-22T02:00:00.000Z"),
    ));
    expect(turns[1]).toMatchObject({ ts, end_ts: "2026-09-22T01:00:07.000Z" });
  });

  it("bounds tool output and history and tolerates malformed or partially written records", () => {
    const text = jsonl(null, 1, { type: "response_item", payload: null },
      item({ type: "function_call", call_id: "c", name: "exec_command", arguments: "{bad json" }),
      item({ type: "function_call_output", call_id: "c", output: "x".repeat(10_000) }));
    const part = parseCodexTranscript(`${text}\n{"type":`)[0]?.parts[0];
    expect(part?.kind === "tool" ? part.output.length : 0).toBeGreaterThan(4000);
    expect(part?.kind === "tool" ? part.output.length : 0).toBeLessThan(4100);
    expect(parseCodexTranscript(jsonl(...Array.from({ length: 150 }, (_, i) => message("user", `request ${i}`))))).toHaveLength(100);
  });
});

describe("Codex queued questions (request_user_input_async)", () => {
  const ask = (callId: string, questions: unknown[]) => item({
    type: "function_call", name: "request_user_input_async", call_id: callId, arguments: JSON.stringify({ questions }),
  });
  const reply = (...answers: { callId: string; index: number; question: string; answer: string }[]) => message("user",
    `<send_user_message_question_reply>\n${JSON.stringify(answers.map((answer) => ({
      answer: answer.answer, question: answer.question,
      questionItemId: JSON.stringify(["request_user_input_async", answer.callId, answer.index]),
    })))}\n</send_user_message_question_reply>`);
  const asked = ask("call_a", [
    { title: "Which dataset?", options: ["LM-O", "YCB-V"] },
    { title: "Any notes?" },
  ]);
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("shows only what was answered, and the questions asked as the tool's summary", () => {
    const turns = parseCodexTranscript(jsonl(
      message("user", "Clean up the outputs"),
      asked,
      item({ type: "function_call_output", call_id: "call_a", output: "{\"accepted\":true}" }),
      reply({ callId: "call_a", index: 0, question: "Which dataset?", answer: "YCB-V" }),
      reply({ callId: "call_a", index: 1, question: "Any notes?", answer: "keep the logs" }, { callId: "call_b", index: 0, question: "Split?", answer: "test" }),
      message("user", "<send_user_message_question_reply>not json</send_user_message_question_reply>"),
    ));
    expect(turns.filter((turn) => turn.role === "user").map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "Clean up the outputs" },
      { kind: "text", text: "YCB-V" },
      { kind: "text", text: "keep the logs\ntest" },
      // not a reply Codex wrote: shown as it is
      { kind: "text", text: "<send_user_message_question_reply>not json</send_user_message_question_reply>" },
    ]);
    expect(turns[1]!.parts[0]).toMatchObject({ kind: "tool", name: "request_user_input_async", summary: "Which dataset? · Any notes?" });
  });

  it("scans a rollout once however many ask at the same time", async () => {
    dir = mkdtempSync(join(tmpdir(), "ovis-codex-questions-"));
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, `${jsonl(message("user", "go"), ask("call_x", [{ title: "First?", options: ["a"] }]))}\n`);
    await unansweredCodexQuestions(path);
    appendFileSync(path, `${jsonl(ask("call_y", [{ title: "Second?", options: ["b"] }]))}\n`);
    // two viewers polling at once: the append is read once, not once per poll
    const [one, two] = await Promise.all([unansweredCodexQuestions(path), unansweredCodexQuestions(path)]);
    expect(one.map((question) => question.title)).toEqual(["First?", "Second?"]);
    expect(two).toEqual(one);
    expect((await unansweredCodexQuestions(path)).map((question) => question.title)).toEqual(["First?", "Second?"]);
  });

  it("lists the questions still unanswered, reading only what the rollout appends", async () => {
    dir = mkdtempSync(join(tmpdir(), "ovis-codex-questions-"));
    const path = join(dir, "rollout.jsonl");
    writeFileSync(path, `${jsonl(message("user", "go"), asked)}\n`);
    expect(await unansweredCodexQuestions(path)).toEqual([
      { key: "call_a:0", title: "Which dataset?", options: ["LM-O", "YCB-V"] },
      { key: "call_a:1", title: "Any notes?", options: [] },
    ]);
    appendFileSync(path, `${jsonl(reply({ callId: "call_a", index: 0, question: "Which dataset?", answer: "LM-O" }))}\n`);
    // a record still being written is not read yet
    appendFileSync(path, JSON.stringify(ask("call_b", [{ title: "Split?", options: [{ label: "train" }, { label: "test" }] }])).slice(0, 40));
    expect((await unansweredCodexQuestions(path)).map((question) => question.key)).toEqual(["call_a:1"]);
    appendFileSync(path, `${JSON.stringify(ask("call_b", [{ title: "Split?", options: [{ label: "train" }, { label: "test" }] }])).slice(40)}\n`);
    expect(await unansweredCodexQuestions(path)).toEqual([
      { key: "call_a:1", title: "Any notes?", options: [] },
      { key: "call_b:0", title: "Split?", options: ["train", "test"] },
    ]);
  });
});

describe("Codex rollout resolution", () => {
  it("reads the thread a TUI was resumed on from its command line", () => {
    const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";
    expect(resumedThread([["node", "/usr/bin/codex", "resume", thread, "--yolo"], ["/vendor/codex", "resume"]])).toBe(thread);
    expect(resumedThread([["codex", "resume", "--last"], ["codex"]])).toBeNull();
    expect(resumedThread([["codex", "exec", "resume"]])).toBeNull();
    expect(resumedThread([])).toBeNull();
  });

  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("accepts files inside the store and rejects traversal, external symlinks, missing files and directories", () => {
    // an accepted rollout comes back canonical; macOS's tmpdir is a symlink into /private
    const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-path-"))); roots.push(root);
    const home = join(root, "codex"); const sessions = join(home, "sessions");
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, "rollout.jsonl"); writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } }));
    const outside = join(root, "other.jsonl"); writeFileSync(outside, "");
    symlinkSync(outside, join(sessions, "escape.jsonl"));
    expect(codexRolloutPath(path, home)).toBe(path);
    for (const candidate of [outside, join(sessions, "escape.jsonl"), join(sessions, "missing.jsonl"), sessions]) {
      expect(codexRolloutPath(candidate, home)).toBeNull();
    }
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: { subagent: { parent_thread_id: "parent" } } } }));
    expect(codexRolloutPath(path, home)).toBeNull();
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "subagent" } }));
    expect(codexRolloutPath(path, home)).toBeNull();
  });

  it("the live reader takes each fixture rollout header as the shared table says", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-eligible-"))); roots.push(root);
    const home = join(root, "codex"); const day = join(home, "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    for (const fixture of rolloutHeaders.cases) {
      const path = join(day, fixture.file);
      writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: fixture.payload }).replaceAll('"{{CWD}}"', JSON.stringify(root))}\n`);
      expect([fixture.name, interactiveCodexRollout(fixture.payload, fixture.file)]).toEqual([fixture.name, fixture.interactive]);
      expect([fixture.name, codexRolloutPath(path, home)]).toEqual([fixture.name, fixture.interactive ? path : null]);
    }
  });

  it("present rollout identities match the canonical filename UUID", () => {
    const thread = "01a0d000-0000-7000-8000-0000000000bb";
    const other = "01a0d000-0000-7000-8000-0000000000cc";
    const name = `rollout-2026-10-20T09-00-00-${thread}.jsonl`;
    const interactive = (payload: unknown, file = name) => interactiveCodexRollout(payload, file);
    // both ids are checked when both are there, in any letter case
    expect(interactive({ id: thread, session_id: thread })).toBe(true);
    expect(interactive({ id: thread.toUpperCase(), session_id: thread }, name.toUpperCase().replace(".JSONL", ".jsonl"))).toBe(true);
    expect(interactive({ id: other, session_id: thread })).toBe(false);
    expect(interactive({ id: thread, session_id: other })).toBe(false);
    expect(interactive({ session_id: other })).toBe(false);
    // a paginated rollout's segment carries its thread first
    expect(interactive({ id: thread }, `rollout-2026-10-20T09-00-00-${thread}_${other}.jsonl`)).toBe(true);
    expect(interactive({ id: other }, `rollout-2026-10-20T09-00-00-${thread}_${other}.jsonl`)).toBe(false);
    // malformed identities and headers
    for (const payload of [{ id: 1 }, { id: "" }, { id: "not-a-thread" }, { id: [thread] }, { session_id: { id: thread } },
      { id: null }, { id: null, session_id: thread }, { id: thread, session_id: null }, [], "header", null, undefined]) {
      expect([payload, interactive(payload)]).toEqual([payload, false]);
    }
    // a name without a UUID has nothing to contradict, but the ids still must agree
    expect(interactive({ id: "legacy" }, "rollout-legacy.jsonl")).toBe(true);
    expect(interactive({ id: thread, session_id: thread.toUpperCase() }, "rollout-legacy.jsonl")).toBe(true);
    expect(interactive({ id: thread, session_id: other }, "rollout-legacy.jsonl")).toBe(false);
    expect(interactive({ id: 7 }, "rollout-legacy.jsonl")).toBe(false);
    // a self-consistent child is still a child: the name proves integrity, not parenthood
    expect(interactive({ id: thread, session_id: thread, parent_thread_id: other })).toBe(false);
    expect(interactive({ id: thread, session_id: thread, agent_role: "" })).toBe(false);
    // a genuine fork continues another thread's history and is a thread of its own
    expect(interactive({ id: thread, session_id: thread, forked_from_id: other, source: "cli", thread_source: "user",
      history_base: { thread_id: other, end_ordinal_exclusive: 3, end_byte_offset: 400 } })).toBe(true);
  });

  it("checks the identity against the file a link inside the store names, and refuses a link out of it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-link-"))); roots.push(root);
    const home = join(root, "codex"); const day = join(home, "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    const thread = "01a0d000-0000-7000-8000-0000000000bb";
    const other = "01a0d000-0000-7000-8000-0000000000cc";
    const header = `${JSON.stringify({ type: "session_meta", payload: { id: thread, session_id: thread, source: "cli" } })}\n`;
    const real = join(day, `rollout-2026-10-20T09-00-00-${thread}.jsonl`);
    writeFileSync(real, header);
    // the link's own name contradicts the header, the file it resolves to does not
    symlinkSync(real, join(day, `rollout-2026-10-20T09-00-00-${other}.jsonl`));
    expect(codexRolloutPath(join(day, `rollout-2026-10-20T09-00-00-${other}.jsonl`), home)).toBe(real);
    // and a well-named, self-consistent rollout outside the store stays out
    const outside = join(root, `rollout-2026-10-20T09-00-00-${thread}.jsonl`);
    writeFileSync(outside, header);
    symlinkSync(outside, join(day, "escape.jsonl"));
    expect(codexRolloutPath(outside, home)).toBeNull();
    expect(codexRolloutPath(join(day, "escape.jsonl"), home)).toBeNull();
  });

  it("a cut header cannot hide a child marker from the live reader", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-cut-"))); roots.push(root);
    const home = join(root, "codex"); const day = join(home, "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    const thread = "01a0d000-0000-7000-8000-0000000000bb";
    const path = join(day, `rollout-2026-10-20T09-00-00-${thread}.jsonl`);
    const write = (padding: number, marker: boolean) => writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: {
      id: thread, source: "cli", base_instructions: { text: "i".repeat(padding) }, ...(marker ? { thread_source: "subagent" } : {}) } })}\n{"type":"event_msg"}\n`);
    // a header within the 256 KiB the reader takes is read whole, its marker included
    write(200 * 1024, false);
    expect(codexRolloutPath(path, home)).toBe(path);
    write(200 * 1024, true);
    expect(codexRolloutPath(path, home)).toBeNull();
    // one longer than that cannot be checked, with or without a marker past the read
    write(256 * 1024, true);
    expect(codexRolloutPath(path, home)).toBeNull();
    write(256 * 1024, false);
    expect(codexRolloutPath(path, home)).toBeNull();
    // byte boundaries: whole JSON that fills the read is not proof its line ends there
    const line = `${JSON.stringify({ type: "session_meta", payload: { id: thread, source: "cli" } })}`;
    const exact = (body: string) => { writeFileSync(path, body); return codexRolloutPath(path, home); };
    expect(exact(`${line.padEnd(256 * 1024 - 1, " ")}\n{"type":"event_msg"}\n`)).toBe(path);
    expect(exact(`${line.padEnd(256 * 1024, " ")}\n{"type":"event_msg"}\n`)).toBeNull();
    expect(exact(`${line.padEnd(256 * 1024 + 1, " ")}\n`)).toBeNull();
    expect(exact(`${line.padEnd(256 * 1024, " ")}{"parent_thread_id":"${thread}"}\n`)).toBeNull();
    // a file that is only its header, without a newline, ends within the read
    expect(exact(line.padEnd(256 * 1024 - 1, " "))).toBe(path);
  });

  it("reads the Windows paths Codex stores with the \\\\?\\ prefix as the plain ones herdr reports (#518)", () => {
    expect(withoutVerbatimPrefix("\\\\?\\D:\\work\\app")).toBe("D:\\work\\app");
    expect(withoutVerbatimPrefix("\\\\?\\UNC\\host\\share\\app")).toBe("\\\\host\\share\\app");
    for (const path of ["D:\\work\\app", "\\\\host\\share\\app", "/home/user/app", "relative\\\\?\\app", "", "\\\\?\\Volume{0a1b}\\codex", "\\\\?\\GLOBALROOT\\Device\\x", "\\\\?\\out.jsonl"]) {
      expect(withoutVerbatimPrefix(path)).toBe(path);
    }
    expect(storedCwds("D:\\work\\app")).toEqual(["D:\\work\\app", "\\\\?\\D:\\work\\app"]);
    expect(storedCwds("\\\\?\\D:\\work\\app")).toEqual(["D:\\work\\app", "\\\\?\\D:\\work\\app"]);
    expect(storedCwds("\\\\host\\share\\app")).toEqual(["\\\\host\\share\\app", "\\\\?\\UNC\\host\\share\\app"]);
    // a POSIX cwd is looked up as it is, and only so
    expect(storedCwds("/home/user/app")).toEqual(["/home/user/app", "/home/user/app"]);
    expect(storedCwds("\\\\.\\pipe\\x")).toEqual(["\\\\.\\pipe\\x", "\\\\.\\pipe\\x"]);
  });

  it("keeps a rollout inside a store whose root alone carries the \\\\?\\ prefix, or whose rollout alone does (#587)", () => {
    const root = "D:\\codex\\sessions";
    const rollout = "D:\\codex\\sessions\\2026\\10\\10\\rollout.jsonl";
    expect(rolloutInsideStore(`\\\\?\\${root}`, rollout, win32)).toBe(true);
    expect(rolloutInsideStore(root, `\\\\?\\${rollout}`, win32)).toBe(true);
    expect(rolloutInsideStore("\\\\?\\UNC\\host\\share\\codex\\sessions", "\\\\host\\share\\codex\\sessions\\x.jsonl", win32)).toBe(true);
    for (const outside of ["D:\\codex\\other.jsonl", "\\\\?\\D:\\codex\\sessions\\..\\other.jsonl", "E:\\codex\\sessions\\x.jsonl", root]) {
      expect(rolloutInsideStore(`\\\\?\\${root}`, outside, win32)).toBe(false);
    }
    // only the prefix and the drive letter's case are one spelling: past it a case-sensitive
    // directory may be another one, and a sibling that shares the name's start is outside
    expect(rolloutInsideStore("\\\\?\\c:\\codex\\sessions", "C:\\codex\\sessions\\x.jsonl", win32)).toBe(true);
    for (const outside of ["C:\\codex\\Sessions\\other.jsonl", "C:\\Codex\\sessions\\other.jsonl", "C:\\codex\\sessions2\\x.jsonl"]) {
      expect(rolloutInsideStore("\\\\?\\C:\\codex\\sessions", outside, win32)).toBe(false);
      expect(rolloutInsideStore("C:\\codex\\sessions", outside, win32)).toBe(false);
    }
    // POSIX paths are compared as they are
    expect(rolloutInsideStore("/home/u/.codex/sessions", "/home/u/.codex/sessions/x.jsonl", posix)).toBe(true);
    for (const outside of ["/home/u/.codex/x.jsonl", "/home/u/.codex/sessions", "/home/u/.Codex/sessions/x.jsonl", "/home/u/.codex/sessions2/x.jsonl", "/home/u/.codex/sessions/../x.jsonl"]) {
      expect(rolloutInsideStore("/home/u/.codex/sessions", outside, posix)).toBe(false);
    }
  });

  const threadsDb = () => {
    const db = new Database(":memory:");
    // Codex's own cwd index (state migration 0027), binary collation
    db.run("CREATE TABLE threads (id TEXT, cwd TEXT, archived INTEGER, updated_at_ms INTEGER)");
    db.run("CREATE INDEX idx_threads_archived_cwd_updated_at_ms ON threads(archived, cwd, updated_at_ms DESC, id DESC)");
    const rows: [string, string][] = [["a", "\\\\?\\d:\\work\\app"], ["b", "d:\\work\\app"], ["c", "D:\\work\\app2"], ["d", "/home/u/app"], ["e", "/home/u/App"], ["f", "\\\\?\\UNC\\host\\share\\app"], ["g", "\\\\?\\d:\\Work\\app"], ["h", "D:\\WORK\\APP"]];
    for (let n = 0; n < 33; n++) rows.push([`x${String(n).padStart(2, "0")}`, "D:\\work\\App"]);
    for (const [id, cwd] of rows) db.run("INSERT INTO threads VALUES (?, ?, 0, ?)", [id, cwd, id.startsWith("x") ? 2 : 1]);
    return db;
  };

  it("finds the threads of a Windows cwd stored with another drive-letter case, never another directory's (#587)", () => {
    const db = threadsDb();
    try {
      const ids = (cwd: string) => {
        const { where, params } = storedCwdCondition(cwd);
        return db.query<{ id: string }, string[]>(`SELECT id FROM threads WHERE ${where} ORDER BY updated_at_ms DESC, id LIMIT 32`).all(...params).map((row) => row.id).sort();
      };
      expect(ids("D:\\work\\app")).toEqual(["a", "b"]);
      expect(ids("\\\\?\\D:\\work\\app")).toEqual(["a", "b"]);
      expect(ids("d:\\work\\app")).toEqual(["a", "b"]);
      // another letter case past the drive may be another, case-sensitive directory: no answer
      // rather than its conversation, and its 33 newer threads do not crowd out the 32
      expect(ids("D:\\work\\App")).toHaveLength(32);
      expect(ids("D:\\work\\App").every((id) => id.startsWith("x"))).toBe(true);
      expect(ids("\\\\host\\share\\app")).toEqual(["f"]);
      expect(ids("\\\\HOST\\share\\app")).toEqual([]);
      expect(ids("/home/u/app")).toEqual(["d"]);
      expect(ids("/home/u/APP")).toEqual([]);
    } finally { db.close(); }
  });

  it("looks threads up on Codex's binary cwd index, not by a scan of every thread (#587)", () => {
    const db = threadsDb();
    try {
      for (const cwd of ["D:\\work\\app", "/home/u/app"]) {
        const { where, params } = storedCwdCondition(cwd);
        const plan = db.query<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN SELECT id FROM threads WHERE ${where} AND archived = 0 ORDER BY updated_at_ms DESC LIMIT 33`)
          .all(...params).map((row) => row.detail).join("\n");
        expect(plan).toMatch(/SEARCH threads USING (?:COVERING )?INDEX idx_threads_archived_cwd_updated_at_ms \(archived=\? AND cwd=\?\)/);
      }
    } finally { db.close(); }
  });

  it("counts a Codex pane in another spelling of the same Windows directory as a peer, by the same rule as the queries (#587)", () => {
    const pane = (pane_id: string, cwd: string | null) => ({ pane_id, workspace_id: "w", tab_id: "t", terminal_id: pane_id, agent: "codex", agent_status: "idle", cwd, focused: false, revision: 0 }) as HerdrPane;
    const panes = [pane("self", "D:\\work\\app"), pane("drive", "d:\\work\\app"), pane("prefixed", "\\\\?\\d:\\work\\app"), pane("sibling", "D:\\work\\App"), pane("unknown", null), { ...pane("shell", "D:\\work\\app"), agent: "shell" } as HerdrPane];
    expect(codexPeersIn(panes, "self", "D:\\work\\app").map((peer) => peer.pane_id)).toEqual(["drive", "prefixed"]);
    expect(codexPeersIn([pane("self", "/home/u/app"), pane("posix", "/home/u/App"), pane("twin", "/home/u/app")], "self", "/home/u/app").map((peer) => peer.pane_id)).toEqual(["twin"]);
    expect(sameDirectory("d:\\work\\app", "\\\\?\\D:\\work\\app")).toBe(true);
    expect(sameDirectory("D:\\work\\app", "D:\\Work\\app")).toBe(false);
  });

  /** Rollouts as Codex 0.156 writes them: one record per line, ordinals running on from the cut a rollout starts at. */
  type Cut = { thread: string; ordinal: number; byte: number };
  const store = () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-codex-chain-")); roots.push(root);
    const home = join(root, "codex");
    const rollout = (day: string, name: string, thread: string, records: unknown[], base?: Cut) => {
      const header = { type: "session_meta", payload: { source: "cli", thread_source: "user",
        ...(base ? { history_base: { thread_id: base.thread, end_ordinal_exclusive: base.ordinal, end_byte_offset: base.byte } } : {}) } };
      const lines = [header, ...records].map((record) => `${JSON.stringify(record)}\n`);
      mkdirSync(join(home, "sessions", "2026", "09", day), { recursive: true });
      const path = join(home, "sessions", "2026", "09", day, name);
      writeFileSync(path, lines.join(""));
      const first = base?.ordinal ?? 0;
      return {
        path, size: Buffer.byteLength(lines.join("")),
        /** the cut a backtrack to just before records[index] names */
        cutBefore: (index: number): Cut => ({ thread, ordinal: first + 1 + index, byte: Buffer.byteLength(lines.slice(0, index + 1).join("")) }),
      };
    };
    const texts = (path: string, budget = 1024 * 1024) => parseCodexTranscript(codexHistoryTail(path, budget, home))
      .map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text : "").join(""));
    return { rollout, texts };
  };
  const parent = "01a09a35-5c5f-7830-94f7-4a1854613531";
  const thread = "01a0a337-19e8-7712-92f5-aa0883392afd";

  it("reads a paginated rollout through the history it continues, without the turns a backtrack discarded", () => {
    const { rollout, texts } = store();
    const forked = rollout("13", `rollout-2026-09-13T18-59-43-${parent}.jsonl`, parent, [message("user", "parent question"), message("assistant", "parent answer")]);
    const original = rollout("15", `rollout-2026-09-15T12-58-12-${thread}.jsonl`, thread,
      [message("user", "첫 질문"), message("assistant", "첫 답"), message("user", "discarded"), message("assistant", "discarded answer")], forked.cutBefore(2));
    // an unrelated later rollout of the same thread must not be taken for the base
    rollout("24", `rollout-2026-09-24T09-00-00-${thread}_01a0cc00-0000-7000-8000-000000000000.jsonl`, thread, [message("user", "future")]);
    const segment = rollout("23", `rollout-2026-09-23T10-46-43-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`, thread,
      [message("user", "다시 묻기"), message("assistant", "새 답")], original.cutBefore(2));

    expect(texts(segment.path)).toEqual(["parent question", "parent answer", "첫 질문", "첫 답", "다시 묻기", "새 답"]);
    // a small budget reads only the newest bytes and never reaches the parent; the cut line is dropped
    const answerLine = Buffer.byteLength(JSON.stringify(message("assistant", "첫 답"))) + 1;
    expect(texts(segment.path, segment.size + answerLine + 10)).toEqual(["첫 답", "다시 묻기", "새 답"]);
  });

  it("follows each backtrack to the rollout that holds its cut, however many there were", () => {
    const { rollout, texts } = store();
    const turns = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => [
      message("user", `${prefix}${index}? ${"x".repeat(200)}`), message("assistant", `${prefix}${index}.`),
    ]).flat();
    const first = rollout("15", `rollout-2026-09-15T12-00-00-${thread}.jsonl`, thread, turns("a", 6));
    // backtrack 1 to before a4, backtrack 2 further back to before a2, backtrack 3 into the second rollout
    const second = rollout("20", `rollout-2026-09-20T12-00-00-${thread}_01a0c000-0000-7000-8000-000000000001.jsonl`, thread, turns("b", 2), first.cutBefore(8));
    const third = rollout("21", `rollout-2026-09-21T12-00-00-${thread}_01a0c000-0000-7000-8000-000000000002.jsonl`, thread, turns("c", 1), first.cutBefore(4));
    const fourth = rollout("22", `rollout-2026-09-22T12-00-00-${thread}_01a0c000-0000-7000-8000-000000000003.jsonl`, thread, turns("d", 1), second.cutBefore(2));
    // the second rollout is newer and larger than the third one's cut: a name-and-size guess would take it
    expect(second.size).toBeGreaterThan(first.cutBefore(4).byte);
    const answers = (path: string) => texts(path).filter((text) => text.endsWith("."));
    expect(answers(second.path)).toEqual(["a0.", "a1.", "a2.", "a3.", "b0.", "b1."]);
    expect(answers(third.path)).toEqual(["a0.", "a1.", "c0."]);
    expect(answers(fourth.path)).toEqual(["a0.", "a1.", "a2.", "a3.", "b0.", "d0."]);
  });

  it("reads a remembered chain again once a rollout in it is archived, instead of failing the read", () => {
    const { rollout, texts } = store();
    const first = rollout("22", `rollout-2026-09-22T12-00-00-${thread}.jsonl`, thread, [message("user", "earlier question"), message("assistant", "earlier answer")]);
    const segment = rollout("23", `rollout-2026-09-23T12-00-00-${thread}_01a0cbf1-9b0e-7383-a345-80974b279c68.jsonl`, thread,
      [message("user", "later question"), message("assistant", "later answer")], { thread, ordinal: 3, byte: first.size });
    forgetHistoryChains();
    expect(texts(segment.path)).toEqual(["earlier question", "earlier answer", "later question", "later answer"]);
    // archived while its complete chain is remembered: the tail the screen match reads still comes
    const archive = join(first.path, "..", "..", "..", "..", "..", "archived_sessions");
    mkdirSync(archive, { recursive: true });
    renameSync(first.path, join(archive, `rollout-2026-09-22T12-00-00-${thread}.jsonl`));
    expect(texts(segment.path)).toEqual(["later question", "later answer"]);
  });

  it("shows less history, never the wrong one, when no rollout holds a cut, and finds it once one does", () => {
    const { rollout, texts } = store();
    const other = "01a0d000-0000-7000-8000-00000000000a";
    const cut = { thread: other, ordinal: 3, byte: 0 };
    const pending = [message("user", "earlier question"), message("assistant", "earlier answer")];
    const lines = [{ type: "session_meta", payload: { source: "cli", thread_source: "user" } }, ...pending].map((record) => `${JSON.stringify(record)}\n`);
    cut.byte = Buffer.byteLength(lines.join(""));
    const segment = rollout("23", `rollout-2026-09-23T12-00-00-${thread}.jsonl`, thread, [message("user", "later question"), message("assistant", "later answer")], cut);
    expect(texts(segment.path)).toEqual(["later question", "later answer"]);
    rollout("22", `rollout-2026-09-22T12-00-00-${other}.jsonl`, other, pending);
    // an incomplete chain is kept a short while (no walk of sessions/ on every append)...
    expect(texts(segment.path)).toEqual(["later question", "later answer"]);
    // ...and looked up afresh once that expires
    forgetHistoryChains();
    expect(texts(segment.path)).toEqual(["earlier question", "earlier answer", "later question", "later answer"]);
  });

  const answer = "The chat parser now reads native session records, removes internal context, and keeps assistant commentary inside the expandable work section.";
  it("requires a unique substantial rendered assistant match and handles terminal wrapping", () => {
    const candidates = [
      { path: "correct", text: jsonl(message("assistant", answer, "final_answer")) },
      { path: "newer-unrelated", text: jsonl(message("assistant", "Another conversation")) },
    ];
    expect(matchCodexTranscript(`• ${answer.replaceAll(" ", "\n  ")}`, candidates)).toBe("correct");
    expect(matchCodexTranscript("Different pane", candidates)).toBeNull();
    expect(matchCodexTranscript(answer, [...candidates, { ...candidates[0]!, path: "ambiguous-copy" }])).toBeNull();
    expect(matchCodexTranscript("Done", [{ path: "short", text: jsonl(message("assistant", "Done")) }])).toBeNull();
  });

  it("matches an answer that links a file, which Codex shows as the label and a path relative to the cwd", () => {
    const linked = `${answer} [The report](/home/user/repo/output/test/REPORT.md)`;
    const candidates = [{ path: "linked", text: jsonl(message("assistant", linked, "final_answer")) }];
    expect(matchCodexTranscript(`• ${answer} The report (output/test/REPORT.md)`, candidates)).toBe("linked");
    // a link in the middle: the end after it is what is looked for
    const middle = `See [the report](/home/user/repo/REPORT.md) for the numbers. ${answer}`;
    expect(matchCodexTranscript(`• See the report (REPORT.md) for the numbers. ${answer}`, [{ path: "middle", text: jsonl(message("assistant", middle)) }])).toBe("middle");
    expect(matchCodexTranscript("• The report (output/test/REPORT.md)", candidates)).toBeNull();
  });

  // issue #283: no answer of this session reaches 64 letters and digits (40, 29 and 38)
  const short = [
    "세 사진을 확인하고 한 장으로 합칠게요. 이미지 편집을 위해 imagegen 스킬을 사용할게요.",
    "세 화면이 모두 보이도록, 올려주신 순서대로 가로로 나란히 배치할게요.",
    "imagegen으로 세 사진을 올려주신 순서대로 가로로 합쳤어요.\n\n[합친 이미지 다운로드](/home/user/repo/.ovis/combined-20261002.png)",
  ];
  const shortRollout = jsonl(
    message("user", "이거 세개 사진 합처서 하나의 이미지로 만들어줘."),
    message("assistant", short[0]!, "commentary"), message("assistant", short[1]!, "commentary"), message("assistant", short[2]!, "final_answer"),
  );
  const shortScreen = [
    "› 이거 세개 사진 합처서 하나의 이미지로 만들어줘.",
    "• 세 사진을 확인하고 한 장으로 합칠게요. 이미지 편집을 위해 imagegen\n  스킬을 사용할게요.",
    "• 세 화면이 모두 보이도록, 올려주신 순서대로 가로로 나란히 배치할게요.",
    "• imagegen으로 세 사진을 올려주신 순서대로 가로로 합쳤어요.\n\n  합친 이미지 다운로드 (.herdr-web-ui/combined-20261002.png)",
  ];
  const answered = (...texts: string[]) => jsonl(...texts.map((text) => message("assistant", text)));
  const bullets = (...texts: string[]) => texts.map((text) => `• ${text}`).join("\n");

  it("reads a session whose answers are all short by its newest answers shown together, in order", () => {
    const candidates = [
      { path: "short", text: shortRollout },
      { path: "other", text: jsonl(message("assistant", answer, "final_answer")) },
    ];
    // the long-answer match alone, as every caller but the last resort uses it, still says nothing
    expect(matchCodexTranscript(shortScreen.join("\n\n"), candidates)).toBeNull();
    expect(matchShortCodexAnswers(shortScreen.join("\n\n"), candidates)).toBe("short");
    // the newest answer not rendered yet: the two before it are enough together
    expect(matchShortCodexAnswers(shortScreen.slice(0, 3).join("\n\n"), candidates)).toBe("short");
    // one short answer alone is too little, and so are the same lines out of order
    expect(matchShortCodexAnswers(shortScreen[2]!, candidates)).toBeNull();
    expect(matchShortCodexAnswers([shortScreen[3], shortScreen[2], shortScreen[1]].join("\n\n"), candidates)).toBeNull();
    // older answers with the newest two missing from the screen are not this rollout's end
    expect(matchShortCodexAnswers(shortScreen.slice(0, 2).join("\n\n"), candidates)).toBeNull();
  });

  it("does not read short answers that two rollouts share, or ones above the welcome card", () => {
    const shared = [{ path: "one", text: shortRollout }, { path: "two", text: jsonl(message("user", "다시 해줘"), ...short.map((text) => message("assistant", text))) }];
    expect(matchShortCodexAnswers(shortScreen.join("\n\n"), shared)).toBeNull();
    expect(matchShortCodexAnswers(`${shortScreen.join("\n\n")}\nOpenAI Codex (v1.0)\nNew session`, [shared[0]!])).toBeNull();
  });

  // the review of #284: each case once bound the wrong rollout, or lost the right one
  const looked = "I'll look at the file and run the tests.";
  const changed = "I'll make the change and verify the result.";
  it("does not take a fork's inherited answers for its parent", () => {
    const fixes = Array.from({ length: 8 }, (_, index) => `Fixed test ${index}.`);
    const candidates = [{ path: "parent", text: answered(looked, changed) }, { path: "fork", text: answered(looked, changed, ...fixes) }];
    const screen = bullets(looked, changed, ...fixes);
    expect(matchCodexTranscript(screen, candidates)).toBeNull();
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
  });

  it("does not count the links of one answer as several answers, wherever they point", () => {
    const linked = "[Open the project report](/other/0.md)\n[Download the updated image](/other/1.md)\n[Review the verification results](/other/2.md)";
    const candidates = [{ path: "linked", text: answered(linked) }];
    const screen = "• Open the project report (my/0.md)\n  Download the updated image (my/1.md)\n  Review the verification results (my/2.md)";
    expect(matchCodexTranscript(screen, candidates)).toBeNull();
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
  });

  it("keeps a unique long-answer match when another rollout shares its short answers", () => {
    const candidates = [{ path: "real", text: answered(looked, changed, answer) }, { path: "unrelated", text: answered(looked, changed) }];
    expect(matchCodexTranscript(bullets(looked, changed, answer), candidates)).toBe("real");
  });

  const migrated = "The migration script now rewrites every legacy record in place.";
  it("needs 64 letters and digits together, 16 in each answer and 12 distinct", () => {
    const read = (...texts: string[]) => matchShortCodexAnswers(bullets(...texts), [{ path: "short", text: answered(...texts) }]);
    // 29 + 34 = 63, and 29 + 36 = 65
    expect(read("The build finished without errors.", "All checks on the feature branch pass now.")).toBeNull();
    expect(read("The build finished without errors.", "All checks on the feature branch pass again.")).toBe("short");
    // 14 + 53 = 67 with an answer below 16, and the same with one of 16
    expect(read("Updated the docs", migrated)).toBeNull();
    expect(read("Updated the README", migrated)).toBe("short");
    // 18 + 29 + 31 = 78 from 10 distinct letters
    expect(read("The tests have passed.", "Tests passed. The tests have passed.", "Ha, the tests passed; these have passed.")).toBeNull();
  });

  // the second review of #284
  const inspect = "I'll inspect the file and run the tests.";
  it("does not read short answers another rollout said inside longer ones", () => {
    const candidates = [
      { path: "wrong", text: answered(inspect, changed) },
      { path: "real", text: answered(`Sure. ${inspect}`, `Sure. ${changed}`, "Done.", "Done.") },
    ];
    expect(matchShortCodexAnswers(bullets(`Sure. ${inspect}`, `Sure. ${changed}`, "Done.", "Done."), candidates)).toBeNull();
  });

  it("does not take a fork for its parent however many turns ago it inherited the answers", () => {
    const later = Array.from({ length: 51 }, () => [message("user", "continue"), message("assistant", "Done.")]).flat();
    const candidates = [
      { path: "parent", text: answered(inspect, changed) },
      { path: "fork", text: jsonl(message("assistant", inspect), message("assistant", changed), ...later) },
    ];
    const screen = [bullets(inspect, changed), ...Array.from({ length: 51 }, () => "› continue\n• Done.")].join("\n");
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
    // and a rollout read only from its end may have said them before: no answer then
    expect(matchShortCodexAnswers(bullets(inspect, changed), [candidates[0]!, { path: "fork", text: answered("Done."), cut: true }])).toBeNull();
    expect(matchShortCodexAnswers(bullets(inspect, changed), [candidates[0]!, { path: "fork", text: answered("Done.") }])).toBe("parent");
  });

  // the third review of #284
  it("takes no answer with a link for evidence: the screen shows its target its own way", () => {
    const linked = ["The [build results](reports/build-results.md) are ready for review.", "All [feature branch checks](reports/check-results.md) passed the verification."];
    // the pane's own conversation said the words after the links, as answers of its own, and
    // the user's prompts hold the labels: the linked rollout's pieces add up on that screen
    const own = ["are ready for review.", "passed the verification.", "Done.", "Done."];
    const screen = "› The build results?\n• are ready for review.\n› All feature branch checks?\n• passed the verification.\n› next\n• Done.\n› next\n• Done.";
    expect(matchShortCodexAnswers(screen, [{ path: "linked", text: answered(...linked) }, { path: "own", text: answered(...own) }])).toBeNull();
    expect(matchShortCodexAnswers("• The build results (reports/build-results.md) are ready for review.\n• All feature branch checks (reports/check-results.md) passed the verification.", [{ path: "linked", text: answered(...linked) }])).toBeNull();
    // the newest answer may hold one: the two before it still tell (the report's own case ends in a download link)
    const report = ["The build finished without errors this time.", "All checks on the feature branch pass again.", "Here is [the image](out/merged.png)."];
    expect(matchShortCodexAnswers(bullets(report[0]!, report[1]!, "Here is the image (out/merged.png)."), [{ path: "report", text: answered(...report) }])).toBe("report");
  });

  it("reads no short answers that another rollout's linked answers show as", () => {
    // the pane's own rollout says them with links, which Codex shows as "label (path)": the screen
    // reads exactly like an older rollout's plain answers
    const live = ["The [build results](/repo/reports/build.md) are ready for review.", "All [feature checks](/repo/reports/check.md) passed verification."];
    const older = ["The build results (reports/build.md) are ready for review.", "All feature checks (reports/check.md) passed verification."];
    const screen = bullets(...older);
    expect(matchShortCodexAnswers(screen, [{ path: "older", text: answered(...older) }])).toBe("older");
    expect(matchShortCodexAnswers(screen, [{ path: "older", text: answered(...older) }, { path: "live", text: answered(...live) }])).toBeNull();
    // also with labels of a few letters, after many later answers, and with many links in one answer
    const terse = ["[Build](/repo/reports/feature-branch-build-results.md)", "[Checks](/repo/reports/feature-branch-check-results.md)"];
    const shownTerse = ["Build (reports/feature-branch-build-results.md)", "Checks (reports/feature-branch-check-results.md)"];
    expect(matchShortCodexAnswers(bullets(...shownTerse), [{ path: "older", text: answered(...shownTerse) }, { path: "live", text: answered(...terse) }])).toBeNull();
    expect(matchShortCodexAnswers(screen, [{ path: "older", text: answered(...older) }, { path: "live", text: answered(...live, ...Array.from({ length: 220 }, () => "Done.")) }])).toBeNull();
    // a linked answer of another rollout that says something else vetoes nothing
    expect(matchShortCodexAnswers(screen, [{ path: "older", text: answered(...older) }, { path: "else", text: answered("See [the notes](docs/notes.md) for the migration plan.") }])).toBe("older");
  });

  it("reads no short answers when a rollout was not read whole, the one that shows them included", () => {
    const texts = ["The build finished without errors this time.", "All checks on the feature branch pass again."];
    const screen = bullets(...texts);
    expect(matchShortCodexAnswers(screen, [{ path: "only", text: answered(...texts) }])).toBe("only");
    expect(matchShortCodexAnswers(screen, [{ path: "only", text: answered(...texts), cut: true }])).toBeNull();
    expect(matchShortCodexAnswers(screen, [{ path: "only", text: answered(...texts) }, { path: "other", text: answered("Done."), cut: true }])).toBeNull();
  });

  it("does not read short answers when two rollouts show that way, sharing nothing", () => {
    const first = ["The build finished without errors.", "All checks on the feature branch pass again."];
    const second = ["Updated the README", migrated];
    const candidates = [{ path: "first", text: answered(...first) }, { path: "second", text: answered(...second) }];
    // the second's answers below, and the first's between them: each is found bottom-up
    expect(matchShortCodexAnswers(bullets(first[0]!, second[0]!, first[1]!, second[1]!), candidates)).toBeNull();
    expect(matchShortCodexAnswers(bullets(second[0]!, second[1]!), candidates)).toBe("second");
  });

  it("reads short answers in bounded time however many unclosed links the answers hold", () => {
    const many = answered(...Array.from({ length: 450 }, () => "](".repeat(1000)));
    const candidates = Array.from({ length: 32 }, (_, index) => ({ path: `unclosed-${index}`, text: many }));
    const screen = Array.from({ length: 400 }, () => "q".repeat(120)).join("\n");
    const started = performance.now();
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("reads short answers in bounded time however many links a large answer has", () => {
    const huge = answered("[abcdefghijklmnop](/a)".repeat(40_000));
    const candidates = Array.from({ length: 32 }, (_, index) => ({ path: `large-${index}`, text: huge }));
    const screen = Array.from({ length: 400 }, () => "q".repeat(120)).join("\n");
    const started = performance.now();
    expect(matchShortCodexAnswers(screen, candidates)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("does not bind using user context, tool output or a previous session above the welcome card", () => {
    expect(matchCodexTranscript(answer, [{ path: "user", text: jsonl(message("user", answer)) }])).toBeNull();
    expect(matchCodexTranscript(`${answer}\nOpenAI Codex (v1.0)\nNew session`, [{ path: "old", text: jsonl(message("assistant", answer)) }])).toBeNull();
  });
});

describe("Codex submitted first exchange", () => {
  const started = Date.parse("2026-10-03T00:00:00Z");
  const prompt = "Check fixture";
  const answer = "The fixture is ready for inspection.";
  const screen = `OpenAI Codex (v1.0)\n\n› ${prompt}\n\n• ${answer}\n\n› `;
  const row = (path = "new", createdAtMs = started, firstUserMessage = prompt, reply = answer) => ({
    path, createdAtMs, firstUserMessage,
    text: jsonl(message("user", firstUserMessage), message("assistant", reply, "final_answer")),
  });

  it("matches a complete first prompt and one answer, including whitespace wrapping", () => {
    expect(matchCodexFirstExchange(screen, [row()], started)).toBe("new");
    expect(matchCodexFirstExchange(screen.replace(prompt, "Check\n  fixture"), [row()], started)).toBe("new");
    expect(matchCodexFirstExchange(screen, [row(), row("old", started - 60_000, "Other fixture", "Different answer")], started)).toBe("new");
  });

  it("matches a short greeting only when the complete exchange is unique", () => {
    const greeting = screen.replace(prompt, "hello");
    const own = row("new", started, "hello");
    expect(matchCodexFirstExchange(greeting, [own], started)).toBe("new");
    expect(matchCodexFirstExchange(greeting, [own, row("old", started - 60_000, "hello")], started)).toBeNull();
    expect(matchCodexFirstExchange(greeting.replace("hello", " "), [{ ...own, firstUserMessage: " " }], started)).toBeNull();
  });

  it("requires exact prompt punctuation and the full answer", () => {
    for (const shown of [
      screen.replace(prompt, "Check-fixture"), screen.replace(prompt, "Check fixture again"),
      screen.replace(answer, "The fixture is ready"), screen.replace(answer, "Ready"),
    ]) expect(matchCodexFirstExchange(shown, [row()], started)).toBeNull();
  });

  it("rejects composers, indented quotes, later turns and a missing welcome card", () => {
    for (const shown of [
      `OpenAI Codex (v1.0)\n› ${prompt}`,
      screen.replace(`› ${prompt}`, `    › ${prompt}`),
      screen.replace(`› ${prompt}`, `• Earlier output\n› ${prompt}`),
      screen.replace(`› ${prompt}`, `› Earlier prompt\n• Earlier reply\n› ${prompt}`),
      screen.slice(screen.indexOf("›")),
      `${screen}\nOpenAI Codex (v1.0)\n› Other fixture`,
    ]) expect(matchCodexFirstExchange(shown, [row()], started)).toBeNull();
  });

  it("keeps older later exchanges and longer answers as competing evidence", () => {
    const old = {
      ...row("old", started - 60_000, "Original request", "Original reply"),
      text: jsonl(message("user", "Original request"), message("assistant", "Original reply"),
        message("user", prompt), message("assistant", answer)),
    };
    expect(matchCodexFirstExchange(screen, [row(), old], started)).toBeNull();
    expect(matchCodexFirstExchange(screen, [old], started)).toBeNull();
    expect(matchCodexFirstExchange(screen, [row(), row("old", started - 60_000, prompt, `${answer} More details.`)], started)).toBeNull();
    expect(matchCodexFirstExchange(screen, [row(), row("other")], started)).toBeNull();
  });

  it("does not admit pre-start timestamps or missing prompt metadata (control)", () => {
    for (const time of [started - 1, Infinity, NaN]) {
      expect(matchCodexFirstExchange(screen, [row("new", time)], started)).toBeNull();
    }
    for (const time of [Infinity, NaN]) expect(matchCodexFirstExchange(screen, [row()], time)).toBeNull();
    expect(matchCodexFirstExchange(screen, [{ ...row(), firstUserMessage: "" }], started)).toBeNull();
  });

  it("matches tiny first answers only with the exact submitted exchange (regression)", () => {
    for (const reply of ["42", "Ready", "Y"]) {
      expect(matchCodexFirstExchange(screen.replace(answer, reply), [row("new", started, prompt, reply)], started)).toBe("new");
    }
    expect(matchCodexFirstExchange(screen.replace(answer, ""), [row("new", started, prompt, "")], started)).toBeNull(); // control
    expect(matchCodexFirstExchange(screen.replace(answer, "42"), [
      row("new", started, prompt, "42"), row("old", started - 1, prompt, "42"),
    ], started)).toBeNull(); // control: competing evidence
  });

  it("matches the first short reply before Codex's completed-turn footer", () => {
    for (const footer of ["Worked for <1s • 11:19", "Worked for 1s • 11:11 AM", "Worked for 2m 14s • 16:11", "Worked for 0s"]) {
      const completed = screen.replace(answer, answer + "\n\n  " + footer);
      expect(matchCodexFirstExchange(completed, [row()], started)).toBe("new");
      expect(matchCodexFirstExchange(completed, [row(), row("old", started - 1)], started)).toBeNull();
    }
  });

  it("does not discard answer text or an unrecognized completion footer", () => {
    for (const suffix of [
      "Worked for a while on this.",
      "Worked for 1s • unknown time",
      "Worked for 1s • 11:11 AM\nMore answer text",
    ]) {
      expect(matchCodexFirstExchange(screen.replace(answer, answer + "\n\n" + suffix), [row()], started)).toBeNull();
    }
    const literal = "Worked for 1s • 11:11 AM";
    expect(matchCodexFirstExchange(screen.replace(answer, literal), [row("new", started, prompt, literal)], started)).toBe("new");
    const completed = screen.replace(answer, answer + "\n\nWorked for 1s • 11:11 AM");
    expect(matchCodexFirstExchange(completed, [
      row(), row("old", started - 1, prompt, answer + "\n\nWorked for 1s • 11:11 AM"),
    ], started)).toBeNull();
  });

  it("preserves a literal footer-shaped final paragraph without native chrome", () => {
    const literal = answer + "\n\nWorked for 1s • 11:11 AM";
    const completed = screen.replace(answer, literal);
    expect(matchCodexFirstExchange(completed, [row("new", started, prompt, literal)], started)).toBe("new");
    expect(matchCodexFirstExchange(completed, [
      row("new", started, prompt, literal), row("old", started - 1),
    ], started)).toBeNull();
  });

  it("skips known Codex notices before the submitted prompt (regression)", () => {
    for (const notice of ["Model changed to gpt-5", "Unrecognized command '/wat'", "Working directory changed to /tmp"]) {
      expect(matchCodexFirstExchange(screen.replace(`› ${prompt}`, `• ${notice}\n\n› ${prompt}`), [row()], started)).toBe("new");
    }
  });
});

describe("Codex tool calls that failed, and patches", () => {
  it("reads a failure from the output Codex records, judging a completed script as a whole", () => {
    expect(codexCallFailed("Chunk ID: 1\nWall time: 0.0 seconds\nProcess exited with code 1\nOutput:\n")).toBe(true);
    expect(codexCallFailed("Process exited with code 0\nOutput:\nok")).toBe(false);
    expect(codexCallFailed('{"output":"boom","metadata":{"exit_code":2}}')).toBe(true);
    expect(codexCallFailed("Script failed\nError: x")).toBe(true);
    expect(codexCallFailed("apply_patch verification failed: Failed to find expected lines in /x")).toBe(true);
    expect(codexCallFailed("Script completed\nProcess exited with code 1")).toBe(false);
    expect(codexCallFailed("{\"accepted\":true}")).toBe(false);
  });

  it("marks the failed call and sums a patch up by its files", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch\n";
    const turns = parseCodexTranscript(jsonl(
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "p", name: "apply_patch", input: patch } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p", output: "Success. Updated the following files:\nM src/a.ts" } },
      { type: "response_item", payload: { type: "function_call", call_id: "c", name: "exec_command", arguments: JSON.stringify({ cmd: "false" }) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "Process exited with code 1\nOutput:\n" } },
    ));
    const tools = turns.flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
    expect(tools.map((tool) => [tool.summary, tool.error === true])).toEqual([["src/a.ts", false], ["false", true]]);
  });
});

describe("Codex native call id and state", () => {
  const plan = (id: string) => item({ type: "function_call", call_id: id, name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Read", status: "completed" }] }) });
  const tools = (text: string) => parseCodexTranscript(text).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");

  it("pending without matching output retains call_id and pending state", () => {
    // an output for another call answers nothing here
    expect(tools(jsonl(message("user", "Plan"), plan("call_a"), item({ type: "function_call_output", call_id: "call_other", output: "Plan updated" }))))
      .toMatchObject([{ call_id: "call_a", state: "pending", output: "" }]);
  });

  it("completed function_call_output omits state and retains call_id", () => {
    for (const output of ["Plan updated", "", "Error: plan update failed", "Process exited with code 1\nOutput:\n"]) {
      const [part] = tools(jsonl(message("user", "Plan"), plan("call_a"), item({ type: "function_call_output", call_id: "call_a", output })));
      expect(part).toMatchObject({ call_id: "call_a" });
      expect(part && "state" in part).toBe(false);
    }
  });

  it("completed custom_tool_call_output omits state and retains call_id", () => {
    for (const output of ["applied", "", "apply_patch verification failed: Failed to find expected lines"]) {
      const [part] = tools(jsonl(item({ type: "custom_tool_call", call_id: "call_p", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" }), item({ type: "custom_tool_call_output", call_id: "call_p", output })));
      expect(part).toMatchObject({ call_id: "call_p" });
      expect(part && "state" in part).toBe(false);
    }
  });

  it("repeated identical calls retain distinct ids", () => {
    const parts = tools(jsonl(message("user", "Plan"), plan("call_a"), item({ type: "function_call_output", call_id: "call_a", output: "Plan updated" }),
      plan("call_b"), item({ type: "function_call_output", call_id: "call_b", output: "Plan updated" })));
    expect(parts.map((part) => part.kind === "tool" && part.call_id)).toEqual(["call_a", "call_b"]);
    expect(parts[0]?.kind === "tool" && parts[1]?.kind === "tool" && [parts[0].input === parts[1].input, parts[0].output === parts[1].output]).toEqual([true, true]);
  });

  it("append and full poll replacement preserve call id and update or omit state", async () => {
    const { createCodexTranscriptParser } = await import("./codex.ts");
    const parser = createCodexTranscriptParser();
    const first = jsonl(message("user", "Plan"), plan("call_a"), plan("call_b"));
    parser.write(first);
    const pending = parser.snapshot();
    const ids = (turns: ReturnType<typeof parseCodexTranscript>) => turns.flatMap((turn) => turn.parts).flatMap((part) => part.kind === "tool" ? [[part.call_id, part.state ?? "omitted"]] : []);
    expect(ids(pending)).toEqual([["call_a", "pending"], ["call_b", "pending"]]);
    const second = jsonl(item({ type: "function_call_output", call_id: "call_a", output: "" }));
    // a preview of an unfinished line, then the appended record, then a full re-read of the file
    expect(ids(parser.snapshot(second))).toEqual([["call_a", "omitted"], ["call_b", "pending"]]);
    parser.write(second);
    expect(ids(parser.snapshot())).toEqual([["call_a", "omitted"], ["call_b", "pending"]]);
    expect(parser.snapshot()).toEqual(parseCodexTranscript(`${first}\n${second}`));
    // the earlier snapshot is not rewritten under the reader
    expect(ids(pending)).toEqual([["call_a", "pending"], ["call_b", "pending"]]);
    const long = tools(jsonl(plan("call_c"), item({ type: "function_call_output", call_id: "call_c", output: "x".repeat(5000) })))[0];
    expect(long).toMatchObject({ call_id: "call_c", output_ref: "call_c", output_size: 5000 });
    expect(long && "state" in long).toBe(false);
  });
});

describe("incremental Codex records", () => {
  it("pairs citation-bearing answers across writes and previews without changing earlier snapshots", async () => {
    const { createCodexTranscriptParser } = await import("./codex.ts");
    const parser = createCodexTranscriptParser();
    const text = "Match `<oai-mem-citation>` literally.\nThe answer continues.";
    parser.write(jsonl(event({ type: "agent_message", message: text })));
    const earlier = parser.snapshot();
    const response = jsonl(message("assistant", `${text}\n<oai-mem-citation>internal metadata</oai-mem-citation>`, "final_answer"));
    const expected: ReturnType<typeof parseCodexTranscript> = [{ role: "assistant", ts, end_ts: ts, parts: [{ kind: "text", text, phase: "final_answer" }] }];
    expect(parser.snapshot(response)).toEqual(expected);
    expect(earlier[0]?.parts).toEqual([{ kind: "text", text }]);
    expect(parser.snapshot()).toEqual(earlier);
    parser.write(response);
    expect(parser.snapshot()).toEqual(expected);
  });

  it("pairs duplicates and tool results across writes without mutating earlier snapshots", async () => {
    const { createCodexTranscriptParser } = await import("./codex.ts");
    const parser = createCodexTranscriptParser();
    const first = jsonl(event({ type: "task_started" }), message("user", "Inspect"), item({ type: "function_call", call_id: "long", name: "exec_command", arguments: '{"cmd":"pwd"}' }));
    parser.write(first);
    const previous = parser.snapshot();
    const previousJSON = JSON.stringify(previous);
    const second = jsonl(item({ type: "function_call_output", call_id: "long", output: "done" }), event({ type: "agent_message", message: "Finished" }));
    parser.write(second);
    const final = jsonl(message("assistant", "Finished", "final_answer"), event({ type: "task_complete" }));
    expect(parser.snapshot(final)).toEqual(parseCodexTranscript(`${first}\n${second}\n${final}`));
    expect(JSON.stringify(previous)).toBe(previousJSON);
    expect(parser.snapshot()).toEqual(parseCodexTranscript(`${first}\n${second}`));
    parser.write(final);
    expect(parser.snapshot()).toEqual(parseCodexTranscript(`${first}\n${second}\n${final}`));
    expect(parser.snapshot().at(-1)?.parts.at(-1)).toMatchObject({ phase: "final_answer", text: "Finished" });
  });
});
