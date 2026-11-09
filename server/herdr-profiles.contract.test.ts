import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import type { Machine } from "../shared/machines.ts";
import type { HerdrMachineProfile } from "./herdr-profiles.ts";

it("publishes inherited rows on the existing authenticated roster and refuses competing edits", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-profile-api-"));
  const profile: HerdrMachineProfile = { id: "catalog-test", label: "Saved PC", enabled: true, target: { destination: "fixture-host", session: "named-session" } };
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "test-token", tailscaleOwner: null, herdrProfiles: async () => [profile] });
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: "Bearer test-token", "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" };
  try {
    expect((await fetch(`${base}/api/machines`)).status).toBe(401);
    const response = await fetch(`${base}/api/machines`, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { machines } = await response.json() as { machines: Machine[] };
    expect(machines).toHaveLength(2);
    const machine = machines[1]!;
    expect(machine).toMatchObject({ herdr_profile_id: profile.id, name: profile.label, target: profile.target, enabled: true, state: "disconnected", action_required: "connect" });
    for (const method of ["PATCH", "DELETE"]) {
      const result = await fetch(`${base}/api/machines/${machine.id}`, { method, headers, ...(method === "PATCH" ? { body: JSON.stringify({ enabled: true }) } : {}) });
      expect(result.status).toBe(400);
      expect((await result.json()).error.message).toContain("in herdr");
    }
    const events = await fetch(`${base}/api/machines/events`, { headers });
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"herdr_profile_id":"catalog-test"');
    await reader.cancel();
  } finally { server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

it("remote bridges do not discover another catalog", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-profile-bridge-"));
  let calls = 0;
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, machines: false, herdrProfiles: async () => { calls++; return []; } });
  try {
    expect((await fetch(`http://127.0.0.1:${server.port}/api/machines`)).status).toBe(404);
    expect(calls).toBe(0);
  } finally { server.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
