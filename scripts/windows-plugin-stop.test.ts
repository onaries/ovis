import { expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The Windows stop path with a process table it is handed, run in a process of its own:
 * scripts/plugin.ts reads its state directory once, when first imported, and a test file beside
 * it in one `bun test` process (as on Windows, which runs the files serially in one) may have
 * imported it already with another one.
 */
it("waits only for the stopped tree: not for a process whose parent number was reused, nor on the process table once the tree is gone (#1833)", async () => {
  const root = join(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "herdr windows stop stray "));
  try {
    const state = join(scratch, "plugin-state");
    mkdirSync(state);
    mkdirSync(join(scratch, "config"));
    const script = join(scratch, "stop.ts");
    writeFileSync(script, `
      const { stop } = await import(${JSON.stringify(join(root, "scripts", "plugin.ts"))});
      const rootPid = process.pid, childPid = rootPid + 100_000_000, strayPid = rootPid + 200_000_000;
      await Bun.write(${JSON.stringify(join(state, "server.pid"))}, rootPid + "\\n");
      const rows = [
        { pid: rootPid, parent: 0, path: process.execPath, commandLine: '"' + process.execPath + '" "' + ${JSON.stringify(join(root, "server", "managed.ts"))} + '"', started: 10 },
        { pid: childPid, parent: rootPid, path: process.execPath, commandLine: '"' + process.execPath + '" -e child', started: 11 },
        // started before the server: its parent was an earlier process that held the server's number
        { pid: strayPid, parent: rootPid, path: "C:\\\\Windows\\\\System32\\\\svchost.exe", commandLine: "svchost.exe", started: 1 },
      ];
      let terminated = false, tableReadsAfterStop = 0, target = 0;
      const result = await stop({
        isWindows: true,
        // the tree is gone once terminated; the stray runs on, as an unrelated process would
        isAlive: (pid) => pid === strayPid || !terminated,
        processTable: async () => { if (terminated) tableReadsAfterStop += 1; return terminated ? [rows[2]] : rows; },
        terminateTree: (pid) => { target = pid; terminated = true; return { status: 0, error: undefined, stderr: "" }; },
      });
      console.log(JSON.stringify({ result, tableReadsAfterStop, targetedRoot: target === rootPid }));
    `);
    const child = Bun.spawn([process.execPath, script], {
      env: { ...process.env, HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: join(scratch, "config") },
      stdout: "pipe", stderr: "pipe", windowsHide: true,
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    const outcome = JSON.parse(out.trim().split("\n").at(-1)!) as { result: number; tableReadsAfterStop: number; targetedRoot: boolean };
    expect(outcome.targetedRoot, "control: termination targets the recorded root process").toBe(true);
    expect(outcome.result, `regression (fails on main): an unrelated process left over a reused parent number kept stop waiting\n${err}`).toBe(0);
    expect(outcome.tableReadsAfterStop, "regression (fails on main): a gone tree needs no process-table query").toBe(0);
    expect(existsSync(join(state, "server.pid"))).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
