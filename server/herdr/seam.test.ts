import { afterEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentGet, HerdrError, herdrRpc, LARGE_REPLY_BYTES, LINE_BYTES, makeLineReader, paneFocus, paneProcessInfo, paneRead, paneSwap, paneSwapWith, sessionSnapshot,
  subscribeEvents, type EventFrame,
} from "./client.ts";
import type { AgentInfo, PaneInfo, PaneLayoutRect, PaneLayoutSnapshot, SessionSnapshot, TabInfo, WorkspaceInfo } from "../../shared/herdr-api.generated.ts";
import { handlePaneRequest } from "../pane-routes.ts";

// The typed herdr seam (server/herdr/methods.ts). `bun run typecheck` checks the lines marked
// with ts-expect-error below: each must stay a compile error. They hold for a call without an explicit
// result type; `herdrRpc<Inline>(…)` still reaches the untyped fallback, which the files in
// HERDR_RPC_ALLOWED (server/conventions.test.ts) use until a follow-up PR moves them to the
// wrappers once their open PRs land, so outside server/herdr/ that guard, not the compiler,
// keeps server code off herdrRpc.
declare const either: boolean;
async function typeOnly(): Promise<void> {
  // @ts-expect-error pane.process_info takes pane_id: given target, herdr answers for the focused pane
  await herdrRpc("pane.process_info", { target: "pane-1" });
  // @ts-expect-error agent.get takes target
  await herdrRpc("agent.get", { pane_id: "pane-1" });
  // @ts-expect-error pane.send_text needs its text
  await herdrRpc("pane.send_text", { pane_id: "pane-1" });
  // @ts-expect-error a union of typed methods would take either method's params
  await herdrRpc(either ? ("pane.process_info" as const) : ("agent.get" as const), { target: "pane-1" });
  // Known holes: these still compile, because an explicit result type or a plain-string method
  // leaves the fallback's `M` at `string`. Splitting the fallback out under its own name (the
  // follow-up above) turns both into ts-expect-error lines.
  await herdrRpc<unknown>("pane.process_info", { target: "pane-1" });
  const widened: string = "pane.process_info";
  await herdrRpc(widened, { target: "pane-1" });
  const info = await herdrRpc("pane.process_info", { pane_id: "pane-1" });
  const shell: number | null | undefined = info.process_info?.shell_pid;
  const agent = await agentGet("pane-1");
  const kind: string | undefined = agent.agent_session?.kind;
  void shell; void kind;
}
void typeOnly;

// A stand-in herdr on a Unix socket. Each accepted connection gathers complete request lines (one
// read is not one request) and hands each to `answer`, which writes whatever bytes it chooses: a
// correlated reply, another request's id, a malformed envelope, a frame in pieces or an event
// stream. Every connection's close is observable from the moment it is accepted, before a byte is
// sent, and everything is torn down after each test.
interface Request { id: string; method: string; params: unknown }
interface Connection { socket: Socket; closed: Promise<void> }
type Answer = (request: Request, connection: Connection) => void;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function peer(answer: Answer) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-seam-"));
  const path = join(dir, "herdr.sock");
  const requests: Request[] = [];
  const connections: Connection[] = [];
  const open = new Set<Socket>();
  const server = createServer((socket) => {
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const connection = { socket, closed };
    connections.push(connection);
    open.add(socket);
    void closed.then(() => open.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (let index = buffer.indexOf("\n"); index !== -1; index = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, index)) as Request;
        buffer = buffer.slice(index + 1);
        requests.push(request);
        answer(request, connection);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  cleanups.push(async () => {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, requests, connections, open };
}

function standIn(result: unknown) {
  return peer((request, { socket }) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`));
}

/** The real RPC wrapper against a peer that models swap's focus side effect. */
async function swapPeer() {
  const state = {
    focus: "elsewhere", changed: true, failRestore: false, failSwap: false,
    onSwap: (_source: string, answer: () => void) => answer(),
    onSnapshot: (answer: () => void) => answer(),
  };
  const layout = fullSnapshot(1, 1, 1).layouts[0]!;
  const fixture = await peer((request, { socket }) => {
    const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    const error = () => socket.end(`${JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: "pane closed" } })}\n`);
    if (request.method === "session.snapshot") {
      const snapshot = { ...fullSnapshot(1, 1, 1), focused_pane_id: state.focus };
      state.onSnapshot(() => answer({ snapshot }));
    } else if (request.method === "pane.swap") {
      if (state.failSwap) { error(); return; }
      const params = request.params as { source_pane_id?: string; pane_id?: string };
      const source = (params.source_pane_id ?? params.pane_id)!;
      if (state.changed) state.focus = source;
      const swap = { changed: state.changed, reason: state.changed ? null : "same_pane",
        focused_pane_id: state.focus, layout, target_pane_id: "target" };
      state.onSwap(source, () => answer({ swap }));
    } else if (request.method === "pane.focus") {
      if (state.failRestore) { error(); return; }
      state.focus = (request.params as { pane_id: string }).pane_id;
      answer({ ok: true });
    } else throw new Error(`unexpected RPC ${request.method}`);
  });
  return { ...fixture, state };
}

it("serializes overlapping explicit swaps before the second snapshots temporary focus", async () => {
  const { path, state } = await swapPeer();
  const started = Promise.withResolvers<() => void>();
  state.onSwap = (source, answer) => source === "first" ? started.resolve(answer) : answer();
  const first = paneSwapWith("first", "target", path);
  const release = await within(started.promise, 5_000, "first swap");
  const connect = spyOn(Bun, "connect");
  const second = paneSwapWith("second", "target", path);
  try {
    // The first swap is unanswered; starting another must not even open its snapshot connection.
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
  } finally {
    connect.mockRestore();
    release();
    expect(await within(Promise.all([first, second]), 5_000, "both swaps")).toMatchObject([
      { changed: true, target_pane_id: "target" }, { changed: true, target_pane_id: "target" },
    ]);
  }
  expect(state.focus).toBe("elsewhere");
});

it("lets another herdr socket swap while the first socket is busy", async () => {
  const firstPeer = await swapPeer(), otherPeer = await swapPeer();
  const started = Promise.withResolvers<() => void>();
  firstPeer.state.onSwap = (_source, answer) => { started.resolve(answer); };
  const first = paneSwapWith("first", "target", firstPeer.path);
  const release = await within(started.promise, 5_000, "held swap");
  try {
    expect((await within(paneSwapWith("other", "target", otherPeer.path), 5_000, "other socket's swap")).changed).toBe(true);
    expect(otherPeer.state.focus).toBe("elsewhere");
  } finally {
    release();
    await first;
  }
});

it("does not restore focus after a refused swap or over a user focus change", async () => {
  for (const changed of [false, true]) {
    const { path, state, requests } = await swapPeer();
    state.changed = changed;
    state.onSwap = (_source, answer) => { state.focus = "user-choice"; answer(); };
    expect((await paneSwapWith("source", "target", path)).changed).toBe(changed);
    expect(state.focus).toBe("user-choice");
    expect(requests.filter((request) => request.method === "pane.focus")).toHaveLength(0);
  }
});

it("does not even recheck focus after a refused swap that leaves focus on the source", async () => {
  const { path, state, requests } = await swapPeer();
  state.changed = false;
  state.onSwap = (_source, answer) => { state.focus = "source"; answer(); };
  expect((await paneSwapWith("source", "target", path)).changed).toBe(false);
  expect(state.focus).toBe("source");
  expect(requests.map((request) => request.method)).toEqual(["session.snapshot", "pane.swap"]);
});

for (const directional of [false, true]) {
  it(`keeps a newer Ovis ${directional ? "directional swap" : "focus choice"} after the restore snapshot`, async () => {
    const { path, state } = await swapPeer();
    const checked = Promise.withResolvers<() => void>();
    let snapshots = 0;
    state.onSnapshot = (answer) => ++snapshots === 2 ? checked.resolve(answer) : answer();
    const swap = paneSwapWith("source", "target", path);
    const release = await within(checked.promise, 5_000, "restore snapshot");
    const connect = spyOn(Bun, "connect");
    const choice = directional ? paneSwap("user-choice", "right", path) : paneFocus("user-choice", path);
    try {
      await Promise.resolve();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      release();
      await within(Promise.all([swap, choice]), 5_000, "swap and user choice");
    }
    expect(state.focus).toBe("user-choice");
  });
}

it("returns the committed swap when its focus restore fails and keeps the queue usable", async () => {
  const { path, state } = await swapPeer();
  state.failRestore = true;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());
  const previousSocket = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  try {
    const url = new URL("http://localhost/api/pane/swap");
    const response = await handlePaneRequest(new Request(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "source", target_pane_id: "target" }),
    }), url, url.pathname, {});
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ ok: true, changed: true, reason: null, target_pane_id: "target" });
  } finally {
    if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previousSocket;
  }
  expect(warn).toHaveBeenCalled();
  state.failRestore = false;
  state.focus = "elsewhere";
  expect((await paneSwapWith("next", "target", path)).changed).toBe(true);
  expect(state.focus).toBe("elsewhere");
});

it("releases the swap queue after a native swap fails without restoring focus", async () => {
  const { path, state, requests } = await swapPeer();
  state.failSwap = true;
  expect((await rejection(paneSwapWith("source", "target", path))).code).toBe("pane_not_found");
  expect(requests.filter((request) => request.method === "pane.focus")).toHaveLength(0);
  state.failSwap = false;
  expect((await paneSwapWith("next", "target", path)).changed).toBe(true);
  expect(state.focus).toBe("elsewhere");
});

/** `promise`, or a rejection naming `what` once `ms` pass: an awaited event, never a fixed wait. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function rejection(promise: Promise<unknown>): Promise<HerdrError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  if (!(error instanceof HerdrError)) throw new Error(`expected a HerdrError, got ${String(error)}`);
  return error;
}

/** One JSON line of exactly `bytes` bytes before its newline: `build` gets the padding to place. */
function exactLine(bytes: number, build: (pad: string) => unknown): string {
  const empty = Buffer.byteLength(JSON.stringify(build("")));
  const line = JSON.stringify(build("a".repeat(bytes - empty)));
  expect(Buffer.byteLength(line)).toBe(bytes);
  return line;
}

/** The diagnostic lines herdrRpc writes, captured for one test and restored after it. */
function captureDiagnostics() {
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line) => { lines.push(String(line)); });
  cleanups.push(() => warn.mockRestore());
  return { lines, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

/** Every timer `run` starts, so a test can see each was cleared again. */
async function timersOf<T>(run: () => Promise<T>): Promise<{ value: T | HerdrError; open: number }> {
  const started = new Set<unknown>();
  const set = spyOn(globalThis, "setTimeout");
  const clear = spyOn(globalThis, "clearTimeout");
  try {
    const value = await run().catch((e: unknown) => { if (e instanceof HerdrError) return e; throw e; });
    for (const result of set.mock.results) started.add(result.value);
    for (const [handle] of clear.mock.calls) started.delete(handle);
    return { value, open: started.size };
  } finally {
    set.mockRestore();
    clear.mockRestore();
  }
}

/** A subscription's callbacks, each counted, with promises for the first of each. */
function subscriber(path: string, expectEvents = 0) {
  const events: EventFrame[] = [];
  const errors: Error[] = [];
  let closes = 0;
  let started = 0;
  const startedOnce = Promise.withResolvers<void>();
  const errored = Promise.withResolvers<void>();
  const closedOnce = Promise.withResolvers<void>();
  const allEvents = Promise.withResolvers<void>();
  if (expectEvents === 0) allEvents.resolve();
  const subscription = subscribeEvents([{ type: "pane.agent_status_changed" }], {
    onEvent: (frame) => { events.push(frame); if (events.length === expectEvents) allEvents.resolve(); },
    onStarted: () => { started++; startedOnce.resolve(); },
    onError: (error) => { errors.push(error); errored.resolve(); },
    onClose: () => { closes++; closedOnce.resolve(); },
  }, path);
  cleanups.push(() => subscription.close());
  return {
    subscription, events, errors, closes: () => closes, started: () => started,
    startedOnce: startedOnce.promise, errored: errored.promise, closedOnce: closedOnce.promise, allEvents: allEvents.promise,
  };
}

/**
 * A schema-complete session.snapshot (SessionSnapshot in shared/herdr-api.generated.ts) for a large
 * session: every required and optional field of each workspace, tab, layout, pane and agent is
 * filled, with multibyte and JSON-escaped text, so its size is a full snapshot's, not a sketch's.
 */
function fullSnapshot(workspaceCount: number, tabsPer: number, panesPer: number): SessionSnapshot {
  const rect = (n: number): PaneLayoutRect => ({ x: n * 12, y: n * 4, width: 120, height: 40 });
  const workspaces: WorkspaceInfo[] = [];
  const tabs: TabInfo[] = [];
  const layouts: PaneLayoutSnapshot[] = [];
  const panes: PaneInfo[] = [];
  const agents: AgentInfo[] = [];
  for (let w = 0; w < workspaceCount; w++) {
    const workspace_id = `ws-${w}`;
    workspaces.push({
      workspace_id, number: w + 1, label: `작업 공간 ${w} "main"`, focused: w === 0, active_tab_id: `${workspace_id}-tab-0`,
      agent_status: "working", pane_count: tabsPer * panesPer, tab_count: tabsPer, tokens: { model: "gpt-5", context: 0.42 },
      worktree: {
        checkout_path: `/home/user/.herdr/worktrees/project/feature-${w}`, is_linked_worktree: true,
        repo_key: "github.com/user/project", repo_name: "project", repo_root: "/home/user/projects/project",
      },
    });
    for (let t = 0; t < tabsPer; t++) {
      const tab_id = `${workspace_id}-tab-${t}`;
      tabs.push({ tab_id, workspace_id, number: t + 1, label: `탭 ${t}`, focused: t === 0, agent_status: "idle", pane_count: panesPer });
      const ids = Array.from({ length: panesPer }, (_, p) => `${tab_id}-pane-${p}`);
      layouts.push({
        workspace_id, tab_id, focused_pane_id: ids[0]!, zoomed: false, area: rect(0),
        panes: ids.map((pane_id, p) => ({ pane_id, focused: p === 0, rect: rect(p) })),
        splits: ids.slice(1).map((_, s) => ({ id: `${tab_id}-split-${s}`, direction: s % 2 ? "down" : "right", ratio: 0.5, rect: rect(s) })),
      });
      ids.forEach((pane_id, p) => {
        const common = {
          pane_id, workspace_id, tab_id, terminal_id: `term-${pane_id}`, focused: w + t + p === 0, revision: 1000 + p,
          agent: "codex", display_agent: "Codex", agent_status: "working",
          cwd: `/home/user/projects/한글-${p}`, foreground_cwd: `/home/user/projects/한글-${p}/src`,
          title: `codex — 작업 ${p}`, terminal_title: "codex — 작업 \"✓\"", terminal_title_stripped: "codex — 작업 \"✓\"",
          agent_session: { agent: "codex", kind: "path", source: "herdr:codex", value: `/home/user/.codex/sessions/2026/10/21/rollout-${pane_id}.jsonl` },
          state_labels: { phase: "editing" }, tokens: { input: 120_000, output: 8_000 },
        };
        panes.push({ ...common, label: `label ${p}`, restore_error: null, scroll: { offset_from_bottom: 0, max_offset_from_bottom: 1000, viewport_rows: 40 } });
        agents.push({ ...common, name: `codex-${p}`, completion_seq: 7, interactive_ready: true, launch_pending: false, screen_detection_skipped: false, state_change_seq: 12 });
      });
    }
  }
  return {
    version: "0.9.5", protocol: 1, focused_workspace_id: "ws-0", focused_tab_id: "ws-0-tab-0", focused_pane_id: "ws-0-tab-0-pane-0",
    workspaces, tabs, layouts, panes, agents,
  };
}

const ack = (id: string) => `${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`;
const event = (n: number, pad = "") => ({ event: "pane.agent_status_changed", data: { pane_id: `pane-${n}`, agent_status: "working", pad }, future_field: n });

it("asks pane.process_info by pane_id and answers its process_info", async () => {
  const process_info = { pane_id: "pane-1", shell_pid: 41, foreground_processes: [{ pid: 42, name: "codex", argv: ["codex"] }] };
  const { path, requests } = await standIn({ type: "pane_process_info", process_info });
  expect(await paneProcessInfo("pane-1", path)).toEqual(process_info);
  expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([{ method: "pane.process_info", params: { pane_id: "pane-1" } }]);
});

it("asks agent.get by target and answers its agent", async () => {
  const agent = { pane_id: "pane-1", agent_session: { agent: "pi", kind: "path", source: "herdr:pi", value: "/s.jsonl" } };
  const { path, requests } = await standIn({ type: "agent_info", agent });
  expect(await agentGet("pane-1", path)).toEqual(agent as never);
  expect(requests.map(({ method, params }) => ({ method, params }))).toEqual([{ method: "agent.get", params: { target: "pane-1" } }]);
});

it("accepts a matching result and compatible unknown fields", async () => {
  const replies = [
    { result: { ok: true, added_later: { nested: [1, 2] } }, envelope_extra: "kept apart" },
    { result: null },
  ];
  const { path, requests, connections } = await peer((request, { socket }) => {
    socket.end(`${JSON.stringify({ id: request.id, ...replies[requests.length - 1] })}\n`);
  });
  expect(await herdrRpc<unknown>("fixture.read", {}, path)).toEqual({ ok: true, added_later: { nested: [1, 2] } });
  expect(await herdrRpc("fixture.read", {}, path)).toBeNull();
  // one connection per call, each with its own request id
  expect(connections).toHaveLength(2);
  expect(new Set(requests.map((r) => r.id)).size).toBe(2);
});

it("rejects null and incoherent envelopes", async () => {
  const secret = "private-reply-text";
  const cases: [string, (id: string) => unknown][] = [
    ["not an object", () => null],
    ["not an object", () => [secret]],
    ["not an object", () => secret],
    ["neither result nor error", (id) => ({ id, note: secret })],
    ["both result and error", (id) => ({ id, result: { ok: true }, error: { code: "x", message: secret } })],
    ["malformed error", (id) => ({ id, error: secret })],
    ["malformed error", (id) => ({ id, error: null })],
    ["malformed error", (id) => ({ id, error: { code: 7, message: secret } })],
    ["malformed error", (id) => ({ id, error: { code: "x" } })],
  ];
  let reply: (id: string) => string = () => "";
  const { path, requests } = await peer((request, { socket }) => socket.end(reply(request.id)));
  for (const [reason, build] of cases) {
    reply = (id) => `${JSON.stringify(build(id))}\n`;
    const error = await rejection(herdrRpc("fixture.read", {}, path));
    const sent = Buffer.byteLength(reply(requests.at(-1)!.id)) - 1;
    expect([error.code, error.message]).toEqual(["bad_frame", `herdr sent an invalid reply to fixture.read (${reason}, ${sent} bytes)`]);
    expect(error.message).not.toContain(secret);
  }
  reply = () => `{"id": "truncated", "result": ${secret}\n`;
  const unparseable = await rejection(herdrRpc("fixture.read", {}, path));
  expect(unparseable.code).toBe("bad_frame");
  expect(unparseable.message).toBe(`herdr sent an invalid reply to fixture.read (unparseable frame, ${Buffer.byteLength(reply("")) - 1} bytes)`);
  // a well-formed herdr error is still herdr's own answer, code and message
  reply = (id) => `${JSON.stringify({ id, error: { code: "pane_not_found", message: "no such pane", detail: 1 } })}\n`;
  const refused = await rejection(herdrRpc("fixture.read", {}, path));
  expect([refused.code, refused.message]).toEqual(["pane_not_found", "no such pane"]);
});

it("rejects a mismatched reply id", async () => {
  let reply: (id: string) => string = () => "";
  const { path } = await peer((request, { socket }) => socket.end(reply(request.id)));
  // another request's answer, a numeric or missing id: none is this request's reply
  for (const id of ["br-someone-else", 7, null, undefined]) {
    reply = () => `${JSON.stringify({ id, result: { stolen: true } })}\n`;
    const error = await rejection(herdrRpc("fixture.read", {}, path));
    expect(error.code).toBe("bad_frame");
    expect(error.message).toContain("(reply to another request, ");
  }
  // two lines in one chunk: the foreign one first fails the call, the matching one after it is ignored
  reply = (id) => `${JSON.stringify({ id: `${id}-other`, result: { stolen: true } })}\n${JSON.stringify({ id, result: { ok: true } })}\n`;
  expect((await rejection(herdrRpc("fixture.read", {}, path))).message).toContain("reply to another request");
  // and the matching one first wins, the rest of the chunk ignored
  reply = (id) => `${JSON.stringify({ id, result: { ok: true } })}\n${JSON.stringify({ id: "br-x", result: { stolen: true } })}\nnull\n`;
  expect(await herdrRpc<unknown>("fixture.read", {}, path)).toEqual({ ok: true });
});

it("takes an error under the ids herdr 0.9.0 and 0.9.1 give it as herdr's own", async () => {
  // herdr 0.9.0 and 0.9.1 answer a request they cannot deserialize with an empty id, and refuse an
  // events.subscribe with `<id>:sub:<n>:probe`; 0.9.2 and later echo the request's id
  const diagnostics = captureDiagnostics();
  const unknown = { code: "invalid_request", message: "invalid request: unknown variant `pane.clear`" };
  const gone = { code: "pane_not_found", message: "pane pane-9 not found" };
  let reply: (id: string) => unknown = () => null;
  const { path } = await peer((request, { socket }) => socket.end(`${JSON.stringify(reply(request.id))}\n`));
  reply = () => ({ id: "", error: unknown });
  const invalid = await rejection(herdrRpc<unknown>("pane.clear", { pane_id: "pane-1" }, path));
  expect([invalid.code, invalid.message]).toEqual([unknown.code, unknown.message]);
  reply = (id) => ({ id: `${id}:sub:0:probe`, error: gone });
  const probe = await rejection(herdrRpc("fixture.read", {}, path));
  expect([probe.code, probe.message]).toEqual([gone.code, gone.message]);
  // herdr's errors, not transport failures
  expect(diagnostics.records()).toEqual([]);

  // only an error may carry those ids, and only this request's probe id
  const foreign: [string, (id: string) => unknown][] = [
    ["reply to another request", () => ({ id: "", result: { stolen: true } })],
    ["reply to another request", (id) => ({ id: `${id}:sub:0:probe`, result: { stolen: true } })],
    ["reply to another request", () => ({ id: "", result: null, error: unknown })],
    ["reply to another request", () => ({ id: "br-someone-else:sub:0:probe", error: gone })],
    ["reply to another request", (id) => ({ id: `${id}:probe`, error: gone })],
    ["malformed error", () => ({ id: "", error: { code: "invalid_request" } })],
  ];
  for (const [reason, build] of foreign) {
    reply = build;
    const error = await rejection(herdrRpc("fixture.read", {}, path));
    expect([error.code, error.message]).toEqual(["bad_frame", expect.stringContaining(`(${reason}, `)]);
  }

  // a subscription refused by herdr 0.9.0 or 0.9.1 reports herdr's error, as one from 0.9.2 does
  type Script = (id: string, socket: Socket) => void;
  let script: Script = () => {};
  const { path: streamPath } = await peer((request, { socket }) => script(request.id, socket));
  const refusals: [(id: string) => string, { code: string; message: string }][] = [[(id) => `${id}:sub:0:probe`, gone], [() => "", unknown]];
  for (const [replyId, error] of refusals) {
    script = (id, socket) => socket.end(`${JSON.stringify({ id: replyId(id), error })}\n`);
    const refused = subscriber(streamPath);
    await within(refused.closedOnce, 5_000, `closing after herdr's ${error.code}`);
    expect(refused.errors.map((e) => [(e as HerdrError).code, e.message])).toEqual([[error.code, error.message]]);
    expect([refused.started(), refused.closes()]).toEqual([0, 1]);
  }
  // and after the acknowledgement, an error under its probe id leaves the stream open
  script = (id, socket) => socket.write(`${ack(id)}${JSON.stringify({ id: `${id}:sub:1:probe`, error: gone })}\n${JSON.stringify(event(1))}\n`);
  const open = subscriber(streamPath, 1);
  await within(open.allEvents, 5_000, "the event after herdr's error");
  expect(open.errors.map((e) => [(e as HerdrError).code, e.message])).toEqual([[gone.code, gone.message]]);
  expect([open.started(), open.closes(), open.events]).toEqual([1, 0, [event(1)] as never]);
  // an acknowledgement still needs the subscribe's own id
  script = (_id, socket) => socket.write(ack(""));
  const unacknowledged = subscriber(streamPath);
  await within(unacknowledged.closedOnce, 5_000, "closing on an acknowledgement with an empty id");
  expect(unacknowledged.errors.map((e) => [(e as HerdrError).code, e.message])).toEqual([["bad_frame", expect.stringContaining("(reply to another request, ")]]);
  expect(unacknowledged.started()).toBe(0);
}, 30_000);

it("bounds bytes before a newline or UTF-8 decoding", async () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const read = (limit: number, chunks: Uint8Array[]) => {
    const lines: [string, number][] = [];
    const oversize: number[] = [];
    const push = makeLineReader(limit, (line, bytes) => lines.push([line, bytes]), (bytes) => oversize.push(bytes));
    const seen: number[] = [];
    for (const chunk of chunks) { push(chunk); seen.push(oversize.length); }
    return { lines, oversize, seen };
  };
  // exactly the limit passes; one byte more fails at the chunk that crosses it, with no newline yet
  expect(read(8, [encode("12345678\n")])).toEqual({ lines: [["12345678", 8]], oversize: [], seen: [0] });
  const over = read(8, [encode("1234"), encode("56789"), encode("more\n{\"after\":1}\n")]);
  expect(over).toEqual({ lines: [], oversize: [9], seen: [0, 1, 1] });
  // several frames in one chunk, and one frame across many chunks
  expect(read(64, [encode("{\"a\":1}\n{\"b\":2}\n\n{\"c\":3}\n")]).lines.map(([line]) => line)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  const whole = encode("{\"text\":\"split frame\"}\n");
  expect(read(64, [...whole].map((byte) => Uint8Array.of(byte))).lines).toEqual([['{"text":"split frame"}', whole.length - 1]]);
  // a multibyte character split between reads decodes whole; CRLF ends a line like LF
  const text = "{\"text\":\"한글 😀 ✓\"}";
  const bytes = encode(`${text}\r\n`);
  const cut = bytes.indexOf(0xf0) + 2; // inside the emoji's four bytes
  const split = read(64, [bytes.subarray(0, bytes.indexOf(0xed) + 1), bytes.subarray(bytes.indexOf(0xed) + 1, cut), bytes.subarray(cut)]);
  expect(split.lines).toEqual([[text, bytes.length - 1]]);
  expect(JSON.parse(split.lines[0]![0])).toEqual({ text: "한글 😀 ✓" });
  // the limit counts bytes, not characters: four three-byte characters are 12 bytes
  expect(read(11, [encode("한한한한\n")]).oversize).toEqual([12]);

  // through a real socket: an ordinary reply at exactly LINE_BYTES is answered, one byte more fails
  // the call before any newline arrives, without waiting for the timeout
  let reply: (id: string) => string = () => "";
  const { path, connections } = await peer((request, { socket }) => socket.write(reply(request.id)));
  reply = (id) => `${exactLine(LINE_BYTES, (pad) => ({ id, result: { text: `한 \u001b[1m✓ ${pad}` } }))}\n`;
  const answered = await herdrRpc<{ text: string }>("fixture.read", {}, path, 30_000);
  expect(answered.text.startsWith("한 \u001b[1m✓ a")).toBe(true);
  await within(connections[0]!.closed, 5_000, "closing the answered connection");
  reply = () => "x".repeat(LINE_BYTES + 1);
  const error = await rejection(herdrRpc("fixture.read", {}, path, 30_000));
  expect(error.code).toBe("bad_frame");
  expect(error.message).toMatch(new RegExp(`^herdr sent an invalid reply to fixture\\.read \\(over the ${LINE_BYTES}-byte line limit, \\d+ bytes\\)$`));
  expect(Number(error.message.match(/(\d+) bytes\)$/)![1])).toBeGreaterThan(LINE_BYTES);
  await within(connections[1]!.closed, 5_000, "closing the oversized connection");
}, 60_000);

it("delivers the rest of a read when a callback throws", async () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  // the chunk is split and its tail kept before any callback runs: every line is delivered, then
  // the first throw is rethrown
  const lines: string[] = [];
  const oversize: number[] = [];
  const push = makeLineReader(16, (line) => { lines.push(line); if (line.startsWith("throw")) throw new Error(line); }, (bytes) => oversize.push(bytes));
  expect(() => push(encode("throw 1\nthrow 2\nkept\n{\"d\""))).toThrow("throw 1");
  expect(lines).toEqual(["throw 1", "throw 2", "kept"]);
  push(encode(":1}\n"));
  expect(lines).toEqual(["throw 1", "throw 2", "kept", '{"d":1}']);
  // a line before an oversized one is delivered too, and the oversize still reported
  expect(() => push(encode(`throw 3\n${"x".repeat(17)}`))).toThrow("throw 3");
  expect([lines.at(-1), oversize]).toEqual(["throw 3", [17]]);

  // through a subscription: a subscriber that throws on the first of three events in one read
  // still gets the other two, and an event cut by the end of that read arrives whole with the next
  const { path, connections } = await peer((request, { socket }) => socket.write(ack(request.id)));
  const events: EventFrame[] = [];
  const started = Promise.withResolvers<void>();
  const three = Promise.withResolvers<void>();
  const four = Promise.withResolvers<void>();
  let closes = 0;
  const subscription = subscribeEvents([{ type: "pane.agent_status_changed" }], {
    onEvent: (frame) => {
      events.push(frame);
      if (events.length === 3) three.resolve();
      if (events.length === 4) four.resolve();
      if (events.length === 1) throw new Error("subscriber bug");
    },
    onStarted: () => started.resolve(),
    onClose: () => { closes++; },
  }, path);
  cleanups.push(() => subscription.close());
  await within(started.promise, 5_000, "subscription_started");
  const cut = JSON.stringify(event(4));
  connections[0]!.socket.write(`${[event(1), event(2), event(3)].map((frame) => `${JSON.stringify(frame)}\n`).join("")}${cut.slice(0, 20)}`);
  await within(three.promise, 5_000, "the two events after the throw");
  connections[0]!.socket.write(`${cut.slice(20)}\n`);
  await within(four.promise, 5_000, "the event cut by the read");
  expect([events, closes]).toEqual([[event(1), event(2), event(3), event(4)] as never, 0]);

  // a subscriber whose onError throws on a bad frame still sees the close, and the socket ends
  const { path: badPath, connections: bad } = await peer((request, { socket }) => socket.write(`${ack(request.id)}null\n`));
  const closed = Promise.withResolvers<void>();
  let badCloses = 0;
  const failing = subscribeEvents([{ type: "pane.agent_status_changed" }], {
    onEvent: () => {},
    onError: () => { throw new Error("subscriber bug"); },
    onClose: () => { badCloses++; closed.resolve(); },
  }, badPath);
  cleanups.push(() => failing.close());
  await within(closed.promise, 5_000, "onClose after a throwing onError");
  await within(bad[0]!.closed, 5_000, "the peer seeing the close");
  expect(badCloses).toBe(1);
}, 30_000);

it("accepts largest supported pane and snapshot replies", async () => {
  // escaped and multibyte text with ANSI colour, padded so each reply line is exactly the ceiling
  const screen = "\u001b[1;38;5;208m한글 ✓ 😀\u001b[0m \"quoted\" back\\slash\ttab\r\n";
  let reply: (request: Request) => string = () => "";
  const { path, connections, requests } = await peer((request, { socket }) => socket.end(`${reply(request)}\n`));

  reply = ({ id }) => exactLine(LARGE_REPLY_BYTES, (pad) => ({
    id, result: { type: "pane_read", read: { pane_id: "pane-1", workspace_id: "ws-1", tab_id: "tab-1", source: "recent", format: "ansi", text: `${screen.repeat(1000)}${pad}`, revision: 9, truncated: false, added_later: 1 } },
  }));
  const read = await paneRead({ paneId: "pane-1", source: "recent", format: "ansi", timeoutMs: 30_000 }, path);
  expect(read.text.startsWith(screen.repeat(1000))).toBe(true);
  expect(read.text.length).toBeGreaterThan(LINE_BYTES);
  expect((read as unknown as { added_later: number }).added_later).toBe(1);

  // pane.selection.read returns any range of the same history, so it has the same ceiling
  reply = ({ id }) => exactLine(LARGE_REPLY_BYTES, (pad) => ({ id, result: { type: "pane_selection", text: `${screen.repeat(1000)}${pad}` } }));
  const selection = await herdrRpc<{ text: string }>("pane.selection.read", { pane_id: "pane-1", anchor: { row: 0, col: 0 }, cursor: { row: 9, col: 0 } }, path, 30_000);
  expect(selection.text.startsWith(screen.repeat(1000))).toBe(true);
  expect(selection.text.length).toBeGreaterThan(LINE_BYTES);

  // The snapshot sizing evidence in client.ts: a schema-complete snapshot of 25 workspaces of 8 tabs
  // of 10 panes (2,000 panes, with every pane's agent and every tab's layout) is 3,598,115 bytes of
  // JSON. Its whole reply line before padding is that plus 58 bytes of envelope
  // ({"id":"","result":{"type":"session_snapshot","snapshot":}}), the id's bytes and the newline:
  // 3,598,174 + id bytes (3,598,188 for a 14-byte id), about 1,800 bytes a pane; twice that is under 8 MiB.
  const full = fullSnapshot(25, 8, 10);
  expect([full.workspaces.length, full.tabs.length, full.layouts.length, full.panes.length, full.agents.length]).toEqual([25, 200, 200, 2000, 2000]);
  expect(Buffer.byteLength(JSON.stringify(full))).toBe(3_598_115);
  let unpadded = 0;
  let idBytes = 0;
  reply = ({ id }) => {
    idBytes = Buffer.byteLength(id);
    unpadded = Buffer.byteLength(`${JSON.stringify({ id, result: { type: "session_snapshot", snapshot: full } })}\n`);
    // the same snapshot, padded through one extension field to exactly the ceiling
    return exactLine(LARGE_REPLY_BYTES, (pad) => ({ id, result: { type: "session_snapshot", snapshot: { ...full, added_later: pad } } }));
  };
  const snapshot = await sessionSnapshot(path, 30_000);
  expect(unpadded).toBe(3_598_115 + 58 + idBytes + 1);
  expect(unpadded).toBeLessThan(3_598_200);
  expect(2 * unpadded).toBeLessThan(8 * 1024 * 1024);
  expect(snapshot).toEqual({ ...full, added_later: expect.any(String) } as never);

  // the large ceiling is for those three methods only: the same 64 MiB answer to any other fails
  const ordinary = await rejection(herdrRpc("pane.get", { pane_id: "pane-1" }, path, 30_000));
  expect(ordinary.code).toBe("bad_frame");
  expect(ordinary.message).toContain(`over the ${LINE_BYTES}-byte line limit`);
  expect(connections).toHaveLength(4);
  expect(requests.map((r) => r.method)).toEqual(["pane.read", "pane.selection.read", "session.snapshot", "pane.get"]);
}, 120_000);

it("keeps subscriptions alive beyond the aggregate line cap", async () => {
  // 2,100 events of about 8 KiB each: far more than LINE_BYTES in total, every line small
  const count = 2100;
  const pad = "e".repeat(8 * 1024);
  const { path, connections } = await peer((request, { socket }) => {
    socket.write(ack(request.id));
    for (let n = 0; n < count; n += 50) socket.write(Array.from({ length: Math.min(50, count - n) }, (_, i) => `${JSON.stringify(event(n + i, pad))}\n`).join(""));
  });
  const s = subscriber(path, count);
  await within(s.startedOnce, 5_000, "subscription_started");
  await within(s.allEvents, 30_000, `${count} events`);
  const total = s.events.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame)) + 1, 0);
  expect(total).toBeGreaterThan(LINE_BYTES);
  expect(s.events[count - 1]).toEqual(event(count - 1, pad) as never);
  expect([s.errors, s.closes(), s.started()]).toEqual([[], 0, 1]);
  // an explicit close ends the socket without an onClose
  s.subscription.close();
  await within(connections[0]!.closed, 5_000, "closing the subscription socket");
  expect([s.errors, s.closes()]).toEqual([[], 0]);
}, 60_000);

it("validates subscription acknowledgement separately from events", async () => {
  type Script = (id: string, socket: Socket) => void;
  let script: Script = () => {};
  const { path, connections } = await peer((request, { socket }) => script(request.id, socket));

  // the acknowledgement must answer this subscribe's id; events after it carry none
  script = (id, socket) => socket.write(`${ack(id)}${JSON.stringify(event(1))}\n${JSON.stringify(event(2))}\n`);
  const good = subscriber(path, 2);
  await within(good.allEvents, 5_000, "two events");
  expect([good.started(), good.errors, good.events]).toEqual([1, [], [event(1), event(2)] as never]);
  good.subscription.close();
  await within(connections[0]!.closed, 5_000, "closing the good subscription");

  // a schema-valid event that also carries `error: null` is still an event, delivered unchanged
  const withError = {
    event: "pane_agent_status_changed",
    data: { type: "pane_agent_status_changed", workspace_id: "w1", pane_id: "p1", agent_status: "working" },
    error: null,
  };
  script = (id, socket) => socket.write(`${ack(id)}${JSON.stringify(withError)}\n`);
  const extended = subscriber(path, 1);
  await within(Promise.race([extended.allEvents, extended.errored]), 5_000, "the event with error: null");
  expect([extended.started(), extended.errors, extended.closes(), extended.events]).toEqual([1, [], 0, [withError] as never]);
  extended.subscription.close();
  await within(connections[1]!.closed, 5_000, "closing the extended-event subscription");

  // each bad acknowledgement: reported once, closed once, never started
  const badAcks: [string, Script][] = [
    ["reply to another request", (_id, socket) => socket.write(ack("br-someone-else"))],
    ["unexpected acknowledgement", (id, socket) => socket.write(`${JSON.stringify({ id, result: { type: "pane_info" } })}\n`)],
    ["not an object", (_id, socket) => socket.write("[1]\n")],
    ["reply to another request", (_id, socket) => socket.write(`${JSON.stringify(event(1))}\n`)],
  ];
  for (const [reason, bad] of badAcks) {
    script = bad;
    const s = subscriber(path);
    await within(s.closedOnce, 5_000, `closing on ${reason}`);
    await within(connections.at(-1)!.closed, 5_000, "the peer seeing the close");
    expect(s.errors.map((e) => [(e as HerdrError).code, e.message])).toEqual([["bad_frame", expect.stringContaining(`(${reason}, `)]]);
    expect([s.started(), s.closes(), s.events]).toEqual([0, 1, []]);
  }

  // a herdr error answering the subscribe is herdr's own, reported as before
  script = (id, socket) => socket.end(`${JSON.stringify({ id, error: { code: "invalid_request", message: "bad subscription" } })}\n`);
  const refused = subscriber(path);
  await within(refused.closedOnce, 5_000, "closing after herdr's error");
  expect(refused.errors.map((e) => [(e as HerdrError).code, e.message])).toEqual([["invalid_request", "bad subscription"]]);
  expect([refused.started(), refused.closes()]).toEqual([0, 1]);

  // after the acknowledgement, a malformed event or an oversized line closes the stream once
  const badEvents: [string, (id: string) => string][] = [
    ["malformed event", () => "null\n"],
    ["malformed event", () => "[1]\n"],
    ["malformed event", () => `${JSON.stringify({ event: "pane.agent_status_changed" })}\n`],
    ["malformed event", () => `${JSON.stringify({ event: 3, data: {} })}\n`],
    // a second acknowledgement is no event either
    ["malformed event", (id) => ack(id)],
    ["unparseable frame", () => "{\"event\":\n"],
    ["both result and error", (id) => `${JSON.stringify({ id, result: {}, error: { code: "x", message: "y" } })}\n`],
    // no newline at all, and a three-byte character on every byte boundary
    [`over the ${LINE_BYTES}-byte line limit`, () => "한".repeat(Math.ceil(LINE_BYTES / 3)) + "x"],
  ];
  for (const [reason, frame] of badEvents) {
    script = (id, socket) => socket.write(`${ack(id)}${JSON.stringify(event(1))}\n${frame(id)}`);
    const s = subscriber(path);
    await within(s.closedOnce, 30_000, `closing on ${reason}`);
    await within(connections.at(-1)!.closed, 5_000, "the peer seeing the close");
    expect(s.errors.map((e) => [(e as HerdrError).code, e.message])).toEqual([["bad_frame", expect.stringContaining(`(${reason}, `)]]);
    expect([s.started(), s.closes(), s.events]).toEqual([1, 1, [event(1)] as never]);
  }
}, 120_000);

it("closes protocol failures without daemon-death proof", async () => {
  const diagnostics = captureDiagnostics();
  let broken = true;
  const { path, connections } = await peer((request, { socket }) => {
    if (!broken) { socket.end(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`); return; }
    // two answers in one chunk, the first carrying another request's id; the socket stays open,
    // so only the client can close it
    socket.write(`${JSON.stringify({ id: "br-other", result: { secret: "private-reply-text" } })}\n${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
  });
  const failed = await timersOf(() => herdrRpc("fixture.read", {}, path, 10_000));
  expect(failed.value).toBeInstanceOf(HerdrError);
  const error = failed.value as HerdrError;
  // a protocol failure, not one of the codes that say herdr is unreachable
  expect(error.code).toBe("bad_frame");
  expect(["connect_failed", "socket_missing", "closed", "socket_error", "timeout"]).not.toContain(error.code);
  expect(failed.open).toBe(0);
  // the client closed that connection, once, and the peer is still listening
  await within(connections[0]!.closed, 5_000, "the client closing the bad connection");
  expect(diagnostics.records()).toEqual([expect.objectContaining({ event: "herdr.rpc.failed", code: "bad_frame", operation: "fixture.read", phase: "response", pending: 0 })]);
  expect(diagnostics.lines.join("\n")).not.toContain("private-reply-text");
  expect(diagnostics.lines.join("\n")).not.toContain(path);

  // the next call opens a fresh socket on the same peer and recovers
  broken = false;
  const recovered = await timersOf(() => herdrRpc("fixture.read", {}, path, 10_000));
  expect([recovered.value, recovered.open]).toEqual([{ ok: true }, 0]);
  expect(connections).toHaveLength(2);
  expect(diagnostics.records()[1]).toEqual(expect.objectContaining({ event: "herdr.rpc.recovered", operation: "fixture.read", pending: 0 }));

  // a subscription on a peer that breaks the protocol, then reopened on one that does not
  broken = true;
  const { path: streamPath, connections: streams } = await peer((request, { socket }) => {
    socket.write(broken ? `${ack(request.id)}{"event":\n` : `${ack(request.id)}${JSON.stringify(event(1))}\n`);
  });
  const bad = subscriber(streamPath);
  await within(bad.closedOnce, 5_000, "the subscription closing");
  await within(streams[0]!.closed, 5_000, "the peer seeing the subscription close");
  expect([bad.errors.map((e) => (e as HerdrError).code), bad.closes()]).toEqual([["bad_frame"], 1]);
  broken = false;
  const again = subscriber(streamPath, 1);
  await within(again.allEvents, 5_000, "an event on the reopened subscription");
  expect([again.errors, again.closes(), again.started()]).toEqual([[], 0, 1]);
  expect(streams).toHaveLength(2);
});
