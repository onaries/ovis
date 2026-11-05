import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest, type ServerContext } from "./dispatch.ts";
import * as herdr from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { PortalService } from "./portal.ts";
import { MachineManager } from "./machines.ts";
import type { MachineRelay } from "./machine-relay.ts";

for (const [path, status, expectedTimeouts] of [["/api/health", 200, [60]], ["/api/nope", 404, [60]]] as const) {
  it(`dispatches GET ${path} with a fake socket context`, async () => {
    // Given: isolated server services and a transport that never uses a Bun request socket.
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-"));
    const ping = spyOn(herdr, "ping").mockResolvedValue({ version: "fixture", protocol: 22, terminal_attach: false, terminal_mirror: true });
    let app: ReturnType<typeof createServer> | undefined;
    try {
      app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
      const request = new Request(`http://127.0.0.1:${app.port}${path}`, { headers: { host: `127.0.0.1:${app.port}` } });
      const timeouts: Array<{ request: Request; seconds: number }> = [];
      const ctx: ServerContext = {
        ...app.context,
        requestIP: () => ({ address: "127.0.0.1" }),
        timeout: (request, seconds) => { timeouts.push({ request, seconds }); },
        upgrade: () => { throw new Error("Unexpected WebSocket upgrade"); },
      };
      // When
      const response = await handleRequest(request, ctx);
      // Then
      expect(response?.status).toBe(status);
      expect(timeouts).toEqual(expectedTimeouts.map((seconds) => ({ request, seconds })));
      expect(response?.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      app?.stop();
      ping.mockRestore();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
}

it("uses only the relay principal, even with valid driving cookies, bridge tokens and Portal proof", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-relay-"));
  const portal = new PortalService({ stateDir });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, portal, token: "shared-token", bridgeToken: "bridge-token", tailscaleOwner: null, machines: false, sidecar: false });
  const store = app.context.services.devices;
  const cookie = store.pair(store.startPairing().code, "Driving cookie", "drive");
  if (!cookie) throw new Error("Expected cookie pairing");
  const cookieMatch = spyOn(store, "match").mockImplementation(() => { throw new Error("Relay must not inspect cookies"); });
  const identity = spyOn(app.context.services, "identityOf").mockImplementation(() => { throw new Error("Relay must not inspect Tailscale"); });
  const proof = spyOn(portal, "vouches").mockReturnValue(true);
  const principal = { id: "0123456789abcdef", label: "Relay watcher", role: "watch" as const };
  const ctx: ServerContext = {
    ...app.context, peer: { kind: "relay", device: principal, sessionId: "session-a", serverId: "0123456789abcdef0123456789abcdef", key: "" },
    requestIP: () => { throw new Error("Relay must not inspect the socket"); },
    timeout: () => {},
    upgrade: (_request, options) => {
      expect(options.data.readOnly).toBe(true);
      expect(options.data.bridge).toBe(false);
      expect(options.data.deviceId).toBe(principal.id);
      return true;
    },
  };
  const headers = {
    cookie: `ovis_device=${cookie.token}; ovis_token=shared-token`, authorization: "Bearer shared-token",
    "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.1",
    "x-portal-proof": "valid-portal-proof", "x-portal-user": "owner", "x-portal-auth": "credential",
    origin: "https://relay.ovis.invalid", "x-herdr-machine": "1",
  };
  const request = (path: string, method = "GET") => new Request(`https://relay.ovis.invalid${path}`, { method, headers });
  try {
    const health = await handleRequest(request("/api/health?scope=bridge"), ctx);
    expect(await health?.json()).toMatchObject({
      auth: { via: "relay", role: "watch", authenticated: true },
      security: { observed_ingress: "relay" },
    });
    const mutation = await handleRequest(request("/api/preferences", "PUT"), ctx);
    expect(mutation?.status).toBe(403);
    expect(await mutation?.json()).toMatchObject({ error: { code: "read_only" } });
    const auth = await handleRequest(request("/api/auth", "POST"), ctx);
    expect(auth?.status).toBe(403);
    expect(auth?.headers.has("set-cookie")).toBe(false);
    expect(await handleRequest(new Request("https://relay.ovis.invalid/ws", { headers: { ...headers, authorization: "Bearer bridge-token" } }), ctx)).toBeUndefined();
    expect(store.gated).toBe(false);
    expect(cookieMatch).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
    expect(proof).not.toHaveBeenCalled();
  } finally {
    cookieMatch.mockRestore();
    identity.mockRestore();
    proof.mockRestore();
    await portal.shutdown();
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("scopes a remote PC's receipt identity to the Portal user, not only to a browser two sign-ins share", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-portal-receipts-"));
  const portal = new PortalService({ stateDir });
  const forwarded: Array<string | undefined> = [];
  let heard: (() => void) | undefined;
  const upstream = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(request, instance) { return instance.upgrade(request) ? undefined : new Response(null, { status: 426 }); },
    websocket: { message(_socket, raw) { forwarded.push(JSON.parse(String(raw)).receipt_resume_id); heard?.(); } },
  });
  const endpoint = spyOn(MachineManager.prototype, "endpoint").mockImplementation((id) =>
    id === "remote" ? { url: `http://127.0.0.1:${upstream.port}`, token: "remote" } : undefined);
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, portal, token: "shared-token", tailscaleOwner: null, sidecar: false });
  const proof = spyOn(portal, "vouches").mockReturnValue(true);
  const role = spyOn(portal, "roleFor").mockReturnValue("drive");
  const relays: MachineRelay[] = [];
  const ctx: ServerContext = {
    ...app.context, requestIP: () => ({ address: "127.0.0.1" }), timeout: () => {},
    upgrade: (_request, options) => { relays.push(options.data.relay!); return true; },
  };
  const browser = crypto.randomUUID();
  const attachAs = async (user: string) => {
    const response = await handleRequest(new Request(`http://127.0.0.1:${app.port}/ws?machine_id=remote`, { headers: {
      host: `127.0.0.1:${app.port}`, origin: `http://127.0.0.1:${app.port}`, "x-forwarded-for": "100.64.0.1",
      "x-portal-proof": "valid-portal-proof", "x-portal-user": user, "x-portal-auth": "credential",
    } }), ctx);
    expect(response).toBeUndefined();
    // one attach at a time: each comes over its own upstream socket, so arrival order is not send order
    const arrived = new Promise<void>((resolve) => { heard = resolve; });
    relays.at(-1)!.message(JSON.stringify({ type: "attach", pane_id: "p", cols: 80, rows: 24, receipt_resume_id: browser }));
    await arrived;
  };
  try {
    await attachAs("alice"); await attachAs("bob"); await attachAs("alice");
    const [alice, bob, aliceAgain] = forwarded;
    expect(alice).toBeString();
    expect(aliceAgain).toBe(alice);
    expect(bob).toBeString();
    expect(bob).not.toBe(alice);
  } finally {
    for (const relay of relays) relay.close();
    proof.mockRestore(); role.mockRestore(); endpoint.mockRestore();
    await portal.shutdown();
    app.stop();
    upstream.stop(true);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("keys relay request budgets by device rather than session or forged source address", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-relay-client-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
  const send = (id: string, sessionId: string, forwarded: string) => handleRequest(new Request("https://relay.ovis.invalid/api/connection-diagnostics", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": forwarded }, body: "{}",
  }), {
    ...app.context, peer: { kind: "relay", device: { id, label: "Relay", role: "drive" }, sessionId, serverId: "0123456789abcdef0123456789abcdef", key: "" }, timeout: () => {},
  });
  const log = spyOn(app.context.services.clientConnectionLog, "handle");
  try {
    for (let i = 0; i < 4; i++) expect((await send("aaaaaaaaaaaaaaaa", `session-${i}`, `100.64.0.${i}`))?.status).toBe(400);
    expect((await send("aaaaaaaaaaaaaaaa", "new-session", "203.0.113.1"))?.status).toBe(429);
    expect((await send("bbbbbbbbbbbbbbbb", "new-session", "203.0.113.1"))?.status).toBe(400);
    expect(log.mock.calls.map((call) => call[1])).toEqual([...Array<string>(5).fill("relay:aaaaaaaaaaaaaaaa"), "relay:bbbbbbbbbbbbbbbb"]);
  } finally {
    log.mockRestore();
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("refuses pairing without a code to an open LAN window, which never hears of a phone waiting", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-dispatch-open-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, sidecar: false });
  try {
    const base = `http://192.168.1.10:${app.port}`;
    const ctx: ServerContext = { ...app.context, requestIP: () => ({ address: "192.168.1.50" }), timeout: () => {}, upgrade: () => false };
    for (const path of ["/api/relay/link", "/api/relay/pairing", "/api/account/records"]) {
      const response = await handleRequest(new Request(base + path, {
        method: "POST", headers: { host: `192.168.1.10:${app.port}`, origin: base, "x-herdr-update": "1", "content-type": "application/json" },
        body: JSON.stringify({ id: "0011223344556677", decision: "approve" }),
      }), ctx);
      expect(response?.status).toBe(403);
      expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("owner_only");
    }
  } finally {
    app.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
