import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CATALOG, type AgentCatalogEntry } from "../shared/agent-catalog.ts";
import { AgentDetector, catalogLocator, LOGIN_PATH_KEPT_MS, runVersion, TIMEOUT_KEPT_MS } from "./agent-catalog-detect.ts";

const entry = (id: string): AgentCatalogEntry => AGENT_CATALOG.find((candidate) => candidate.id === id)!;

// Stub agents are real executables run by the real runVersion: POSIX shell scripts, so not on Windows
describe.skipIf(process.platform === "win32")("AgentDetector", () => {
  let bin: string;
  let runs: string;
  /** a home with no installer folders: the detector never looks in the real one here */
  let emptyHome: string;
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> '${runs}'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const runsOf = (name: string) => readFileSync(runs, "utf8").split("\n").filter((line) => line === name).length;
  const locate = async (binary: string) => Bun.which(binary, { PATH: bin });

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), "ovis-catalog-bin-"));
    emptyHome = mkdtempSync(join(tmpdir(), "ovis-catalog-empty-home-"));
    runs = join(bin, "runs.log");
    writeFileSync(runs, "");
    stub("claude", "echo '2.1.311 (Claude Code)'");
    stub("codex", "echo 'codex-cli 0.150.0'");
    stub("omp", "echo 'usage: omp [options]'");
    stub("hermes", "exec sleep 10");
  });
  afterAll(() => {
    rmSync(bin, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  });

  it("reads an installed agent's version once, and again only when its executable changes", async () => {
    const detector = new AgentDetector({ home: emptyHome, locate });
    expect(await detector.state(entry("claude"), "linux")).toEqual({ installed: true, binary: "claude", on_path: true, version: "2.1.311", version_error: null, meets_min_version: true });
    expect(await detector.state(entry("claude"), "linux")).toMatchObject({ version: "2.1.311" });
    expect(runsOf("claude")).toBe(1);
    // an update replaces the file: the next read asks it again
    stub("claude", "echo '2.1.320 (Claude Code, updated)'");
    expect(await detector.state(entry("claude"), "linux")).toMatchObject({ version: "2.1.320" });
    expect(runsOf("claude")).toBe(2);
  });

  it("reads the version again when the executable is replaced by another file of the same size and time", async () => {
    stub("copilot", "echo 'copilot 0.10.0'");
    const target = join(bin, "copilot");
    utimesSync(target, 1_700_000_000, 1_700_000_000);
    const detector = new AgentDetector({ home: emptyHome, locate });
    expect(await detector.state(entry("copilot"), "linux")).toMatchObject({ version: "0.10.0" });
    // an updater writes the new file beside the old one and renames it over: same size, mtime copied
    const before = statSync(target);
    const next = join(bin, "copilot.next");
    writeFileSync(next, readFileSync(target, "utf8").replace("0.10.0", "0.20.0"));
    chmodSync(next, 0o755);
    utimesSync(next, 1_700_000_000, 1_700_000_000);
    renameSync(next, target);
    const after = statSync(target);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(await detector.state(entry("copilot"), "linux")).toMatchObject({ version: "0.20.0" });
    expect(runsOf("copilot")).toBe(2);
  });

  it("runs one version flag for readers that ask at once", async () => {
    const detector = new AgentDetector({ home: emptyHome, locate });
    const before = runsOf("omp");
    const [first, second] = await Promise.all([detector.state(entry("omp"), "linux"), detector.state(entry("omp"), "linux")]);
    expect(first).toEqual(second);
    expect(runsOf("omp") - before).toBe(1);
  });

  it("says when a version is older than Ovis's feature needs, or cannot be read", async () => {
    const detector = new AgentDetector({ home: emptyHome, locate });
    expect(await detector.state(entry("codex"), "linux")).toEqual({ installed: true, binary: "codex", on_path: true, version: "0.150.0", version_error: null, meets_min_version: false });
    expect(await detector.state(entry("omp"), "linux")).toEqual({ installed: true, binary: "omp", on_path: true, version: null, version_error: "unreadable", meets_min_version: null });
  });

  it("kills a version flag that hangs, and asks again only after a while", async () => {
    let now = 1_000;
    const detector = new AgentDetector({ home: emptyHome, locate, timeoutMs: 300, now: () => now });
    const started = performance.now();
    expect(await detector.state(entry("hermes"), "linux")).toEqual({ installed: true, binary: "hermes", on_path: true, version: null, version_error: "timeout", meets_min_version: null });
    expect(performance.now() - started).toBeLessThan(5_000);
    await detector.state(entry("hermes"), "linux");
    expect(runsOf("hermes")).toBe(1);
    now += TIMEOUT_KEPT_MS;
    await detector.state(entry("hermes"), "linux");
    expect(runsOf("hermes")).toBe(2);
  });

  it("reports an agent not on PATH as not installed, and runs nothing where its name proves nothing", async () => {
    const looked: string[] = [];
    const detector = new AgentDetector({ home: emptyHome, locate: async (binary) => { looked.push(binary); return locate(binary); } });
    expect(await detector.state(entry("grok"), "linux")).toEqual({ installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null });
    expect(await detector.state(entry("cmd"), "windows")).toEqual({ installed: null, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null });
    expect(looked).toEqual(["grok"]);
  });

  it("finds an agent an installer put on the login shell's PATH only, reading that PATH at most once a minute", async () => {
    let now = 0;
    let probes = 0;
    const probe = async () => { probes++; return { path: `/nonexistent:${bin}` }; };
    const locateWithLogin = catalogLocator({ probe, servicePath: () => "/usr/bin/nonexistent", now: () => now });
    expect(await locateWithLogin("claude")).toBe(join(bin, "claude"));
    expect(await locateWithLogin("grok")).toBeNull();
    expect(probes).toBe(1);
    now += LOGIN_PATH_KEPT_MS;
    await locateWithLogin("grok");
    expect(probes).toBe(2);
    // the service PATH alone, as tests and Windows run it
    expect(await catalogLocator({ probe: null, servicePath: () => "/usr/bin/nonexistent" })("claude")).toBeNull();
    expect(await catalogLocator({ probe: null, servicePath: () => bin })("claude")).toBe(join(bin, "claude"));
    const detector = new AgentDetector({ home: emptyHome, locate: locateWithLogin });
    expect(await detector.state(entry("claude"), "linux")).toMatchObject({ installed: true, binary: "claude" });
  });

  it("finds an agent its installer put in its own folder, off PATH, and says so", async () => {
    const home = mkdtempSync(join(tmpdir(), "ovis-catalog-home-"));
    try {
      const dir = join(home, ".pi", "agent", "bin");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pi"), "#!/bin/sh\necho '1.4.0'\n");
      chmodSync(join(dir, "pi"), 0o755);
      const nowhere = async () => null;
      const detector = new AgentDetector({ locate: nowhere, home });
      const pi = { ...entry("pi"), detect: { ...entry("pi").detect, install_dirs: { linux: ["~/.pi/agent/bin"] } } };
      expect(await detector.state(pi, "linux")).toEqual({ installed: true, binary: "pi", on_path: false, version: "1.4.0", version_error: null, meets_min_version: null });
      // another platform's folders are never looked in
      expect(await detector.state(pi, "macos")).toMatchObject({ installed: false });
      const windows = new AgentDetector({ locate: nowhere, home, env: { LOCALAPPDATA: home } });
      const viaVariable = { ...pi, detect: { ...pi.detect, install_dirs: { linux: ["%LOCALAPPDATA%/.pi/agent/bin"] } } };
      expect(await windows.state(viaVariable, "linux")).toMatchObject({ installed: true, on_path: false });
      // a variable the environment does not have names no folder
      expect(await new AgentDetector({ locate: nowhere, home, env: {} }).state(viaVariable, "linux")).toMatchObject({ installed: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never finds a binary through a relative, empty or '.' PATH entry, whatever the server's working folder", async () => {
    const cwd = process.cwd();
    process.chdir(bin);
    try {
      for (const path of [".", "", `.:${"/nonexistent"}`, "bin-relative", `:/nonexistent`]) {
        expect(await catalogLocator({ probe: null, servicePath: () => path })("claude")).toBeNull();
        expect(await catalogLocator({ probe: async () => ({ path }), servicePath: () => "/nonexistent" })("claude")).toBeNull();
      }
      // an absolute entry still counts
      expect(await catalogLocator({ probe: null, servicePath: () => `.:${bin}` })("claude")).toBe(join(bin, "claude"));
    } finally {
      process.chdir(cwd);
    }
  });

  /** Whether `pid` has ended: no such process, or one that only waits to be reaped. */
  const gone = async (pid: number): Promise<boolean> => {
    const state = (await new Response(Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout).text()).trim();
    return state === "" || state.startsWith("Z");
  };
  /** Waits for `pid` to end, for at most a second: SIGKILL is sent at once, and the kernel ends the process right after. */
  const ends = async (pid: number): Promise<boolean> => {
    const deadline = performance.now() + 1_000;
    while (performance.now() < deadline) if (await gone(pid)) return true;
    return gone(pid);
  };

  it("ends a timed-out version flag with every process it started, even one still holding its output", async () => {
    const pidFile = join(bin, "holder.pid");
    stub("holder", `sleep 30 &\necho $! > '${pidFile}'\nsleep 30`);
    const started = performance.now();
    const run = await runVersion(join(bin, "holder"), ["--version"], 300);
    expect(run.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await ends(Number(readFileSync(pidFile, "utf8").trim()))).toBe(true);
  });

  it("reads the version of a flag that answers and exits at once, and ends the child it left holding the output", async () => {
    const pidFile = join(bin, "leaver.pid");
    stub("leaver", `sleep 30 &\necho $! > '${pidFile}'\necho 'leaver 1.2.3'\nexit 0`);
    const started = performance.now();
    const run = await runVersion(join(bin, "leaver"), ["--version"], 5_000);
    expect(run.timedOut).toBe(false);
    expect(run.output).toContain("leaver 1.2.3");
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await ends(Number(readFileSync(pidFile, "utf8").trim()))).toBe(true);
  });

  it("reads at most a bounded amount of what a version flag prints", async () => {
    stub("chatty", "yes 1.2.3 | head -c 1000000");
    const run = await runVersion(join(bin, "chatty"), ["--version"], 5_000);
    expect(run.timedOut).toBe(false);
    expect(run.output.length).toBeLessThan(10_000);
    expect(run.output.startsWith("1.2.3")).toBe(true);
  });
});
