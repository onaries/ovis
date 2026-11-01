import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreAttachSession } from "./attach-session.ts";
import { HcConnection } from "./connection.ts";

/**
 * The hc client against a real hc, in a core of its own: a session name and state, config and
 * runtime folders no other core uses, so the user's core and the Herdr app never see it. Runs only
 * where OVIS_TEST_HC_BIN names an hc (generation 1).
 */
const bin = process.env["OVIS_TEST_HC_BIN"];

const WAIT_MS = 5000;
/** each test and hook outlasts its own bounded waits and calls, so a failure names the wait that ran out */
const TEST_MS = 30_000;

interface Waiter { check: () => boolean; resolve: () => void }

describe.skipIf(!bin)("hc client against a real hc", () => {
  let dir = "";
  /** set only once every isolating variable is in it: nothing runs hc without it */
  let env: Record<string, string> | null = null;
  /** the core and holder this test started, stopped (or killed) in afterAll */
  let pids: number[] = [];
  let hc: HcConnection;
  const waiters = new Set<Waiter>();
  const wake = () => { for (const waiter of [...waiters]) if (waiter.check()) { waiters.delete(waiter); waiter.resolve(); } };
  const until = (label: string, check: () => boolean): Promise<void> => {
    if (check()) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter = { check, resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`no ${label} within ${WAIT_MS}ms`)); }, WAIT_MS);
    waiters.add(waiter);
    return promise;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ovis-hc-live-"));
    for (const sub of ["state", "config", "run"]) mkdirSync(join(dir, sub), { mode: 0o700 });
    // an inherited HC_* (a terminal of the user's core, its socket) must not point this test at that core
    const inherited = Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith("HC_") && entry[1] !== undefined);
    const isolated = {
      ...Object.fromEntries(inherited),
      HC_SESSION: `ovis-test-${process.pid}`,
      XDG_STATE_HOME: join(dir, "state"),
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_RUNTIME_DIR: join(dir, "run"),
      HC_SOCKET: join(dir, "run", "hc.sock"),
    };
    env = isolated;
    const started = Bun.spawn([bin!, "server", "start"], { env: isolated, stdout: "ignore", stderr: "pipe" });
    expect({ exit: await started.exited, stderr: await new Response(started.stderr).text() }).toMatchObject({ exit: 0 });
    const status = Bun.spawn([bin!, "server", "status", "--json"], { env: isolated, stdout: "pipe", stderr: "ignore" });
    const running = JSON.parse(await new Response(status.stdout).text()) as { pid: number; holder?: { pid: number } | null };
    pids = [running.pid, ...(running.holder ? [running.holder.pid] : [])];
    // spawnHcConnect would run hc with the env this process started with: this core's env is passed explicitly
    hc = new HcConnection(() => {
      const child = Bun.spawn([bin!, "connect"], { env: isolated, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      return {
        readable: child.stdout,
        write: (bytes: Uint8Array) => { child.stdin.write(bytes); void child.stdin.flush(); },
        exited: child.exited,
        kill: () => child.kill(),
      };
    });
  }, TEST_MS);

  afterAll(async () => {
    hc?.close();
    // a core started with anything but the isolated env could be the user's: only this test's is stopped
    let stopped = 0;
    if (bin && env) stopped = await Bun.spawn([bin, "server", "stop"], { env, stdout: "ignore", stderr: "ignore" }).exited;
    // hc's core and holder are detached daemons, not children: their exit has no event to await
    const running = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + WAIT_MS;
    while (pids.some(running) && Date.now() < deadline) await Bun.sleep(25);
    const alive = pids.filter(running);
    for (const pid of alive) process.kill(pid, "SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
    expect({ stopped, killed: alive }).toEqual({ stopped: 0, killed: [] });
  }, TEST_MS);

  it("speaks generation 1 in framed mode", async () => {
    const hello = await hc.hello();
    expect(hello.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(hello.core.id).not.toBe("");
  }, TEST_MS);

  it("attaches, resizes, types, and hears the program's OSC 7501 status as events", async () => {
    const events: { type: string; terminal?: string; data?: Record<string, unknown> }[] = [];
    let pending = "";
    const subscription = await hc.open<{ channel: number; seq: number }>("events.subscribe", {}, {
      onData: (payload) => {
        pending += new TextDecoder().decode(payload);
        for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          const message = JSON.parse(line) as { method: string; params: { type: string; terminal?: string; data?: Record<string, unknown> } };
          if (message.method === "event") events.push(message.params);
        }
        wake();
      },
      onClose: () => {},
    });
    const report = (state: string) => `printf '\\033]7501;state=${state}:app=ovis-test\\033\\\\'`;
    const script = `stty -echo; while IFS= read -r line; do case "$line" in w) ${report("working")};; d) ${report("done")};; esac; echo "got:$line"; done`;
    const record = await hc.call<{ address: string }>("terminal.run", { argv: ["bash", "-c", script] });

    let screen = "";
    const attach = await hc.open<{ channel: number }>("terminal.attach", { terminal: record.address, cols: 80, rows: 24 }, {
      onData: (payload) => { screen += new TextDecoder().decode(payload); wake(); },
      onClose: () => {},
    });
    await until("first paint", () => screen.length > 0);
    const attached = await hc.call<{ cols: number; rows: number }>("terminal.get", { terminal: record.address });
    expect([attached.cols, attached.rows]).toEqual([80, 24]);

    attach.channel.resize(100, 30);
    await until("resize", () => events.some((event) => event.type === "size" && event.terminal === record.address && event.data?.["cols"] === 100));
    const resized = await hc.call<{ cols: number; rows: number }>("terminal.get", { terminal: record.address });
    expect([resized.cols, resized.rows]).toEqual([100, 30]);

    const stateOf = (event: (typeof events)[number]) => (event.data?.["status"] as { state?: string } | null | undefined)?.state;
    attach.channel.write("w\r");
    await until("working", () => events.some((event) => event.type === "status" && event.terminal === record.address && stateOf(event) === "working"));
    attach.channel.write("d\r");
    await until("done", () => events.some((event) => event.type === "status" && event.terminal === record.address && stateOf(event) === "done"));
    await until("echo", () => screen.includes("got:d"));

    await attach.channel.close();
    await hc.call("terminal.kill", { terminal: record.address });
    await until("finished", () => events.some((event) => event.type === "finished" && event.terminal === record.address));
    await hc.call("terminal.rm", { terminal: record.address });
    await until("removed", () => events.some((event) => event.type === "removed" && event.terminal === record.address));
    await subscription.channel.close();
  }, TEST_MS);

  it("streams a terminal through CoreAttachSession: typing, a resize, and the program's exit code", async () => {
    const record = await hc.call<{ address: string }>("terminal.run", { argv: ["bash", "-c", "stty -echo; IFS= read -r line; echo \"got:$line\"; exit 7"] });
    let sizes = "";
    const events = await hc.open<{ channel: number }>("events.subscribe", { terminal: record.address }, {
      onData: (payload) => { sizes += new TextDecoder().decode(payload); wake(); },
      onClose: () => {},
    });
    let screen = "";
    const exit = Promise.withResolvers<number | null>();
    const session = new CoreAttachSession({
      hc,
      terminal: record.address,
      cols: 80,
      rows: 24,
      onData: (data) => { screen += data; wake(); },
      onExit: (code) => exit.resolve(code),
    });
    await until("first paint", () => screen.length > 0);
    session.resize(90, 20);
    await until("resize", () => sizes.includes('"cols":90'));
    const sized = await hc.call<{ cols: number; rows: number }>("terminal.get", { terminal: record.address });
    expect([sized.cols, sized.rows]).toEqual([90, 20]);
    session.write("hi\r");
    expect(await exit.promise).toBe(7);
    expect(screen).toContain("got:hi");
    events.channel.close();
    await hc.call("terminal.rm", { terminal: record.address });
  }, TEST_MS);
});
