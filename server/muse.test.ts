import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, paneTranscript, transcriptPage, transcriptToolOutput } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import * as herdr from "./herdr/client.ts";
import { museModel, musePrompt, museResult, museToolOutput, MuseUnavailable, parseMuseTranscript } from "./muse.ts";
import { isMuseExecutable, museSessionFor, museSessionLive, parseMuseLock } from "./muse-store.ts";
import type { ConversationPart, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

type Tool = Extract<ConversationPart, { kind: "tool" }>;
const fixture = readFileSync(join(import.meta.dir, "fixtures", "muse", "session.jsonl"), "utf8");
const recorded = readFileSync(join(import.meta.dir, "fixtures", "muse", "recorded-1.4.13.jsonl"), "utf8");
/** The sessions the two logs belong to: a log is read in a folder named after its session. */
const FICTION = "00000000-0000-7000-8000-000000000001";
const RECORDED = "01a17441-bc95-7e23-b488-988dceb829cd";
const fiction = (log: string) => parseMuseTranscript(log, FICTION);
const real = (log: string) => parseMuseTranscript(log, RECORDED);
let root: string;
const logAt = (session: string, log: string): string => {
  mkdirSync(join(root, session), { recursive: true });
  writeFileSync(join(root, session, "session.jsonl"), log);
  return join(root, session, "session.jsonl");
};
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ovis-muse-unit-")); forgetTranscriptState(); });
afterEach(() => { forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); });

describe("Muse session log", () => {
  test("reads prompts, reasoning, answers, tool results and compaction from the native records", () => {
    const turns = fiction(fixture);
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["thinking", "text", "tool", "tool", "tool", "tool", "tool", "text"]],
      ["user", ["text"]],
      ["user", ["compact"]],
      ["assistant", ["text"]],
    ]);
    const [prompt, work] = turns;
    // run/started repeats the prompt; only the accepted intent is the user's message
    expect(prompt!.parts).toEqual([{ kind: "text", text: "Count the lines in notes.txt" }]);
    expect(work!.parts[1]).toEqual({ kind: "text", text: "Counting the lines now.", phase: "commentary" });
    // the run's completed end makes its last answer final
    expect(work!.parts.at(-1)).toEqual({ kind: "text", text: "notes.txt has 3 lines.", phase: "final_answer" });
    const tools = work!.parts.filter((part): part is Tool => part.kind === "tool");
    expect(tools.map((tool) => [tool.name, tool.summary, tool.output.slice(0, 50), tool.error ?? false])).toEqual([
      ["bash", "Count the lines", "3 notes.txt\n", false],
      ["read_file", "notes.txt", "one\ntwo\nthree\n", false],
      ["bash", "Read the missing file", "cat: missing.txt: No such file or directory\n", true],
      ["bash", "Remove the notes", "tool denied: the user declined this command", true],
      ["bash", "Print numbers", Array.from({ length: 20 }, (_, n) => `${n + 1}\n`).join("").slice(0, 50), false],
    ]);
    expect(tools[4]!.output.endsWith("\n… trimmed")).toBe(true);
    expect(JSON.parse(tools[0]!.input)).toEqual({ command: "wc -l notes.txt", description: "Count the lines" });
    expect(tools[4]!.output_ref).toBe("call_05");
    expect(tools[4]!.output_size).toBe(Array.from({ length: 1200 }, (_, n) => `${n + 1}\n`).join("").length);
    expect(turns[3]!.parts[0]).toEqual({ kind: "compact", text: "The user counted the lines of notes.txt: 3." });
    // recorded_at is in microseconds; the answer starts at its first record, the reasoning
    const reasoning = JSON.parse(fixture.split("\n").find((line) => line.includes("reasoning_summary_committed"))!);
    expect(work!.ts).toBe(new Date(Math.floor(reasoning.recorded_at / 1000)).toISOString());
  });

  test("a result whose call is on an earlier page keeps its output on a row of its own", () => {
    const lines = fixture.trimEnd().split("\n");
    const batch = lines.find((line) => line.includes('"call_01"') && line.includes("tool_result_batch_committed"))!;
    const tools = fiction(batch).flatMap((turn) => turn.parts).filter((part): part is Tool => part.kind === "tool");
    expect(tools.map((tool) => [tool.name, tool.output])).toEqual([["Tool output", "3 notes.txt\n"], ["Tool output", "one\ntwo\nthree\n"]]);
    // without an id, a long result is cut with nothing to fetch the rest by
    const unnamed = fiction(batch.replace('"tool_call_id":"call_01"', '"tool_call_id":""').replace("3 notes.txt", "x".repeat(5000)))
      .flatMap((turn) => turn.parts).find((part): part is Tool => part.kind === "tool")!;
    expect([unnamed.output.length < 5000, unnamed.output_ref, unnamed.output_size]).toEqual([true, undefined, undefined]);
  });

  test("only a run that completes on an answer marks it final", () => {
    const lines = fixture.trimEnd().split("\n");
    const last = (log: string[]) => fiction(log.join("\n")).at(-1)!.parts.at(-1);
    const end = lines.findIndex((line) => line.includes('"terminal":"completed"'));
    expect(last(lines.slice(0, end))).toEqual({ kind: "text", text: "notes.txt has 3 lines." });
    expect(last([...lines.slice(0, end), lines[end]!.replace('"terminal":"completed"', '"terminal":"failed"')])).toEqual({ kind: "text", text: "notes.txt has 3 lines." });
    // a run that ends on progress prose or on a tool has no answer to mark
    const commentary = lines.find((line) => line.includes('"phase":"commentary"'))!;
    expect(last([lines[2]!, commentary, lines[end]!])).toEqual({ kind: "text", text: "Counting the lines now.", phase: "commentary" });
    const call = lines.find((line) => line.includes("assistant_tool_calls_committed"))!;
    expect(last([lines[2]!, call, lines[end]!])?.kind).toBe("tool");
  });

  test("unwraps result envelopes and the harness's own verdicts", () => {
    expect(museResult('{"output":"ok","exit_code":0}')).toEqual({ text: "ok", error: false });
    expect(museResult('{"output":"","exit_code":2}')).toEqual({ text: "", error: true });
    expect(museResult('{"status":"done","summary":"found it"}')).toEqual({ text: '{"status":"done","summary":"found it"}', error: false });
    expect(museResult("tool failed: timed out")).toEqual({ text: "tool failed: timed out", error: true });
    expect(museResult("plain text")).toEqual({ text: "plain text", error: false });
  });

  test("pages at prompts, follows appends as a cold read does, and names the latest model", () => {
    const lines = fixture.trimEnd().split("\n").map((line) => `${line}\n`);
    const second = lines.findIndex((line, at) => at > 2 && line.includes('"runtime.user_intent.accepted"'));
    const path = logAt(FICTION, lines.slice(0, second).join(""));
    const first = transcriptPage("muse-transcript", path);
    expect(first.source).toBe("muse-transcript");
    expect(first.metadata.model).toBe("muse-fiction-2");
    for (const line of lines.slice(second)) appendFileSync(path, line);
    const live = transcriptPage("muse-transcript", path);
    expect(live.history_id).toBe(first.history_id);
    forgetTranscriptState();
    expect(transcriptPage("muse-transcript", path).turns).toEqual(live.turns);
    expect(live.turns).toEqual(fiction(fixture));
    expect(museToolOutput(path, "call_05")).toBe(Array.from({ length: 1200 }, (_, n) => `${n + 1}\n`).join(""));
    expect(museToolOutput(path, "call_03")).toBe("cat: missing.txt: No such file or directory\n");
    expect(museToolOutput(path, "call_99")).toBeNull();
    // Show all is bounded as for every other agent
    const batch = lines.find((line) => line.includes('"call_02"') && line.includes("tool_result_batch_committed"))!;
    appendFileSync(path, batch.replace('"call_02"', '"call_big"').replace("one\\ntwo\\nthree\\n", "x".repeat(2_000_001)));
    expect(transcriptToolOutput("muse-transcript", path, "call_big")).toBe(`${"x".repeat(2_000_000)}\n… trimmed`);
    expect(transcriptToolOutput("muse-transcript", path, "call_05")).toBe(museToolOutput(path, "call_05"));
  });

  test("reads a session Muse 1.4.13 recorded, with its records as Muse wrote them", () => {
    const turns = real(recorded);
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind === "text" && part.phase ? `text:${part.phase}` : part.kind)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["thinking", "text:commentary", "tool", "tool", "tool", "thinking", "text:final_answer"]],
      ["user", ["text"]],
      ["assistant", ["text:commentary", "tool", "text:final_answer"]],
      ["user", ["text"]],
      ["assistant", ["tool", "text:final_answer"]],
    ]);
    expect(turns.filter((turn) => turn.role === "user").map((turn) => turn.parts)).toEqual([
      [{ kind: "text", text: "Read notes.txt, run sh greet.sh, and run ls missing-folder. Then tell me in one sentence what the notes say." }],
      [{ kind: "text", text: "Run rm greet.sh to delete the script." }],
      [{ kind: "text", text: "Count the lines in notes.txt with wc -l and tell me the number." }],
    ]);
    const tools = turns.flatMap((turn) => turn.parts).filter((part): part is Tool => part.kind === "tool");
    expect(tools.map((tool) => [tool.name, tool.summary, tool.output, tool.error ?? false])).toEqual([
      ["read_file", "notes.txt", "Read text file `notes.txt`.\n1|Garden plan\n2|- plant tomatoes in May\n3|- water every other day", false],
      ["bash", "Run greet script", "hello from greet\n", false],
      ["bash", "List missing folder", "ls: missing-folder: No such file or directory\n", true],
      // the call the user declined at the approval prompt
      ["bash", "Delete greet script", "tool denied: approval aborted\nThe user rejected this action. Don't retry it unless they ask.", true],
      ["bash", "Count lines in notes", "       3 notes.txt\n", false],
    ]);
    // `/model` switched muse-spark-1.3 to muse-spark-1.2 before the last prompt
    const lines = recorded.split("\n");
    const switched = lines.findIndex((line) => line.includes('"command":"/model"'));
    expect([museModel(lines.slice(0, switched).join("\n"), null), museModel(recorded, null)]).toEqual(["muse-spark-1.3", "muse-spark-1.2"]);
    const path = logAt(RECORDED, recorded);
    const page = transcriptPage("muse-transcript", path);
    expect([page.turns, page.metadata.model]).toEqual([turns, "muse-spark-1.2"]);
    expect(museToolOutput(path, "call_01a1744243497078923c0e3306f4900d")).toBe("ls: missing-folder: No such file or directory\n");
    // Muse ended the session on exit; until then it was live
    expect(museSessionLive(path)).toBe(false);
    writeFileSync(path, `${lines.slice(0, -2).join("\n")}\n`);
    expect(museSessionLive(path)).toBe(true);
  });

  test("a log in a shape the reader does not know is refused, so the pane uses Terminal", () => {
    const line = (mark: string) => recorded.split("\n").find((candidate) => candidate.includes(mark))!;
    const prompt = line('"runtime.user_intent.accepted"');
    const cut = prompt.slice(0, prompt.indexOf('"model_messages"'));
    // the fictional log's compaction, as a record of the recorded session
    const compaction = fixture.split("\n").find((candidate) => candidate.includes('"context_compaction_installed"'))!.replace(FICTION, RECORDED);
    const refused = [
      // another log version, a line that is no Muse record, or a whole line cut short
      prompt.replace('{"schema_version":1,', '{"schema_version":2,'),
      "not a record",
      cut,
      // a record or a run event those builds do not write, or a renamed one
      line('"payload_type":"command.invoked"').replace('"command.invoked"', '"command.invoked_v2"'),
      line('"assistant_message_committed"').replace('"assistant_message_committed"', '"assistant_message_final"'),
      line('"assistant_message_committed"').replace('"kind":"run"', '"kind":"later"'),
      // a record the reader takes, in another shape
      prompt.replace('"model_messages":[', '"model_messages":"moved","messages":['),
      prompt.replace('"model_messages":[{"content":[{"kind":"text"', '"model_messages":[{"content":[{"kind":"video"'),
      line('"assistant_tool_calls_committed"').replaceAll('"name":', '"tool_name":'),
      line('"tool_result_batch_committed"').replaceAll('"text":', '"output":'),
      compaction.replace('"summary_text"', '"handoff_text"'),
      compaction.replace('"text":', '"summary":'),
      // a record of another session: its turns are not this pane's
      prompt.replace(RECORDED, FICTION),
    ];
    for (const added of refused) expect(() => real(`${recorded}${added}\n`), added.slice(0, 80)).toThrow(MuseUnavailable);
    expect(real(`${recorded}${compaction}\n`).at(-1)!.parts[0]!.kind).toBe("compact");
    // a renamed record in the recording itself, rather than Chat without its answers
    expect(() => real(recorded.replaceAll('"assistant_message_committed"', '"assistant_message_final"'))).toThrow(MuseUnavailable);
    // a last line Muse is still writing is skipped until it is whole
    expect(real(`${recorded}${cut}`)).toEqual(real(recorded));
    const path = logAt(RECORDED, `${recorded}${refused[3]}\n`);
    expect(() => transcriptPage("muse-transcript", path)).toThrow(ConversationUnavailable);
    // the log of another session in this session's folder: no turn and no tool output of it
    const other = logAt(FICTION, recorded);
    expect(() => transcriptPage("muse-transcript", other)).toThrow(ConversationUnavailable);
    expect(museToolOutput(other, "call_01a1744243497078923c0e3306f4900d")).toBeNull();
  });

  test("a log rewritten in place that also grew is read again, under another history id", () => {
    const path = logAt(RECORDED, recorded);
    const before = transcriptPage("muse-transcript", path);
    // the first prompt, settled before the last, takes words of the same length, and a record follows
    const rewritten = recorded.replaceAll("tell me in one sentence", "tell me in two sentence");
    expect(rewritten.length).toBe(recorded.length);
    writeFileSync(path, `${rewritten}${recorded.split("\n").find((line) => line.includes('"payload_type":"session.name.changed"'))}\n`);
    const after = transcriptPage("muse-transcript", path);
    expect(after.turns[0]!.parts[0]).toEqual({ kind: "text", text: "Read notes.txt, run sh greet.sh, and run ls missing-folder. Then tell me in two sentence what the notes say." });
    expect(after.history_id).not.toBe(before.history_id);
    forgetTranscriptState();
    expect(transcriptPage("muse-transcript", path).turns).toEqual(after.turns);
  });

  test("a prompt of pictures alone shows Muse's own name for each", () => {
    const prompt = JSON.parse(recorded.split("\n").find((line) => line.includes('"runtime.user_intent.accepted"'))!);
    const picture = { kind: "asset", asset: { schema_version: 1, algorithm: "sha256", digest: "0".repeat(64), media_type: "image/png", byte_length: 1, width: 1, height: 1 } };
    prompt.payload.model_messages[0].content = [{ kind: "text", text: "" }, picture, picture];
    expect(musePrompt(prompt)).toBe("[Image #1] [Image #2]");
    expect(real(`${JSON.stringify(prompt)}\n`)[0]!.parts).toEqual([{ kind: "text", text: "[Image #1] [Image #2]" }]);
  });
});

describe("Muse session binding", () => {
  const start = Date.parse("2026-10-22T12:00:00Z");
  const session = (day: string, id: string, lock: string | null, log = fixture, at = start + 60_000): string => {
    const dir = join(root, "sessions", "2026", "10", day, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.jsonl"), log);
    if (lock !== null) {
      writeFileSync(join(dir, ".session.lock"), lock);
      utimesSync(join(dir, ".session.lock"), at / 1000, at / 1000);
    }
    return join(dir, "session.jsonl");
  };
  const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const END = '{"payload_type":"session.end","payload":{"kind":"session_end"}}\n';
  const ended = `${fixture}${END}`;
  const owner = [{ pid: 4242, startedAt: start }];
  // a scan that bound nothing stands for 2 s: a test that scans again moves the clock past it
  const later = () => Date.now() + 2000;

  test("binds the one live session whose lock names the process", () => {
    const live = session("22", id(1), "pid=4242\nhost=fiction\n");
    session("22", id(2), "pid=7\nhost=fiction\n");
    session("21", id(3), null);
    expect(museSessionFor(root, owner, "fiction")).toBe(live);
  });

  test("a lock from before the process started, another host's lock, an ended session and a lock without its log never bind", () => {
    session("20", id(1), "pid=4242\nhost=fiction\n", fixture, start - 3_600_000);
    session("22", id(2), "pid=4242\nhost=elsewhere\n");
    session("22", id(3), "pid=4242\nhost=fiction\n", ended);
    rmSync(session("22", id(5), "pid=4242\nhost=fiction\n"));
    expect(museSessionFor(root, owner, "fiction")).toBeNull();
    // after an in-TUI switch, the session left behind ends and the one switched to is live
    const live = session("22", id(4), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, owner, "fiction", later())).toBe(live);
  });

  test("a host name matches by its first label", () => {
    const live = session("22", id(1), "pid=4242\nhost=Fiction\n");
    expect(museSessionFor(root, owner, "fiction.local")).toBe(live);
  });

  test("two live sessions for one process bind neither, and an older lock without a host binds", () => {
    const old = session("22", id(1), "pid=4242\n");
    const other = session("22", id(2), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, owner, "fiction")).toBeNull();
    appendFileSync(other, END);
    expect(museSessionFor(root, owner, "fiction", later())).toBe(old);
  });

  test("every resolve scans again: a second live session leaves none, whatever was bound before", () => {
    const first = session("22", id(1), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, owner, "fiction")).toBe(first);
    // as a cold lookup does, which sees two
    const second = session("22", id(2), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, owner, "fiction")).toBeNull();
    // an in-TUI switch ends the log it leaves
    appendFileSync(first, END);
    expect(museSessionFor(root, owner, "fiction", later())).toBe(second);
    // a process that took the pid later never binds
    expect(museSessionFor(root, [{ pid: 4242, startedAt: start + 3_600_000 }], "fiction", later())).toBeNull();
  });

  test("only the start of a lock is read", () => {
    const live = session("22", id(1), `pid=4242\nhost=fiction\n${"#".repeat(1 << 20)}\n`);
    expect(museSessionFor(root, owner, "fiction")).toBe(live);
    session("22", id(1), `${"#".repeat(1024)}\npid=4242\nhost=fiction\n`);
    expect(museSessionFor(root, owner, "fiction", later())).toBeNull();
  });

  test("a Muse pane's processes are asked for once per lookup", async () => {
    const live = session("22", id(1), `pid=${process.pid}\nhost=${hostname()}\n`, fixture, Date.now());
    const pane = { pane_id: "w1:p1", agent: "muse", cwd: root } as HerdrPane;
    const asked: string[] = [];
    const info = spyOn(herdr, "paneProcessInfo").mockImplementation(async (paneId) => {
      asked.push(paneId);
      return { pane_id: paneId, foreground_processes: [{ pid: process.pid, name: "muse", argv: ["muse"] }] } as herdr.ProcessInfo;
    });
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => { asked.push(method); return {} as never; });
    try {
      expect((await paneTranscript(pane.pane_id, undefined, { panes: [pane] } as SessionSnapshot, undefined, undefined, undefined, undefined, root)).path).toBe(live);
      expect(asked).toEqual(["w1:p1"]);
    } finally { info.mockRestore(); rpc.mockRestore(); }
  });

  test("a launcher alive beside its muse-bin child binds the session the child holds", () => {
    const live = session("22", id(1), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, [{ pid: 4241, startedAt: start }, ...owner], "fiction")).toBe(live);
  });

  test("a scan that binds nothing is not repeated for 2 s, except for other processes", () => {
    const now = Date.now();
    expect(museSessionFor(root, owner, "fiction", now)).toBeNull();
    // a fresh Muse writes its session after the pane is first resolved
    const live = session("22", id(1), "pid=4242\nhost=fiction\n");
    expect(museSessionFor(root, owner, "fiction", now + 1999)).toBeNull();
    expect(museSessionFor(root, owner, "fiction", now + 2000)).toBe(live);
    // the miss is kept per set of processes: a launcher beside the child is scanned at once
    const child = [{ pid: 4343, startedAt: start }];
    expect(museSessionFor(root, child, "fiction", now)).toBeNull();
    const other = session("22", id(2), "pid=4343\nhost=fiction\n");
    expect(museSessionFor(root, [{ pid: 4342, startedAt: start }, ...child], "fiction", now)).toBe(other);
  });

  test("a store of more than 4096 sessions is not scanned", () => {
    const live = session("22", id(1), "pid=4242\nhost=fiction\n");
    for (let n = 2; n <= 4097; n++) mkdirSync(join(root, "sessions", "2026", "10", "23", id(n)), { recursive: true });
    expect(museSessionFor(root, owner, "fiction")).toBeNull();
    rmSync(join(root, "sessions", "2026", "10", "23", id(4097)), { recursive: true });
    expect(museSessionFor(root, owner, "fiction", later())).toBe(live);
    // nor a folder of more entries than that, sessions or not: it is not listed whole
    for (const name of ["a", "b"]) writeFileSync(join(root, "sessions", "2026", "10", "23", name), "");
    expect(museSessionFor(root, owner, "fiction", later())).toBeNull();
  });

  test("a subagent's nested session is never a candidate", () => {
    const live = session("22", id(1), "pid=4242\nhost=fiction\n");
    const nested = join(root, "sessions", "2026", "10", "22", id(1), "subagent", id(2));
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".session.lock"), "pid=4242\nhost=fiction\n");
    writeFileSync(join(nested, "session.jsonl"), fixture);
    expect(museSessionFor(root, owner, "fiction")).toBe(live);
  });

  test("reads locks, ends and executables as Muse writes them", () => {
    expect(parseMuseLock("pid=10362\nhost=mini\n")).toEqual({ pid: 10362, host: "mini" });
    expect(parseMuseLock("pid=56643\n")).toEqual({ pid: 56643, host: null });
    expect(parseMuseLock("")).toBeNull();
    const path = session("22", id(1), null, ended);
    expect(museSessionLive(path)).toBe(false);
    // a resume writes its records at once, after the end the earlier close left
    appendFileSync(path, '{"payload_type":"session.resumed"');
    expect(museSessionLive(path)).toBe(true);
    expect(museSessionLive(join(root, "missing.jsonl"))).toBe(false);
    for (const name of ["muse", "/Users/a/.local/bin/muse-bin-1.4.12-R6909.1", "C:\\bin\\muse.exe"]) expect(isMuseExecutable(name), name).toBe(true);
    for (const name of ["museum", "muse-helper", "bash"]) expect(isMuseExecutable(name), name).toBe(false);
  });
});
