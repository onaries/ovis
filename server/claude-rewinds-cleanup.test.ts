import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";

let stateDir: string;
let server: ReturnType<typeof createServer> | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
  rmSync(stateDir, { recursive: true, force: true });
});

it("removes the Chat rewind record a pre-release build left in the state directory, keeping the rest", () => {
  stateDir = mkdtempSync(join(tmpdir(), "ovis-claude-rewinds-"));
  writeFileSync(join(stateDir, "claude-rewinds.json"), JSON.stringify({ "/fixture/session.jsonl": { pid: 4242, paneId: "p1", restored: "apple" } }));
  writeFileSync(join(stateDir, "keep.json"), "{}");
  server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  expect(existsSync(join(stateDir, "claude-rewinds.json"))).toBe(false);
  expect(readFileSync(join(stateDir, "keep.json"), "utf8")).toBe("{}");
});

it("starts as before when there is no such record", () => {
  stateDir = mkdtempSync(join(tmpdir(), "ovis-claude-rewinds-"));
  server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  expect(server.port).toBeGreaterThan(0);
  expect(existsSync(join(stateDir, "claude-rewinds.json"))).toBe(false);
});
