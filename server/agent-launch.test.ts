import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { agentLaunch } from "./agent-launch.ts";
import { launchedAgents } from "./launched-agents.ts";

const ULTRACODE = JSON.stringify({ ultracode: true });
const PANE = "agent-launch-test-pane";

describe("agentLaunch", () => {
  /** what herdr's agent.start was asked, without a herdr */
  const starts: Parameters<typeof herdr.agentStart>[0][] = [];
  const roots: string[] = [];
  afterEach(() => {
    starts.length = 0;
    launchedAgents.forget(PANE);
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const settingsDir = (): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-agent-launch-")));
    roots.push(root);
    return join(root, "claude-settings");
  };
  const launch = async (kind: string, args: string[], options: { platform: string; settingsDir: string }) => {
    const start = spyOn(herdr, "agentStart").mockImplementation(async (params) => { starts.push(params); return {}; });
    try {
      expect(await agentLaunch(PANE, { kind, name: `${kind}-launch-test`, args }, undefined, undefined, options)).toEqual({ agent_started: true });
    } finally {
      start.mockRestore();
    }
    expect(starts).toHaveLength(1);
    return starts[0]!;
  };

  it("starts Claude Code on Windows with its inline JSON --settings as a file's path", async () => {
    const dir = settingsDir();
    const args = ["--effort", "medium", "--settings", ULTRACODE];
    const started = await launch("claude", args, { platform: "win32", settingsDir: dir });
    expect(started).toMatchObject({ name: "claude-launch-test", kind: "claude", paneId: PANE });
    expect(started.args!.slice(0, 3)).toEqual(["--effort", "medium", "--settings"]);
    expect(dirname(started.args![3]!)).toBe(dir);
    expect(readFileSync(started.args![3]!, "utf8")).toBe(ULTRACODE);
    // the request's own args are left as they came
    expect(args).toEqual(["--effort", "medium", "--settings", ULTRACODE]);
  });

  it("hands the args on as they came off Windows, and another agent's on Windows", async () => {
    const dir = settingsDir();
    const claude = ["--effort", "medium", "--settings", ULTRACODE];
    expect((await launch("claude", claude, { platform: "linux", settingsDir: dir })).args).toBe(claude);
    starts.length = 0;
    const codex = ["--settings", ULTRACODE];
    expect((await launch("codex", codex, { platform: "win32", settingsDir: dir })).args).toBe(codex);
    expect(existsSync(dir)).toBe(false);
  });
});
