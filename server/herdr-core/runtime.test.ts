import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "./runtime.ts";

const platform = process.platform;
const previousRuntime = process.env["OVIS_RUNTIME"];
const previousSocket = process.env["HERDR_SOCKET"];
let cleanup = () => {};
afterEach(() => {
  cleanup();
  cleanup = () => {};
  mock.restore();
  Object.defineProperty(process, "platform", { value: platform });
  if (previousRuntime === undefined) delete process.env["OVIS_RUNTIME"];
  else process.env["OVIS_RUNTIME"] = previousRuntime;
  if (previousSocket === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = previousSocket;
});

it.skipIf(platform === "win32")("tightens an existing state directory and socket on every start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-mode-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  process.env["OVIS_RUNTIME"] = "herdr-core";
  for (let start = 0; start < 2; start++) {
    chmodSync(dir, 0o755);
    const adapter = await startRuntime(dir);
    if (!adapter) throw new Error("runtime did not start");
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(adapter.socketPath).mode & 0o777).toBe(0o600);
      expect(process.env["HERDR_SOCKET"]).toBe(adapter.socketPath);
    } finally {
      adapter.stop();
    }
  }
});

it.skipIf(platform === "win32")("refuses another user's state directory before changing its mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-owner-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  chmodSync(dir, 0o755);
  process.env["OVIS_RUNTIME"] = "herdr-core";
  spyOn(process, "geteuid").mockReturnValue(statSync(dir).uid + 1);
  await expect(startRuntime(dir)).rejects.toThrow();
  expect(statSync(dir).mode & 0o777).toBe(0o755);
  expect(existsSync(join(dir, "herdr-core.sock"))).toBe(false);
});

it("rejects herdr-core on Windows before creating state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-windows-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  process.env["OVIS_RUNTIME"] = "herdr-core";
  Object.defineProperty(process, "platform", { value: "win32" });
  await expect(startRuntime(state)).rejects.toThrow();
  expect(existsSync(state)).toBe(false);
});

it("leaves the default runtime's state and socket unchanged even on Windows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-default-"));
  cleanup = () => rmSync(dir, { recursive: true, force: true });
  const state = join(dir, "state");
  delete process.env["OVIS_RUNTIME"];
  process.env["HERDR_SOCKET"] = "default-socket";
  Object.defineProperty(process, "platform", { value: "win32" });
  expect(await startRuntime(state)).toBeNull();
  expect(existsSync(state)).toBe(false);
  expect(process.env["HERDR_SOCKET"]).toBe("default-socket");
});
