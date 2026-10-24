import { afterAll, beforeAll, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createServer } from "./index.ts";
import { forgetPiModels } from "./pi-models.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse } from "../shared/protocol.ts";

// Real herdr metadata + HTTP + native files, all under an owned workspace/store.
const root = mkdtempSync(join(tmpdir(), "ovis-pi-contract-"));
const sessionDir = join(root, ".pi", "agent", "sessions");
const slug = join(sessionDir, `--${root.replaceAll("/", "-")}--`);
const transcript = join(slug, "session.jsonl");
const workspaces: string[] = [];
const fakePi = join(root, "bin", "pi");
let paneId: string;
let server: ReturnType<typeof createServer>;
// herdr keeps one session report per pane and refuses one older than the last.
let seq = Date.now() * 1000;
const nextSeq = () => ++seq;
const reportSession = (path: string, target = paneId) =>
  herdrRpc("pane.report_agent_session", { pane_id: target, source: "herdr:pi", agent: "pi", seq: nextSeq(), agent_session_path: path, session_start_source: "startup" });

const page = (entries: unknown[]) => [
  { type: "session", version: 3, id: "session", timestamp: new Date().toISOString(), cwd: root },
  ...entries,
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";

const turns = (prompt: string, answer: string) => page([
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
  { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: [{ type: "text", text: prompt }] } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
    role: "assistant", model: "pi-contract-model", provider: "test", stopReason: "stop",
    usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0 },
    content: [{ type: "text", text: answer }],
  } },
]);

async function createPiPane(): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-pi-contract" });
  workspaces.push(created.workspace.workspace_id);
  const target = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: target, text: `${fakePi}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === target);
    if (pane?.agent === "pi") break;
    if (Date.now() > deadline) throw new Error("test pi did not start");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:pi", agent: "pi", state: "idle", seq: nextSeq() });
  return target;
}

beforeAll(async () => {
  process.env["PI_CODING_AGENT_SESSION_DIR"] = sessionDir;
  mkdirSync(slug, { recursive: true });
  // herdr takes a session report only from an agent holding the pane: one it detected
  // running there, reporting under its own integration source. A fake pi stands in.
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(fakePi, "#!/bin/sh\nsleep 600\n");
  chmodSync(fakePi, 0o755);
  paneId = await createPiPane();
  await reportSession(transcript);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push") });
});

afterAll(async () => {
  server?.stop();
  for (const workspaceId of workspaces) await workspaceClose(workspaceId);
  delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  rmSync(root, { recursive: true, force: true });
});

const read = async (target = paneId): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(target)}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};


it.skipIf(process.platform !== "linux")("serves a fresh Pi session in its pane-owned profile before its first message", async () => {
  const profileDir = join(root, "fictional-pi-profile");
  const profileSessions = join(profileDir, "sessions");
  mkdirSync(profileSessions, { recursive: true });
  const profileBin = join(root, "profile-bin");
  mkdirSync(profileBin, { recursive: true });
  const profilePi = join(profileBin, "pi");
  writeFileSync(profilePi, `#!/bin/bash\nexport PI_CODING_AGENT_DIR='${profileDir}'\nexec -a pi /bin/sleep 600\n`);
  chmodSync(profilePi, 0o755);

  const created = await workspaceCreate({ cwd: root, label: "ovis-test-pi-custom-profile" });
  workspaces.push(created.workspace.workspace_id);
  const target = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: target, text: `${profilePi}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === target);
    if (pane?.agent === "pi") break;
    if (Date.now() > deadline) throw new Error("custom-profile Pi fixture was not detected");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:pi", agent: "pi", state: "idle", seq: nextSeq() });
  const fresh = join(profileSessions, `--${root.replaceAll("/", "-")}--`, "2026-10-16_fresh.jsonl");
  await reportSession(fresh, target);

  const beforeMessage = await read(target);
  expect(beforeMessage).toMatchObject({ source: "pi-transcript", turns: [], cursor: null, history_id: "unwritten:2026-10-16_fresh" });

  mkdirSync(dirname(fresh), { recursive: true });
  writeFileSync(fresh, turns("Synthetic new profile session", "First response in the profile session"));
  // the window comes from the profile's own catalog, not from the one the bridge's env names
  writeFileSync(join(profileDir, "models.json"), JSON.stringify({ providers: { test: { models: [{ id: "pi-contract-model", contextWindow: 400_000 }] } } }));
  const bridgeDir = join(root, "bridge-agent-dir");
  mkdirSync(bridgeDir, { recursive: true });
  writeFileSync(join(bridgeDir, "models.json"), JSON.stringify({ providers: { test: { models: [{ id: "pi-contract-model", contextWindow: 200_000 }] } } }));
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = bridgeDir;
  try {
    const afterMessage = await read(target);
    expect(afterMessage.source).toBe("pi-transcript");
    expect(afterMessage.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(afterMessage.turns[0]!.parts).toEqual([{ kind: "text", text: "Synthetic new profile session" }]);
    expect(afterMessage.metadata?.context).toEqual({ used: 35, window: 400_000 });
  } finally {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previous;
    forgetPiModels();
  }
});

it("serves a pi pane's native transcript over HTTP", async () => {
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  const first = await read();
  expect(first.source).toBe("pi-transcript");  expect(first.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(first.turns[0]!.parts).toEqual([{ kind: "text", text: "Check chat" }]);
  // the figure pi's own footer shows: input + output + both cache tiers
  // the figure pi's own footer shows: input + output + both cache tiers
  expect(first.metadata).toEqual({ model: "pi-contract-model", reasoning_effort: null, context: { used: 35, window: null } });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

it("offers a tool's own picture over the image endpoint", async () => {
  writeFileSync(transcript, page([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "open shot.png" } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
      role: "assistant", model: "pi-contract-model", provider: "test", stopReason: "toolUse", usage: { input: 4, output: 1 },
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }],
    } },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:03Z", message: {
      role: "toolResult", toolCallId: "call-1", toolName: "read",
      content: [{ type: "text", text: "read 1 image" }, { type: "image", mimeType: "image/png", data: PNG.toString("base64") }],
    } },
  ]));
  // the tests after this one read the session this file first held, so put it back
  try {
    const conversation = await read();
    const tool = conversation.turns.flatMap((turn) => turn.parts).find((part) => part.kind === "tool");
    expect(tool !== undefined && tool.kind === "tool" && tool.images).toEqual([{ media_type: "image/png", ref: "pi:call-1:0" }]);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?pane_id=${encodeURIComponent(paneId)}&ref=${encodeURIComponent("pi:call-1:0")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
    // a ref naming no image, and one that is no pi ref at all
      const miss = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?pane_id=${encodeURIComponent(paneId)}&ref=${encodeURIComponent("pi:call-9:0")}`);
      expect(miss.status).toBe(404);
  } finally {
    writeFileSync(transcript, turns("Check chat", "Answer one"));
  }
});

it("resolves pi's context window from the agent dir pi reads its models from", async () => {
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  expect((await read()).metadata?.context?.window).toBeNull();
  // the window is nowhere in the transcript: pi's own catalog is the only disk answer for it
  const agentDir = join(root, "agent-dir");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { test: { models: [{ id: "pi-contract-model", contextWindow: 200_000 }] } } }));
  const previous = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  try {
    // no pi process is identified here (the stand-in is not pi), and the session store is shared
    // (PI_CODING_AGENT_SESSION_DIR), not the one inside that agent dir: its catalogs are no pane's
    writeFileSync(transcript, turns("Check chat twice", "Answer two"));
    expect((await read()).metadata?.context).toEqual({ used: 35, window: null });
    // the store inside the bridge's own agent dir: the session was written by that profile
    const owner = dirname(sessionDir);
    writeFileSync(join(owner, "models.json"), JSON.stringify({ providers: { test: { models: [{ id: "pi-contract-model", contextWindow: 200_000 }] } } }));
    process.env["PI_CODING_AGENT_DIR"] = owner;
    // the window is read as the metadata is rebuilt, so a new answer carries it
    writeFileSync(transcript, turns("Check chat three times", "Answer three"));
    const withWindow = await read();
    expect(withWindow.metadata?.context).toEqual({ used: 35, window: 200_000 });
    rmSync(join(owner, "models.json"));
  } finally {
    if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previous;
    forgetPiModels();
    // the tests after this one read the session this file first held
    writeFileSync(transcript, turns("Check chat", "Answer one"));
  }
});

it("follows the pane to a new session file when /new or /resume replaces it", async () => {  const before = await read();
  const replacement = join(slug, "replacement.jsonl");
  writeFileSync(replacement, turns("New topic", "Answer from the new session"));
  // pi emits no history marker: the integration re-reports the path herdr holds.
  await reportSession(replacement);
  const after = await read();
  expect(after.source).toBe("pi-transcript");
  expect(after.history_id).not.toBe(before.history_id);
  expect(after.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(after.turns[0]!.parts).toEqual([{ kind: "text", text: "New topic" }]);
  // the previous conversation is gone: it lived in the abandoned file
  expect(JSON.stringify(after.turns)).not.toContain("Check chat");
});

it("shows the branch /tree leaves the leaf on, and invalidates the pages held before it", async () => {
  await reportSession(transcript); // /resume back to the session this pane began on
  const before = await read();
  expect(JSON.stringify(before.turns)).toContain("Answer one");
  // pi writes the new answer beside the old one, parented to the prompt, and moves the leaf
  const branched = [...turns("Check chat", "Answer one").trimEnd().split("\n")];
  const prompt = JSON.parse(branched[2]!);
  branched.push(JSON.stringify({
    type: "message", id: "a2", parentId: prompt.id, timestamp: new Date().toISOString(),
    message: { role: "assistant", model: "pi-contract-model", stopReason: "stop", content: [{ type: "text", text: "the retried answer" }] },
  }));
  writeFileSync(transcript, branched.join("\n") + "\n");
  const after = await read();
  expect(after.source).toBe("pi-transcript");
  expect(after.history_id).not.toBe(before.history_id); // same file, same size class: the tree moved
  expect(JSON.stringify(after.turns)).toContain("the retried answer");
  expect(JSON.stringify(after.turns)).not.toContain("Answer one");
});

it("counts the turns a /tree left behind, over HTTP", async () => {
  // shaped like a real file: a parentless model_change is where the first turns hang, and a
  // navigation re-hangs a new turn beside an abandoned one there, exactly as /tree leaves it
  writeFileSync(transcript, page([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "the question" } },
    { type: "message", id: "a-gone", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: { role: "assistant", content: "the abandoned answer" } },
    { type: "message", id: "u2", parentId: "m1", timestamp: "2026-09-30T00:00:03Z", message: { role: "user", content: "the retried question" } },
    { type: "message", id: "a-live", parentId: "u2", timestamp: "2026-09-30T00:00:04Z", message: { role: "assistant", content: "the answer in play" } },
  ]));
  const branched = await read();
  // pi moved its leaf and wrote nothing, so the page is built from the live branch alone; the
  // count is the only thing that can tell the reader the file holds more than this
  expect(JSON.stringify(branched.turns)).not.toContain("abandoned");
  expect(branched.abandoned).toEqual({ count: 2, branches: 1, summary: null });

  // answering /tree's "Summarize branch?" writes pi's own account of the abandoned path
  writeFileSync(transcript, page([
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "pi-contract-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "the question" } },
    { type: "message", id: "a-gone", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: { role: "assistant", content: "the abandoned answer" } },
    { type: "branch_summary", id: "bs", parentId: "m1", timestamp: "2026-09-30T00:00:03Z", fromId: "a-gone", summary: "Tried the first question; it failed." },
    { type: "message", id: "u2", parentId: "bs", timestamp: "2026-09-30T00:00:04Z", message: { role: "user", content: "the retried question" } },
    { type: "message", id: "a-live", parentId: "u2", timestamp: "2026-09-30T00:00:05Z", message: { role: "assistant", content: "the answer in play" } },
  ]));
  expect((await read()).abandoned?.summary).toBe("Tried the first question; it failed.");

  // a session no /tree touched answers zero, not absent: the client shows nothing at 0
  writeFileSync(transcript, turns("Check chat", "Answer one"));
  expect((await read()).abandoned).toEqual({ count: 0, branches: 0, summary: null });
});

it("answers a session pi has not written yet as an empty conversation, then follows the file it writes", async () => {
  const target = await createPiPane();
  const fresh = join(slug, "fresh.jsonl");
  await reportSession(fresh, target);
  expect(await read(target)).toMatchObject({ source: "pi-transcript", turns: [], cursor: null, history_id: "unwritten:fresh" });
  // a cursor from another conversation is refused, whichever way it points
  for (const cursor of ["before", "since", "from"]) {
    const stale = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(target)}&${cursor}=${encodeURIComponent("other:0")}`);
    expect(stale.status).toBe(409);
  }
  // at work on its first turn, pi has written nothing yet: the terminal shows the turn (a status
  // report carries the session too: one without it would drop the session herdr holds)
  await herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:pi", agent: "pi", state: "working", seq: nextSeq(), agent_session_path: fresh });
  try {
    expect(await read(target)).toEqual({ source: "scrollback", turns: [] });
    const stale = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(target)}&from=${encodeURIComponent("other:0")}`);
    expect(stale.status).toBe(409);
  } finally {
    await herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:pi", agent: "pi", state: "idle", seq: nextSeq(), agent_session_path: fresh });
  }
  writeFileSync(fresh, turns("First prompt", "First answer"));
  const written = await read(target);
  expect(written.source).toBe("pi-transcript");
  expect(written.history_id).not.toBe("unwritten:fresh");
  expect(written.turns[0]!.parts).toEqual([{ kind: "text", text: "First prompt" }]);
  // a transcript read and then removed is missing, not a conversation not begun
  rmSync(fresh);
  expect(await read(target)).toEqual({ source: "scrollback", turns: [] });
});

it("distinguishes unwritten sessions with the same filename in different folders", async () => {
  const target = await createPiPane();
  const first = join(slug, "shared-name.jsonl");
  const other = join(sessionDir, "other-project");
  mkdirSync(other);
  const fresh = join(other, "shared-name.jsonl");
  writeFileSync(first, turns("Earlier prompt", "Earlier answer"));
  await reportSession(first, target);
  expect((await read(target)).source).toBe("pi-transcript");
  await reportSession(fresh, target);
  expect(await read(target)).toMatchObject({ source: "pi-transcript", turns: [], history_id: "unwritten:shared-name" });
  writeFileSync(fresh, turns("Fresh prompt", "Fresh answer"));
  expect((await read(target)).turns[0]!.parts).toEqual([{ kind: "text", text: "Fresh prompt" }]);
  rmSync(fresh);
  expect(await read(target)).toEqual({ source: "scrollback", turns: [] });
  // Another spelling of the same directory must not make a removed transcript unwritten again.
  const alias = join(sessionDir, "alias-project");
  symlinkSync(other, alias, "dir");
  await reportSession(join(alias, "shared-name.jsonl"), target);
  expect(await read(target)).toEqual({ source: "scrollback", turns: [] });
});

it("falls back to the scrollback when the reported path leaves the store", async () => {
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, turns("Must not be read", "no"));
  await reportSession(outside);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ source: "scrollback", turns: [] });
});
