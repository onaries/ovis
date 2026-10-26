import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { ConversationResponse, InteractivePrompt } from "../shared/protocol.ts";

// omp names its session file when it starts and writes it with the first message (seen on a
// fresh omp pane: herdr held the path, the file was not there). A fake omp stands in.
const root = mkdtempSync(join(tmpdir(), "ovis-omp-contract-"));
const slug = join(root, ".omp", "agent", "sessions", "-omp-contract");
const fresh = join(slug, "2026-10-06T00-00-00-000Z_omp-fresh.jsonl");
const originalHome = process.env["HOME"];
let workspaceId: string | undefined;
let paneId: string;
let handoffPaneId: string;
// omp 18.8.7's /handoff as recorded (server/fixtures/omp-handoff-18.8.7-*): a stand-in draws the
// "Generating handoff" status and, on Esc, the cancelled screen, then notes the key it got.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/omp-handoff-18.8.7-${name}`, import.meta.url), "utf8");
const recorded = fixture("session.jsonl").split("\n").filter(Boolean);
const compaction = recorded.find((line) => JSON.parse(line).type === "compaction")!;
const handoffSession = join(slug, "2026-10-20T09-51-33-687Z_omp-handoff.jsonl");
const handoffMarker = join(root, "handoff-keys");
const HANDOFF = `
const { readFileSync, writeFileSync } = require("node:fs");
const [generating, cancelled, marker] = process.argv.slice(2);
const draw = (file) => process.stdout.write("\\x1b[2J\\x1b[H" + readFileSync(file, "utf8").replace(/\\n$/, "").split("\\n").join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  if (!data.includes(0x1b)) return;
  draw(cancelled);
  writeFileSync(marker, JSON.stringify([...data]));
});
draw(generating);
`;
let server: ReturnType<typeof createServer>;
let seq = Date.now() * 1000;

beforeAll(async () => {
  mkdirSync(slug, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const fakeOmp = join(bin, "omp");
  writeFileSync(fakeOmp, "#!/bin/sh\nsleep 600\n");
  chmodSync(fakeOmp, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-omp-contract" });
  workspaceId = created.workspace.workspace_id;
  paneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `${fakeOmp}\n` });
  for (let attempt = 0; attempt < 100; attempt++) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if (pane?.agent === "omp") break;
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "herdr:omp", agent: "omp", state: "idle", seq: ++seq });
  await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:omp", agent: "omp", seq: ++seq, agent_session_path: fresh, session_start_source: "startup" });
  // omp writes the pane's cwd into its session header
  writeFileSync(handoffSession, recorded.filter((line) => line !== compaction)
    .map((line) => JSON.parse(line).type === "session" ? JSON.stringify({ ...JSON.parse(line), cwd: root }) : line).join("\n") + "\n");
  writeFileSync(join(root, "handoff.js"), HANDOFF);
  const handoffBin = join(root, "handoff-bin");
  mkdirSync(handoffBin, { recursive: true });
  copyFileSync(process.execPath, join(handoffBin, "omp"));
  chmodSync(join(handoffBin, "omp"), 0o755);
  const split = await herdrRpc<{ pane: { pane_id: string } }>("pane.split", { target_pane_id: paneId, direction: "down", focus: false });
  handoffPaneId = split.pane.pane_id;
  const screens = ["generating-narrow.txt", "cancelled-narrow.txt"].map((name) => fileURLToPath(new URL(`./fixtures/omp-handoff-18.8.7-${name}`, import.meta.url)));
  // omp keeps its sessions under its own home, which the bridge reads from the process
  await herdrRpc("pane.send_text", { pane_id: handoffPaneId, text: `HOME='${root}' exec '${join(handoffBin, "omp")}' '${join(root, "handoff.js")}' '${screens[0]}' '${screens[1]}' '${handoffMarker}'\n` });
  for (const deadline = Date.now() + 5_000; (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === handoffPaneId)?.agent !== "omp";) {
    if (Date.now() > deadline) throw new Error("the stand-in omp did not start in the handoff pane");
    await Bun.sleep(50);
  }
  await herdrRpc("pane.report_agent", { pane_id: handoffPaneId, source: "herdr:omp", agent: "omp", state: "idle", seq: ++seq });
  await herdrRpc("pane.report_agent_session", { pane_id: handoffPaneId, source: "herdr:omp", agent: "omp", seq: ++seq, agent_session_path: handoffSession, session_start_source: "startup" });
  process.env["HOME"] = root;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
});

afterAll(async () => {
  server?.stop();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (workspaceId) await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
});

const read = async (pane = paneId): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

it("answers a session omp has not written yet as an empty conversation, then follows the file it writes", async () => {
  expect(await read()).toMatchObject({ source: "omp-transcript", turns: [], cursor: null, history_id: "unwritten:2026-10-06T00-00-00-000Z_omp-fresh" });
  writeFileSync(fresh, [
    { type: "session", version: 3, id: "omp-fresh", timestamp: new Date().toISOString(), cwd: root },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-06T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "First prompt" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-06T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "First answer" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const written = await read();
  expect(written.source).toBe("omp-transcript");
  expect(written.history_id).not.toBe("unwritten:2026-10-06T00-00-00-000Z_omp-fresh");
  expect(written.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
});

/** The pane's card once `wanted` holds for it, within a deadline. */
async function promptWhen(wanted: (prompt: InteractivePrompt | null) => boolean): Promise<InteractivePrompt | null> {
  let last: InteractivePrompt | null = null;
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(50)) {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(handoffPaneId)}`);
    expect(response.status).toBe(200);
    last = (await response.json() as { prompt: InteractivePrompt | null }).prompt;
    if (wanted(last)) return last;
  }
  throw new Error(`the handoff pane's card did not settle: ${JSON.stringify(last)}`);
}

it("cancels omp's /handoff from its card, and keeps the same conversation when a handoff compacts it in place", async () => {
  const original = readFileSync(handoffSession, "utf8");
  const before = await read(handoffPaneId);
  expect(before.source).toBe("omp-transcript");
  expect(before.turns.filter((turn) => turn.role === "user")).toHaveLength(2);

  const card = await promptWhen((prompt) => prompt !== null);
  expect(card).toMatchObject({ agent: "omp", question: "Generating handoff…", options: [{ label: "Cancel", description: null }] });
  const answered = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pane_id: handoffPaneId, prompt_id: card!.id, option_index: 0 }),
  });
  expect(answered.status).toBe(200);
  for (const deadline = Date.now() + 10_000; !existsSync(handoffMarker); await Bun.sleep(50)) {
    if (Date.now() > deadline) throw new Error("the stand-in omp got no key");
  }
  expect(JSON.parse(readFileSync(handoffMarker, "utf8"))).toEqual([0x1b]);
  expect(await promptWhen((prompt) => prompt === null)).toBeNull();
  // cancelled: omp left the session as it was, and the chat on the same conversation
  expect(readFileSync(handoffSession, "utf8")).toBe(original);
  expect((await read(handoffPaneId)).history_id).toBe(before.history_id);

  // a finished handoff appends its compaction entry to the same session file
  appendFileSync(handoffSession, compaction + "\n");
  const after = await read(handoffPaneId);
  expect(after.history_id).toBe(before.history_id);
  expect(after.turns.slice(0, before.turns.length)).toEqual(before.turns);
});

// omp 18.8.7's pictures as recorded (server/fixtures/omp-pictures-18.8.7-*): the bytes sit in the blob
// store beside the session store, the transcript holds `blob:sha256:<digest>`
it("serves an omp session's prompt and tool pictures, named by ref, from omp's blob store", async () => {
  const blob = readFileSync(new URL("./fixtures/omp-pictures-18.8.7-blob.webp", import.meta.url));
  const blobs = join(root, ".omp", "agent", "blobs");
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, createHash("sha256").update(blob).digest("hex")), blob);
  writeFileSync(fresh, readFileSync(new URL("./fixtures/omp-pictures-18.8.7-session.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line).type === "session" ? JSON.stringify({ ...JSON.parse(line), cwd: root }) : line).join("\n") + "\n");
  const refs = (await read()).turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "image" ? [part.ref] : part.kind === "tool" ? (part.images ?? []).map((image) => image.ref) : []));
  expect(refs).toEqual(["pi-prompt:d4a9dbba:0", expect.stringMatching(/^pi:call_[0-9a-f]+\|fc_[0-9a-f]+:0$/), "pi-prompt:faaa5772:0"]);
  const image = (ref: string) => fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref })}`);
  for (const ref of refs) {
    const response = await image(ref);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(Buffer.from(await response.arrayBuffer()).equals(blob)).toBe(true);
  }
  // a ref the conversation does not name, and one past the shape the endpoint takes
  expect((await image("pi-prompt:d4a9dbba:1")).status).toBe(404);
  expect((await image("pi:../blobs:0")).status).toBe(404);
});
