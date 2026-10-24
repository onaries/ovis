import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { forgetTranscriptState, HistoryChanged, transcriptPage } from "./conversation.ts";
import { grokToolOutput, grokProjection, GrokUnavailable, parseGrokTranscript } from "./grok.ts";
import { grokHomeFromEnvironment, grokPaneProcesses, grokTranscriptPath, isGrokExecutable, resolveGrokStore } from "./grok-store.ts";
import * as herdr from "./herdr/client.ts";
import type { ConversationPart, HerdrPane } from "../shared/protocol.ts";

const session = "fictional-session";
const event = (update: object, extension = false) => JSON.stringify({ timestamp: 1700000000, method: extension ? "_x.ai/session/update" : "session/update", params: { sessionId: session, update } }) + "\n";
const user = (index: number, text = `prompt ${index}`, meta = {}) => event({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { promptIndex: index, modelId: "fictional-model", ...meta } });
const answer = (text = "fictional answer") => event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const rewind = (target: number) => event({ sessionUpdate: "rewind_marker", target_prompt_index: target }, true);
const tool = (id = "call-1") => event({ sessionUpdate: "tool_call", toolCallId: id, title: "Read file", rawInput: { path: "fiction.txt" }, content: [], status: "pending" });
const update = (output: string, id = "call-1") => event({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: output } }] });
type Tool = Extract<ConversationPart, { kind: "tool" }>;
let root: string, path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-grok-unit-"));
  path = join(root, "sessions", "%2Ffiction", session, "updates.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  forgetTranscriptState();
});
afterEach(() => { forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); });
const page = () => transcriptPage("grok-transcript", path);
const lastTool = () => page().turns.flatMap((t) => t.parts).find((p): p is Tool => p.kind === "tool")!;

describe("Grok native event adapter", () => {
  test("native activity follows thoughts, tools, completion and rewind without pane status", () => {
    const activity = () => grokProjection(path, statSync(path)).activity;
    writeFileSync(path, user(0));
    expect(activity()).toBe("working");
    appendFileSync(path, event({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fictional thought" } }));
    expect(activity()).toBe("thinking");
    expect(page().turns).toHaveLength(1);
    appendFileSync(path, tool());
    expect(activity()).toBe("working");
    appendFileSync(path, event({ sessionUpdate: "turn_completed" }));
    expect(activity()).toBe("idle");
    appendFileSync(path, update("late background result"));
    expect(activity()).toBe("idle");
    appendFileSync(path, user(1));
    expect(activity()).toBe("working");
    appendFileSync(path, rewind(1));
    expect(activity()).toBe("idle");
  });
  test("replays an isolated native tool call and its two updates", () => {
    writeFileSync(path, readFileSync(new URL("./fixtures/grok/native-tool.jsonl", import.meta.url), "utf8"));
    const part = lastTool();
    expect(part.name).toBe("run_terminal_command");
    expect(JSON.parse(part.input).variant).toBe("Bash");
    expect(part.output).toBe("FICTIONAL_TOOL_OUTPUT\n");
    expect(page().turns.at(-1)!.parts.at(-1)).toEqual({ kind: "text", text: "FICTIONAL_AFTER_TOOL", phase: "final_answer" });
  });
  test("text chunks, hidden boundaries and synthetic prompts", () => {
    const turns = parseGrokTranscript(user(0, "hello ") + user(0, "world") + answer("one ") + answer("two") + user(1, "hidden", { hideFromScrollback: true }) + answer("separate answer") + user(2, "visible", { syntheticPrompt: true }));
    expect(turns.map((t) => t.parts)).toEqual([
      [{ kind: "text", text: "hello world" }], [{ kind: "text", text: "one two" }],
      [{ kind: "text", text: "separate answer" }], [{ kind: "text", text: "visible" }],
    ]);
    expect(turns[1]!.end_ts).toBe("2023-11-14T22:13:20.000Z");
  });
  test("omitted tool fields survive, present output replaces, and shrink removes expansion", () => {
    writeFileSync(path, user(0) + tool() + update("x".repeat(6000)));
    const first = lastTool();
    expect(first.output_size).toBe(6000);
    expect(grokToolOutput(path, first.output_ref!)).toBe("x".repeat(6000));
    appendFileSync(path, event({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" }));
    expect(lastTool().input).toContain("fiction.txt");
    expect(lastTool().output_size).toBe(6000);
    const second = lastTool().output_ref!;
    appendFileSync(path, update("short"));
    expect(lastTool().output).toBe("short");
    expect(lastTool().output_ref).toBeUndefined();
    expect(lastTool().output_size).toBeUndefined();
    expect(grokToolOutput(path, second)).toBeNull();
  });
  test("unknown, cross-prompt, abandoned and mid-turn updates fail instead of disappearing", () => {
    for (const text of [user(0) + update("unknown"), user(0) + tool() + user(1) + update("late"), user(0) + tool() + rewind(0) + user(0) + update("abandoned")]) {
      forgetTranscriptState(); writeFileSync(path, text);
      expect(() => page()).toThrow();
    }
    expect(() => parseGrokTranscript(update("missing seed"))).toThrow(GrokUnavailable);
  });
  test("nullable raw fields preserve the call while an empty content array clears output", () => {
    const turns = parseGrokTranscript(user(0) + tool() + update("old") + event({ sessionUpdate: "tool_call_update", toolCallId: "call-1", name: "read_file" }) + event({ sessionUpdate: "tool_call_update", toolCallId: "call-1", name: null, rawInput: null, content: [] }));
    const part = turns.flatMap((t) => t.parts).find((p): p is Tool => p.kind === "tool")!;
    expect(part.name).toBe("read_file");
    expect(part.input).toContain("fiction.txt");
    expect(part.output).toBe("");
  });
  test("turn completion separates assistant activity without dropping earlier messages", () => {
    const turns = parseGrokTranscript(user(0) + answer("first") + event({ sessionUpdate: "turn_completed" }, true) + answer("later"));
    expect(turns.map((t) => t.parts)).toEqual([[{ kind: "text", text: "prompt 0" }], [{ kind: "text", text: "first", phase: "final_answer" }], [{ kind: "text", text: "later" }]]);
  });
  test("native tool metadata, search variants and historical diffs survive output replacement", () => {
    const native = event({ sessionUpdate: "tool_call", toolCallId: "edit-1", _meta: { "x.ai/tool": { name: "edit_file" } }, content: [{ type: "diff", path: "fiction.txt", oldText: "before", newText: "after" }] });
    writeFileSync(path, user(0) + native + update("completed", "edit-1"));
    const part = lastTool();
    expect(part.name).toBe("edit_file");
    expect(part.output).toBe("--- fiction.txt\nbefore\n+++ fiction.txt\nafter\ncompleted");
    const search = parseGrokTranscript(user(0) + event({ sessionUpdate: "tool_call", toolCallId: "search-1", kind: "search", rawInput: { variant: "XSearch" } }));
    expect((search[1]!.parts[0] as Tool).name).toBe("XSearch");
  });
  test("malformed known history controls and mismatched sessions fail", () => {
    writeFileSync(path, user(0) + event({ sessionUpdate: "rewind_marker" }, true));
    expect(() => page()).toThrow();
    forgetTranscriptState(); writeFileSync(path, user(0).replace(session, "other-session"));
    expect(() => page()).toThrow();
  });
});

describe("shared pager projection", () => {
  test("matches the fictional native session/load replay after nested rewinds", () => {
    const fixture = (name: string) => readFileSync(new URL(`./fixtures/grok/${name}.jsonl`, import.meta.url), "utf8");
    writeFileSync(path, fixture("nested-rewind"));
    const visible = (turns: ReturnType<typeof parseGrokTranscript>) => turns.map(({ role, parts }) => ({ role, parts }));
    expect(visible(page().turns)).toEqual(visible(parseGrokTranscript(fixture("native-replay"))));
    expect(page().turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });
  test("ordinary append keeps identity; marker-only rewind invalidates even a cursor at new EOF", () => {
    const first = user(0) + answer();
    writeFileSync(path, first + user(1) + answer());
    const before = page();
    appendFileSync(path, answer("streamed"));
    expect(page().history_id).toBe(before.history_id);
    appendFileSync(path, rewind(1));
    const after = page();
    expect(after.history_id).not.toBe(before.history_id);
    expect(after.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(() => transcriptPage("grok-transcript", path, { before: `${before.history_id}:${Buffer.byteLength(first)}` })).toThrow(HistoryChanged);
    appendFileSync(path, user(1, "replacement") + answer());
    expect(page().history_id).toBe(after.history_id);
  });
  test("nested 1,1,0 rewinds agree cold, warm and with empty history", () => {
    writeFileSync(path, user(0) + answer() + user(1) + answer()); page();
    appendFileSync(path, rewind(1) + user(1) + answer() + user(2) + answer()); page();
    appendFileSync(path, rewind(1) + user(1) + answer()); page();
    appendFileSync(path, rewind(0));
    expect(page().turns).toEqual([]);
    appendFileSync(path, user(0, "final active prompt") + answer());
    const warm = page();
    forgetTranscriptState();
    expect(page()).toEqual(warm);
    expect(warm.turns).toHaveLength(2);
  });
  test("irrelevant extension records between rewind and replacement do not reconnect discarded bytes", () => {
    writeFileSync(path, user(0) + answer() + user(1) + answer() + rewind(1)
      + event({ sessionUpdate: "background_tasks", tasks: [] }, true) + user(1, "replacement") + answer());
    expect(page().turns.filter((turn) => turn.role === "user").map((turn) => turn.parts)).toEqual([
      [{ kind: "text", text: "prompt 0" }], [{ kind: "text", text: "replacement" }],
    ]);
  });
  test("older pages meet newest page with no duplicate turns, and stale pages cannot survive rewind", () => {
    writeFileSync(path, Array.from({ length: 130 }, (_, i) => user(i) + answer()).join(""));
    const newest = page();
    expect(newest.cursor).not.toBeNull();
    const older = transcriptPage("grok-transcript", path, { before: newest.cursor! });
    const oldest = transcriptPage("grok-transcript", path, { before: older.cursor! });
    const prompts = [...oldest.turns, ...older.turns, ...newest.turns].filter((t) => t.role === "user");
    expect(prompts).toHaveLength(130);
    expect(new Set(prompts.map((t) => JSON.stringify(t.parts))).size).toBe(130);
    appendFileSync(path, rewind(1));
    expect(() => transcriptPage("grok-transcript", path, { before: newest.cursor! })).toThrow(HistoryChanged);
  });
  test("partial UTF-8 writes are invisible until complete; metadata follows active prompts", () => {
    writeFileSync(path, user(0));
    const before = page();
    const bytes = Buffer.from(answer("hello 🌍"));
    const split = bytes.indexOf(Buffer.from("🌍")) + 2;
    appendFileSync(path, bytes.subarray(0, split));
    expect(page().turns).toEqual(before.turns);
    appendFileSync(path, bytes.subarray(split));
    expect(page().turns.at(-1)!.parts).toEqual([{ kind: "text", text: "hello 🌍" }]);
    expect(page().metadata.model).toBe("fictional-model");
  });
  test("truncation resets history and tool refs; refs cannot cross stores", () => {
    writeFileSync(path, user(0) + tool() + update("a".repeat(6000)));
    const first = page(); const ref = lastTool().output_ref!;
    const other = join(root, "other", session, "updates.jsonl");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, user(0) + tool() + update("a".repeat(6000)));
    expect(grokToolOutput(other, ref)).toBeNull();
    writeFileSync(path, user(0));
    expect(page().history_id).not.toBe(first.history_id);
    expect(grokToolOutput(path, ref)).toBeNull();
  });
});

describe("exact store lookup", () => {
  test("discovery takes Grok's own executable from the foreground processes", () => {
    expect(grokPaneProcesses({ foreground_processes: [{ pid: 11, argv: ["/usr/local/bin/grok"] }, { pid: 12, argv: ["/bin/sh"] }] }).map((p) => p.pid)).toEqual([11]);
    expect(grokPaneProcesses({})).toEqual([]);
  });
  test("discovery and the exe gate accept the same Grok names without a version pin", () => {
    const accepted = [
      "grok",
      "/usr/local/bin/grok",
      "/usr/local/bin/grok (deleted)",
      "grok.exe",
      "GROK.EXE",
      "C:\\Grok\\grok.exe",
      "grok-1.0.50-linux-x86_64",
      "/home/user/.grok/downloads/grok-1.0.52-linux-x86_64",
      "/home/user/.grok/downloads/grok-1.0.52-linux-x86_64 (deleted)",
      "grok-1.0.52.exe",
      "grok.js",
      "grok.cjs",
      "grok.mjs",
      "grok.js.exe",
      "grok-2.0.0-darwin-arm64",
      "grok-statusline", // Synthetic nonnumeric suffix; not a claim about a shipped build.
    ];
    for (const exe of accepted) {
      expect(isGrokExecutable(exe)).toBe(true);
      expect(grokPaneProcesses({ foreground_processes: [{ pid: 11, argv: [exe] }] })).toHaveLength(1);
    }
    const rejected = ["/bin/sleep", "sleep", "grokker", "notgrok", "grok_cli", "grok.bak", "/opt/grok/bin/sleep", ""];
    for (const exe of rejected) {
      expect(isGrokExecutable(exe)).toBe(false);
      expect(grokPaneProcesses({ foreground_processes: [{ pid: 11, argv: [exe] }] })).toEqual([]);
    }
  });
  // These resolver tests need Linux /proc/<pid>/fd and /proc/<pid>/exe; macOS and
  // Windows intentionally use Terminal because that evidence is unavailable.
  for (const scenario of [
    { name: "older files stay open", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: true },
    { name: "/resume writes a newer session", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false },
    { name: "the reported id is held in two directories", otherGroup: "other-group", otherSession: session, otherMtime: 100, binds: false },
    { name: "held sessions have tied write times", otherGroup: "group", otherSession: "tied-session", otherMtime: 200, binds: false },
    { name: "the newest held events file is unlinked", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "unlink" },
    { name: "the newest held events file is renamed", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "rename" },
    { name: "a replacement reported file has a newer timestamp", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, replacement: "current" },
    { name: "a replacement competing file has an older timestamp", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, replacement: "other" },
    // a newer held events file moved to a name or a folder the session filter does not take
    { name: "the newest held events file is renamed without its prefix", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "rename-away" },
    { name: "the newest held session's folder is renamed past the id filter", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "rename-folder" },
    // older write times: these must not bind as merely older held sessions either
    { name: "an older held session's folder is renamed past the id filter", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: false, change: "rename-folder" },
    { name: "an events-named file is held deeper in the store", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: false, nested: true },
    { name: "a held events file is renamed in a folder renamed past the id filter", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: false, change: "rename-both" },
    // another file held in a session folder: its events file beside it says nothing moved away
    { name: "another file is held beside an older session's events file", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: true, heldLock: "beside events.jsonl" },
    { name: "another file is held in a session folder with no events file", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: false, heldLock: "alone" },
  ] as { name: string; otherGroup: string; otherSession: string; otherMtime: number; binds: boolean; change?: string; replacement?: string; nested?: boolean; heldLock?: string }[]) {
    test.skipIf(process.platform !== "linux" || !existsSync("/proc/self/fd"))(`resolves Herdr's session safely when ${scenario.name}`, async () => {
      const home = realpathSync(root);
      const transcript = join(home, "sessions", "%2Ffiction", session, "updates.jsonl");
      const current = join(dirname(transcript), "events.jsonl");
      const other = join(home, "sessions", scenario.otherGroup, scenario.otherSession, "events.jsonl");
      const retained = join(home, "sessions", "group", "retained-session", "events.jsonl");
      const outside = join(home, "events.jsonl");
      mkdirSync(dirname(other), { recursive: true });
      mkdirSync(dirname(retained), { recursive: true });
      writeFileSync(transcript, user(0));
      writeFileSync(current, "");
      writeFileSync(other, "");
      writeFileSync(retained, "");
      writeFileSync(outside, "");
      utimesSync(current, 200, 200);
      utimesSync(other, scenario.otherMtime, scenario.otherMtime);
      utimesSync(retained, 50, 50);
      utimesSync(outside, 400, 400);
      // Only the reported directory has updates.jsonl, including the duplicate-id case.
      const executable = join(home, "grok");
      // Use our runtime, not a sleep executable that may dispatch by its copied name.
      copyFileSync(process.execPath, executable);
      const held = [current, other, retained, outside];
      if (scenario.heldLock !== undefined) {
        const lock = join(home, "sessions", "group", "closed-session", "updates.jsonl.lock");
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, "");
        if (scenario.heldLock !== "alone") writeFileSync(join(dirname(lock), "events.jsonl"), "");
        // a file held at the store's root (Grok's session index) is no session's
        const index = join(home, "sessions", "session_search.sqlite");
        writeFileSync(index, "");
        held.push(lock, index);
      }
      if (scenario.nested) {
        const nested = join(home, "sessions", "group", "older-session", "checkpoint", "events.jsonl");
        mkdirSync(dirname(nested), { recursive: true });
        writeFileSync(nested, "");
        utimesSync(nested, 100, 100);
        held.push(nested);
      }
      const fds = held.map((file) => openSync(file, "r"));
      const child = spawn(executable, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore", ...fds] });
      const pane: HerdrPane = {
        pane_id: "grok-fixture", agent: "grok", agent_status: "ready", focused: false,
        revision: 0, tab_id: "tab-fixture", terminal_id: "terminal-fixture", workspace_id: "workspace-fixture",
        agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value: session },
      };
      const info = spyOn(herdr, "paneProcessInfo").mockResolvedValue({
        pane_id: pane.pane_id, foreground_processes: [{ pid: child.pid!, name: "grok", argv: [executable] }],
      });
      const nativeStat = fs.statSync;
      let replaced = false;
      const stats = spyOn(fs, "statSync").mockImplementation(new Proxy(nativeStat, {
        apply(target, receiver, args) {
          const replacement = "replacement" in scenario ? scenario.replacement : null;
          const file = replacement === "current" ? current : other;
          // Replace after /proc's link was read, before the path's stat is sampled.
          if (replacement && !replaced && args[0] === file) {
            replaced = true;
            unlinkSync(file);
            writeFileSync(file, "");
            utimesSync(file, replacement === "current" ? 400 : 100, replacement === "current" ? 400 : 100);
          }
          return Reflect.apply(target, receiver, args);
        },
      }));
      try {
        await once(child, "spawn", { signal: AbortSignal.timeout(2000) });
        if (scenario.change === "unlink") unlinkSync(other);
        else if (scenario.change === "rename") renameSync(other, `${other}.old`);
        else if (scenario.change === "rename-away") renameSync(other, join(dirname(other), "old-events.jsonl"));
        else if (scenario.change === "rename-folder") renameSync(dirname(other), join(dirname(dirname(other)), ".archived-resumed"));
        else if (scenario.change === "rename-both") {
          renameSync(other, join(dirname(other), "old-events.jsonl"));
          renameSync(dirname(other), join(dirname(dirname(other)), ".archived-older"));
        }
        expect(await resolveGrokStore(pane, home)).toBe(scenario.binds ? transcript : null);
      } finally {
        stats.mockRestore();
        info.mockRestore();
        const exited = once(child, "exit", { signal: AbortSignal.timeout(2000) });
        child.kill();
        await exited;
        for (const fd of fds) closeSync(fd);
      }
    });
  }
  test("discovery checks a script only behind bun or node, never arbitrary arguments", () => {
    const processes = [
      { pid: 11, argv: ["/usr/bin/node", "/opt/grok/grok.js"] },
      { pid: 12, argv: ["bun", "/opt/grok/grok-statusline.mjs"] },
      { pid: 13, argv: ["C:\\bin\\node.exe", "C:\\bin\\grok.cjs"] },
      { pid: 14, argv: ["/bin/sh", "grok"] },
      { pid: 15, argv: ["node", "unrelated.js", "grok"] },
      { pid: 16, argv: ["node"] },
      { pid: 17, argv: null },
    ];
    expect(grokPaneProcesses({ foreground_processes: processes }).map((p) => p.pid)).toEqual([11, 12, 13]);
  });
  test("custom home and hashed cwd names need no newest-file guess", () => {
    const hashed = join(root, "sessions", "long-slug-abc123", session, "updates.jsonl");
    mkdirSync(join(hashed, ".."), { recursive: true }); writeFileSync(hashed, user(0));
    expect(grokTranscriptPath(root, session)).toBe(hashed);
    writeFileSync(path, user(0));
    expect(grokTranscriptPath(root, session)).toBeNull();
    expect(grokTranscriptPath(root, "../escape")).toBeNull();
  });
  test("symlinked sessions are not followed outside the store", () => {
    const external = join(root, "external"); mkdirSync(external); writeFileSync(join(external, "updates.jsonl"), user(0));
    rmSync(join(path, ".."), { recursive: true }); symlinkSync(external, join(path, ".."));
    expect(grokTranscriptPath(root, session)).toBeNull();
  });
  test("pane environment chooses the home and never a relative store", () => {
    expect(grokHomeFromEnvironment("HOME=/user\0GROK_HOME=/custom store\0")).toBe("/custom store");
    expect(grokHomeFromEnvironment("HOME=/user\0")).toBe("/user/.grok");
    expect(grokHomeFromEnvironment("USERPROFILE=/user\0")).toBe("/user/.grok");
    expect(grokHomeFromEnvironment("HOME=/user\0GROK_HOME=relative\0")).toBeNull();
  });
});
