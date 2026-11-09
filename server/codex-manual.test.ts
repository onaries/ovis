import { afterEach, beforeEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexManualState } from "../shared/codex-manual.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { CODEX_MANUAL_PATH, handleCodexManualRequest, manualCodexTranscript } from "./codex-manual.ts";
import { readCommandTranscript } from "./conversation.ts";

const SESSION = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc01";
const OTHER = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc02";
const NEW = "01a0c7a1-56d9-7e20-9f08-f7a2d973bc03";
let root: string, home: string, alias: string, path: string;
let previousSocket: string | undefined;
let listener: ReturnType<typeof Bun.listen>;
let panes: HerdrPane[];
let clients: ReturnType<typeof Bun.spawn>[];
let foregrounds: Map<string, { pid: number; argv: string[] }[]>;
let calls: string[];
let changed: string[];

async function client() {
  const child = Bun.spawn([process.execPath, "-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    cwd: root, env: { HOME: root, CODEX_HOME: alias }, stdout: "pipe", stderr: "ignore",
  });
  clients.push(child);
  const reader = child.stdout.getReader();
  expect((await reader.read()).done).toBe(false);
  reader.releaseLock();
  return child.pid;
}

function addThread(id: string, source = "cli", created = 1): string {
  const file = join(home, "sessions", "2026", "11", "07", `rollout-2026-11-07T00-00-00-${id}.jsonl`);
  writeFileSync(file, [
    { type: "session_meta", payload: { id, session_id: id, cwd: root, source, thread_source: "user", timestamp: "2026-11-07T00:00:00Z" } },
    { type: "event_msg", payload: { type: "user_message", message: `Fixture question ${id}` } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const db = new Database(join(home, "state_5.sqlite"));
  try { db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, ?, 1, ?)").run(id, file, root, created, source); }
  finally { db.close(); }
  return file;
}

function pane(paneId: string): HerdrPane {
  return { pane_id: paneId, terminal_id: `terminal-${paneId}`, workspace_id: "fixture-workspace", tab_id: "fixture-tab", agent: "codex",
    agent_status: "working", cwd: root, focused: false, revision: 0, terminal_title: "⠋ Working | Fixture project | Fixture thread" };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ovis-codex-manual-"));
  home = join(root, "store");
  alias = join(root, "codex-home");
  mkdirSync(join(home, "sessions", "2026", "11", "07"), { recursive: true });
  symlinkSync(home, alias);
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT)");
  db.close();
  path = addThread(SESSION);
  addThread(OTHER);
  clients = [];
  foregrounds = new Map([["fixture-pane", [{ pid: await client(), argv: ["codex"] }]]]);
  panes = [pane("fixture-pane")];
  calls = [];
  changed = [];
  previousSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = join(root, "herdr.sock");
  listener = Bun.listen<{ buffer: string }>({ unix: process.env["HERDR_SOCKET"], socket: {
    open(socket) { socket.data = { buffer: "" }; },
    data(socket, chunk) {
      socket.data.buffer += chunk.toString();
      if (!socket.data.buffer.includes("\n")) return;
      const request: { id: string; method: string; params?: { pane_id?: string; target?: string } } = JSON.parse(socket.data.buffer);
      calls.push(request.method);
      const id = request.params?.pane_id ?? request.params?.target;
      const selected = panes.find((entry) => entry.pane_id === id);
      const result = request.method === "session.snapshot" ? { snapshot: { panes, workspaces: [], tabs: [], layouts: [], agents: [] } }
        : request.method === "pane.get" ? { pane: selected }
        : request.method === "agent.get" ? { agent: selected }
        : request.method === "pane.process_info" ? { process_info: { pane_id: id, foreground_processes: (foregrounds.get(id ?? "") ?? []).map((entry) => ({ ...entry, name: "codex", cwd: root })) } }
        : request.method === "pane.read" ? { read: { text: "" } } : null;
      socket.end(`${JSON.stringify(result === null ? { id: request.id, error: { code: "fixture_forbidden_rpc", message: "Only reads are supported" } } : { id: request.id, result })}\n`);
    },
  } });
});

afterEach(async () => {
  listener?.stop(true);
  for (const child of clients ?? []) { if (child.exitCode === null) child.kill(); await child.exited; }
  if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = previousSocket;
  rmSync(root, { recursive: true, force: true });
});

function call(method = "GET", body?: unknown, readOnly = false, codexHome?: string) {
  const url = new URL(`http://fixture${CODEX_MANUAL_PATH}?pane_id=fixture-pane`);
  return handleCodexManualRequest(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url,
    { readOnly, codexHome, changed: (id) => changed.push(id) });
}

async function prepare(): Promise<CodexManualState> {
  const response = await call();
  expect(response.status).toBe(200);
  return response.json();
}

async function connect() {
  const state = await prepare();
  const response = await call("POST", { target: state.target, session_id: SESSION });
  expect(response.status).toBe(200);
  return state.target;
}

it("lists stored titles and first prompts when the rollout header has no message", async () => {
  const db = new Database(join(home, "state_5.sqlite"));
  try {
    db.exec("ALTER TABLE threads ADD COLUMN title TEXT; ALTER TABLE threads ADD COLUMN first_user_message TEXT");
    db.query("UPDATE threads SET title = ?, first_user_message = ? WHERE id = ?").run("  EW11 설치와 네트워크 설정  ", "설치가 멈춘 원인을 확인해 주세요", SESSION);
  } finally { db.close(); }
  writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: root, source: "cli", thread_source: "user", timestamp: "2026-11-07T00:00:00Z" } })}\n`);

  const state = await prepare();

  expect(state.sessions.find((row) => row.id === SESSION)).toMatchObject({ title: "EW11 설치와 네트워크 설정", firstMessage: "설치가 멈춘 원인을 확인해 주세요" });
  expect(state.sessions.map((row) => row.id).sort()).toEqual([SESSION, OTHER]);
});

it("keeps rollout labels when stored metadata belongs to another folder or has no title", async () => {
  const db = new Database(join(home, "state_5.sqlite"));
  try {
    db.exec("ALTER TABLE threads ADD COLUMN title TEXT");
    db.query("UPDATE threads SET title = ?, cwd = ? WHERE id = ?").run("Unrelated folder title", join(root, "other-folder"), SESSION);
    db.query("UPDATE threads SET title = ? WHERE id = ?").run("   ", OTHER);
  } finally { db.close(); }

  const state = await prepare();

  expect(state.sessions.map((row) => ({ id: row.id, title: row.title, firstMessage: row.firstMessage })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: SESSION, title: null, firstMessage: `Fixture question ${SESSION}` },
    { id: OTHER, title: null, firstMessage: `Fixture question ${OTHER}` },
  ]);
});

it("keeps listing rollout sessions when optional title metadata is unavailable", async () => {
  unlinkSync(join(home, "state_5.sqlite"));

  const state = await prepare();

  expect(state.sessions.map((row) => row.id).sort()).toEqual([SESSION, OTHER]);
});

it("lists the actual store and connects and disconnects only the displayed transcript", async () => {
  const initial = await prepare();
  expect([initial.cwd, initial.session_id, initial.sessions.map((row) => row.id).sort()]).toEqual([root, null, [SESSION, OTHER].sort()]);
  const response = await call("POST", { target: initial.target, session_id: SESSION });
  const connected: CodexManualState = await response.json();
  expect([response.status, connected.session_id, await manualCodexTranscript("fixture-pane", home)]).toEqual([200, SESSION, { path, sessionId: SESSION }]);
  const removed = await call("DELETE", { target: initial.target });
  const disconnected: CodexManualState = await removed.json();
  expect([removed.status, disconnected.session_id, await manualCodexTranscript("fixture-pane", home), changed]).toEqual([200, null, null, ["fixture-pane", "fixture-pane"]]);
  expect(calls.filter((method) => !["pane.get", "agent.get", "pane.process_info", "session.snapshot", "pane.read"].includes(method))).toEqual([]);
});

for (const mutation of ["terminal", "process"] as const) for (const method of ["POST", "DELETE"] as const) it(`rejects a stale ${mutation} target on ${method} and expires its binding`, async () => {
  const target = await connect();
  if (mutation === "terminal") panes = [{ ...pane("fixture-pane"), terminal_id: "replacement" }];
  if (mutation === "process") foregrounds.set("fixture-pane", [{ pid: await client(), argv: ["codex"] }]);
  const response = await call(method, { target, session_id: SESSION });
  expect([response.status, (await response.json()).error.code]).toEqual([409, "codex_manual_stale"]);
  expect(await manualCodexTranscript("fixture-pane", home)).toBeNull();
  expect(changed).toEqual(["fixture-pane"]);
});

it("rejects a different process birth without removing the confirmed binding", async () => {
  const target = await connect();
  const response = await call("DELETE", { target: { ...target, process_started_at: target.process_started_at + 1 } });
  expect([response.status, (await response.json()).error.code, changed]).toEqual([409, "codex_manual_stale", ["fixture-pane"]]);
  expect(await manualCodexTranscript("fixture-pane", alias)).toEqual({ path, sessionId: SESSION });
});

it("expires a binding when its process exits despite stale foreground metadata", async () => {
  await connect();
  const child = clients[0];
  if (child === undefined) throw new Error("fixture process missing");
  child.kill();
  await child.exited;
  expect(await manualCodexTranscript("fixture-pane", home)).toBeNull();
  const response = await call();
  expect([response.status, (await response.json()).error.code]).toEqual([409, "codex_manual_identity_unknown"]);
});

it("scopes a pane's selection to its Herdr socket", async () => {
  await connect();
  const socket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = join(root, "another.sock");
  expect(await manualCodexTranscript("fixture-pane", home)).toBeNull();
  process.env["HERDR_SOCKET"] = socket;
  expect(await manualCodexTranscript("fixture-pane", home)).toEqual({ path, sessionId: SESSION });
});

it("expires a binding when the same process's home resolves to a different store", async () => {
  await connect();
  const replacement = join(root, "other-store");
  mkdirSync(replacement);
  unlinkSync(alias);
  symlinkSync(replacement, alias);
  expect(await manualCodexTranscript("fixture-pane", replacement)).toBeNull();
  unlinkSync(alias);
  symlinkSync(home, alias);
  expect(await manualCodexTranscript("fixture-pane", home)).toBeNull();
});

it("ignores spinner and activity changes but releases a different native title or report", async () => {
  await connect();
  panes = [{ ...pane("fixture-pane"), terminal_title: "● Idle | Fixture project | Fixture thread" }];
  expect(await manualCodexTranscript("fixture-pane", home)).toEqual({ path, sessionId: SESSION });
  panes = [{ ...pane("fixture-pane"), terminal_title: `Working | ${OTHER}` }];
  expect(await manualCodexTranscript("fixture-pane", home)).toBeNull();
  panes = [pane("fixture-pane")];
  await connect();
  panes = [{ ...pane("fixture-pane"), agent_session: { agent: "codex", source: "fixture", kind: "id", value: OTHER } }];
  expect(await manualCodexTranscript("fixture-pane", home)).toBeNull();
});

it("releases the selection when native automatic resolution confirms another thread", async () => {
  await connect();
  const entry = foregrounds.get("fixture-pane")?.[0];
  expect(entry).toBeDefined();
  if (entry === undefined) throw new Error("fixture process missing");
  foregrounds.set("fixture-pane", [{ ...entry, argv: ["codex", "resume", OTHER] }]);
  expect(await manualCodexTranscript("fixture-pane", home)).toBeNull();
  foregrounds.set("fixture-pane", [entry]);
  expect(await manualCodexTranscript("fixture-pane", home)).toBeNull();
});

for (const source of ["cli", "vscode", "exec", "subagent"] as const) it(`treats a new ${source} thread according to interactive ownership`, async () => {
  await connect();
  addThread(NEW, source, Math.ceil(Date.now() / 1000) + 1);
  expect(await manualCodexTranscript("fixture-pane", home)).toEqual(source === "cli" || source === "vscode" ? null : { path, sessionId: SESSION });
});

it("refuses more recent interactive threads than it can safely compare", async () => {
  const target = (await prepare()).target;
  for (let index = 0; index < 65; index++) addThread(`01a0c7a1-56d9-7e20-9f08-${index.toString(16).padStart(12, "0")}`, "cli", Math.ceil(Date.now() / 1000));
  const response = await call("POST", { target, session_id: SESSION });
  expect([response.status, (await response.json()).error.code, changed]).toEqual([409, "codex_manual_busy", []]);
  expect(await manualCodexTranscript("fixture-pane", home)).toBeNull();
});

it("never treats manually selected history as native command outcome evidence", async () => {
  await connect();
  expect(await manualCodexTranscript("fixture-pane", home)).toEqual({ path, sessionId: SESSION });
  expect(await readCommandTranscript("fixture-pane", home)).toBeNull();
});

it("connects an interactive profile whose name is also a headless command", async () => {
  const entry = foregrounds.get("fixture-pane")?.[0];
  if (entry === undefined) throw new Error("fixture process missing");
  foregrounds.set("fixture-pane", [{ ...entry, argv: ["codex", "--profile", "review"] }]);
  await connect();
  expect(await manualCodexTranscript("fixture-pane", home)).toEqual({ path, sessionId: SESSION });
});

it("refuses a headless command even when it follows a valid profile option", async () => {
  const entry = foregrounds.get("fixture-pane")?.[0];
  if (entry === undefined) throw new Error("fixture process missing");
  foregrounds.set("fixture-pane", [{ ...entry, argv: ["codex", "--profile", "work", "review"] }]);
  const response = await call();
  expect([response.status, (await response.json()).error.code]).toEqual([409, "codex_manual_identity_unknown"]);
});

for (const owner of ["resume", "report", "manual", "profile-report"] as const) it(`refuses a session held by another pane's ${owner}`, async () => {
  const target = (await prepare()).target;
  const peer = pane("fixture-peer");
  panes.push(peer);
  foregrounds.set(peer.pane_id, [{ pid: await client(), argv: owner === "resume" ? ["codex", "resume", SESSION] : owner === "profile-report" ? ["codex", "--profile", "review"] : ["codex"] }]);
  if (owner === "report" || owner === "profile-report") peer.agent_session = { agent: "codex", source: "fixture", kind: "id", value: SESSION };
  if (owner === "manual") {
    const url = new URL(`http://fixture${CODEX_MANUAL_PATH}?pane_id=${peer.pane_id}`);
    const selected: CodexManualState = await (await handleCodexManualRequest(new Request(url), url, { readOnly: false })).json();
    const connected = await handleCodexManualRequest(new Request(url, { method: "POST", body: JSON.stringify({ target: selected.target, session_id: SESSION }) }), url, { readOnly: false });
    expect(connected.status).toBe(200);
  }
  const response = await call("POST", { target, session_id: SESSION });
  expect([response.status, (await response.json()).error.code, changed]).toEqual([409, "codex_manual_session_in_use", []]);
});

for (const id of [SESSION.slice(0, 8), `../${SESSION}`, `${SESSION}.jsonl`, "not-a-uuid"]) it(`refuses a malformed session identifier: ${id}`, async () => {
  const target = (await prepare()).target;
  const response = await call("POST", { target, session_id: id });
  expect([response.status, (await response.json()).error.code, changed]).toEqual([400, "invalid_session_id", []]);
});

for (const invalid of ["header", "child", "outside", "symlink", "missing", "row", "cwd"] as const) it(`refuses an invalid ${invalid} before connecting`, async () => {
  const target = (await prepare()).target;
  if (invalid === "header" || invalid === "child") writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: invalid === "header" ? OTHER : SESSION, parent_thread_id: invalid === "child" ? OTHER : undefined, cwd: root } }) + "\n");
  if (invalid === "missing") unlinkSync(path);
  const db = new Database(join(home, "state_5.sqlite"));
  try {
    if (invalid === "outside" || invalid === "symlink") {
      const outside = join(root, "outside.jsonl");
      writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: root } }) + "\n");
      if (invalid === "outside") db.query("UPDATE threads SET rollout_path = ? WHERE id = ?").run(outside, SESSION);
      else { unlinkSync(path); symlinkSync(outside, path); }
    }
    if (invalid === "row") db.query("DELETE FROM threads WHERE id = ?").run(SESSION);
    if (invalid === "cwd") db.query("UPDATE threads SET cwd = ? WHERE id = ?").run(join(root, "another-folder"), SESSION);
  } finally { db.close(); }
  const response = await call("POST", { target, session_id: SESSION });
  expect([response.status, (await response.json()).error.code, changed]).toEqual([400, "codex_manual_invalid_session", []]);
});

for (const method of ["GET", "POST", "DELETE", "PATCH"]) it(`denies watch ${method} before reading any pane or session`, async () => {
  const response = await call(method, undefined, true);
  expect([response.status, (await response.json()).error.code, calls, changed]).toEqual([403, "read_only", [], []]);
});

it("does not substitute a configured store for the actual process's home", async () => {
  const response = await call("GET", undefined, false, root);
  expect([response.status, (await response.json()).error.code]).toEqual([409, "codex_manual_store_unknown"]);
});

it("refuses a reported cwd that differs from the actual process's cwd", async () => {
  panes = [{ ...pane("fixture-pane"), foreground_cwd: home }];
  const response = await call();
  expect([response.status, (await response.json()).error.code]).toEqual([409, "codex_manual_store_unknown"]);
});
