import { afterAll, afterEach, beforeAll, expect, it, spyOn } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexRestartFixture, RESTART_SESSION } from "./codex-restart.fake.ts";
import { paneGet, paneProcessInfo } from "./herdr/client.ts";
import * as herdr from "./herdr/client.ts";
import type { CodexRestartTarget } from "../shared/protocol.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";

let fixture: Awaited<ReturnType<typeof codexRestartFixture>>;
beforeAll(async () => { fixture = await codexRestartFixture(); });
afterAll(async () => { await fixture?.close(); });
afterEach(async () => { await fixture?.clear(); });
const call = (path: string, options?: RequestInit) => fetch(`http://127.0.0.1:${fixture.app.port}${path}`, options);
const prepare = async (pane: string): Promise<CodexRestartTarget> => {
  const response = await call(`/api/pane/codex-restart?pane_id=${encodeURIComponent(pane)}`);
  const result = await response.json();
  expect([response.status, result.error]).toEqual([200, undefined]);
  return result;
};
const restart = (target: CodexRestartTarget) => call("/api/pane/codex-restart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(target) });
const conversation = async (pane: string) => (await call(`/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`)).json();

it("reopens the same conversation in the same terminal with its model and without a new prompt", async () => {
  const pane = await fixture.pane("restart-happy");
  const target = await prepare(pane.pane_id);
  const before = await conversation(pane.pane_id);
  const response = await restart(target);
  const result = await response.json();
  expect([response.status, result]).toEqual([200, { pane_id: pane.pane_id, session_id: RESTART_SESSION }]);
  expect((await paneGet(pane.pane_id)).terminal_id).toBe(pane.terminal_id);
  const after = await conversation(pane.pane_id);
  expect(after.source).toBe("codex-transcript");
  expect(after.metadata.model).toBe("fixture-sol");
  expect(after.turns).toEqual(before.turns);
  expect(fixture.records().some((record) => record.event === "stopped" && record.pid === target.process_id)).toBe(true);
  expect((await paneProcessInfo(pane.pane_id))?.foreground_processes?.some((entry) => entry.pid === target.process_id)).toBe(false);
  expect(fixture.daemon.exitCode).toBeNull();
  const repeated = await restart(await prepare(pane.pane_id));
  expect([repeated.status, await repeated.json()]).toEqual([200, { pane_id: pane.pane_id, session_id: RESTART_SESSION }]);
  expect((await paneGet(pane.pane_id)).terminal_id).toBe(pane.terminal_id);
}, 85_000);

it("refuses a stale conversation confirmation without stopping its client", async () => {
  const pane = await fixture.pane("restart-stale");
  const target = await prepare(pane.pane_id);
  const before = readFileSync(`/proc/${target.process_id}/stat`, "utf8");
  const response = await restart({ ...target, session_id: "01a0c7a1-56d9-7e20-9f08-f7a2d973bf99" });
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("codex_restart_stale");
  expect(readFileSync(`/proc/${target.process_id}/stat`, "utf8").split(") ")[1]?.split(" ")[19]).toBe(before.split(") ")[1]?.split(" ")[19]);
}, 30_000);

it("restarts Codex under an interactive fish shell without changing the conversation", async () => {
  const pane = await fixture.pane("restart-fish", undefined, true);
  const response = await restart(await prepare(pane.pane_id));
  expect([response.status, await response.json()]).toEqual([200, { pane_id: pane.pane_id, session_id: RESTART_SESSION }]);
  expect((await paneGet(pane.pane_id)).terminal_id).toBe(pane.terminal_id);
  expect((await conversation(pane.pane_id)).metadata.model).toBe("fixture-sol");
}, 30_000);

it("binds the resumed client to its original store when the shell exported a different one", async () => {
  const pane = await fixture.pane("restart-exported-home", join(fixture.root, "wrong-store"));
  const response = await restart(await prepare(pane.pane_id));
  expect([response.status, await response.json()]).toEqual([200, { pane_id: pane.pane_id, session_id: RESTART_SESSION }]);
  expect((await conversation(pane.pane_id)).source).toBe("codex-transcript");
}, 30_000);

it("refuses native steering input before stopping its client", async () => {
  writeFileSync(join(fixture.root, "steering"), "pending");
  const pane = await fixture.pane("restart-steering");
  const stops = fixture.records().filter((record) => record.event === "stopped").length;
  const response = await call(`/api/pane/codex-restart?pane_id=${encodeURIComponent(pane.pane_id)}`);
  expect([response.status, (await response.json()).error.code]).toEqual([409, "codex_queue_present"]);
  expect(fixture.records().filter((record) => record.event === "stopped").length).toBe(stops);
}, 30_000);

it("clears the suffix of a shell draft when its cursor is at the beginning", async () => {
  const pane = await fixture.pane("restart-draft");
  const target = await prepare(pane.pane_id);
  const marker = join(fixture.root, "draft-must-not-run");
  const send = herdr.paneSendText;
  const intercept = spyOn(herdr, "paneSendText").mockImplementation(async (...args: Parameters<typeof send>) => {
    await send(pane.pane_id, `: ; touch '${marker}'`);
    await send(pane.pane_id, "\u0001");
    return send(...args);
  });
  try {
    const response = await restart(target);
    expect([response.status, await response.json()]).toEqual([200, { pane_id: pane.pane_id, session_id: RESTART_SESSION }]);
    expect(existsSync(marker)).toBe(false);
  } finally { intercept.mockRestore(); }
}, 30_000);

it("accepts a double click only once while a restart is in progress", async () => {
  const pane = await fixture.pane("restart-double");
  const target = await prepare(pane.pane_id);
  const starts = fixture.records().filter((record) => record.event === "started").length;
  const responses = await Promise.all([restart(target), restart(target)]);
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const refused = responses.find((response) => response.status === 409);
  expect(await refused?.json()).toMatchObject({ error: { code: "codex_restart_in_progress" } });
  expect(fixture.records().filter((record) => record.event === "started").length).toBe(starts + 1);
}, 85_000);

it("refuses a watching device before inspecting or restarting a session", async () => {
  const stateDir = join(fixture.root, "watch-state");
  const devices = new DeviceStore(stateDir);
  const watch = devices.pair(devices.startPairing().code, "Watch restart fixture", "watch");
  if (!watch) throw new Error("fixture pairing failed");
  devices.match(watch.token);
  const app = createServer({ port: 0, hostname: "127.0.0.1", token: "restart-drive-fixture", stateDir, codexHome: fixture.home, tailscaleOwner: null, machines: false });
  try {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`http://127.0.0.1:${app.port}/api/pane/codex-restart?pane_id=missing`, {
        method, headers: { cookie: `ovis_device=${watch.token}`, "x-herdr-machine": "1" }, ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect([response.status, (await response.json()).error.code]).toEqual([403, "read_only"]);
    }
  } finally { app.stop(); }
});

it("refuses another pane using the same conversation before stopping either client", async () => {
  const one = await fixture.pane("restart-duplicate-a");
  const two = await fixture.pane("restart-duplicate-b");
  const response = await call(`/api/pane/codex-restart?pane_id=${encodeURIComponent(one.pane_id)}`);
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("codex_session_in_use");
  expect((await conversation(two.pane_id)).source).toBe("codex-transcript");
}, 30_000);
