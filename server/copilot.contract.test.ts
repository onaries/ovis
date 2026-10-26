import { afterAll, beforeAll, expect, it } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { forgetTranscriptState } from "./conversation.ts";

const id = "12aa83d8-48bc-41f2-a498-7055c5c44a01";
const other = "12aa83d8-48bc-41f2-a498-7055c5c44a02";
const root = mkdtempSync(join(tmpdir(), "herdr-copilot-contract-"));
const home = join(root, "custom-home");
const executable = join(root, "copilot.js");
const file = (session: string) => join(home, "session-state", session, "events.jsonl");
const event = (type: string, data: object) => JSON.stringify({ type, data, id: crypto.randomUUID(), timestamp: "2026-10-21T00:00:00Z", parentId: null }) + "\n";
const fixture = (session: string, content: string) =>
  event("session.start", { sessionId: session, copilotVersion: "1.0.102-1" })
  + event("user.message", { content, transformedContent: "not shown", parentAgentTaskId: "root-task-id" })
  + event("assistant.message", { content: "fixture response", phase: "final_answer", model: "fixture-model" });
let app: ReturnType<typeof createServer>;
let workspace: string;
let pane: string;

async function startFixture(pane: string, session: string, flags = "") {
  await herdrRpc("pane.send_text", { pane_id: pane, text: `COPILOT_HOME=${home} node ${executable} ${session}${flags ? ` ${flags}` : ""}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    if ((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent === "copilot") return;
    if (Date.now() > deadline) throw new Error(`isolated Copilot stand-in not detected in ${pane}`);
    await Bun.sleep(50);
  }
}

beforeAll(async () => {
  if (process.platform !== "linux") return;
  for (const session of [id, other]) mkdirSync(join(home, "session-state", session), { recursive: true });
  writeFileSync(executable, `import { openSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.COPILOT_HOME;
const hold = (id) => { const dir = join(home, "session-state", id); mkdirSync(dir, { recursive: true }); openSync(join(dir, \`inuse.\${process.pid}.hold\`), "w"); };
const lifecycle = process.argv.includes("--lifecycle");
const log = join(home, "logs", \`process-100-\${process.pid}.log\`);
let selected = process.argv[2];
mkdirSync(join(home, "logs"), { recursive: true });
openSync(log, "w");
if (lifecycle) {
  appendFileSync(log, new Date().toISOString() + " [INFO] Registering foreground session: " + selected + "\\n");
} else if (!process.argv.includes("--no-proof")) hold(selected);
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at; (at = buffer.indexOf("\\n")) !== -1;) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (line.startsWith(":hold ")) hold(line.slice(6));
    else if (line.startsWith(":switch ") && lifecycle) {
      const next = line.slice(8);
      appendFileSync(log, new Date().toISOString() + " [INFO] Unregistering foreground session: " + selected + "\\n");
      appendFileSync(log, new Date().toISOString() + " [INFO] Registering foreground session: " + next + "\\n");
      selected = next;
    }
    else if (line === ":unregister" && lifecycle) {
      appendFileSync(log, new Date().toISOString() + " [INFO] Unregistering foreground session: " + selected + "\\n");
    }
    else if (line.startsWith(":register ") && lifecycle) {
      selected = line.slice(10);
      appendFileSync(log, new Date().toISOString() + " [INFO] Registering foreground session: " + selected + "\\n");
    }
    else if (line === ":quit") process.exit(0);
    else appendFileSync(join(home, "input.txt"), line + "\\n");
  }
});
console.log("fixture ready");`);
  chmodSync(executable, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-api" });
  workspace = created.workspace.workspace_id;
  pane = created.root_pane.pane_id;
  await startFixture(pane, id);
  app = createServer({ hostname: "127.0.0.1", port: 0, token: "", stateDir: join(root, "state"), tailscaleOwner: null });
});

afterAll(async () => {
  app?.stop();
  if (workspace) await workspaceClose(workspace);
  forgetTranscriptState();
  rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== "linux")("binds only the reported UUID to the foreground process's home and rejects old cursors after a switch", async () => {
  const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`;
  const read = async () => (await fetch(url)).json() as Promise<{ source: string; turns: { parts: { kind?: string; text?: string; output_ref?: string }[] }[]; cursor?: string; history_id?: string }>;
  const external = await read();
  expect(external.source).toBe("copilot-transcript");
  expect(external.turns).toEqual([]);
  expect(external.history_id).toBe(`unwritten:${id}`);
  expect((await read()).history_id).toBe(external.history_id);
  expect((await fetch(`${url}&from=old-history`)).status).toBe(409);
  writeFileSync(file(id), fixture(id, "session A"));
  expect((await read()).source).toBe("scrollback");
  const report = async (session: string, seq: number, source = "herdr:copilot", paneId = pane) => {
    await herdrRpc("pane.report_agent_session", { pane_id: paneId, agent: "copilot", source, seq: Date.now() * 1000 + seq, agent_session_id: session });
  };
  await report(id, 1, "untrusted");
  expect((await read()).source).toBe("scrollback");
  await report(id, 2);
  const header = event("session.start", { sessionId: id });
  writeFileSync(file(id), header);
  expect((await read()).source).toBe("copilot-transcript");
  expect((await read()).turns).toEqual([]);
  for (const record of [
    event("user.message", { content: [{ type: "text", text: "unsupported prompt" }] }),
    event("assistant.message", { content: [{ type: "text", text: "unsupported answer" }] }),
    event("assistant.message", { toolRequests: ["unreadable request"] }),
    event("assistant.message", { content: "", toolRequests: { toolCallId: "call", name: "shell" } }),
    "malformed complete record\n",
  ]) {
    writeFileSync(file(id), header + record);
    expect((await read()).source).toBe("scrollback");
  }
  writeFileSync(file(id), fixture(id, "session A"));
  const first = await read();
  expect(first.source).toBe("copilot-transcript");
  expect(first.history_id).not.toBe(external.history_id);
  expect(first.turns[0]?.parts[0]?.text).toBe("session A");
  appendFileSync(file(id), event("assistant.message", { content: "Checking.", phase: "commentary",
    toolRequests: [{ toolCallId: "call-1", name: "shell", arguments: { command: "pwd" } }], model: "fixture-model" }));
  const toolUrl = (ref: string) => `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: pane, ref })}`;
  expect((await read()).turns.at(-1)?.parts.at(-1)).toMatchObject({ kind: "tool", output: "" });
  appendFileSync(file(id), event("tool.execution_start", { toolCallId: "call-1", toolName: "shell" })
    + event("tool.execution_complete", { toolCallId: "call-1", success: false, result: { content: "error ".repeat(900) } }));
  const completed = (await read()).turns.at(-1)?.parts.at(-1);
  if (completed?.kind !== "tool" || !completed.output_ref) throw new Error("fixture tool output ref missing");
  const completedRef = completed.output_ref;
  expect(completed).toMatchObject({ kind: "tool", error: true });
  expect(completedRef).toMatch(/^cp[0-9a-f]{16}\.call-1@[0-9a-z]+@[0-9a-z]+@[0-9a-f]{32}$/);
  expect((await fetch(toolUrl("call-1"))).status).toBe(404);
  expect((await fetch(toolUrl(completedRef.slice(0, completedRef.indexOf("@"))))).status).toBe(404);
  expect(await (await fetch(toolUrl(completedRef))).text()).toBe("error ".repeat(900));
  appendFileSync(file(id), event("session.resume", { selectedModel: "fixture-model" }) + event("user.message", { content: "appended" }));
  expect((await read()).history_id).toBe(first.history_id);
  expect((await read()).turns.at(-1)?.parts[0]?.text).toBe("appended");
  writeFileSync(file(other), fixture(other, "session B"));
  const second = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-peer" });
  try {
    const peer = second.root_pane.pane_id;
    await startFixture(peer, other);
    await report(other, 1, "herdr:copilot", peer);
    const peerUrl = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(peer)}`;
    expect((await (await fetch(peerUrl)).json()).turns[0].parts[0].text).toBe("session B");
    expect((await read()).turns[0]?.parts[0]?.text).toBe("session A");
    const duplicate = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-duplicate" });
    try {
      const claimant = duplicate.root_pane.pane_id;
      await startFixture(claimant, id);
      await report(id, 1, "herdr:copilot", claimant);
      expect((await read()).source).toBe("scrollback");
      const claimantUrl = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(claimant)}`;
      expect((await (await fetch(claimantUrl)).json()).source).toBe("scrollback");
      expect((await (await fetch(peerUrl)).json()).source).toBe("copilot-transcript");
    } finally { await workspaceClose(duplicate.workspace.workspace_id); }
    expect((await read()).source).toBe("copilot-transcript");
  } finally { await workspaceClose(second.workspace.workspace_id); }
  await herdrRpc("pane.send_text", { pane_id: pane, text: `:hold ${other}\n` });
  for (const deadline = Date.now() + 4000;;) {
    if ((await read()).source === "scrollback") break;
    if (Date.now() > deadline) throw new Error("ambiguous native holds did not disable chat");
    await Bun.sleep(50);
  }
  await report(other, 3);
  // Herdr 0.9.3 ignores a replacement Copilot ID. Its stale old ID must not
  // show that old session as if it belonged to the now-switched pane.
  expect((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent_session?.value).toBe(id);
  expect((await read()).source).toBe("scrollback");
  expect((await fetch(`${url}&from=${encodeURIComponent(first.cursor!)}`)).status).toBe(409);
  expect((await fetch(toolUrl(completedRef))).status).toBe(404);
  await herdrRpc("pane.send_text", { pane_id: pane, text: ":quit\n" });
  for (const deadline = Date.now() + 10_000;;) {
    if ((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent !== "copilot") break;
    if (Date.now() > deadline) throw new Error("isolated fixture did not exit");
    await Bun.sleep(50);
  }
  await startFixture(pane, other);
  await report(other, 4);
  expect((await read()).turns[0]?.parts[0]?.text).toBe("session B");
  expect((await fetch(`${url}&from=${encodeURIComponent(first.cursor!)}`)).status).toBe(409);
  writeFileSync(file(other), fixture(id, "wrong header"));
  expect((await read()).source).toBe("scrollback");
  rmSync(file(other));
  expect((await read()).source).toBe("scrollback");
  symlinkSync(file(id), file(other));
  expect((await read()).source).toBe("scrollback");
}, 20_000);

it.skipIf(process.platform !== "linux")("reads a resumed CLI without marker or report and follows foreground switches rather than stale reports", async () => {
  const resumed = "12aa83d8-48bc-41f2-a498-7055c5c44a03";
  const forked = "12aa83d8-48bc-41f2-a498-7055c5c44a04";
  for (const id of [resumed, forked]) {
    mkdirSync(join(home, "session-state", id), { recursive: true });
    writeFileSync(file(id), fixture(id, id) + Array.from({ length: 55 }, () => event("user.message", { content: id })).join("") + event("assistant.message", {
      toolRequests: [{ toolCallId: `call-${id}`, name: "shell", arguments: {} }],
    }) + event("tool.execution_complete", { toolCallId: `call-${id}`, result: { content: `output-${id} `.repeat(600) } }));
  }
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-lifecycle" });
  const current = created.root_pane.pane_id;
  try {
    await startFixture(current, resumed, `--resume=${resumed} --lifecycle`);
    const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(current)}`;
    const read = async () => (await fetch(url)).json() as Promise<{
      source: string; turns: { parts: { text?: string; output_ref?: string }[] }[]; cursor?: string; history_id?: string;
    }>;
    const initial = await read();
    expect(initial.source).toBe("copilot-transcript");
    expect(initial.turns[0]?.parts[0]?.text).toBe(resumed);
    expect(initial.history_id).not.toStartWith("unwritten:");
    const oldCursor = initial.cursor!;
    expect(oldCursor).toBeDefined();
    const oldRef = initial.turns.flatMap((turn) => turn.parts).find((part) => part.output_ref)?.output_ref;
    expect(oldRef).toBeDefined();
    expect((await fetch(`${url}&from=${encodeURIComponent(oldCursor)}`)).status).toBe(200);
    expect((await fetch(`${url}&before=${encodeURIComponent(oldCursor)}`)).status).toBe(200);
    const outputUrl = (ref: string) => `http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${new URLSearchParams({ pane_id: current, ref })}`;
    expect((await fetch(outputUrl(oldRef!))).status).toBe(200);
    const duplicate = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-log-peer" });
    try {
      const peer = duplicate.root_pane.pane_id;
      await startFixture(peer, resumed, `--resume=${resumed} --lifecycle`);
      expect((await read()).source).toBe("scrollback");
      const peerUrl = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(peer)}`;
      expect((await (await fetch(peerUrl)).json()).source).toBe("scrollback");
    } finally { await workspaceClose(duplicate.workspace.workspace_id); }
    expect((await read()).source).toBe("copilot-transcript");
    await herdrRpc("pane.report_agent_session", { pane_id: current, agent: "copilot", source: "herdr:copilot",
      seq: Date.now() * 1000, agent_session_id: resumed });
    await herdrRpc("pane.send_text", { pane_id: current, text: `:hold ${resumed}\n:hold ${forked}\n:switch ${forked}\n` });
    for (const deadline = Date.now() + 5000;;) {
      if ((await read()).turns[0]?.parts[0]?.text === forked) break;
      if (Date.now() > deadline) throw new Error("logged fork was not selected");
      await Bun.sleep(50);
    }
    expect((await fetch(`${url}&from=${encodeURIComponent(initial.cursor ?? initial.history_id!)}`)).status).toBe(409);
    const staleTool = new URLSearchParams({ pane_id: current, ref: `call-${resumed}` });
    expect((await fetch(`http://127.0.0.1:${app.port}/api/pane/conversation/tool-output?${staleTool}`)).status).toBe(404);
    await herdrRpc("pane.send_text", { pane_id: current, text: `:switch ${resumed}\n` });
    for (const deadline = Date.now() + 5000;;) {
      if ((await read()).turns[0]?.parts[0]?.text === resumed) break;
      if (Date.now() > deadline) throw new Error("switch-back was not selected");
      await Bun.sleep(50);
    }
    const returned = await read();
    expect(returned.history_id).not.toBe(initial.history_id);
    expect((await fetch(`${url}&from=${encodeURIComponent(oldCursor)}`)).status).toBe(409);
    expect((await fetch(`${url}&before=${encodeURIComponent(oldCursor)}`)).status).toBe(409);
    expect((await fetch(outputUrl(oldRef!))).status).toBe(404);
    const newRef = returned.turns.flatMap((turn) => turn.parts).find((part) => part.output_ref)?.output_ref;
    expect(newRef).toBeDefined();
    expect(newRef).not.toBe(oldRef);
    expect((await fetch(outputUrl(newRef!))).status).toBe(200);
    expect((await fetch(`${url}&before=${encodeURIComponent(returned.cursor!)}`)).status).toBe(200);
    await herdrRpc("pane.send_text", { pane_id: current, text: `:switch ${forked}\n:switch ${resumed}\n` });
    let unobserved = await read();
    for (const deadline = Date.now() + 5000; unobserved.history_id === returned.history_id;) {
      if (Date.now() > deadline) throw new Error("unobserved switch-back did not advance binding");
      await Bun.sleep(50);
      unobserved = await read();
    }
    expect(unobserved.turns[0]?.parts[0]?.text).toBe(resumed);
    expect((await fetch(`${url}&before=${encodeURIComponent(returned.cursor!)}`)).status).toBe(409);
    expect((await fetch(outputUrl(newRef!))).status).toBe(404);
    await herdrRpc("pane.send_text", { pane_id: current, text: ":unregister\n" });
    for (const deadline = Date.now() + 5000;;) {
      if ((await read()).source === "scrollback") break;
      if (Date.now() > deadline) throw new Error("unregistered foreground did not fail closed");
      await Bun.sleep(50);
    }
    expect((await fetch(`${url}&from=${encodeURIComponent(unobserved.cursor!)}`)).status).toBe(409);
    const latestRef = unobserved.turns.flatMap((turn) => turn.parts).find((part) => part.output_ref)?.output_ref;
    expect(latestRef).toBeDefined();
    expect((await fetch(outputUrl(latestRef!))).status).toBe(404);
    await herdrRpc("pane.send_text", { pane_id: current, text: `:register ${forked}\n` });
    for (const deadline = Date.now() + 5000;;) {
      if ((await read()).turns[0]?.parts[0]?.text === forked) break;
      if (Date.now() > deadline) throw new Error("new registration was not selected after unregistration");
      await Bun.sleep(50);
    }
  } finally {
    await workspaceClose(created.workspace.workspace_id);
  }
}, 15_000);

it.skipIf(process.platform !== "linux")("never mistakes an explicitly resumed launch without current evidence for a fresh empty chat", async () => {
  const resumed = "12aa83d8-48bc-41f2-a498-7055c5c44a05";
  mkdirSync(join(home, "session-state", resumed), { recursive: true });
  writeFileSync(file(resumed), fixture(resumed, "existing history"));
  const created = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-copilot-no-proof" });
  const current = created.root_pane.pane_id;
  try {
    await startFixture(current, resumed, `--resume=${resumed} --no-proof`);
    const url = `http://127.0.0.1:${app.port}/api/pane/conversation?pane_id=${encodeURIComponent(current)}`;
    expect((await (await fetch(url)).json()).source).toBe("scrollback");
    expect((await fetch(`${url}&from=stale`)).status).toBe(409);
  } finally {
    await workspaceClose(created.workspace.workspace_id);
  }
});
