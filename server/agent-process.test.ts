import { describe, expect, it } from "bun:test";
import { agentProcessInFront } from "./agent-process.ts";

const info = (...foreground: { pid: number; argv: string[] }[]) => ({ pane_id: "fixture", foreground_processes: foreground.map((entry) => ({ ...entry, name: entry.argv[0]! })) });
// a launcher that does not exec its agent stays listed before the native binary it started
const launcher = { pid: 100, argv: ["node", "/opt/fixture/bin/claude"] };
const native = { pid: 101, argv: ["/opt/fixture/native/claude"] };

describe("the agent process in front", () => {
  it("takes the agent's native binary over a launcher listed before it", () => {
    expect(agentProcessInFront(info(launcher, native), "claude")?.pid).toBe(native.pid);
  });

  it("keeps the bound process while herdr lists it, the launcher a launch reported included", () => {
    expect(agentProcessInFront(info(launcher, native), "claude", launcher.pid)?.pid).toBe(launcher.pid);
  });

  it("takes the agent's own process once the bound one is gone", () => {
    expect(agentProcessInFront(info(launcher, { ...native, pid: 102 }), "claude", native.pid)?.pid).toBe(102);
  });

  it("takes the OmO process holding a session over its SDK child, while it is listed and nothing is bound", () => {
    const parent = { pid: 200, argv: ["/opt/team-ai/bin/run"] };
    const sdk = { pid: 201, argv: ["/opt/omo-ai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"] };
    expect(agentProcessInFront(info(parent, sdk), "omo")?.pid).toBe(sdk.pid);
    expect(agentProcessInFront(info(parent, sdk), "omo", null, parent.pid)?.pid).toBe(parent.pid);
    expect(agentProcessInFront(info(parent, sdk), "omo", sdk.pid, parent.pid)?.pid).toBe(sdk.pid);
    expect(agentProcessInFront(info(sdk), "omo", null, parent.pid)?.pid).toBe(sdk.pid);
  });

  // bunx or npx run omp's npm package entry point (its `bin`), and herdr names the process omp (#2280)
  it("takes omp started from its npm package's entry point, never another package's", () => {
    const entry = (pid: number, runtime: string, script: string) => ({ pane_id: "fixture", foreground_processes: [{ pid, name: "omp", argv: [runtime, script, "--continue"] }] });
    expect(agentProcessInFront(entry(300, "bun", "/tmp/bunx-1000-@oh-my-pi/pi-coding-agent@latest/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"), "omp")?.pid).toBe(300);
    expect(agentProcessInFront(entry(301, "/usr/local/bin/node", "C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js"), "omp")?.pid).toBe(301);
    expect(agentProcessInFront(entry(302, "bun", "/opt/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "omp")).toBeNull();
    expect(agentProcessInFront(entry(303, "bun", "/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/other.js"), "omp")).toBeNull();
    expect(agentProcessInFront(entry(304, "sh", "/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"), "omp")).toBeNull();
    expect(agentProcessInFront(entry(305, "python3", "/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"), "omp")).toBeNull();
  });

  it("names none where herdr names no agent or none of its programs runs", () => {
    expect(agentProcessInFront(info(launcher, native), null)).toBeNull();
    expect(agentProcessInFront(info({ pid: 7, argv: ["pwsh.exe"] }), "codex")).toBeNull();
    expect(agentProcessInFront(undefined, "claude")).toBeNull();
  });
});
