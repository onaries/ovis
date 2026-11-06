import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "./herdr/client.ts";
import * as conversation from "./conversation.ts";
import { handlePromptRequest, noteSubmitted } from "./prompt.ts";
import type { PanePromptResponse, SlashCommand } from "../shared/protocol.ts";
import { commandInvocations, commandTranscriptRecords, CommandReservations, type CommandSend } from "./outcome.ts";

afterEach(() => mock.restore());

const at = Date.parse("2026-11-06T00:00:00Z");
const skills: SlashCommand[] = [{ name: "skill:probe", source: "skill", description: "" }, { name: "skill:other", source: "skill", description: "" }];
const send = (text = "/skill:probe hello there", id = "send"): CommandSend => ({
  id, text, at, agent: "gjc", identity: "fixture", screen: "", form: null, invocations: commandInvocations("gjc", text, skills),
});
const stamp = (ms: number) => new Date(at + ms).toISOString();
// the records real gjc 0.18.12 writes for `/skill:probe hello there` typed into its TUI (content shortened)
const skillPrompt = (ms: number, id = "s1", name = "probe", args = "hello there") => ({
  type: "custom_message", customType: "skill-prompt", content: "Reply with the word PROBED.\n\n---\n\nSkill: /home/fixture/.gjc/agent/skills/probe/SKILL.md\nUser: hello there",
  display: true, details: { name, path: `/home/fixture/.gjc/agent/skills/${name}/SKILL.md`, args, lineCount: 1, subskillActivationSet: [] },
  attribution: "user", id, parentId: "p0", timestamp: stamp(ms),
});
const assistant = (ms: number, id: string, parentId: string, stopReason: string) => ({
  type: "message", id, parentId, timestamp: stamp(ms),
  message: { role: "assistant", content: [], provider: "fake", model: "fake-model", stopReason, timestamp: at + ms },
});
const toolResult = (ms: number, id: string, parentId: string) => ({
  type: "message", id, parentId, timestamp: stamp(ms), message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] },
});
const user = (ms: number, id: string, parentId: string) => ({ type: "message", id, parentId, timestamp: stamp(ms), message: { role: "user", content: "steer" } });
const jsonl = (...entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
const observe = (sent: CommandSend, transcript: string) => {
  const reservations = new CommandReservations();
  reservations.add(sent, []);
  reservations.observeTranscript("fixture", "store", commandTranscriptRecords(transcript), sent.id);
  return sent.transcriptEvidence;
};

it.each(["stop", "error", "aborted"])("settles a Chat-typed gjc skill when the turn its skill-prompt record started ends (%s)", (stopReason) => {
  const started = jsonl(skillPrompt(10), assistant(20, "a1", "s1", "toolUse"), toolResult(30, "t1", "a1"));
  expect(observe(send(), started)).toBeUndefined();
  expect(observe(send(), started + jsonl(assistant(40, "a2", "t1", stopReason)))?.at).toBe(at + 40);
});

it.each([
  ["another skill", jsonl(skillPrompt(10, "s1", "other"), assistant(20, "a1", "s1", "stop"))],
  ["other arguments", jsonl(skillPrompt(10, "s1", "probe", "something else"), assistant(20, "a1", "s1", "stop"))],
  ["other spacing inside the arguments", jsonl(skillPrompt(10, "s1", "probe", "hello  there"), assistant(20, "a1", "s1", "stop"))],
  ["a run from before the send", jsonl(skillPrompt(-10), assistant(20, "a1", "s1", "stop"))],
  ["a turn another prompt joined before it ended", jsonl(skillPrompt(10), assistant(20, "a1", "s1", "toolUse"), user(25, "u1", "a1"), assistant(30, "a2", "u1", "stop"))],
  ["an end on another branch", jsonl(skillPrompt(10), assistant(20, "a1", "p0", "stop"))],
  ["the same skill typed again in the terminal", jsonl(skillPrompt(10), assistant(20, "a1", "s1", "stop"), skillPrompt(30, "s2"), assistant(40, "a2", "s2", "stop"))],
])("takes no gjc skill evidence from %s", (_, transcript) => {
  expect(observe(send(), transcript)).toBeUndefined();
});

it("gives two Chat sends of one gjc skill each its own turn's end", () => {
  const first = send("/skill:probe hello there", "first");
  const second = { ...send("/skill:probe hello there", "second"), at: at + 15 };
  const reservations = new CommandReservations();
  reservations.add(first, []);
  reservations.add(second, []);
  const records = commandTranscriptRecords(jsonl(skillPrompt(10), assistant(20, "a1", "s1", "stop"), skillPrompt(30, "s2"), assistant(40, "a2", "s2", "error")));
  reservations.observeTranscript("fixture", "store", records, second.id);
  expect([first.transcriptEvidence?.at, second.transcriptEvidence?.at]).toEqual([at + 20, at + 40]);
});

it("shows a Chat-typed gjc skill's result once its turn ends", async () => {
  let now = at;
  spyOn(Date, "now").mockImplementation(() => now);
  const pane = { pane_id: "gjc-skill-outcome", workspace_id: "w", tab_id: "t", terminal_id: "terminal",
    cwd: "/fixture", focused: false, revision: 0, agent: "gjc", agent_status: "working" };
  spyOn(client, "sessionSnapshot").mockResolvedValue({ panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture", focused_workspace_id: null });
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  let transcript = "";
  spyOn(conversation, "readCommandTranscript").mockImplementation(async () => ({ identity: "fixture", records: commandTranscriptRecords(transcript) }));
  const sent = { ...send(), store: null, identity: JSON.stringify([pane.terminal_id, undefined]) };
  noteSubmitted(pane.pane_id, sent.text, sent);
  const poll = async () => {
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
    return (await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse).outcomes?.at(-1);
  };
  now += 30;
  transcript = jsonl(skillPrompt(10), assistant(20, "a1", "s1", "toolUse"));
  expect(await poll()).toMatchObject({ state: "accepted", evidence: [] });
  now += 30;
  transcript += jsonl(assistant(50, "a2", "a1", "stop"));
  expect(await poll()).toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript", at: stamp(50) }] });
});
