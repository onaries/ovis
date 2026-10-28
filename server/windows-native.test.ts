/**
 * What only a real Windows PC can show: its process table as PowerShell answers it, and a
 * session store on its own file system with its own path rules. Everything else about the
 * Windows branches is tested with rows and paths handed in (gjc-runtime.test.ts); these run
 * on the Windows runners of reusable CI and the remote-bundle workflow (#271).
 */
import { expect, it, spyOn } from "bun:test";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";

import { claudeProcessSession, forgetClaudeSessions, processClaudeConfigDir } from "./claude-store.ts";
import { Database } from "bun:sqlite";

import { codexRolloutPath, directoryKey, sameDirectory, storedCwdCondition } from "./codex.ts";
import { gjcSessionFile, storeRelative } from "./gjc-runtime.ts";
import { descendantArgv, windowsProcessTable } from "./windows-processes.ts";
import { windowsHost } from "./remote-host.ts";
import type { SshConnection } from "./ssh.ts";
import { psQuote } from "./powershell.ts";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { isAgyProcessName, windowsHolders } from "./agy-store.ts";
import { ancestorsToRepoRoot } from "./skills/walk.ts";
import { startInteractiveWindowsHerdr } from "./windows-herdr-start.ts";

const onWindows = process.platform === "win32";

it.skipIf(!onWindows)("waits when Windows accepts an interactive task without running it, but rejects a failed launcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-desktop-not-run-"));
  const marker = join(root, "unexpected-child");
  const script = join(root, "child.ts");
  writeFileSync(script, `await Bun.write(${JSON.stringify(marker)}, 'launched');`);
  const spawn = Bun.spawn.bind(Bun);
  let failedResult = false;
  const failures: unknown[] = [];
  // Replay Run returning no instance while the real, fresh task remains Ready/never-run.
  // Registration, status queries, private payload creation and cleanup still run natively.
  const intercepted = spyOn(Bun, "spawn").mockImplementation(((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const args = [...command];
    const encoded = args.indexOf("-EncodedCommand") + 1;
    let source = Buffer.from(args[encoded]!, "base64").toString("utf16le");
    source = source.replace("try { $running = $registered.Run($null) }", "try { $running = $null }");
    // A completed launcher error must not be mistaken for a never-run task.
    if (failedResult) source = source.replace("$deadline = [DateTime]::UtcNow.AddSeconds(30)", "$registered = [pscustomobject]@{ State = 3; LastTaskResult = 1 }; $deadline = [DateTime]::UtcNow.AddSeconds(30)");
    args[encoded] = Buffer.from(source, "utf16le").toString("base64");
    return spawn(args, options);
  }) as typeof Bun.spawn);
  try {
    expect(await startInteractiveWindowsHerdr(process.execPath, [script], join(root, "herdr.log"))).toBe("waiting_login");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith("herdr-start-"))).toEqual([]);
    failedResult = true;
    await expect(startInteractiveWindowsHerdr(process.execPath, [script], join(root, "herdr.log"))).rejects.toThrow("exited before reading its payload");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith("herdr-start-"))).toEqual([]);
  } catch (error) { failures.push(error); }
  intercepted.mockRestore();
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Desktop wait test and cleanup failed");
}, 30_000);

it.skipIf(!onWindows)("starts a desktop child outside the launcher, preserving quoted arguments and private environment, or waits without launching", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-desktop-start-"));
  const resultPath = join(root, "result.json");
  const stopPath = join(root, "stop");
  const script = join(root, "child with spaces.ts");
  const sentinel = "private-launch-sentinel-\"&%!\n한글";
  const previous = process.env["OVIS_START_TEST_SECRET"];
  let pid: number | undefined;
  const watcher = watch(root);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const result = new Promise<{ pid: number; secret: string; args: string[]; session: number }>((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("the desktop child did not answer")), 15_000);
    watcher.on("change", () => {
      if (existsSync(resultPath)) { clearTimeout(deadline); resolve(JSON.parse(readFileSync(resultPath, "utf8"))); }
    });
  });
  // A waiting host has no child and therefore no result; still observe a later rejection on failure.
  void result.catch(() => {});
  writeFileSync(script, `import { watch, existsSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
const { symbols } = dlopen('kernel32.dll', { ProcessIdToSessionId: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 } });
const session = new Uint32Array(1); if (!symbols.ProcessIdToSessionId(process.pid, session)) throw new Error('no session');
watch(${JSON.stringify(root)}, () => { if (existsSync(${JSON.stringify(stopPath)})) process.exit(0); });
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({pid:process.pid, secret:process.env.OVIS_START_TEST_SECRET, args:process.argv.slice(2), session:session[0]}));
`);
  process.env["OVIS_START_TEST_SECRET"] = sentinel;
  const failures: unknown[] = [];
  try {
    const started = await startInteractiveWindowsHerdr(process.execPath, [script, "argument with spaces & 한글"], join(root, "herdr.log"));
    if (started === "waiting_login") {
      expect(existsSync(resultPath)).toBe(false);
    } else {
      // The launcher already exited, but this child's watch still runs in the desktop session.
      const child = await result;
      pid = child.pid;
      expect(child.session).toBeGreaterThan(0);
      expect(child.secret).toBe(sentinel);
      expect(child.args).toEqual(["argument with spaces & 한글"]);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    }
    expect(readdirSync(root).filter((name) => name.startsWith("herdr-start-"))).toEqual([]);
  } catch (error) { failures.push(error); }
  try {
    clearTimeout(deadline);
    const closed = new Promise<void>((resolve) => watcher.once("close", resolve));
    watcher.close();
    await closed;
    if (previous === undefined) delete process.env["OVIS_START_TEST_SECRET"]; else process.env["OVIS_START_TEST_SECRET"] = previous;
    // Only this fixture's child is stopped, never a herdr daemon or another test's task.
    if (pid !== undefined) try { process.kill(pid); } catch {}
    const cleanupBy = Date.now() + 5000;
    for (;;) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || Date.now() >= cleanupBy) throw error;
        await Bun.sleep(25);
      }
    }
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Desktop startup test and cleanup failed");
}, 60_000);

it.skipIf(!onWindows)("stops skill discovery at the user's home whatever its letter case", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-home-case-"));
  const before = process.env["HOME"];
  try {
    process.env["HOME"] = home.toLowerCase();
    // home is itself a repository: a folder under it with no .git of its own must not reach it
    mkdirSync(join(home, ".git"));
    const cwd = join(home.toUpperCase(), "work", "sub");
    mkdirSync(cwd, { recursive: true });
    expect(ancestorsToRepoRoot(cwd)).toEqual([cwd]);
    expect(ancestorsToRepoRoot(home.toUpperCase())).toEqual([]);
    // and a folder above home in another case is not a project of its own either
    expect(ancestorsToRepoRoot(dirname(home).toUpperCase())).toEqual([]);
  } finally {
    if (before === undefined) delete process.env["HOME"]; else process.env["HOME"] = before;
    rmSync(home, { recursive: true, force: true });
  }
});

it.skipIf(!onWindows)("finds this process holding an open file through Restart Manager, then observes its release", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-agy-native-"));
  const path = join(root, "conversation.lock");
  let fd: number | undefined;
  try {
    fd = openSync(path, "w+");
    expect(windowsHolders(path)).toContain(process.pid);
    closeSync(fd);
    fd = undefined;
    const after = windowsHolders(path);
    expect(after).not.toBeNull();
    expect(after!).not.toContain(process.pid);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(!onWindows)("recognizes Windows Agy executable names and full paths regardless of letter case", () => {
  expect(isAgyProcessName("agy.exe")).toBe(true);
  expect(isAgyProcessName("AGY.ExE")).toBe(true);
  expect(isAgyProcessName("C:\\Programs\\Antigravity\\AgY.eXe")).toBe(true);
  expect(isAgyProcessName("c:\\PROGRAMS\\ANTIGRAVITY\\AGY.EXE")).toBe(true);
  expect(isAgyProcessName("C:\\Programs\\agyx.exe")).toBe(false);
});

it.skipIf(!onWindows)("installs with native tar when PATH shadows tar, and preserves the runtime after bad extraction", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-bundle-native-")));
  const before = process.env["OVIS_BUNDLE_MANIFEST"];
  const runtime = join(home, "herdr-web-ui", `remote-v${REMOTE_BUNDLE_VERSION}`);
  const runPowerShell = async (script: string) => {
    const prefixed = `$env:LOCALAPPDATA=${psQuote(home)}; $env:PATH=${psQuote(join(home, "shadow"))}+';'+$env:PATH; ${script}`;
    // started from PowerShell 7 (the CI step), the child inherits its module path, and Windows
    // PowerShell then cannot load its own Get-FileHash; with none set it builds its own, as over SSH
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(prefixed, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
    return stdout.trim();
  };
  const ssh = { runPowerShell, upload: async (source: string, destination: string) => copyFileSync(source, destination) } as unknown as SshConnection;
  try {
    mkdirSync(join(home, "input", "bin"), { recursive: true });
    copyFileSync(process.execPath, join(home, "input", "bin", "bun.exe"));
    mkdirSync(join(home, "shadow"));
    // An invalid executable first on PATH must never handle this archive.
    writeFileSync(join(home, "shadow", "tar.exe"), "not a Windows executable");
    await runPowerShell(`& "$env:SystemRoot\\System32\\tar.exe" -czf ${psQuote(join(home, "bundle.tgz"))} -C ${psQuote(join(home, "input"))} .; if ($LASTEXITCODE -ne 0) { throw 'fixture archive failed' }`);
    const manifest = join(home, "manifest.json");
    const writeManifest = async () => writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "win32-x64": { url: "bundle.tgz", sha256: createHash("sha256").update(new Uint8Array(await Bun.file(join(home, "bundle.tgz")).arrayBuffer())).digest("hex") } } }));
    await writeManifest();
    process.env["OVIS_BUNDLE_MANIFEST"] = manifest;
    await windowsHost.installBundle(ssh, "win32-x64", AbortSignal.timeout(60_000));
    expect(existsSync(join(runtime, "bin", "bun.exe"))).toBe(true);
    const target = realpathSync(runtime);
    writeFileSync(join(home, "bundle.tgz"), "invalid archive with a valid manifest checksum");
    await writeManifest();
    await expect(windowsHost.installBundle(ssh, "win32-x64", AbortSignal.timeout(60_000))).rejects.toThrow();
    expect(realpathSync(runtime)).toBe(target);
    expect(existsSync(join(home, "herdr-web-ui", "install.lock"))).toBe(false);
    expect(existsSync(join(home, "herdr-web-ui", `install.${process.pid}`))).toBe(false);
  } finally {
    if (before === undefined) delete process.env["OVIS_BUNDLE_MANIFEST"]; else process.env["OVIS_BUNDLE_MANIFEST"] = before;
    // Remove the junction separately: the immutable release is cleaned with the fixture.
    if (existsSync(runtime)) await runPowerShell(`[IO.Directory]::Delete(${psQuote(runtime)})`);
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

it.skipIf(!onWindows)("reads this PC's process table: this process, its parent, when it started and what it runs", async () => {
  const rows = await windowsProcessTable(30_000);
  const self = rows.find((row) => row.pid === process.pid);
  expect(self).toBeDefined();
  expect(self!.parent).toBe(process.ppid);
  // ms since 1970, as Date.now() counts: started before now, and not a day ago
  expect(typeof self!.started).toBe("number");
  expect(self!.started!).toBeLessThanOrEqual(Date.now() + 2000);
  expect(self!.started!).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
  expect((self!.path ?? "").toLowerCase()).toContain("bun");
  // found from its parent the way a pane's program is found from the pane's shell
  expect(descendantArgv(rows, process.ppid).some((argv) => (argv[0] ?? "").toLowerCase() === (self!.path ?? "").toLowerCase())).toBe(true);
}, 40_000);

it.skipIf(!onWindows)("keeps a session file inside its store on a real Windows file system", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-gjc-native-")));
  try {
    const root = join(home, ".gjc", "agent", "sessions");
    const store = join(root, "v2-project");
    mkdirSync(join(store, "2026-10-01_session"), { recursive: true });
    const session = join(store, "2026-10-01_session.jsonl");
    writeFileSync(session, "{}\n");
    writeFileSync(join(store, "2026-10-01_session", "task.jsonl"), "{}\n");
    expect(root).toContain("\\");
    expect(gjcSessionFile(root, session)).toBe(session);
    // the drive letter's case is not another place, and a subagent's file stands for its session
    const lower = session[0]!.toLowerCase() + session.slice(1);
    const upper = session[0]!.toUpperCase() + session.slice(1);
    expect(gjcSessionFile(root, lower)).toBe(lower);
    expect(gjcSessionFile(root, upper)).toBe(upper);
    expect(gjcSessionFile(root, join(store, "2026-10-01_session", "task.jsonl"))).toBe(session);
    expect(storeRelative(root, session)).toEqual(["v2-project", "2026-10-01_session.jsonl"]);
    for (const outside of [`${root}-evil\\v2-project\\session.jsonl`, `${root}\\..\\sessions-evil\\v2-project\\session.jsonl`, `\\\\server\\share\\session.jsonl`, root]) {
      expect(storeRelative(root, outside)).toBeNull();
      expect(gjcSessionFile(root, outside)).toBeNull();
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it.skipIf(!onWindows)("reads a Codex rollout path stored with the \\\\?\\ prefix, and still keeps it inside the store", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-native-")));
  try {
    const home = join(root, "With Spaces", ".codex");
    const day = join(home, "sessions", "2026", "10", "05");
    mkdirSync(day, { recursive: true });
    const path = join(day, "rollout.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } }));
    const outside = join(root, "other.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } }));
    // as Codex on Windows writes `threads.rollout_path`
    expect(codexRolloutPath(`\\\\?\\${path}`, home)).toBe(path);
    expect(codexRolloutPath(path, home)).toBe(path);
    expect(codexRolloutPath(`\\\\?\\${outside}`, home)).toBeNull();
    // raw `..` segments (join would fold them) that climb from the store to `outside`, which exists
    expect(codexRolloutPath(`\\\\?\\${home}\\sessions\\..\\..\\..\\other.jsonl`, home)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(!onWindows)("finds Codex's thread under the on-disk casing when herdr reports another spelling of the directory (#740)", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "herdr-codex-cwd-")));
  mkdirSync(join(root, "Recorde"));
  const reported = join(root, "recorde");
  const canonical = realpathSync.native(reported);
  const db = new Database(":memory:");
  try {
    // the two spellings are only one directory to the file system, not to directoryKey
    expect(directoryKey(reported)).not.toBe(directoryKey(canonical));
    db.run("CREATE TABLE threads (id TEXT, cwd TEXT)");
    db.run("INSERT INTO threads VALUES (?, ?)", ["own", `\\\\?\\${canonical}`]);
    const { where, params } = storedCwdCondition(reported);
    expect(db.query<{ id: string }, string[]>(`SELECT id FROM threads WHERE ${where}`).all(...params)).toEqual([{ id: "own" }]);
    expect(sameDirectory(reported, canonical)).toBe(true);
    mkdirSync(join(root, "Other"));
    expect(sameDirectory(reported, join(root, "Other"))).toBe(false);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it.skipIf(!onWindows)("finds a Claude's own store from the start it records, which the process table repeats", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-claude-native-")));
  const serverConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  try {
    const session = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";
    // Claude records its start as FILETIME ticks, as PowerShell gives them
    const probe = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`], { stdin: "ignore", stderr: "ignore" });
    const procStart = probe.stdout.toString().trim();
    expect(procStart).toMatch(/^\d+$/);
    const user = join(home, "User With Spaces");
    const store = join(user, ".claude-second");
    mkdirSync(join(store, "sessions"), { recursive: true });
    mkdirSync(join(user, ".claude", "sessions"), { recursive: true });
    const record = (start: string) => writeFileSync(join(store, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: session, procStart: start, kind: "interactive" }));
    // a millisecond off is another process that had this PID
    record(String(BigInt(procStart) + 10_000n));
    expect(await claudeProcessSession(user, process.pid, store)).toBeNull();
    record(procStart);
    expect(await claudeProcessSession(user, process.pid, store)).toBe(session);
    expect(await processClaudeConfigDir(process.pid, [process.execPath], user)).toBe(store);
  } finally {
    forgetClaudeSessions();
    if (serverConfigDir !== undefined) process.env["CLAUDE_CONFIG_DIR"] = serverConfigDir;
    rmSync(home, { recursive: true, force: true });
  }
});
