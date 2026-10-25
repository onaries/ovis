import { expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_COOKIE } from "./auth.ts";
import { DeviceStore } from "./devices.ts";
import { privateStateFs } from "./private-state.ts";
import { MachineRelay } from "./machine-relay.ts";
import type { MachineManager } from "./machines.ts";
import { startFakePushService } from "./push.fake.ts";
import { createServer } from "./index.ts";
import { workspaceCreate, workspaceClose } from "./herdr/client.ts";
import type { ServerMessage } from "../shared/protocol.ts";

const guard = { "x-herdr-machine": "1", "content-type": "application/json" };

/** Fails every flush of a private state file, before its rename, until restored. */
function failFileSync() {
  return spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
}

async function connect(url: string, cookie: string) {
  // Bun supports handshake headers; lib.dom's browser constructor does not list them.
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: { cookie: string } }) => WebSocket;
  const socket = new RuntimeSocket(url, { headers: { cookie } });
  const messages: ServerMessage[] = [];
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return { socket, messages, closed };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for websocket output");
    await Bun.sleep(20);
  }
}

it("keeps the gate closed, and a device paired in the install's other state dir signed in, on a fresh state dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-access-"));
  // an update from a fresh 0.4.14 install starts on the old dir, while the phone was paired in the new one
  const [active, sibling] = [join(root, "herdr-web-ui"), join(root, "ovis")];
  for (const dir of [active, sibling]) mkdirSync(dir);
  const token = "7".repeat(64);
  const created = "2026-10-25T05:20:00.000Z";
  writeFileSync(join(sibling, "devices.json"), JSON.stringify({ gate_closed_at: created, devices: [{ id: "0123456789abcdef", label: "Phone", role: "drive", token_hash: createHash("sha256").update(token).digest("hex"), created_at: created, last_seen_at: null }] }));
  writeFileSync(join(sibling, "preferences.json"), JSON.stringify({ revision: 1, settings: { language: "en", sidebarRows: "two" } }));
  const server = createServer({ port: 0, stateDir: active, siblingStateDir: sibling, tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  // a request through a proxy on this PC stands for one from another device
  const remote = { "x-forwarded-for": "100.64.0.9" };
  try {
    expect((await fetch(`${base}/api/preferences`, { headers: remote })).status).toBe(401);
    const anonymous = await (await fetch(`${base}/api/health`, { headers: remote })).json() as { auth: unknown };
    expect(anonymous.auth).toMatchObject({ required: true, authenticated: false });
    const cookie = `${DEVICE_COOKIE}=${token}`;
    const paired = await (await fetch(`${base}/api/health`, { headers: { ...remote, cookie } })).json() as { auth: unknown };
    expect(paired.auth).toMatchObject({ authenticated: true, via: "device" });
    const preferences = await fetch(`${base}/api/preferences`, { headers: { ...remote, cookie } });
    expect(await preferences.json()).toMatchObject({ settings: { language: "en", sidebarRows: "two" } });
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("serves the state dir it merged into, even when the merge gave the old dir files of its own", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-access-"));
  // the old name holds only the bridge registry; the phone is paired in the new dir
  const [legacy, next] = [join(root, "herdr-web-ui"), join(root, "ovis")];
  mkdirSync(join(legacy, "bridges"), { recursive: true });
  writeFileSync(join(legacy, "bridges", "local.json"), "{}");
  mkdirSync(next);
  const token = "8".repeat(64);
  const created = "2026-10-25T05:20:00.000Z";
  writeFileSync(join(next, "devices.json"), JSON.stringify({ gate_closed_at: created, devices: [{ id: "0123456789abcdef", label: "Phone", role: "drive", token_hash: createHash("sha256").update(token).digest("hex"), created_at: created, last_seen_at: null }] }));
  const env = { XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"], OVIS_STATE_DIR: process.env["OVIS_STATE_DIR"] };
  process.env["XDG_CONFIG_HOME"] = root;
  delete process.env["OVIS_STATE_DIR"];
  // the copy of the registry for the old dir fails; its merge record does not, and gives it files of its own
  const rename = privateStateFs.renameSync;
  const failing = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (to === join(legacy, "devices.json")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    rename(from, to);
  });
  let server: ReturnType<typeof createServer> | undefined;
  try {
    server = createServer({ port: 0, siblingStateDir: legacy, tailscaleOwner: null, machines: false });
    const base = `http://127.0.0.1:${server.port}`;
    const remote = { "x-forwarded-for": "100.64.0.9" };
    expect((await fetch(`${base}/api/preferences`, { headers: remote })).status).toBe(401);
    expect((await fetch(`${base}/api/preferences`, { headers: { ...remote, cookie: `${DEVICE_COOKIE}=${token}` } })).status).toBe(200);
  } finally {
    failing.mockRestore();
    server?.stop();
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

it("revocation closes an active device's terminal and roster stream without disconnecting another device", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-access-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-device-access", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-device-access" };
  const sockets: WebSocket[] = [];
  const abort = new AbortController();
  let workspaceId: string | undefined;
  try {
    const pair = async (label: string) => {
      const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
      const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code, label }) });
      expect(response.status).toBe(204);
      const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
      expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(200);
      return cookie;
    };
    const cookieA = await pair("A");
    const cookieB = await pair("B");
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string; label: string }[] };
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-device-revocation" });
    workspaceId = created.workspace.workspace_id;
    const paneId = created.root_pane.pane_id;
    const a = await connect(`${base.replace("http:", "ws:")}/ws`, cookieA); sockets.push(a.socket);
    const b = await connect(`${base.replace("http:", "ws:")}/ws`, cookieB); sockets.push(b.socket);
    for (const client of [a, b]) {
      client.socket.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 80, rows: 24 }));
      await until(() => client.messages.some((message) => message.type === "pty-data"));
    }
    const events = await fetch(`${base}/api/machines/events`, { headers: { cookie: cookieA }, signal: abort.signal });
    const reader = events.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const ended = (async () => { while (!(await reader.read()).done) {} })();
    expect((await fetch(`${base}/api/devices/${devices.find((device) => device.label === "A")!.id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await a.closed).code).toBe(1008);
    await ended;
    expect((await fetch(`${base}/api/session`, { headers: { cookie: cookieA } })).status).toBe(401);
    b.socket.send(JSON.stringify({ type: "role", mode: "observe" }));
    await until(() => b.messages.some((message) => message.type === "role-ack" && message.mode === "observe"));
    expect(b.socket.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`${base}/api/session`, { headers: { cookie: cookieB } })).status).toBe(200);
  } finally {
    abort.abort();
    for (const socket of sockets) socket.close();
    server.stop();
    if (workspaceId) await workspaceClose(workspaceId);
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

it("a corrupt device registry refuses strangers while keeping local recovery and the original file", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-recovery-"));
  const path = join(root, "devices.json");
  writeFileSync(path, "{broken registry");
  const server = createServer({ port: 0, stateDir: root, token: "", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${base}/api/session`, { headers: { "x-forwarded-for": "192.0.2.1" } })).status).toBe(401);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
    const response = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: guard });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "device_store_unavailable" } });
    expect(readFileSync(path, "utf8")).toBe("{broken registry");
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("keeps a forwarded first-pair gate open until a returned cookie is durably confirmed", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-first-pair-proxy-"));
  const options = { port: 0, stateDir: root, token: "", tailscaleOwner: null, machines: false } as const;
  let server = createServer(options);
  let base = `http://127.0.0.1:${server.port}`;
  const forwarded = { "x-forwarded-for": "198.51.100.24" };
  const start = async () => {
    const response = await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1", ...forwarded } });
    expect(response.status).toBe(200);
    return (await response.json() as { code: string }).code;
  };
  const issue = async (code: string) => {
    const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: { origin: base, "x-herdr-machine": "1", "content-type": "application/json", ...forwarded }, body: JSON.stringify({ code }) });
    expect(response.status).toBe(204);
    return response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const stranger = () => fetch(`${base}/api/devices`, { headers: forwarded });
  try {
    const droppedCookie = await issue(await start());
    expect((await stranger()).status).toBe(200);
    expect((await (await fetch(`${base}/api/devices`, { headers: forwarded })).json()).devices).toEqual([]);
    expect(() => readFileSync(join(root, "devices.json"), "utf8")).toThrow();

    // A lost cookie can be retried through the proxy; issuing another cookie still does
    // not close the gate until one of them returns in a later request.
    const retryCookie = await issue(await start());
    expect((await stranger()).status).toBe(200);
    expect(retryCookie).not.toBe(droppedCookie);
    server.stop();

    // No first-pair candidate or gate survives a restart before confirmation.
    server = createServer(options);
    base = `http://127.0.0.1:${server.port}`;
    expect((await stranger()).status).toBe(200);
    const confirmedCookie = await issue(await start());
    expect((await stranger()).status).toBe(200);
    const fsync = failFileSync();
    try {
      const failed = await fetch(`${base}/api/devices`, { headers: { ...forwarded, cookie: confirmedCookie } });
      expect(failed.status).toBe(500);
      expect(failed.headers.get("content-type")).toContain("application/json");
      expect(await failed.json()).toMatchObject({ error: { code: "internal_error" } });
      expect((await stranger()).status).toBe(200);
      expect(() => readFileSync(join(root, "devices.json"), "utf8")).toThrow();
    } finally { fsync.mockRestore(); }
    expect((await fetch(`${base}/api/devices`, { headers: { ...forwarded, cookie: confirmedCookie } })).status).toBe(200);
    expect((await stranger()).status).toBe(401);
    const registry = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { gate_closed_at: string | null; devices: unknown[] };
    expect(registry.gate_closed_at).not.toBeNull();
    expect(registry.devices).toHaveLength(1);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

it("watch credentials cannot mutate HTTP state, read credential files, or elevate local and relayed terminals", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-watch-access-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-watch", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${server.port}`;
  const cookie = `ovis_device=${watch.token}`;
  const headers = { ...guard, cookie };
  const sockets: WebSocket[] = [];
  const relays: MachineRelay[] = [];
  const manager = { endpoint: () => ({ url: base, token: "test-watch" }), trackTerminal: () => () => {} } as unknown as MachineManager;
  const proxy = Bun.serve<{ relay: MachineRelay }>({ port: 0, hostname: "127.0.0.1", async fetch(request, instance) {
    const relay = new MachineRelay(manager, "remote", true); relays.push(relay);
    await relay.ready;
    if (instance.upgrade(request, { data: { relay } })) return;
    relay.close(); return new Response(null, { status: 426 });
  }, websocket: { open(ws) { ws.data.relay.bind(ws); }, message(ws, raw) { ws.data.relay.message(raw); }, close(ws) { ws.data.relay.close(); } } });
  try {
    expect((await fetch(`${base}/api/session`, { headers })).status).toBe(200);
    for (const path of ["pane/input", "workspace/create", "tab/create", "tab/rename", "tab/close", "machines/setup", "updates/install", "herdr/update", "portal/start", "portal/stop"]) {
      expect((await fetch(`${base}/api/${path}`, { method: "POST", headers, body: "{}" })).status).toBe(403);
    }
    // the shared settings: a watching device reads them, and cannot change them for every browser
    expect((await fetch(`${base}/api/preferences`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ settings: { theme: "light" }, pins: [] }) })).status).toBe(403);
    // herdr's copy_on_select: a watching device selects text too, so it reads it (#1559)
    expect((await fetch(`${base}/api/herdr-ui`, { headers })).status).toBe(200);
    // what was read in the other browsers: a watching device sees it, and its own views stay its own
    expect((await fetch(`${base}/api/seen`, { headers })).status).toBe(200);
    const told = await fetch(`${base}/api/seen`, { method: "POST", headers, body: JSON.stringify({ pc: "local", epoch: "e", pane: "p", id: 1 }) });
    expect(told.status).toBe(403);
    expect(await told.json()).toMatchObject({ error: { code: "read_only" } });
    expect((await fetch(`${base}/api/fs/file?path=${encodeURIComponent(join(root, "devices.json"))}`, { headers })).status).toBe(403);
    // a PC's file is read without the origin check (#448, Android's Open button): the watch refusal still comes first, for GET and HEAD alike
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${base}/api/machines/pc1/fs/file?path=%2Fetc%2Fhostname`, { method, headers: { ...headers, "sec-fetch-site": "cross-site" } });
      expect(response.status).toBe(403);
      if (method === "GET") expect(await response.json()).toMatchObject({ error: { code: "read_only" } });
    }
    // a repository's changes are file contents: refused like a file read, on this PC and through a PC's route
    for (const path of ["workspace/diff/files", "workspace/diff/file", "workspace/diff/refs", "machines/pc1/workspace/diff/files", "machines/pc1/workspace/diff/file", "machines/pc1/workspace/diff/refs", "machines/local/workspace/diff/file"]) {
      const response = await fetch(`${base}/api/${path}?directory=${encodeURIComponent(root)}&path=devices.json`, { headers });
      expect([path, response.status]).toEqual([path, 403]);
      expect(await response.json()).toMatchObject({ error: { code: "read_only" } });
    }
    for (const path of ["api//workspace/diff/file", "api/workspace//diff/file", "api/machines/pc1//workspace/diff/file"]) {
      expect((await fetch(`${base}/${path}?directory=${encodeURIComponent(root)}&path=devices.json`, { headers })).status).toBe(404);
    }
    // an empty segment must not turn a file read into "some other route" (the PC proxy drops it)
    for (const path of ["api//fs/file", "api/machines/pc1//fs/file", "api/machines/pc1/fs//file"]) {
      expect((await fetch(`${base}/${path}?path=${encodeURIComponent(join(root, "devices.json"))}`, { headers })).status).toBe(404);
    }
    for (const origin of [base, `http://127.0.0.1:${proxy.port}`]) {
      const client = await connect(`${origin.replace("http:", "ws:")}/ws`, cookie); sockets.push(client.socket);
      client.socket.send(JSON.stringify({ type: "role", mode: "interact" }));
      await until(() => client.messages.some((m) => m.type === "role-ack" && m.mode === "observe"));
      for (const frame of [{ type: "input", text: "must not type" }, { type: "keys", keys: ["Enter"] }, { type: "resize", cols: 40, rows: 10 }]) {
        const before = client.messages.filter((m) => m.type === "error").length;
        client.socket.send(JSON.stringify({ ...frame, pane_id: "absent" }));
        await until(() => client.messages.filter((m) => m.type === "error").length > before);
        expect(client.messages.filter((m) => m.type === "error").at(-1)).toMatchObject({ code: "read_only" });
      }
      client.socket.send(JSON.stringify({ type: "submit", id: 1, pane_id: "absent", text: "no", payload: "no" }));
      await until(() => client.messages.some((m) => m.type === "submit-result"));
      expect(client.messages.find((m) => m.type === "submit-result")).toMatchObject({ ok: false, code: "read_only" });
    }
  } finally {
    for (const socket of sockets) socket.close();
    for (const relay of relays) relay.close();
    proxy.stop(true); server.stop(); rmSync(root, { recursive: true, force: true });
  }
});

it("a route spelled with a trailing, doubled or encoded slash is no route, for a watching and a driving device alike", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-route-spelling-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const drive = store.pair(store.startPairing().code, "Drive", "drive")!;
  store.match(drive.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-route-spelling", tailscaleOwner: null });
  const base = `http://127.0.0.1:${server.port}`;
  const query = "?workspace_id=w1&agent=pi";
  try {
    // the PC proxy drops empty segments before it forwards with the PC's own credential, so each
    // of these would reach the PC's history past the watch refusal if it were taken for a route
    const spellings = [
      "api/sessions/history/", "api/sessions//history", "api/sessions%2Fhistory", "api/sessions%2fhistory", "api/machines/local/sessions/history/",
      "api/machines/pc1/sessions/history/", "api/machines/pc1/sessions//history", "api/machines/pc1//sessions/history", "api/machines/pc1/sessions%2Fhistory",
      "api/machines/pc1/workspace/directories/", "api/machines/pc1/pane/commands/",
    ];
    for (const [label, token] of [["watch", watch.token], ["drive", drive.token]] as const) {
      const headers = { cookie: `ovis_device=${token}` };
      for (const path of spellings) {
        const response = await fetch(`${base}/${path}${query}`, { headers });
        expect([label, path, response.status]).toEqual([label, path, 404]);
      }
    }
    // the canonical spellings: refused to a watching device on this PC, its alias and another PC's route
    for (const path of ["api/sessions/history", "api/machines/local/sessions/history", "api/machines/pc1/sessions/history"]) {
      const response = await fetch(`${base}/${path}${query}`, { headers: { cookie: `ovis_device=${watch.token}` } });
      expect([path, response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([path, 403, "read_only"]);
    }
    // and answered for a driving one (no such workspace here; no such PC connected)
    const driving = { cookie: `ovis_device=${drive.token}` };
    const absent = await fetch(`${base}/api/sessions/history?workspace_id=ovis-test-absent&agent=pi`, { headers: driving });
    expect([absent.status, ((await absent.json()) as { error: { code: string } }).error.code]).toEqual([404, "workspace_not_found"]);
    expect((await fetch(`${base}/api/machines/pc1/sessions/history${query}`, { headers: driving })).status).toBe(503);
  } finally {
    server.stop(); rmSync(root, { recursive: true, force: true });
  }
});

it("revoking a paired device removes its persistent push subscription", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-push-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-push-owner", tailscaleOwner: null, machines: false, pushLoopbackHttp: true });
  const fake = await startFakePushService();
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-push-owner" };
  try {
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code }) });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    const registered = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, cookie }, body: JSON.stringify({ subscription: fake.subscription }) });
    expect(registered.status).toBe(204);
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string }[] };
    const id = devices[0]!.id;
    expect(JSON.parse(readFileSync(join(root, "push-subscriptions.json"), "utf8"))[0].device_id).toBe(id);
    expect((await fetch(`${base}/api/devices/${id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await fetch(`${base}/api/session`, { headers: { cookie } })).status).toBe(401);
    expect(JSON.parse(readFileSync(join(root, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: admin, body: JSON.stringify({ endpoint: fake.subscription.endpoint }) })).status).toBe(404);
  } finally { fake.stop(); server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("returns an error when revocation cannot be persisted, then allows a successful retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-device-write-"));
  const store = new DeviceStore(root);
  const paired = store.pair(store.startPairing().code, "Phone", "drive")!;
  store.match(paired.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-write", tailscaleOwner: null, machines: false });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const revoke = () => fetch(`${base}/api/devices/${paired.device.id}`, { method: "DELETE", headers: { ...guard, authorization: "Bearer test-write" } });
    const fsync = failFileSync();
    try {
      const failed = await revoke();
      expect(failed.status).toBe(500);
      expect(await failed.json()).toMatchObject({ error: { code: "internal_error" } });
      expect(new DeviceStore(root).match(paired.token)).not.toBeNull();
    } finally { fsync.mockRestore(); }
    expect((await revoke()).status).toBe(204);
    expect(new DeviceStore(root).match(paired.token)).toBeNull();
  } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
});
