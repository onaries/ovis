import { afterEach, describe, expect, it, jest } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError, herdrRpc, paneGet, paneSendKeys, paneSendText, sessionSnapshot, subscribeEvents, type EventFrame, paneClose, tabClose, tabCreate, workspaceClose, workspaceCreate, agentManifests, agentStart, ping } from "../herdr/client.ts";
import { startHerdrCoreAdapter } from "./adapter.ts";
import { encodeFrame, FRAME_CLOSE, FRAME_DATA, HcConnection, HcError, type HcTransport, makeFrameReader } from "./connection.ts";
import type { HcTerminal } from "./snapshot.ts";

type Handler = (params: Record<string, unknown>) => unknown;

/** A core behind a fake `hc connect`: answers channel 0 from `handlers` and records every stream write. */
class FakeCore implements HcTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly exited: Promise<unknown>;
  /** bytes written to each stream channel, and which channels the client closed */
  readonly typed: { channel: number; text: string }[] = [];
  readonly closed: number[] = [];
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Stream frames bundled with the next RPC response in one pipe read. */
  replyTail: Uint8Array = new Uint8Array(0);
  killed = false;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private endExited!: () => void;
  private plain = true;
  private nextChannel = 1;
  private readonly frames = makeFrameReader((frame) => this.onFrame(frame.channel, frame.kind, frame.payload), () => {});

  constructor(readonly handlers: Record<string, Handler>, readonly answerHello = true) {
    this.readable = new ReadableStream({ start: (controller) => { this.controller = controller; } });
    const { promise, resolve } = Promise.withResolvers<unknown>();
    this.exited = promise;
    this.endExited = () => resolve(null);
  }

  write(bytes: Uint8Array): void {
    if (this.plain) {
      this.plain = false;
      if (!this.answerHello) return;
      this.controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ id: 0, jsonrpc: "2.0", result: { generation: 1, framed: true, version: "0.1.14", core: { id: "c1", name: "lab" }, methods: [], features: [] } })}\n`));
      return;
    }
    this.frames(bytes);
  }

  kill(): void {
    this.killed = true;
    try { this.controller.close(); } catch { /* closed */ }
    this.endExited();
  }

  /** A notification on a stream channel, as hc sends events. */
  notify(channel: number, method: string, params: Record<string, unknown>): void {
    this.data(channel, `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  data(channel: number, text: string): void {
    this.controller.enqueue(encodeFrame(channel, FRAME_DATA, text));
  }

  channel(): number {
    return this.nextChannel++;
  }

  private onFrame(channel: number, kind: number, payload: Uint8Array): void {
    if (channel !== 0) {
      if (kind === FRAME_DATA) this.typed.push({ channel, text: new TextDecoder().decode(payload) });
      if (kind === FRAME_CLOSE) {
        this.closed.push(channel);
        // hc answers a viewer's CLOSE with its own
        this.controller.enqueue(encodeFrame(channel, FRAME_CLOSE, new Uint8Array(0)));
      }
      return;
    }
    const message = JSON.parse(new TextDecoder().decode(payload)) as { id: number; method: string; params: Record<string, unknown> };
    this.calls.push({ method: message.method, params: message.params });
    const handler = this.handlers[message.method];
    const reply = handler
      ? (() => { try { return { result: handler(message.params) }; } catch (error) { return { error: { code: -32000, message: String(error), data: { kind: "not_found" } } }; } })()
      : { error: { code: -32601, message: `no ${message.method}`, data: { kind: "unknown_method" } } };
    this.controller.enqueue(Buffer.concat([encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply })), this.replyTail]));
    this.replyTail = new Uint8Array(0);
  }
}

function terminal(address: string, extra: Partial<HcTerminal> = {}): HcTerminal {
  return { address, cols: 100, rows: 30, cwd: "/home/u", state: "live", ...extra };
}

const LAYOUT = { spaces: [{ id: "s1", name: "api", tabs: [{ id: "s1t1", name: "", root: { type: "row", id: "r", children: [{ type: "block", id: "b1", content: { terminal: "t1" } }] } }] }] };

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

for (const method of ["call", "open"] as const) {
  it(`times out ${method} while hc never answers hello and reconnects on the next call`, async () => {
    const cores: FakeCore[] = [];
    const hc = new HcConnection(() => {
      const core = new FakeCore({ ping: () => ({ ok: true }) }, cores.length > 0);
      cores.push(core);
      return core;
    });
    jest.useFakeTimers();
    try {
      const pending = method === "call" ? hc.call("ping", {}, 50)
        : hc.open("events.subscribe", {}, { onData() {}, onClose() {} }, 50);
      const failure = pending.then(() => "resolved", (error: unknown) => error instanceof HcError ? error.kind : "unexpected");
      jest.advanceTimersByTime(50);
      expect(cores[0]?.killed).toBe(true);
      expect(await failure).toBe("timeout");
      expect(await hc.call<{ ok: boolean }>("ping", {}, 50)).toEqual({ ok: true });
      expect(cores).toHaveLength(2);
    } finally {
      hc.close();
      jest.useRealTimers();
    }
  });
}
async function setup(terminals: HcTerminal[], extra: Record<string, Handler> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-hc-"));
  const socket = join(dir, "herdr.sock");
  const cores: FakeCore[] = [];
  const handlers: Record<string, Handler> = {
    "terminal.list": () => ({ terminals, hidden_finished: 0 }),
    "doc.get": () => ({ value: LAYOUT, version: 1 }),
    "terminal.get": (params) => {
      const found = terminals.find((entry) => entry.address === params["terminal"]);
      if (!found) throw new Error(`no terminal ${String(params["terminal"])}`);
      return { terminal: found };
    },
    "terminal.attach": () => ({ channel: cores.at(-1)!.channel(), terminal: terminals[0] }),
    "terminal.keys": () => ({ turn: 0 }),
    ...extra,
  };
  const hc = new HcConnection(() => {
    const core = new FakeCore(handlers);
    cores.push(core);
    return core;
  });
  const adapter = await startHerdrCoreAdapter(hc, socket);
  cleanups.push(() => { adapter.stop(); hc.close(); rmSync(dir, { recursive: true, force: true }); });
  return { socket, cores, hc };
}

describe("herdr-core adapter", () => {
  it("refuses a second adapter on a live socket and leaves the first serving", async () => {
    const { socket, hc } = await setup([terminal("t1")]);
    await sessionSnapshot(socket);
    await expect((async () => {
      const second = await startHerdrCoreAdapter(hc, socket);
      cleanups.push(() => second.stop());
    })()).rejects.toThrow();
    expect((await sessionSnapshot(socket)).panes.map((pane) => pane.pane_id)).toEqual(["t1"]);
  });

  it("says it is herdr-core, so the browser offers only what herdr-core can do", async () => {
    const { socket } = await setup([terminal("t1")]);
    expect(await ping(socket)).toEqual({ version: "0.1.14", protocol: 22, terminal_attach: true, runtime: "herdr-core" });
  });

  it("answers herdr's session snapshot with the app's spaces over hc's terminals", async () => {
    const { socket } = await setup([terminal("t1", { status: { app: "claude", state: "blocked" } }), terminal("t2")]);
    const snapshot = await sessionSnapshot(socket);
    expect(snapshot.workspaces.map((w) => w.label)).toEqual(["api", "Other terminals"]);
    expect(snapshot.panes.map((p) => [p.pane_id, p.agent, p.agent_status])).toEqual([["t1", "claude", "blocked"], ["t2", null, "unknown"]]);
  });

  it("types send_text into an attach at the terminal's own grid, and answers once hc took the attach's close", async () => {
    const { socket, cores } = await setup([terminal("t1", { cols: 90, rows: 20 })]);
    await paneSendText("t1", "héllo 한글", socket);
    const core = cores[0]!;
    expect(core.calls.find((call) => call.method === "terminal.attach")?.params).toEqual({ terminal: "t1", cols: 90, rows: 20 });
    expect(core.typed).toEqual([{ channel: 1, text: "héllo 한글" }]);
    expect(core.closed).toEqual([1]);
  });

  it("presses keys in order: typed runs together, runs of mode-dependent keys through hc's encoder", async () => {
    const { socket, cores } = await setup([terminal("t1")]);
    await paneSendKeys("t1", ["Escape", "ctrl+shift+left", "x", "alt+|", "Enter", "c-c", "alt+x"], socket);
    const core = cores[0]!;
    expect(core.typed.map((write) => write.text)).toEqual(["x\x1b|\r"]);
    expect(core.calls.filter((call) => call.method === "terminal.keys").map((call) => call.params["keys"])).toEqual([
      ["escape", "ctrl+shift+left"],
      ["ctrl+c", "alt+x"],
    ]);
    const order = core.calls.map((call) => call.method).filter((method) => method === "terminal.attach" || method === "terminal.keys");
    expect(order).toEqual(["terminal.keys", "terminal.attach", "terminal.keys"]);
  });

  it("replaces a socket file a killed server left behind", async () => {
    const { hc } = await setup([terminal("t1")]);
    const dir = mkdtempSync(join(tmpdir(), "ovis-hc-dead-"));
    const dead = join(dir, "herdr.sock");
    // a server that was killed and left its socket file behind
    const gone = Bun.spawn([process.execPath, "-e", `Bun.listen({ unix: ${JSON.stringify(dead)}, socket: { data() {} } }); console.log("up")`], { stdout: "pipe" });
    await gone.stdout.getReader().read();
    gone.kill("SIGKILL");
    await gone.exited;
    expect(existsSync(dead)).toBe(true);
    const adapter = await startHerdrCoreAdapter(hc, dead);
    cleanups.push(() => { adapter.stop(); rmSync(dir, { recursive: true, force: true }); });
    expect((await sessionSnapshot(dead)).panes.map((pane) => pane.pane_id)).toEqual(["t1"]);
  });

  it("refuses what only the Herdr app does, and a pane hc does not have, in herdr's codes", async () => {
    const { socket } = await setup([terminal("t1")]);
    const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof HerdrError ? error.code : String(error)));
    expect(await failure(herdrRpc("pane.split", { pane_id: "t1", direction: "right" }, socket))).toBe("unsupported");
    expect(await failure(paneGet("t9", socket))).toBe("pane_not_found");
    expect(await failure(paneSendText("t9", "x", socket))).toBe("pane_not_found");
  });

  it("streams status for the subscribed panes only, a finish as herdr's exit and close, and ends on hc's missed", async () => {
    let channel = 0;
    const { socket, cores } = await setup([terminal("t1"), terminal("t2")], {
      "events.subscribe": () => {
        channel = cores.at(-1)!.channel();
        return { channel, seq: 1, terminals: [] };
      },
    });
    const frames: EventFrame[] = [];
    const started = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const subscription = subscribeEvents([{ type: "pane.created" }, { type: "pane.agent_status_changed", pane_id: "t1" }], {
      onEvent: (frame) => frames.push(frame),
      onStarted: () => started.resolve(),
      onClose: () => ended.resolve(),
    }, socket);
    cleanups.push(() => subscription.close());
    await started.promise;
    const core = cores[0]!;
    core.notify(channel, "event", { seq: 2, type: "status", terminal: "t2", data: { status: { app: "codex", state: "working" } } });
    core.notify(channel, "event", { seq: 3, type: "status", terminal: "t1", data: { status: { app: "omp", state: "error" } } });
    core.notify(channel, "event", { seq: 4, type: "title", terminal: "t1", data: { title: "spinner" } });
    core.notify(channel, "event", { seq: 5, type: "finished", terminal: "t1", data: { reason: "exited", exit_code: 0 } });
    core.notify(channel, "missed", { seq: 9, terminals: [] });
    await ended.promise;
    expect(frames).toEqual([
      { event: "pane.agent_status_changed", data: { pane_id: "t1", agent_status: "unknown", agent: "omp" } },
      { event: "pane.exited", data: { type: "pane_exited", pane_id: "t1" } },
      { event: "pane.closed", data: { type: "pane_closed", pane_id: "t1" } },
    ]);
    // the subscription that ended lets go of hc's stream too
    expect(core.closed).toContain(channel);
  });

  it("acknowledges before an event bundled with the hc subscribe response", async () => {
    const { socket, cores } = await setup([terminal("t1")], {
      "events.subscribe": () => ({ channel: cores[0]!.channel(), seq: 1, terminals: [] }),
    });
    await sessionSnapshot(socket);
    cores[0]!.replyTail = encodeFrame(1, FRAME_DATA, `${JSON.stringify({ method: "event", params: { type: "created", terminal: "t1" } })}\n`);
    const order: (string | undefined)[] = [];
    const received = Promise.withResolvers<EventFrame>();
    const subscription = subscribeEvents([{ type: "pane.created" }], {
      onStarted: () => order.push("ack"),
      onEvent: (event) => { order.push(event.event); received.resolve(event); },
      onError: (error) => received.reject(error),
    }, socket);
    cleanups.push(() => subscription.close());
    expect(await received.promise).toEqual({ event: "pane.created", data: { type: "pane_created", pane_id: "t1" } });
    expect(order).toEqual(["ack", "pane.created"]);
  });

  it("fails what waited on a line to hc that ended, and opens a new one for the next call", async () => {
    const { socket, cores } = await setup([terminal("t1")]);
    await sessionSnapshot(socket);
    cores[0]!.kill();
    await cores[0]!.exited;
    const snapshot = await sessionSnapshot(socket);
    expect(snapshot.panes.map((pane) => pane.pane_id)).toEqual(["t1"]);
    expect(cores.length).toBe(2);
  });

  for (const newline of ["", "\n"]) {
    it(`closes an oversized event line across frames ${newline ? "with" : "without"} a newline with an error`, async () => {
      let channel = 0;
      const { socket, cores } = await setup([terminal("t1")], {
        "events.subscribe": () => {
          channel = cores.at(-1)!.channel();
          return { channel, seq: 1, terminals: [] };
        },
      });
      const started = Promise.withResolvers<void>();
      const ended = Promise.withResolvers<void>();
      const errors: Error[] = [];
      const frames: EventFrame[] = [];
      const subscription = subscribeEvents([{ type: "pane.created" }], {
        onStarted: () => started.resolve(),
        onClose: () => ended.resolve(),
        onError: (error) => errors.push(error),
        onEvent: (event) => frames.push(event),
      }, socket);
      cleanups.push(() => subscription.close());
      await started.promise;
      const core = cores[0]!;
      core.data(channel, " ".repeat(3 * 1024 * 1024));
      core.data(channel, " ".repeat(1024 * 1024 + 1) + newline);
      await ended.promise;
      expect(errors.map((error) => error instanceof HerdrError ? error.code : error.name)).toEqual(["bad_frame"]);
      expect(frames).toEqual([]);
      expect(core.closed).toEqual([channel]);
    });
  }

describe("herdr-core adapter, new and closed terminals", () => {
  /** a core whose terminal list follows its own terminal.run, terminal.kill and terminal.rm */
  async function living(start: HcTerminal[]) {
    const terminals = [...start];
    const runs: Record<string, unknown>[] = [];
    const ends: string[] = [];
    let next = terminals.length + 1;
    const ready = await setup(terminals, {
      "terminal.run": (params) => {
        runs.push(params);
        const record = terminal(`t${next++}`, { cwd: typeof params["cwd"] === "string" ? params["cwd"] : "/home/u", labels: params["labels"] as Record<string, string> });
        terminals.push(record);
        return record;
      },
      "terminal.kill": (params) => {
        ends.push(`kill ${String(params["terminal"])}`);
        const found = terminals.find((entry) => entry.address === params["terminal"]);
        if (!found) throw new Error("no terminal");
        found.state = "finished";
        return found;
      },
      "terminal.rm": (params) => {
        ends.push(`rm ${String(params["terminal"])}`);
        terminals.splice(terminals.findIndex((entry) => entry.address === params["terminal"]), 1);
        return { removed: params["terminal"] };
      },
    });
    return { ...ready, runs, ends };
  }

  it("starts a new workspace as a kept shell labeled with a space and tab of its own, named as asked", async () => {
    const { socket, runs } = await living([terminal("t1")]);
    const created = await workspaceCreate({ cwd: "/work/web", label: "web" }, socket);
    const labels = runs[0]!["labels"] as Record<string, string>;
    expect(runs[0]).toMatchObject({ keep: true, cwd: "/work/web" });
    expect(labels["herdr.space"]).toMatch(/^ovis-/);
    expect(labels["herdr.tab"]).toMatch(/^ovis-/);
    expect(labels["ovis.workspace"]).toBe("web");
    expect(created.workspace).toMatchObject({ workspace_id: labels["herdr.space"], label: "web" });
    expect(created.tab).toMatchObject({ tab_id: labels["herdr.tab"], workspace_id: labels["herdr.space"] });
    expect(created.root_pane).toMatchObject({ pane_id: "t2", terminal_id: "t2", tab_id: labels["herdr.tab"] });
  });

  it("starts a new tab in the app's space, where that space's first pane works, and one in Other terminals on its own", async () => {
    const { socket, runs } = await living([terminal("t1", { cwd: "/repo/api" })]);
    const tab = await tabCreate({ workspaceId: "s1", label: "logs" }, socket);
    expect(runs[0]).toMatchObject({ keep: true, cwd: "/repo/api" });
    expect(runs[0]!["labels"]).toMatchObject({ "herdr.space": "s1", "ovis.tab": "logs" });
    expect(tab.tab).toMatchObject({ workspace_id: "s1", label: "logs" });
    expect(tab.root_pane.pane_id).toBe("t2");
    await tabCreate({ workspaceId: "hc-other" }, socket);
    expect(runs[1]!["labels"]).toEqual({});
    await expect(tabCreate({ workspaceId: "nope" }, socket)).rejects.toMatchObject({ code: "workspace_not_found" });
  });

  it("closes a pane, a tab or a workspace by ending each of its terminals and removing its record", async () => {
    const { socket, ends } = await living([terminal("t1"), terminal("t2", { labels: { "herdr.space": "s1", "herdr.tab": "s1t2" } }), terminal("t3")]);
    await paneClose("t3", socket);
    expect(ends).toEqual(["kill t3", "rm t3"]);
    await tabClose("s1t2", socket);
    expect(ends.slice(2)).toEqual(["kill t2", "rm t2"]);
    await workspaceClose("s1", socket);
    expect(ends.slice(4)).toEqual(["kill t1", "rm t1"]);
    expect((await sessionSnapshot(socket)).panes).toEqual([]);
    await expect(paneClose("t9", socket)).rejects.toMatchObject({ code: "pane_not_found" });
  });

  it("closes only a tab's own terminal when labels name the same ids in other spaces", async () => {
    // t1 is the app's own (the layout document places it); t5 to t7 are labeled only
    const { socket, ends } = await living([
      terminal("t1"),
      terminal("t5", { labels: { "herdr.space": "S", "herdr.tab": "T" } }),
      terminal("t6", { labels: { "herdr.space": "T" } }),
      terminal("t7", { labels: { "herdr.space": "Y", "herdr.tab": "T" } }),
    ]);
    await tabClose("T", socket);
    expect(ends).toEqual(["kill t5", "rm t5"]);
  });

  it("refuses to close Other terminals as a whole: its jobs and agents' workers are no workspace's", async () => {
    const { socket, ends } = await living([terminal("t1"), terminal("t5")]);
    await expect(workspaceClose("hc-other", socket)).rejects.toMatchObject({ code: "unsupported" });
    expect(ends).toEqual([]);
  });

  it("ends every terminal of a closed workspace at once, and answers a failure only after trying them all", async () => {
    const kills: string[] = [];
    const held = Promise.withResolvers<void>();
    const terminals = [terminal("t1"), terminal("t2", { labels: { "herdr.space": "s1", "herdr.tab": "s1t2" } })];
    const { socket } = await setup(terminals, {
      "terminal.kill": (params) => {
        kills.push(String(params["terminal"]));
        if (kills.length === 2) held.resolve();
        if (params["terminal"] === "t1") throw new Error("kill refused");
        return {};
      },
      "terminal.rm": () => ({}),
    });
    await expect(workspaceClose("s1", socket)).rejects.toMatchObject({ message: expect.stringContaining("kill refused") });
    await held.promise;
    expect(kills.sort()).toEqual(["t1", "t2"]);
  });
});

describe("herdr-core adapter, agents", () => {
  it("starts an agent by typing its kind and quoted arguments into the pane's idle shell, and answers once it is in front", async () => {
    const shell = { pid: 10, name: "bash" };
    const agent = { pid: 11, name: "claude" };
    const record = terminal("t1", { cols: 90, rows: 20, pid: 10, argv: ["/bin/bash"], foreground: shell });
    const { socket, cores } = await setup([record], {
      // hc's foreground: the shell until the line was typed, then the agent
      "terminal.get": () => ({ terminal: { ...record, foreground: cores[0]!.typed.length > 0 ? agent : shell } }),
    });
    await agentStart({ name: "claude-1", kind: "claude", paneId: "t1", args: ["--model", "it's big"] }, socket);
    const core = cores[0]!;
    expect(core.calls.find((call) => call.method === "terminal.attach")?.params).toMatchObject({ terminal: "t1", cols: 90, rows: 20 });
    expect(core.typed.map((write) => write.text).join("")).toBe("\u0015'claude' '--model' 'it'\\''s big'\r");
    // it looked again after typing: the answer follows what hc saw in front
    const methods = core.calls.map((call) => call.method);
    expect(methods.lastIndexOf("terminal.get")).toBeGreaterThan(methods.indexOf("terminal.attach"));
  });

  it("counts an agent run through its interpreter as started, and a shell's command-not-found handler as a failed start", async () => {
    const shell = { pid: 10, name: "bash" };
    // hc's foreground: the shell until the line is typed, then each later look sees the next one
    const sequence = (after: { pid: number; name: string; argv?: string[] }[]) => {
      const record = terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: shell });
      const holder: { cores: FakeCore[] } = { cores: [] };
      let seen = 0;
      const get = () => ({ terminal: { ...record, foreground: holder.cores[0]?.typed.length ? after[Math.min(seen++, after.length - 1)] : shell } });
      return { record, holder, get };
    };
    const node = sequence([{ pid: 11, name: "node", argv: ["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"] }]);
    const started = await setup([node.record], { "terminal.get": node.get });
    node.holder.cores = started.cores;
    await agentStart({ name: "claude-1", kind: "claude", paneId: "t1" }, started.socket);
    const missing = sequence([{ pid: 12, name: "python3", argv: ["/usr/bin/python3", "/usr/lib/command-not-found", "--", "amp"] }, shell]);
    const failed = await setup([missing.record], { "terminal.get": missing.get });
    missing.holder.cores = failed.cores;
    await expect(agentStart({ name: "amp-1", kind: "amp", paneId: "t1" }, failed.socket)).rejects.toMatchObject({ code: "agent_start_failed" });
  });

  it("lets what is typed after a start reach the pane while the start waits for its agent", async () => {
    const shell = { pid: 10, name: "bash" };
    const record = terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: shell });
    const holder: { cores: FakeCore[]; agentUp: boolean } = { cores: [], agentUp: false };
    const ready = await setup([record], { "terminal.get": () => ({ terminal: { ...record, foreground: holder.agentUp ? { pid: 11, name: "claude" } : shell } }) });
    holder.cores = ready.cores;
    const starting = agentStart({ name: "claude-1", kind: "claude", paneId: "t1" }, ready.socket);
    let started = false;
    void starting.then(() => { started = true; });
    // typed while the agent is not in front yet: it goes in, and the start is still waiting
    await paneSendText("t1", "hi", ready.socket);
    expect(holder.cores[0]!.typed.map((write) => write.text)).toContain("hi");
    expect(started).toBe(false);
    holder.agentUp = true;
    await starting;
  });

  it("types Cursor's agent command, not the IDE's, and waits for it in front", async () => {
    const shell = { pid: 10, name: "bash" };
    const record = terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: shell });
    const holder: { cores: FakeCore[] } = { cores: [] };
    const ready = await setup([record], { "terminal.get": () => ({ terminal: { ...record, foreground: holder.cores[0]?.typed.length ? { pid: 11, name: "cursor-agent" } : shell } }) });
    holder.cores = ready.cores;
    await agentStart({ name: "cursor-1", kind: "cursor", paneId: "t1" }, ready.socket);
    expect(ready.cores[0]!.typed.map((write) => write.text).join("")).toBe("\u0015'cursor-agent'\r");
  });

  it("refuses a pane with a program in front, a kind that is no command, and an argument with a control character", async () => {
    const { socket, cores } = await setup([terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: { pid: 12, name: "vim" } })]);
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    await expect(agentStart({ name: "x", kind: "rm -rf /", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1", args: ["a\u0015touch /tmp/x\r"] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t9" }, socket)).rejects.toMatchObject({ code: "pane_not_found" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("types into no pane whose own program is not a shell, even with that program in front of itself", async () => {
    // a terminal the app started as a program: hc reports it in front of itself, like a shell
    const { socket, cores } = await setup([
      terminal("t1", { pid: 10, argv: ["claude"], foreground: { pid: 10, name: "claude", argv: ["claude"] } }),
      // a template or a line: dash runs it as its child and stays in front under its own pid
      terminal("t2", { pid: 20, argv: ["sh", "-c", "claude"], foreground: { pid: 20, name: "sh", argv: ["sh", "-c", "claude"] } }),
    ]);
    // never a shell to start in: refused at once, not retried as a busy one
    await expect(agentStart({ name: "x", kind: "codex", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_unsupported" });
    await expect(agentStart({ name: "y", kind: "codex", paneId: "t2" }, socket)).rejects.toMatchObject({ code: "agent_pane_unsupported" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("types into no shell that exec'd a non-plain shell, and checks fish's quoting on the shell in front", async () => {
    const { socket, cores } = await setup([
      terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: { pid: 10, name: "bash", argv: ["bash", "-c", "read line"] } }),
      terminal("t2", { pid: 20, argv: ["/bin/bash"], foreground: { pid: 20, name: "fish", argv: ["fish"] } }),
    ]);
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t1", timeoutMs: 300 }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    await expect(agentStart({ name: "y", kind: "claude", paneId: "t2", args: ["C:\\dir"] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("refuses a backslash fish would read differently", async () => {
    const fish = { pid: 20, name: "fish", argv: ["/usr/bin/fish"] };
    const { socket, cores } = await setup([terminal("t2", { pid: 20, argv: ["/usr/bin/fish"], foreground: fish })]);
    await expect(agentStart({ name: "x", kind: "claude", paneId: "t2", args: ["C:\\dir"] }, socket)).rejects.toMatchObject({ code: "invalid_params" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("starts in a login shell", async () => {
    const login = { pid: 10, name: "zsh", argv: ["-zsh", "-l"] };
    const record = terminal("t1", { pid: 10, argv: ["-zsh", "-l"], foreground: login });
    const holder: { cores: FakeCore[] } = { cores: [] };
    const ready = await setup([record], { "terminal.get": () => ({ terminal: { ...record, foreground: holder.cores[0]?.typed.length ? { pid: 11, name: "claude" } : login } }) });
    holder.cores = ready.cores;
    await agentStart({ name: "y", kind: "claude", paneId: "t1" }, ready.socket);
    expect(ready.cores[0]!.typed.map((write) => write.text).join("")).toBe("\u0015'claude'\r");
  });

  it("types into no shell that has become another program with exec, its pid unchanged", async () => {
    const { socket, cores } = await setup([terminal("t1", { pid: 10, argv: ["/bin/bash"], foreground: { pid: 10, name: "claude", argv: ["claude"] } })]);
    await expect(agentStart({ name: "x", kind: "codex", paneId: "t1" }, socket)).rejects.toMatchObject({ code: "agent_pane_busy" });
    expect(cores[0]!.typed).toEqual([]);
  });

  it("offers the agents Ovis knows by kind, leaving the ones Ovis starts itself to the server", async () => {
    const { socket } = await setup([terminal("t1")]);
    const kinds = (await agentManifests(socket)).manifests.map((manifest) => manifest.agent);
    expect(kinds).toContain("claude");
    expect(kinds).toContain("codex");
    expect(kinds).not.toContain("omo");
  });
});
});
