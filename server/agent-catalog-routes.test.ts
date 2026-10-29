import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CATALOG, catalogPlatform, type AgentCatalogResponse } from "../shared/agent-catalog.ts";
import { AgentDetector, catalogLocator } from "./agent-catalog-detect.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const BROWSER_TOKEN = "catalog-browser-token";
const BRIDGE_TOKEN = "c".repeat(64);
const WATCH_TOKEN = "w".repeat(64);

describe("GET /api/agent-catalog", () => {
  let server: ReturnType<typeof createServer>;
  let root: string;
  let bin: string;
  const savedPath = process.env["PATH"];
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ovis-catalog-route-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    const state = join(root, "state");
    mkdirSync(state);
    // one paired device that may only watch
    writeFileSync(join(state, "devices.json"), JSON.stringify({ gate_closed_at: new Date().toISOString(), devices: [{ id: "0123456789abcdef", label: "Watch fixture", role: "watch", token_hash: createHash("sha256").update(WATCH_TOKEN).digest("hex"), created_at: new Date().toISOString(), last_seen_at: null }] }), { mode: 0o600 });
    // installer folders are looked for in an empty home, never this PC's own
    const home = join(root, "home");
    mkdirSync(home);
    const agentDetector = new AgentDetector({ locate: catalogLocator({ probe: null }), home, env: {} });
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: BROWSER_TOKEN, bridgeToken: BRIDGE_TOKEN, machines: false, sidecar: false, tailscaleOwner: null, agentDetector });
  });
  afterEach(() => { process.env["PATH"] = savedPath; });
  afterAll(() => {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("lists every catalog agent with this platform's commands and what is installed here", async () => {
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.311 (Claude Code)'\n");
    chmodSync(join(bin, "claude"), 0o755);
    process.env["PATH"] = bin;
    const response = await fetch(url("/api/agent-catalog"), { headers: bearer(BROWSER_TOKEN) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as AgentCatalogResponse;
    const platform = catalogPlatform(process.platform)!;
    expect(body.platform).toBe(platform);
    expect(body.agents.map((agent) => agent.id)).toEqual(AGENT_CATALOG.map((entry) => entry.id));
    const claude = body.agents.find((agent) => agent.id === "claude")!;
    expect(claude.install).toEqual(AGENT_CATALOG.find((entry) => entry.id === "claude")!.install[platform]);
    expect(claude.state).toEqual({ installed: true, binary: "claude", on_path: true, version: "2.1.311", version_error: null, meets_min_version: true });
    expect(body.agents.find((agent) => agent.id === "grok")!.state.installed).toBe(false);
    const muse = body.agents.find((agent) => agent.id === "muse")!;
    expect([muse.install, typeof muse.no_install]).toEqual([null, "string"]);
  });

  it("answers a watch device and the connection server's bridge token, and refuses no credential and a write", async () => {
    process.env["PATH"] = bin;
    expect((await fetch(url("/api/agent-catalog"))).status).toBe(401);
    const watched = await fetch(url("/api/agent-catalog"), { headers: { cookie: `ovis_device=${WATCH_TOKEN}`, "x-forwarded-for": "100.64.0.9" } });
    expect(watched.status).toBe(200);
    expect((await fetch(url("/api/agent-catalog"), { headers: bearer(BRIDGE_TOKEN) })).status).toBe(200);
    const watchPost = await fetch(url("/api/agent-catalog"), { method: "POST", headers: { cookie: `ovis_device=${WATCH_TOKEN}`, "x-forwarded-for": "100.64.0.9", origin: url("") } });
    expect([watchPost.status, ((await watchPost.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
    const post = await fetch(url("/api/agent-catalog"), { method: "POST", headers: { ...bearer(BROWSER_TOKEN), origin: url("") } });
    expect([post.status, ((await post.json()) as { error: { code: string } }).error.code]).toEqual([400, "method_not_allowed"]);
  });

  it("reaches another PC's catalog through the PC proxy with that PC's bridge token", async () => {
    process.env["PATH"] = bin;
    const manager = { endpoint: (id: string) => id === "remote" ? { url: url(""), token: BRIDGE_TOKEN } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    const response = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/remote/agent-catalog"), manager);
    expect(response.status).toBe(200);
    const direct = await (await fetch(url("/api/agent-catalog"), { headers: bearer(BROWSER_TOKEN) })).json();
    expect(await response.json()).toEqual(direct);
  });
});
