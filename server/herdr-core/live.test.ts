import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, paneMoveToNewTab, paneRead, paneSendText, ping, sessionSnapshot, tabRename, workspaceClose, workspaceCreate, workspaceRename } from "../herdr/client.ts";
import { startHerdrCoreAdapter } from "./adapter.ts";
import { CoreAttachSession } from "./attach-session.ts";
import { HcConnection } from "./connection.ts";
import { listHcMachines } from "./machine-bridge.ts";
import { MachineScopedConnection } from "./machine-scope.ts";
import { buildSnapshot } from "./snapshot.ts";
import type { HerdrPane } from "../../shared/protocol.ts";

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

  it("publishes the schema hc-api.generated.ts was made from", async () => {
    const proc = Bun.spawn([bin!, "schema"], { env: env!, stdout: "pipe", stderr: "ignore" });
    const schema: unknown = JSON.parse(await new Response(proc.stdout).text());
    expect(await proc.exited).toBe(0);
    // a different hc: refresh with OVIS_HC_BIN=<it> bun run generate:types --refresh-hc
    expect(schema).toEqual(JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "scripts", "hc-schema.json"), "utf8")));
  }, TEST_MS);

  it("speaks generation 1 in framed mode", async () => {
    const hello = await hc.hello();
    expect(hello.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(hello.core.id).not.toBe("");
  }, TEST_MS);

  it("renames a real Core agent and resolves its name across adapter restarts", async () => {
    const agy = join(dir, "agy");
    symlinkSync("/bin/bash", agy);
    const record = await hc.call("terminal.run", { cwd: dir, argv: [agy, "--noprofile", "--norc", "-c", "printf '\\033]7501;state=idle:app=agy\\033\\\\'; while IFS= read -r line; do printf 'got:%s\\n' \"$line\"; done"] });
    let adapter: Awaited<ReturnType<typeof startHerdrCoreAdapter>> | undefined;
    const socket = join(dir, "names.sock");
    try {
      const deadline = Date.now() + WAIT_MS;
      while (!(await hc.call("terminal.get", { terminal: record.address })).foreground?.argv?.includes(agy)) {
        if (Date.now() >= deadline) throw new Error(`Core did not report the fixture agent process: ${JSON.stringify(await hc.call("terminal.get", { terminal: record.address }))}`);
        await Bun.sleep(25);
      }
      adapter = await startHerdrCoreAdapter(hc, socket);
      await herdrRpc("agent.rename", { target: record.address, name: "live-agy" }, socket);
      expect((await sessionSnapshot(socket)).agents.find((entry) => entry.pane_id === record.address)?.name).toBe("live-agy");
      adapter.stop();
      adapter = await startHerdrCoreAdapter(hc, socket);
      expect(await herdrRpc("agent.get", { target: "live-agy" }, socket)).toMatchObject({ agent: { pane_id: record.address, name: "live-agy" } });
      await herdrRpc("agent.prompt", { target: "live-agy", text: "named-fixture-input" }, socket);
      expect((await paneRead({ paneId: record.address, source: "visible", format: "text" }, socket)).text).toContain("named-fixture-input");
      await herdrRpc("agent.rename", { target: "live-agy", name: null }, socket);
      await expect(herdrRpc("agent.get", { target: "live-agy" }, socket)).rejects.toMatchObject({ code: "agent_not_found" });
    } finally {
      adapter?.stop();
      await hc.call("terminal.kill", { terminal: record.address });
      await hc.call("terminal.rm", { terminal: record.address });
    }
  }, TEST_MS);

  it("attaches, resizes, types, and hears the program's OSC 7501 status as events", async () => {
    const events: { type: string; terminal?: string; data?: Record<string, unknown> }[] = [];
    let pending = "";
    const subscription = await hc.open("events.subscribe", {}, {
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
    const record = await hc.call("terminal.run", { argv: ["bash", "-c", script] });

    let screen = "";
    const attach = await hc.open("terminal.attach", { terminal: record.address, cols: 80, rows: 24 }, {
      onData: (payload) => { screen += new TextDecoder().decode(payload); wake(); },
      onClose: () => {},
    });
    await until("first paint", () => screen.length > 0);
    const attached = await hc.call("terminal.get", { terminal: record.address });
    expect([attached.cols, attached.rows]).toEqual([80, 24]);

    attach.channel.resize(100, 30);
    await until("resize", () => events.some((event) => event.type === "size" && event.terminal === record.address && event.data?.["cols"] === 100));
    const resized = await hc.call("terminal.get", { terminal: record.address });
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

  it("gets a reply the viewer's terminal made itself to the program, whether or not hc confirms automatic input", async () => {
    const hello = await hc.hello();
    const record = await hc.call("terminal.run", { argv: ["bash", "-c", "stty -echo; IFS= read -r line; echo \"got:$line\"; exit 3"] });
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
    // a core without the feature must get it as DATA: AUTOMATIC_INPUT it does not know would be dropped
    session.write("auto\r", true);
    expect(await exit.promise).toBe(3);
    expect(screen).toContain("got:auto");
    // what the pinned core says, for whoever raises the pin: hc 0.1.14 to 0.1.17 do not name the feature
    console.info(`hc ${hello.version} automatic_input: ${hello.features.includes("automatic_input")}`);
    await hc.call("terminal.rm", { terminal: record.address });
  }, TEST_MS);

  it("streams a terminal through CoreAttachSession: typing, a resize, and the program's exit code", async () => {
    const record = await hc.call("terminal.run", { argv: ["bash", "-c", "stty -echo; IFS= read -r line; echo \"got:$line\"; exit 7"] });
    let sizes = "";
    const events = await hc.open("events.subscribe", { terminal: record.address }, {
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
    const sized = await hc.call("terminal.get", { terminal: record.address });
    expect([sized.cols, sized.rows]).toEqual([90, 20]);
    session.write("hi\r");
    expect(await exit.promise).toBe(7);
    expect(screen).toContain("got:hi");
    events.channel.close();
    await hc.call("terminal.rm", { terminal: record.address });
  }, TEST_MS);
  it("places an hc run child after its parent's tab and carries its OSC 7501 kind, message and progress", async () => {
    const events: { type: string; terminal?: string; data?: Record<string, unknown> }[] = [];
    let pending = "";
    const subscription = await hc.open("events.subscribe", {}, {
      onData: (payload) => {
        pending += new TextDecoder().decode(payload);
        for (let at = pending.indexOf("\n"); at !== -1; at = pending.indexOf("\n")) {
          const message = JSON.parse(pending.slice(0, at)) as { method: string; params: { type: string; terminal?: string; data?: Record<string, unknown> } };
          pending = pending.slice(at + 1);
          if (message.method === "event") events.push(message.params);
        }
        wake();
      },
      onClose: () => {},
    });
    // the spec's msg is base64; hc keeps it decoded
    const msg = Buffer.from("Allow bash: rm -rf build?").toString("base64");
    const child = `printf '\\033]7501;state=blocked:app=codex:kind=permission:progress=60:msg=${msg}\\033\\\\'; sleep 30`;
    // started from inside the parent, as an agent starts a helper: hc names the parent from HC_TERMINAL_ID
    const parent = await hc.call("terminal.run", {
      argv: ["bash", "-c", '"$OVIS_TEST_HC" run --bg --name helper -- bash -c "$OVIS_TEST_CHILD"; sleep 30'],
      env: { OVIS_TEST_HC: bin!, OVIS_TEST_CHILD: child },
      labels: { "herdr.space": "s-live", "herdr.tab": "t-live" },
    });
    const statusOf = (event: (typeof events)[number]) => event.data?.["status"] as { state?: string; kind?: string } | null | undefined;
    await until("the child's blocked report", () => events.some((event) => event.type === "status" && event.terminal !== parent.address && statusOf(event)?.kind === "permission"));
    const childAddress = events.find((event) => event.type === "status" && statusOf(event)?.kind === "permission")!.terminal!;

    const list = await hc.call("terminal.list", {});
    const snapshot = buildSnapshot(list.terminals, null, "live");
    expect(snapshot.tabs.filter((tab) => tab.workspace_id === "s-live").map((tab) => tab.tab_id)).toEqual(["t-live", `s-live:${childAddress}`]);
    expect(snapshot.panes.find((pane) => pane.pane_id === childAddress)).toMatchObject({
      workspace_id: "s-live", parent_pane_id: parent.address, agent_status: "blocked", agent: "codex",
      agent_kind: "permission", agent_message: "Allow bash: rm -rf build?", agent_progress: 60,
    } satisfies Partial<HerdrPane>);

    for (const address of [childAddress, parent.address]) {
      await hc.call("terminal.kill", { terminal: address });
      await until(`${address} finished`, () => events.some((event) => event.type === "finished" && event.terminal === address));
      await hc.call("terminal.rm", { terminal: address });
    }
    await subscription.channel.close();
  }, TEST_MS);

  it("renames and moves Ovis's own workspaces and tabs in labels, and splits them in its own document, on a core no Herdr app arranges", async () => {
    const socket = join(dir, "herdr.sock");
    const adapter = await startHerdrCoreAdapter(hc, socket);
    // the core is this test's own and stops in afterAll: a failure here leaves nothing for another test
    try {
      expect((await ping(socket)).layout).toEqual({ rename: true, split: true, move: true, arrange: true, worktrees: true });
      const api = await workspaceCreate({ cwd: dir, label: "api" }, socket);
      const web = await workspaceCreate({ cwd: dir, label: "web" }, socket);

      await workspaceRename(api.workspace.workspace_id, "backend", socket);
      await tabRename(api.tab.tab_id, "server", socket);
      // #2812: split right, then the first pane down; a viewer sizes each terminal to its pane, and the panes keep their places
      const right = (await herdrRpc<{ pane: HerdrPane }>("pane.split", { target_pane_id: api.root_pane.pane_id, direction: "right" }, socket)).pane;
      const down = (await herdrRpc<{ pane: HerdrPane }>("pane.split", { target_pane_id: api.root_pane.pane_id, direction: "down" }, socket)).pane;
      const tabRects = async () => (await sessionSnapshot(socket)).layouts.find((layout) => layout.tab_id === api.tab.tab_id)!.panes.map((pane) => [pane.pane_id, pane.rect]);
      const placed = [
        [api.root_pane.pane_id, { x: 0, y: 0, width: 500, height: 500 }],
        [down.pane_id, { x: 0, y: 500, width: 500, height: 500 }],
        [right.pane_id, { x: 500, y: 0, width: 500, height: 1000 }],
      ];
      expect(await tabRects()).toEqual(placed);
      for (const [paneId, cols, rows] of [[api.root_pane.pane_id, 15, 1], [down.pane_id, 56, 29], [right.pane_id, 56, 29]] as const) {
        const { channel } = await hc.open("terminal.attach", { terminal: paneId, cols, rows }, { onData: () => {}, onClose: () => {} });
        await channel.close();
      }
      expect(await tabRects()).toEqual(placed);
      expect(await tabRects()).toEqual(placed);
      expect((await hc.call("doc.get", { name: "ovis-layout" })).version).toBe(2);
      await herdrRpc("pane.close", { pane_id: down.pane_id }, socket);
      await herdrRpc("pane.close", { pane_id: right.pane_id }, socket);

      let snapshot = await sessionSnapshot(socket);
      expect(snapshot.workspaces.find((workspace) => workspace.workspace_id === api.workspace.workspace_id)?.label).toBe("backend");
      expect(snapshot.tabs.find((tab) => tab.tab_id === api.tab.tab_id)?.label).toBe("server");
      expect(snapshot.panes.filter((pane) => pane.tab_id === api.tab.tab_id).map((pane) => pane.pane_id)).toEqual([api.root_pane.pane_id]);

      const moved = await paneMoveToNewTab(web.root_pane.pane_id, api.workspace.workspace_id, "moved", socket);
      expect(moved).toMatchObject({ pane: { pane_id: web.root_pane.pane_id, workspace_id: api.workspace.workspace_id }, closed_tab_id: web.tab.tab_id, closed_workspace_id: web.workspace.workspace_id });
      snapshot = await sessionSnapshot(socket);
      expect(snapshot.workspaces.some((workspace) => workspace.workspace_id === web.workspace.workspace_id)).toBe(false);
      expect(snapshot.tabs.filter((tab) => tab.workspace_id === api.workspace.workspace_id).map((tab) => tab.label)).toEqual(["server", "moved"]);
      // the moved pane takes its new workspace's name, so it never renames it
      expect(snapshot.workspaces.find((workspace) => workspace.workspace_id === api.workspace.workspace_id)?.label).toBe("backend");
      await workspaceClose(api.workspace.workspace_id, socket);
    } finally {
      adapter.stop();
    }
  }, TEST_MS);
});

/**
 * Another machine of a real hc's core, shown as a PC of its own (#2497): two cores of their own
 * (sessions, state, config and runtime folders nobody else uses), the second added to the first as
 * `lab` through a `--via` command that runs its `hc connect` in its own env, as SSH would there. Runs
 * only where OVIS_TEST_HC_BIN names an hc.
 */
describe.skipIf(!bin)("another machine of a real hc's core", () => {
  let dir = "";
  /** each core's env, set only once every isolating variable is in it */
  const envs: Record<string, string>[] = [];
  let hc: MachineScopedConnection | null = null;
  let stopAdapter: (() => void) | null = null;
  let socket = "";

  const until = async <T>(label: string, read: () => Promise<T | null>): Promise<T> => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const value = await read();
      if (value !== null) return value;
      if (Date.now() > deadline) throw new Error(`no ${label} within ${WAIT_MS}ms`);
      await Bun.sleep(25);
    }
  };
  const run = async (env: Record<string, string>, args: string[]) => {
    const proc = Bun.spawn([bin!, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ args, code, err: code === 0 ? "" : err }).toEqual({ args, code: 0, err: "" });
    return out;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ovis-hc-machine-"));
    // `--via` finds hc on the PATH as `herdr-core`
    mkdirSync(join(dir, "bin"));
    symlinkSync(bin!, join(dir, "bin", "herdr-core"));
    const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => !entry[0].startsWith("HC_") && entry[1] !== undefined));
    for (const name of ["here", "lab"]) {
      for (const sub of ["state", "config", "run"]) mkdirSync(join(dir, name, sub), { recursive: true, mode: 0o700 });
      envs.push({
        ...inherited,
        PATH: `${join(dir, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        HC_SESSION: `ovis-test-${name}-${process.pid}`,
        XDG_STATE_HOME: join(dir, name, "state"),
        XDG_CONFIG_HOME: join(dir, name, "config"),
        XDG_RUNTIME_DIR: join(dir, name, "run"),
        HC_SOCKET: join(dir, name, "run", "hc.sock"),
      });
    }
    const [here, lab] = envs as [Record<string, string>, Record<string, string>];
    await run(here, ["server", "start"]);
    await run(lab, ["server", "start"]);
    const via = join(dir, "bin", "via-lab");
    const assignments = Object.entries(lab).filter(([key]) => key.startsWith("HC_") || key.startsWith("XDG_") || key === "PATH").map(([key, value]) => `${key}='${value}'`).join(" ");
    writeFileSync(via, `#!/bin/sh\nexec env ${assignments} sh -c "$1"\n`);
    chmodSync(via, 0o755);
    await run(here, ["machine", "add", "--name", "lab", "--via", via]);
    await run(here, ["run", "--bg", "bash"]);
    hc = new MachineScopedConnection(() => {
      const child = Bun.spawn([bin!, "connect"], { env: here, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      return {
        readable: child.stdout,
        write: (bytes: Uint8Array) => { child.stdin.write(bytes); void child.stdin.flush(); },
        exited: child.exited,
        kill: () => child.kill(),
      };
    }, "lab", (JSON.parse(await run(here, ["machine", "ls", "--json"])) as { machines: { id: string }[] }).machines[0]!.id);
    socket = join(dir, "lab.sock");
    stopAdapter = (await startHerdrCoreAdapter(hc, socket, undefined, { otherMachine: true })).stop;
  }, TEST_MS);

  afterAll(async () => {
    stopAdapter?.();
    hc?.close();
    // only this test's cores, each by its own isolated env
    const stopped = await Promise.all(envs.map((env) => Bun.spawn([bin!, "server", "stop"], { env, stdout: "ignore", stderr: "ignore" }).exited));
    if (dir) rmSync(dir, { recursive: true, force: true });
    expect(stopped.every((code) => code === 0)).toBe(true);
  }, TEST_MS);

  it("lists the machine, then starts, types into and reads a terminal there by its own address", async () => {
    expect((await listHcMachines(hc!)).map((machine) => [machine.name, machine.connected])).toEqual([["lab", true]]);
    // this PC's own terminal is none of lab's
    expect((await sessionSnapshot(socket)).panes).toEqual([]);
    const made = await workspaceCreate({ label: "on lab" }, socket);
    const paneId = made.root_pane.pane_id;
    expect(paneId).not.toContain("/");
    const listed = JSON.parse(await run(envs[1]!, ["ls", "--json"])) as { terminals: { address: string }[] };
    expect(listed.terminals.map((terminal) => terminal.address)).toContain(paneId);
    expect((await sessionSnapshot(socket)).workspaces.map((workspace) => workspace.label)).toEqual(["on lab"]);
    await paneSendText(paneId, "echo lab-$((40+2))\r", socket);
    const text = await until("echo", async () => {
      const read = await paneRead({ paneId, source: "recent", format: "text", lines: 50 }, socket);
      return read.text.includes("lab-42") ? read.text : null;
    });
    expect(text).toContain("lab-42");
  }, TEST_MS);
});
