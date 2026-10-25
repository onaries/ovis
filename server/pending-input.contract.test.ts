import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import * as herdrClient from "./herdr/client.ts";
import { herdrRpc, paneRead, paneScrollInfo, sessionSnapshot } from "./herdr/client.ts";
import { noteSubmitted, parseInteractivePrompt } from "./prompt.ts";
import type { PendingMessage, ServerMessage } from "../shared/protocol.ts";
import * as processStart from "./process-start.ts";
import * as pendingInput from "./pending-input.ts";
import { OmoStatus } from "./omo-status.ts";
import * as claudeStore from "./claude-store.ts";
import * as agentLaunchModule from "./agent-launch.ts";

type PendingUpdate = Extract<ServerMessage, { type: "pending-messages" }>;

const root = mkdtempSync(join(tmpdir(), "ovis-pending-"));
const active: Array<{ stop: () => void; sockets: Socket[]; workspace: string }> = [];
let next = 0;
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
// The bridge's paste and its committing key, held as a slow herdr connect would hold them (#666).
// Without a hold they go straight to herdr; this file runs in a process of its own (ci-tests.ts).
const sendText = herdrClient.paneSendText;
const sendKeys = herdrClient.paneSendKeys;
let connectHold: { rpc: "text" | "keys"; reached: () => void; release: Promise<void> } | null = null;
const holding = async (rpc: "text" | "keys"): Promise<void> => {
  const hold = connectHold;
  if (hold?.rpc !== rpc) return;
  connectHold = null; hold.reached(); await hold.release;
};
/** Each text, key (a draft clear's among them) and agent.prompt write the bridge asks herdr for, as `<kind> <pane>`. */
const herdrWrites: string[] = [];
const agentPrompt = herdrClient.agentPrompt;
mock.module("./herdr/client.ts", () => ({
  ...herdrClient,
  agentPrompt: async (...args: Parameters<typeof agentPrompt>) => { herdrWrites.push(`prompt ${args[0]}`); return agentPrompt(...args); },
  paneSendText: async (...args: Parameters<typeof sendText>) => { herdrWrites.push(`text ${args[0]}`); if (args[1].startsWith("\u001b[200~")) await holding("text"); return sendText(...args); },
  paneSendKeys: async (...args: Parameters<typeof sendKeys>) => { herdrWrites.push(`keys ${args[0]}`); await holding("keys"); return sendKeys(...args); },
}));
// The create routes' launch, for the first-message cases: nothing is started (an agent kind may be a
// real program on this PC); the case starts its recorder in the pane itself, after the route answered,
// as a real agent comes up after herdr typed its launch.
// Only while `standInLaunch` is set; every other launch (another contract file in the same process) is the real one.
const launches: string[] = [];
const realLaunch = agentLaunchModule.agentLaunch;
let standInLaunch = false;
/** the process the stood-in launch says it brought up, as a shell-started agent's launch does */
let standInPid: number | null = null;
mock.module("./agent-launch.ts", () => ({
  ...agentLaunchModule,
  agentLaunch: async (...args: Parameters<typeof realLaunch>) => {
    if (!standInLaunch) return realLaunch(...args);
    launches.push(String(args[1].kind));
    if (standInPid !== null) args[2]?.(standInPid);
    return { agent_started: true as const };
  },
}));
/** Holds the next paste (`text`) or key (`keys`) RPC before it connects; `reached` resolves there. */
function holdConnect(rpc: "text" | "keys"): { reached: Promise<void>; release: () => void } {
  let release!: () => void; let reached!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  const at = new Promise<void>((resolve) => { reached = resolve; });
  connectHold = { rpc, reached, release: done };
  return { reached: at, release };
}
const approval = "Would you like to run the following command?\n\n$ rm -rf junk\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n";
const codexSteering = (entry = "send this now") => `• Working (2s • esc to interrupt)\n• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ ${entry}\n› Ask Codex to do anything\n  gpt-6.1 default · /workspace\n`;

class Socket {
  readonly seen: any[] = [];
  private readonly ws: WebSocket;
  constructor(port: number) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.addEventListener("message", (event) => this.seen.push(JSON.parse(String((event as MessageEvent).data))));
  }
  async wait(predicate: (frame: any) => boolean, from = 0): Promise<any> {
    const deadline = Date.now() + 15_000;
    while (true) {
      const value = this.seen.slice(from).find(predicate);
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(`pending frame timeout: ${JSON.stringify(this.seen.slice(-5))}`);
      await Bun.sleep(25);
    }
  }
  /** Subscribe before triggering a state transition; retain already received frames. */
  event(predicate: (frame: PendingUpdate) => boolean, from = 0): Promise<PendingUpdate> {
    const found = this.seen.slice(from).find((frame) => frame.type === "pending-messages" && predicate(frame));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.ws.removeEventListener("message", received); reject(new Error("pending event timeout")); }, 15_000);
      const received = (event: MessageEvent) => {
        const frame: ServerMessage = JSON.parse(String(event.data));
        if (frame.type !== "pending-messages" || !predicate(frame)) return;
        clearTimeout(timeout); this.ws.removeEventListener("message", received); resolve(frame);
      };
      this.ws.addEventListener("message", received);
    });
  }
  send(frame: unknown) { this.ws.send(JSON.stringify(frame)); }
  result(id: number) { return this.wait((frame) => frame.type === "submit-result" && frame.id === id); }
  action(id: number) { return this.wait((frame) => frame.type === "pending-result" && frame.id === id); }
  /** this connection's id, from its first snapshot: what a create request names as `first_message_connection` */
  async connection(): Promise<string> { return (await this.wait((frame) => frame.type === "snapshot")).connection; }
  /** `chat`: as the chat lens attaches, over a covered grid */
  async attach(pane: string, chat = false) {
    await this.wait((frame) => frame.type === "snapshot");
    this.send({ type: "attach", pane_id: pane, cols: 100, rows: 30, ...(chat ? { keep_size: true } : {}) });
    await this.wait((frame) => frame.type === "input-ready" && frame.pane_id === pane && frame.ready !== false);
  }
  close() { this.ws.close(); }
  async disconnect() { await new Promise<void>((resolve) => { this.ws.addEventListener("close", () => resolve(), { once: true }); this.close(); }); }
}

beforeAll(() => {
  // The recorder polls its screen file: fs.watch can drop the change that follows writeFileSync's
  // truncation, leaving the cleared screen it read in between up for good.
  writeFileSync(join(root, "record.cjs"), `const fs=require("node:fs");const out=process.argv[2];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h"+(process.argv[3]||"").replace(/\\\\x1b/g,"\\x1b"),()=>fs.writeFileSync(out,""));process.stdin.on("data",c=>fs.appendFileSync(out,JSON.stringify(c.toString("utf8"))+"\\n"));let shown="";setInterval(()=>{const next=fs.readFileSync(process.argv[4],"utf8");if(next!==shown){shown=next;process.stdout.write("\\x1b[2J\\x1b[H"+next);}},20);`);
  for (const name of ["claude", "codex", "omp", "plain"]) { copyFileSync(process.execPath, join(root, name)); chmodSync(join(root, name), 0o755); }
});
afterEach(async () => {
  for (const item of active.splice(0)) { for (const socket of item.sockets) socket.close(); item.stop(); await herdrRpc("workspace.close", { workspace_id: item.workspace }).catch(() => undefined); }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function setup(label: string, agent = "claude", screen = "› Message\n", options: Parameters<typeof createServer>[0] = {}, replaceable = false) {
  const id = ++next;
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { label: `ovis-test-pending-${label}`, cwd: root, focus: false });
  // registered before anything below can throw, so afterEach closes the workspace of a setup that failed
  const entry: (typeof active)[number] = { stop: () => {}, sockets: [], workspace: created.workspace.workspace_id }; active.push(entry);
  const pane = created.root_pane.pane_id;
  const log = join(root, `${id}.jsonl`);
  const screenFile = join(root, `${id}.screen`);
  writeFileSync(screenFile, "");
  const command = `'${join(root, agent)}' '${join(root, "record.cjs")}' '${log}' '${screen.replace(/\n/g, "\r\n")}' '${screenFile}'`;
  // The shell immediately starts SESSION2 once SESSION1 exits, preserving terminal and lease.
  const replacementLog = join(root, `${id}-replacement.jsonl`);
  await herdrRpc("pane.send_text", { pane_id: pane, text: replaceable
    ? `${command}; exec '${join(root, agent)}' '${join(root, "record.cjs")}' '${replacementLog}' 'SESSION2' '${screenFile}'\n`
    : `exec ${command}\n` });
  const deadline = Date.now() + 10_000;
  while (!existsSync(log)) { if (Date.now() > deadline) throw new Error("recorder did not start"); await Bun.sleep(25); }
  // "plain" is a program herdr knows as no agent
  if (agent !== "plain") await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent, state: "working" });
  const server = createServer({ ...options, port: 0, stateDir: join(root, `state-${id}`) });
  entry.stop = server.stop;
  const socket = new Socket(server.port); entry.sockets.push(socket);
  await socket.attach(pane);
  const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  const waitBytes = async (ending: string) => {
    const deadline = Date.now() + 8_000;
    while (!bytes().endsWith(ending)) { if (Date.now() >= deadline) throw new Error(`input timeout: ${JSON.stringify(bytes())}`); await Bun.sleep(25); }
  };
  const state = async (value: string, reader = socket) => {
    const from = reader.seen.length;
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent, state: value });
    await reader.wait((frame) => frame.type === "pane-status" && frame.pane_id === pane && (value === "idle" || value === "unknown" ? ["idle", "done"].includes(frame.agent_status) : frame.agent_status === value), from);
  };
  // `ending`: what the screen ends with once drawn, for a text taller than the pane
  // and a new screen that ends as the last one did is told apart by its colors and spacing
  const showScreen = async (text: string, ending = text) => {
    const drawn = async () => (await paneRead({ paneId: pane, source: "visible", format: "ansi" })).text;
    const before = await drawn();
    writeFileSync(screenFile, text);
    const deadline = Date.now() + 5_000;
    while (await drawn() === before || !(await paneRead({ paneId: pane, source: "visible", format: "text" })).text.trimEnd().endsWith(ending.trimEnd())) {
      if (Date.now() >= deadline) throw new Error("recorder screen did not update");
      await Bun.sleep(25);
    }
  };
  const queue = async (id: number, text: string): Promise<PendingMessage> => {
    socket.send({ type: "submit", id, pane_id: pane, text, payload: "unused\r", delivery: "queue" });
    const answer = await socket.result(id); expect(answer.ok).toBe(true); expect(answer.pending?.request_id).toBe(id); return answer.pending;
  };
  const removed = (id: string, outcome = "sent", reader = socket) => reader.wait((frame) => frame.type === "pending-messages" && frame.pane_id === pane && frame.removed?.some((entry: any) => entry.id === id && entry.outcome === outcome));
  const another = async (attach = true, chat = false) => { const reader = new Socket(server.port); entry.sockets.push(reader); if (attach) await reader.attach(pane, chat); else await reader.wait((frame) => frame.type === "snapshot"); return reader; };
  return { screenFile, pane, port: server.port, server, socket, bytes, waitBytes, state, showScreen, queue, removed, another, replacementLog };
}

describe("connection-owned pending input", () => {
  it.each([
    { agent: "omp", text: "/model", expected: "/switch" },
    { agent: "codex", text: "/model", expected: "/model" },
    { agent: "omp", text: "/model x", expected: "/model x" },
  ])("delivers queued $text as $expected to $agent", async ({ agent, text, expected }) => {
    // Given a command queued while the agent is working.
    const f = await setup("queued-model", agent, "");
    const message = await f.queue(1476, text);
    const delivered = f.socket.event((frame) => frame.removed?.some((entry) => entry.id === message.id && entry.outcome === "sent") === true);
    const recorded = new Promise<void>((resolve, reject) => {
      const watcher = watch(root, () => {
        if (!f.bytes().endsWith("\r")) return;
        clearTimeout(timeout); watcher.close(); resolve();
      });
      const timeout = setTimeout(() => { watcher.close(); reject(new Error("queued command was not recorded")); }, 8_000);
    });
    // When the agent finishes its turn.
    await f.state("idle");
    await Promise.all([delivered, recorded]);
    // Then the terminal receives the same command the immediate path would send.
    expect(f.bytes()).toBe(`${paste(expected)}\r`);
  });

  it("holds a queued message when a hookless agent process is replaced in the same terminal (regression #540)", async () => {
    const f = await setup("process-replaced", "claude", "SESSION1", {}, true);
    const before = await herdrClient.paneGet(f.pane);
    const process = (await herdrClient.paneProcessInfo(f.pane))?.foreground_processes?.find((entry) => entry.name === "claude");
    if (!process) throw new Error("SESSION1 has no foreground claude process");
    const message = await f.queue(540, "MSG-FOR-SESSION-1");
    expect(before.agent_session ?? null).toBeNull(); // control: no native session distinguishes the processes
    expect(f.bytes()).toBe(""); // control: enqueue never types while working
    const started = new Promise<void>((resolve, reject) => {
      const watcher = watch(root, () => {
        if (!existsSync(f.replacementLog)) return;
        clearTimeout(timeout); watcher.close(); resolve();
      });
      const timeout = setTimeout(() => { watcher.close(); reject(new Error("SESSION2 did not start")); }, 10_000);
    });
    globalThis.process.kill(process.pid, "SIGKILL");
    await started;
    const after = await herdrClient.paneGet(f.pane);
    const replacement = (await herdrClient.paneProcessInfo(f.pane))?.foreground_processes?.find((entry) => entry.name === "claude");
    expect(after.terminal_id).toBe(before.terminal_id); // control: same terminal and attach
    expect(replacement).toBeDefined(); // control: SESSION2 is a live foreground agent
    expect(replacement?.pid).not.toBe(process.pid); // control: the process really changed
    const settled = f.socket.event((frame) => frame.removed?.some((entry) => entry.id === message.id)
      || frame.messages.some((entry) => entry.id === message.id && entry.state === "held"));
    await f.state("idle");
    const outcome = await settled;
    const bytes = readFileSync(f.replacementLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
    expect(outcome.messages).toContainEqual(expect.objectContaining({
      id: message.id, state: "held", error: expect.objectContaining({ code: "pending_target_changed" }),
    })); // regression: replacement is held instead of automatic delivery
    expect(bytes).not.toContain("MSG-FOR-SESSION-1"); // regression: SESSION2 receives nothing
  }, 30_000);

  it("delivers to the same hookless process with unchanged pid and birth (control #540)", async () => {
    const f = await setup("same-process");
    const before = (await herdrClient.paneProcessInfo(f.pane))?.foreground_processes?.[0];
    if (!before) throw new Error("No foreground recorder");
    const birth = processStart.processStartedAt(before.pid);
    const message = await f.queue(541, "same process");
    const removed = f.socket.event((frame) => frame.removed?.some((entry) => entry.id === message.id) === true);
    await f.state("idle"); await removed; await f.waitBytes("\r");
    const after = (await herdrClient.paneProcessInfo(f.pane))?.foreground_processes?.[0];
    expect(after?.pid).toBe(before.pid); // control
    const afterBirth = processStart.processStartedAt(before.pid);
    if (globalThis.process.platform === "darwin" && birth !== null && afterBirth !== null) {
      expect(Math.abs(afterBirth - birth)).toBeLessThanOrEqual(1000); // control: macOS precision
    } else expect(afterBirth).toBe(birth); // control: Linux birth is exact
    expect(f.bytes()).toBe(`${paste("same process")}\r`); // control
  }, 30_000);

  for (const [drift, delivered] of [[600, true], [1500, false]] as const) {
    it(`${delivered ? "delivers" : "holds"} a same-pid message with ${drift} ms birth drift on darwin (control #540)`, async () => {
      const f = await setup(`darwin-birth-${drift}`);
      const process = (await herdrClient.paneProcessInfo(f.pane))?.foreground_processes?.[0];
      if (!process) throw new Error("No foreground recorder");
      let reading = 100_000;
      const birth = processStart.processStartedAt;
      const compare = pendingInput.samePendingIdentity;
      // Supply macOS's two observations without changing the real recorder, RPCs or delivery.
      const startedAt = spyOn(processStart, "processStartedAt").mockImplementation((pid) => pid === process.pid ? reading : birth(pid));
      const platform = spyOn(pendingInput, "samePendingIdentity").mockImplementation((before, after) => compare(before, after, "darwin"));
      try {
        const message = await f.queue(544, `darwin birth ${drift}`);
        reading += drift;
        const settled = f.socket.event((frame) => frame.removed?.some((entry) => entry.id === message.id)
          || frame.messages.some((entry) => entry.id === message.id && entry.state === "held"));
        await f.state("idle");
        const outcome = await settled;
        if (delivered) {
          expect(outcome.removed).toContainEqual({ id: message.id, outcome: "sent" }); // control: tolerated 600 ms drift
          await f.waitBytes("\r");
          expect(f.bytes()).toBe(`${paste(message.text)}\r`); // control: actual delivery
        } else {
          expect(outcome.messages).toContainEqual(expect.objectContaining({
            id: message.id, state: "held", error: expect.objectContaining({ code: "pending_target_changed" }),
          })); // control: 1500 ms is a different birth, even on the same PID
          expect(f.bytes()).toBe(""); // control: nothing was delivered
        }
      } finally { platform.mockRestore(); startedAt.mockRestore(); }
    }, 30_000);
  }

  it("delivers when an initially unknown native session becomes known (regression #540)", async () => {
    const f = await setup("session-upgrade");
    const message = await f.queue(542, "session became known");
    const snapshot = herdrClient.sessionSnapshot;
    const upgraded = spyOn(herdrClient, "sessionSnapshot").mockImplementation(async (...args) => {
      const current = await snapshot(...args);
      return { ...current, panes: current.panes.map((pane) => pane.pane_id === f.pane
        ? { ...pane, agent_session: { kind: "session_id", source: "cli", value: "now-known", agent: "claude" } } : pane) };
    });
    try {
      const settled = f.socket.event((frame) => frame.removed?.some((entry) => entry.id === message.id)
        || frame.messages.some((entry) => entry.id === message.id && entry.state === "held"));
      await f.state("idle");
      const outcome = await settled;
      expect(outcome.removed ?? []).toContainEqual({ id: message.id, outcome: "sent" }); // regression: learning identity is not replacement
      await f.waitBytes("\r");
      expect(f.bytes()).toBe(`${paste("session became known")}\r`); // control: exactly one delivery
    } finally { upgraded.mockRestore(); }
  }, 30_000);

  it("holds a message when OmO reports a different session on the same process (regression #540)", async () => {
    const f = await setup("omo-session-changed");
    let sessionId = "omo-first";
    const session = spyOn(OmoStatus.prototype, "sessionOf").mockImplementation((paneId) => paneId === f.pane ? { cwd: root, sessionId } : null);
    try {
      const message = await f.queue(543, "for the first omo session");
      sessionId = "omo-second";
      const settled = f.socket.event((frame) => frame.messages.some((entry) => entry.id === message.id && entry.state === "held")
        || frame.removed?.some((entry) => entry.id === message.id) === true);
      await f.state("idle");
      expect((await settled).messages).toContainEqual(expect.objectContaining({
        id: message.id, state: "held", error: expect.objectContaining({ code: "pending_target_changed" }),
      })); // regression: native OmO session is part of pending identity
      expect(f.bytes()).toBe(""); // regression: the new session receives nothing
    } finally { session.mockRestore(); }
  }, 30_000);

  for (const cleared of [true, false]) it(`${cleared ? "holds" : "delivers"} a message when a hookless Claude's PID record ${cleared ? "names another session after /clear" : "keeps its session"} (${cleared ? "regression" : "control"} #540)`, async () => {
    const f = await setup(`claude-session-${cleared ? "cleared" : "kept"}`);
    expect((await herdrClient.paneGet(f.pane)).agent_session ?? null).toBeNull(); // control: herdr reports no session
    let sessionId = "11111111-1111-4111-8111-111111111111";
    // the recorder runs as `claude`; its PID record is supplied, so no real Claude store is read
    const session = spyOn(claudeStore, "claudeForegroundSession").mockImplementation(async (processes) =>
      processes.some((entry) => entry.name === "claude") ? sessionId : null);
    try {
      const message = await f.queue(545, "for the session before clear");
      if (cleared) sessionId = "22222222-2222-4222-8222-222222222222";
      const settled = f.socket.event((frame) => frame.messages.some((entry) => entry.id === message.id && entry.state === "held")
        || frame.removed?.some((entry) => entry.id === message.id) === true);
      await f.state("idle");
      const outcome = await settled;
      if (cleared) {
        expect(outcome.messages).toContainEqual(expect.objectContaining({
          id: message.id, state: "held", error: expect.objectContaining({ code: "pending_target_changed" }),
        })); // regression: a session switched inside the same process is held
        expect(f.bytes()).toBe(""); // regression: the new session receives nothing
      } else {
        expect(outcome.removed).toContainEqual({ id: message.id, outcome: "sent" }); // control
        await f.waitBytes("\r");
        expect(f.bytes()).toBe(`${paste(message.text)}\r`); // control: delivered once
      }
    } finally { session.mockRestore(); }
  }, 30_000);

  for (const originalFirst of [false, true]) it(`regression: two connections share refusal then retry a new attempt once (original first=${originalFirst})`, async () => {
    const rule = "\u2500".repeat(60), footer = "[Haiku 4.5] \u2502 project";
    const f = await setup("copy-retry", "claude", `  \u273b Cooked for 1s\n${rule}\n\u276f occupied draft\n${rule}\n  ${footer}\n`);
    let resendId = "retry-copy-id";
    if (originalFirst) {
      f.socket.send({ type: "submit", id: 0, pane_id: f.pane, text: "retry copy", payload: "unused", delivery: "hold" });
      const held = await f.socket.result(0);
      expect(held.pending?.state).toBe("held");
      resendId = held.pending.id;
    }
    await f.state("idle");
    const other = await f.another();
    const send = (socket: Socket, id: number, generation: number) => socket.send(originalFirst && socket === f.socket
      ? { type: "pending-action", id, pane_id: f.pane, pending_id: resendId, action: "steer", resend_generation: generation }
      : { type: "submit", id, pane_id: f.pane, text: "retry copy", payload: paste("retry copy"), resend_id: resendId, resend_generation: generation });
    const originalResult = (id: number) => originalFirst ? f.socket.action(id) : f.socket.result(id);
    send(f.socket, 1, 0); send(other, 2, 0);
    expect(await originalResult(1)).toMatchObject({ ok: false, code: "input_draft" });
    expect(await other.result(2)).toMatchObject({ ok: false, code: "input_draft" });
    let output = "";
    const processed = new Set<object>();
    const drawn = f.socket.wait((frame) => {
      if (frame.type !== "pty-data" || processed.has(frame)) return false;
      processed.add(frame); output += frame.data;
      return output.includes("run the tests");
    }, f.socket.seen.length);
    writeFileSync(f.screenFile, `  \u273b Cooked for 1s\n${rule}\n\u276f \u001b[2mrun the tests\u001b[0m\n${rule}\n  ${footer} \n`);
    await drawn;
    send(other, 3, 0);
    expect(await other.result(3)).toMatchObject({ ok: false, code: "input_draft" });
    send(f.socket, 4, 1); send(other, 5, 1);
    expect(await originalResult(4)).toMatchObject({ ok: true });
    expect(await other.result(5)).toMatchObject({ ok: true });
    other.send({ type: "submit", id: 6, pane_id: f.pane, text: "retry-barrier", payload: "retry-barrier", typed: true });
    expect(await other.result(6)).toMatchObject({ ok: true });
    await f.waitBytes("retry-barrier\r");
    expect(f.bytes().split("retry copy").length - 1).toBe(1);
  }, 30_000);
  for (const copyFirst of [false, true]) it(`regression: shares a held row's send with its saved copy (copy first=${copyFirst})`, async () => {
    const f = await setup("cross-tab-held");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "held cross tab", payload: "unused", delivery: "hold" });
    const answer = await f.socket.result(1);
    expect(answer.pending?.state).toBe("held");
    await f.state("idle");
    const other = await f.another();
    const copy = () => other.send({ type: "submit", id: 2, pane_id: f.pane, text: "held cross tab", payload: paste("held cross tab"), resend_id: answer.pending.id });
    const original = () => f.socket.send({ type: "pending-action", id: 3, pane_id: f.pane, pending_id: answer.pending.id, action: "steer" });
    if (copyFirst) { copy(); expect(await other.result(2)).toMatchObject({ ok: true }); original(); }
    else { original(); expect(await f.socket.action(3)).toMatchObject({ ok: true }); copy(); }
    expect(await other.result(2)).toMatchObject({ ok: true });
    expect(await f.socket.action(3)).toMatchObject({ ok: true });
    other.send({ type: "submit", id: 4, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await other.result(4)).toMatchObject({ ok: true });
    await f.waitBytes("barrier\r");
    expect(f.bytes().split("held cross tab").length - 1).toBe(1);
  }, 30_000);
  it("sends Codex Send now with Enter without interrupting its native steering panel", async () => {
    const f = await setup("codex-send-now", "codex"); const message = await f.queue(1, "send this now");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("send this now")}\r`);
    await f.showScreen(codexSteering());
    expect(await f.socket.action(10)).toMatchObject({ ok: true }); await f.removed(message.id);
    const received = f.socket.seen.length;
    f.socket.send({ type: "pending-action", id: 11, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(11)).toMatchObject({ ok: true });
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.removed?.some((item: any) => item.id === message.id), received);
    expect(f.bytes()).toBe(`${paste("send this now")}\r`);
  }, 30_000);

  it("never interrupts an ordinary queue submit that races from idle into working Codex", async () => {
    const f = await setup("codex-send-race", "codex", "› Message\n", { submitDelayMs: 500 });
    await f.state("idle");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "ordinary send", payload: "unused", delivery: "queue" });
    await f.waitBytes("\u001b[201~"); await f.state("working"); await f.showScreen(codexSteering());
    expect(await f.socket.result(1)).toMatchObject({ ok: true }); await f.waitBytes("\r");
    expect(f.bytes()).toBe(`${paste("ordinary send")}\r`);
  }, 30_000);

  it("does not send Escape when a Codex approval opens after the steering Enter", async () => {
    const f = await setup("codex-menu-after-enter", "codex"); const message = await f.queue(1, "send this now");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.waitBytes("\r"); await f.showScreen(approval);
    expect(await f.socket.action(10)).toMatchObject({ ok: true });
    expect(f.bytes()).toBe(`${paste("send this now")}\r`);
  }, 30_000);

  it("does not send Escape after the pending message's pane was detached", async () => {
    const f = await setup("codex-detach-after-enter", "codex"); const message = await f.queue(1, "send this now");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.waitBytes("\r"); f.socket.send({ type: "detach", pane_id: f.pane });
    expect(await f.socket.action(10)).toMatchObject({ ok: true });
    expect(f.bytes()).toBe(`${paste("send this now")}\r`);
  }, 30_000);

  it("queues any working agent and advances one message per confirmed turn", async () => {
    const f = await setup("automatic");
    const first = await f.queue(1, "한글 👩🏽‍💻\nnext"); const second = await f.queue(2, "second");
    expect(f.bytes()).toBe("");
    await f.state("idle"); await f.removed(first.id); await f.waitBytes("\r");
    expect(f.bytes()).toBe(`${paste(first.text)}\r`);
    const receipt = f.socket.seen.filter((frame) => frame.type === "pending-messages").at(-1);
    expect(receipt.messages.find((message: PendingMessage) => message.id === second.id)?.state).toBe("queued");
    await f.state("working"); await f.state("idle"); await f.removed(second.id); await f.waitBytes(`${paste("second")}\r`);
    expect(f.bytes()).toBe(`${paste(first.text)}\r${paste("second")}\r`);
  }, 30_000);

  it("keeps a held message through the turn's end and sends it only on Send now", async () => {
    const f = await setup("hold");
    expect(f.socket.seen.find((frame) => frame.type === "snapshot")?.features).toContain("pending-hold");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "hold me", payload: "unused\r", delivery: "hold" });
    const answer = await f.socket.result(1);
    expect(answer).toMatchObject({ ok: true, pending: { request_id: 1, state: "held" } });
    expect(answer.pending.error).toBeUndefined();
    await f.state("idle");
    // the turn's end sent nothing: a message typed after it is the first thing the pane gets
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await f.socket.result(2)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r");
    expect(f.bytes()).toBe("barrier\r");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: answer.pending.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: true }); await f.removed(answer.pending.id);
    await f.waitBytes(`${paste("hold me")}\r`);
    expect(f.bytes()).toBe(`barrier\r${paste("hold me")}\r`);
  }, 30_000);

  it("keeps a held message that arrives after the turn ended, typing nothing until Send now", async () => {
    const f = await setup("hold-ready"); await f.state("idle");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "late hold", payload: "unused\r", delivery: "hold" });
    const answer = await f.socket.result(1);
    expect(answer).toMatchObject({ ok: true, pending: { request_id: 1, state: "held" } });
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await f.socket.result(2)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r");
    expect(f.bytes()).toBe("barrier\r");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: answer.pending.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: true }); await f.removed(answer.pending.id);
    await f.waitBytes(`${paste("late hold")}\r`);
    expect(f.bytes()).toBe(`barrier\r${paste("late hold")}\r`);
  }, 30_000);

  it("closes a trailing @file mention with a space before its Enter", async () => {
    const f = await setup("mention");
    const message = await f.queue(1, "look at @/tmp/shot.png");
    await f.state("idle"); await f.removed(message.id); await f.waitBytes("\r");
    expect(f.bytes()).toBe(`${paste("look at @/tmp/shot.png ")}\r`);
  }, 30_000);

  it("promotes a pending message only once and does not send it again after completion", async () => {
    const f = await setup("promote"); const message = await f.queue(1, "steer once");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: true }); await f.removed(message.id); await f.waitBytes("\r");
    const late = f.socket.seen.length;
    f.socket.send({ type: "pending-action", id: 11, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(11)).toMatchObject({ ok: true });
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.removed?.some((entry: any) => entry.id === message.id && entry.outcome === "sent"), late);
    await f.state("idle");
    f.socket.send({ type: "submit", id: 12, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await f.socket.result(12)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r");
    expect(f.bytes()).toBe(`${paste("steer once")}\rbarrier\r`);
  }, 30_000);

  it("arbitrates completion racing with a click without duplicate input", async () => {
    const f = await setup("race"); const message = await f.queue(1, "race once");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.state("idle"); expect(await f.socket.action(10)).toMatchObject({ ok: true });
    await f.removed(message.id); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("race once")}\r`);
  }, 30_000);

  it("discards pending input without typing and keeps owner receipts private", async () => {
    const f = await setup("discard"); const intruder = await f.another(); const message = await f.queue(1, "discard me");
    intruder.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await intruder.action(10)).toMatchObject({ ok: false, code: "pending_not_found" });
    expect(intruder.seen.filter((frame) => frame.type === "pending-messages")).toEqual([]);
    f.socket.send({ type: "pending-action", id: 11, pane_id: f.pane, pending_id: message.id, action: "discard" });
    expect(await f.socket.action(11)).toMatchObject({ ok: true }); await f.removed(message.id, "discarded");
    await f.state("idle"); expect(f.bytes()).toBe("");
  }, 30_000);

  it("deduplicates accepted submit ids and rejects different text on the same id", async () => {
    const f = await setup("dedupe"); const message = await f.queue(1, "once");
    const from = f.socket.seen.length;
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "once", payload: "unused\r", delivery: "queue" });
    expect((await f.socket.wait((frame) => frame.type === "submit-result" && frame.id === 1, from)).pending.id).toBe(message.id);
    const changed = f.socket.seen.length;
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "different", payload: "unused\r", delivery: "queue" });
    expect(await f.socket.wait((frame) => frame.type === "submit-result" && frame.id === 1, changed)).toMatchObject({ ok: false, code: "invalid_submit_id" });
    await f.state("idle"); await f.removed(message.id); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("once")}\r`);
    const completed = f.socket.seen.length;
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "once", payload: "unused\r", delivery: "queue" });
    expect((await f.socket.wait((frame) => frame.type === "submit-result" && frame.id === 1, completed)).pending).toBeUndefined();
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.removed?.some((entry: any) => entry.id === message.id && entry.outcome === "sent"), completed);
  }, 30_000);

  it("holds on observe mode and requires a fresh explicit steer after interact resumes", async () => {
    const f = await setup("observe"); const message = await f.queue(1, "held");
    f.socket.send({ type: "role", mode: "observe" });
    await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "observe");
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "held"));
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "read_only" });
    await f.state("idle"); expect(f.bytes()).toBe("");
    f.socket.send({ type: "role", mode: "interact" }); await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "interact");
    f.socket.send({ type: "pending-action", id: 11, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(11)).toMatchObject({ ok: true }); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("held")}\r`);
  }, 30_000);

  it("does not auto-send or replay a closed connection's pending input", async () => {
    const f = await setup("disconnect"); const keeper = await f.another(); const message = await f.queue(1, "never replay");
    await f.socket.disconnect(); await f.state("idle", keeper);
    keeper.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await keeper.result(20)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r"); expect(f.bytes()).toBe("barrier\r");
    keeper.send({ type: "pending-action", id: 21, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await keeper.action(21)).toMatchObject({ ok: false, code: "pending_not_found" });
  }, 30_000);

  it("cancels the committing key when a sender closes after its paste", async () => {
    const f = await setup("partial", "claude", "› Message\n", { submitDelayMs: 750 }); const keeper = await f.another(); const message = await f.queue(1, "partial");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.waitBytes("\u001b[201~"); await f.socket.disconnect();
    keeper.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await keeper.result(20)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r"); expect(f.bytes()).toBe(`${paste("partial")}barrier\r`);
  }, 30_000);

  it("rejects a real menu, malformed delivery and terminal-mode queue before typing", async () => {
    const f = await setup("menu", "codex", approval);
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "no", payload: "no", delivery: "queue" });
    expect(await f.socket.result(1)).toMatchObject({ ok: false, code: "agent_blocked" });
    for (const [id, delivery, typed] of [[2, "bad", false], [3, "queue", true]] as const) {
      f.socket.send({ type: "submit", id, pane_id: f.pane, text: "no", payload: "no", delivery, typed });
      expect(await f.socket.result(id)).toMatchObject({ ok: false, code: "invalid_delivery" });
    }
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("uses a collector-confirmed Codex finish even when its raw status is unknown", async () => {
    const f = await setup("codex-finish", "codex"); const message = await f.queue(1, "after finish");
    await f.state("unknown"); await f.removed(message.id); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("after finish")}\r`);
  }, 30_000);

  it("falls back to immediate Enter when a queued request arrives after the agent became ready", async () => {
    const f = await setup("ready-race"); await f.state("idle");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "ready now", payload: "unused", delivery: "queue" });
    expect(await f.socket.result(1)).toMatchObject({ ok: true }); expect((await f.socket.result(1)).pending).toBeUndefined();
    await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("ready now")}\r`);
    expect(f.socket.seen.some((frame) => frame.type === "pending-messages")).toBe(false);
  }, 30_000);

  it("refuses a queue request when no agent is in front, and types nothing into the program there", async () => {
    const f = await setup("no-agent", "plain");
    expect((await sessionSnapshot()).panes.find((pane) => pane.pane_id === f.pane)?.agent ?? null).toBeNull();
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "for the agent", payload: "unused", delivery: "queue" });
    expect(await f.socket.result(1)).toMatchObject({ ok: false, code: "agent_not_ready" });
    expect(f.bytes()).toBe("");
    expect(f.socket.seen.some((frame) => frame.type === "pending-messages")).toBe(false);
  }, 30_000);

  it("keeps a request that finds the agent ready behind the messages already waiting", async () => {
    const f = await setup("ready-behind", "claude", "› Message\n", { pendingStartTimeoutMs: 20_000 });
    const first = await f.queue(1, "first"); const second = await f.queue(2, "second");
    await f.state("idle"); await f.removed(first.id); await f.waitBytes("\r");
    // the first one's turn has not been seen starting, so the second still waits while the pane reads ready
    const third = await f.queue(3, "third");
    expect(f.bytes()).toBe(`${paste("first")}\r`);
    await f.state("working"); await f.state("idle"); await f.removed(second.id);
    await f.state("working"); await f.state("idle"); await f.removed(third.id); await f.waitBytes(`${paste("third")}\r`);
    expect(f.bytes()).toBe(`${paste("first")}\r${paste("second")}\r${paste("third")}\r`);
  }, 30_000);

  it("waits behind a message Claude Code holds for its invisible characters, with no hint left on screen", async () => {
    const f = await setup("held");
    // the first queued message, with a zero-width space, goes at the next turn as usual
    await f.queue(1, "first\u200bmessage");
    await f.state("idle");
    await f.waitBytes(`${paste("first\u200bmessage")}\r`);
    // Claude took the character out and kept the message in its box; its hint has gone
    const rule = "\u2500".repeat(60);
    await f.state("working");
    await f.showScreen(`  \u273b Cooked for 1s\n${rule}\n\u276f firstmessage\n${rule}\n  [Haiku 4.5] \u2502 project\n`, "[Haiku 4.5] \u2502 project");
    const before = f.bytes();
    // the held message is a card to answer first, as a menu is: nothing is queued or pasted over it
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "second", payload: "unused\r", delivery: "queue" });
    expect(await f.socket.result(2)).toMatchObject({ ok: false, code: "agent_blocked" });
    await f.state("idle");
    await Bun.sleep(500);
    expect(f.bytes()).toBe(before);
  }, 30_000);

  it("queues past Claude's hint left over an empty box that shows its grey suggestion", async () => {
    const f = await setup("held-grey");
    // the held message was sent from the terminal: the hint outlasts it over a box that is empty again
    const rule = "\u2500".repeat(60);
    const hint = `${" ".repeat(20)}Removed 1 invisible character \u00b7 review and press Enter to send`;
    const footer = "[Haiku 4.5] \u2502 project";
    await f.showScreen(`${hint}\n${rule}\n\u276f \u001b[0m\u001b[2mrun the tests\u001b[0m\n${rule}\n  ${footer}\n`, footer);
    // grey text is Claude's own, no message waiting for an answer: the chat's message is queued as ever
    await f.queue(1, "next message");
    // typed text in the same place is a held message, and a card to answer first
    await f.showScreen(`${hint}\n${rule}\n\u276f run the tests\n${rule}\n  ${footer} \n`, `${footer} `);
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "another", payload: "unused\r", delivery: "queue" });
    expect(await f.socket.result(2)).toMatchObject({ ok: false, code: "agent_blocked" });
  }, 30_000);

  it("sends the same words again after a held message was dealt with: its own paste is no held message", async () => {
    // a long pause between paste and Enter, so the screen below is drawn before the check ahead of the Enter
    const f = await setup("held-again", "claude", "› Message\n", { submitDelayMs: 3_000 });
    const first = await f.queue(1, "same\u200bmessage");
    await f.state("idle"); await f.removed(first.id);
    await f.waitBytes(`${paste("same\u200bmessage")}\r`);
    // dealt with in the terminal; the message goes out once more, the character taken out by hand
    await f.state("working");
    const second = await f.queue(2, "samemessage");
    await f.state("idle");
    await f.waitBytes(paste("samemessage"));
    // Claude's box holds the paste, as it does for any message between its paste and its Enter
    const rule = "\u2500".repeat(60);
    await f.showScreen(`  \u273b Cooked for 1s\n${rule}\n\u276f samemessage\n${rule}\n  [Haiku 4.5] \u2502 project\n`, "[Haiku 4.5] \u2502 project");
    await f.removed(second.id);
    await f.waitBytes(`${paste("samemessage")}\r`);
  }, 30_000);

  it("sends its own paste under Claude's hint left from the message before", async () => {
    // a long pause between paste and Enter, so the screen below is drawn before the check ahead of the Enter
    const f = await setup("held-hint-left", "claude", "\u203a Message\n", { submitDelayMs: 3_000 });
    const rule = "\u2500".repeat(60);
    const hint = `${" ".repeat(20)}Removed 1 invisible character \u00b7 review and press Enter to send`;
    const footer = "[Haiku 4.5] \u2502 project";
    // the held message was sent from the terminal: its hint is still up over an empty box
    await f.showScreen(`${hint}\n${rule}\n\u276f\n${rule}\n  ${footer}\n`, footer);
    const message = await f.queue(1, "next message");
    await f.state("idle");
    await f.waitBytes(paste("next message"));
    // typing does not take the hint down (Claude Code 2.1.294): the box under it now holds this delivery's paste
    await f.showScreen(`${hint}\n${rule}\n\u276f next message\n${rule}\n  ${footer} \n`, `${footer} `);
    await f.removed(message.id);
    await f.waitBytes(`${paste("next message")}\r`);
  }, 30_000);

  it("holds a queued message rather than pasting it over a draft typed in Claude's input box", async () => {
    const f = await setup("draft");
    const rule = "\u2500".repeat(60);
    const footer = "[Haiku 4.5] \u2502 project";
    await f.showScreen(`  \u273b Cooked for 1s\n${rule}\n\u276f half a thought typed in the terminal\n${rule}\n  ${footer}\n`, footer);
    const message = await f.queue(1, "queued message");
    await f.state("idle");
    const held = await f.socket.wait((frame) => frame.type === "pending-messages" && frame.pane_id === f.pane
      && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "held"));
    expect(held.messages.find((item: PendingMessage) => item.id === message.id).error.code).toBe("input_draft");
    expect(f.bytes()).toBe("");
    // the draft sent or cleared in the terminal, Send now delivers the message
    await f.showScreen(`  \u273b Cooked for 1s\n${rule}\n\u276f \u001b[2mrun the tests\u001b[0m\n${rule}\n  ${footer} \n`, `${footer} `);
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: true });
    await f.removed(message.id);
    await f.waitBytes(`${paste("queued message")}\r`);
  }, 30_000);

  it("takes no colors from a scrolled viewport: an older grey box with the typed words holds the message", async () => {
    const f = await setup("draft-scrolled");
    const rule = "\u2500".repeat(60);
    // 48 rows on a 30-row pane: the older box, with Claude's grey suggestion, is in the history; the
    // live box at the bottom holds the same words typed by the user
    const filler = Array.from({ length: 40 }, (_, index) => `  output line ${index + 1}`).join("\n");
    await f.showScreen(`${rule}\n\u276f \u001b[2mrun the tests\u001b[0m\n${rule}\n  [Haiku 4.5] older\n${filler}\n${rule}\n\u276f run the tests\n${rule}\n  [Haiku 4.5] \u2502 project\n`, "[Haiku 4.5] \u2502 project");
    const message = await f.queue(1, "queued message");
    // the user scrolls to the top: the viewport now shows the older box, its words equal to the live draft's
    const top = (await paneScrollInfo(f.pane))!.max_offset_from_bottom;
    expect(top).toBeGreaterThan(0);
    await herdrRpc("pane.scroll", { pane_id: f.pane, offset_from_bottom: top });
    expect((await paneRead({ paneId: f.pane, source: "visible", format: "text" })).text).toContain("[Haiku 4.5] older");
    await f.state("idle");
    const held = await f.socket.wait((frame) => frame.type === "pending-messages" && frame.pane_id === f.pane
      && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "held"));
    expect(held.messages.find((item: PendingMessage) => item.id === message.id).error.code).toBe("input_draft");
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("answers `restored` from the live box only: an older box in a scrolled viewport is no restored copy", async () => {
    const f = await setup("restored-scrolled");
    const rule = "\u2500".repeat(60);
    const filler = Array.from({ length: 40 }, (_, index) => `  output line ${index + 1}`).join("\n");
    const restored = async () => (await (await fetch(`http://localhost:${f.port}/api/pane/prompt?pane_id=${encodeURIComponent(f.pane)}`)).json() as { restored: string | null }).restored;
    noteSubmitted(f.pane, "run the tests");
    await f.state("idle");
    // the older box, in the history, holds the chat's message typed; the live box at the bottom is empty
    await f.showScreen(`${rule}\n\u276f run the tests\n${rule}\n  [Haiku 4.5] older\n${filler}\n${rule}\n\u276f\u00a0\n${rule}\n  [Haiku 4.5] \u2502 project\n`, "[Haiku 4.5] \u2502 project");
    const top = (await paneScrollInfo(f.pane))!.max_offset_from_bottom;
    await herdrRpc("pane.scroll", { pane_id: f.pane, offset_from_bottom: top });
    expect((await paneRead({ paneId: f.pane, source: "visible", format: "text" })).text).toContain("[Haiku 4.5] older");
    expect(await restored()).toBeNull();
    // at the bottom, with the copy in the live box, it is the restored message
    await herdrRpc("pane.scroll", { pane_id: f.pane, offset_from_bottom: 0 });
    await f.showScreen(`${rule}\n\u276f run the tests\n${rule}\n  [Haiku 4.5] \u2502 project\n`, "[Haiku 4.5] \u2502 project");
    expect(await restored()).toBe("run the tests");
  }, 30_000);

  it("reads the pane's live screen: a menu drawn below a scrolled viewport still stops Send now", async () => {
    const f = await setup("scrolled", "codex"); const message = await f.queue(1, "after the menu");
    const history = Array.from({ length: 150 }, (_, index) => `line ${index + 1}`).join("\n");
    await f.showScreen(`${history}\n${approval}`, approval);
    const { pane: { scroll } } = await herdrRpc<{ pane: { scroll: { offset_from_bottom: number; viewport_rows: number } } }>("pane.scroll", { pane_id: f.pane, offset_from_bottom: 60 });
    expect(scroll.offset_from_bottom).toBeGreaterThanOrEqual(scroll.viewport_rows);
    expect((await paneRead({ paneId: f.pane, source: "visible", format: "text" })).text).not.toContain("Would you like");
    f.socket.send({ type: "pending-action", id: 2, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(2)).toMatchObject({ ok: false, code: "agent_blocked" });
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("leaves a model list no reader could read alone, where Enter would save a default", async () => {
    const f = await setup("model-list"); const message = await f.queue(1, "after the list");
    // a name the pane cut in two: no card is read from it, and herdr does not report the pane blocked
    const list = ["❯ /model", "", "  Select model", "  Switch between Claude models. Your pick becomes the default for new sessions.", "",
      "    1.  Default (recommended)  Opus 5.5 with 1M context", "  ❯ 2.  Opus", "        4.7                    Best for everyday, complex tasks", "",
      "  ◐ Medium effort (default) ←/→ to adjust", "", "  Enter to set as default · s to use this session only · Esc to cancel", ""].join("\n");
    expect(parseInteractivePrompt("claude", list)).toBeNull();
    await f.showScreen(list);
    f.socket.send({ type: "pending-action", id: 2, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(2)).toMatchObject({ ok: false, code: "agent_blocked" });
    // a narrow pane wraps the hint, and Claude draws the session's rule under the open list
    await f.showScreen(list.replace("  Enter to set as default · s to use this session only · Esc to cancel\n", "  Enter to set as default · s to use this session only · Esc to\n  cancel\n──────────── Session name ─\n"));
    f.socket.send({ type: "pending-action", id: 3, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(3)).toMatchObject({ ok: false, code: "agent_blocked" });
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("does not take a model list's hint above later output for an open list", async () => {
    const f = await setup("stale-list"); const message = await f.queue(1, "after the old list");
    await f.showScreen("  Enter to set as default · s to use this session only · Esc to cancel\nSome later output\n› Message\n");
    f.socket.send({ type: "pending-action", id: 2, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(2)).toMatchObject({ ok: true });
    await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("after the old list")}\r`);
  }, 30_000);

  it("supports pending input on a mirrored attachment without a PTY sidecar", async () => {
    const f = await setup("mirror", "claude", "› Message\n", { terminalAttach: false });
    const message = await f.queue(1, "mirror 한글\nnext"); expect(f.bytes()).toBe("");
    // A mirror can connect before the collector's initial subscription. Its ready
    // baseline still advances the queue, without requiring an event the startup gap missed.
    await herdrRpc("pane.report_agent", { pane_id: f.pane, source: "manual", agent: "claude", state: "idle" });
    await f.removed(message.id); await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste(message.text)}\r`);
  }, 30_000);

  it("rejects unattached owners and paste-control injection without accepting input", async () => {
    const f = await setup("input-guard"); const other = await f.another(false);
    other.send({ type: "submit", id: 1, pane_id: f.pane, text: "not attached", payload: "not attached", delivery: "queue" });
    expect(await other.result(1)).toMatchObject({ ok: false, code: "input_not_ready" });
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "escape\u001b[201~\r", payload: "unused", delivery: "queue" });
    expect(await f.socket.result(2)).toMatchObject({ ok: false, code: "invalid_submit_text" });
    expect(f.bytes()).toBe(""); expect(f.socket.seen.some((frame) => frame.type === "pending-messages")).toBe(false);
  }, 30_000);

  for (const mirror of [false, true]) it(`rejects malformed immediate framing on shell and mirror paths (${mirror ? "mirror" : "attached shell"})`, async () => {
    const f = await setup(mirror ? "framing-mirror" : "framing-shell", "plain", "$ ", mirror ? { terminalAttach: false } : {});
    const writes = () => herdrWrites.filter((write) => write.endsWith(` ${f.pane}`)).length;
    const sentinel = "touch /tmp/herdr-web-ui-framing-sentinel";
    const forged = [
      // its own terminator, then a CR that would run the line after it
      { text: `ok\u001b[201~\r${sentinel}`, payload: `${paste("ok")}\r${sentinel}\u001b[201~` },
      { text: "ok", payload: `${paste("ok")}\r${sentinel}` },
      // a payload its text does not name, and markers twice over
      { text: "ls", payload: sentinel },
      { text: "ls", payload: paste(paste("ls")) },
      { text: "ls", payload: `\u001b[201~ls\u001b[200~` },
      // a hidden trailing CR: an Enter of its own besides the bridge's
      { text: "ls", payload: "ls\r" },
    ];
    let id = 100;
    const refused = async (frame: Record<string, unknown>, code = "invalid_submit_text", socket = f.socket) => {
      socket.send({ type: "submit", id: ++id, pane_id: f.pane, ...frame });
      expect(await socket.result(id), JSON.stringify(frame).slice(0, 120)).toMatchObject({ ok: false, code });
    };
    for (const typed of [false, true]) for (const frame of forged) await refused({ ...frame, ...(typed ? { typed: true } : {}) });
    // a forged send over a named draft clears nothing; one under a held-copy id reserves nothing
    await refused({ text: "ls", payload: "ls\r", clear_draft: "old draft" });
    await refused({ text: "ls", payload: "ls\r", resend_id: "forged-copy" });
    // over either cap, by one character
    await refused({ text: "x".repeat(20_001), payload: "x".repeat(20_001) });
    await refused({ text: "x".repeat(32_769), payload: "x".repeat(32_769), typed: true });
    // an observing connection is refused for its role, forged or not
    const watcher = await f.another();
    watcher.send({ type: "role", mode: "observe" }); await watcher.wait((frame) => frame.type === "role-ack" && frame.mode === "observe");
    await refused({ text: "ls", payload: "ls" }, "read_only", watcher);
    await refused(forged[0]!, "read_only", watcher);
    expect(writes(), "no text, key or draft-clear write").toBe(0);
    expect(f.bytes()).toBe("");

    // ordinary keys still go as typed
    f.socket.send({ type: "input", pane_id: f.pane, text: "\u001b[A" }); await f.waitBytes("\u001b[A");
    f.socket.send({ type: "input", pane_id: f.pane, text: "\u001b" }); await f.waitBytes("\u001b[A\u001b");
    // and the caps take what they allow: chat 20000, the input line 20001 and 32768
    let expected = "\u001b[A\u001b";
    for (const [length, typed] of [[20_000, false], [20_001, true], [32_768, true]] as const) {
      const text = "x".repeat(length);
      f.socket.send({ type: "submit", id: ++id, pane_id: f.pane, text, payload: text, ...(typed ? { typed: true } : {}) });
      expect(await f.socket.result(id)).toMatchObject({ ok: true });
      expected += `${text}\r`; await f.waitBytes(expected);
    }
    // a canonical multiline paste goes as one paste and one Enter
    f.socket.send({ type: "submit", id: ++id, pane_id: f.pane, text: "첫 줄\tone\nsecond ✓", payload: paste("첫 줄\tone\rsecond ✓"), typed: true });
    expect(await f.socket.result(id)).toMatchObject({ ok: true });
    expected += `${paste("첫 줄\tone\rsecond ✓")}\r`; await f.waitBytes(expected);

    // a sender that leaves while its submits wait behind earlier input: the forged one types nothing, the one
    // the bridge had already taken goes once, and nothing is typed again when another connection comes
    const keeper = await f.another();
    const hold = holdConnect("keys");
    keeper.send({ type: "submit", id: 1, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    await hold.reached;
    f.socket.send({ type: "submit", id: ++id, pane_id: f.pane, ...forged[0]!, typed: true });
    f.socket.send({ type: "submit", id: ++id, pane_id: f.pane, text: "taken once", payload: "taken once", typed: true });
    await f.socket.disconnect();
    hold.release();
    expect(await keeper.result(1)).toMatchObject({ ok: true });
    const later = await f.another();
    later.send({ type: "submit", id: 2, pane_id: f.pane, text: "after reconnect", payload: "after reconnect", typed: true });
    expect(await later.result(2)).toMatchObject({ ok: true });
    expected += "barrier\rtaken once\rafter reconnect\r"; await f.waitBytes(expected);
    expect(f.bytes()).toBe(expected);
    expect(f.bytes()).not.toContain(sentinel);
  }, 60_000);

  for (const stop of [false, true]) it(`checks a new blocked state after the ${stop ? "composer's Stop" : "typed ESC"}'s settling gap, before pasting`, async () => {
    const f = await setup(stop ? "stop-gap-intent" : "stop-gap"); const message = await f.queue(1, "must not paste");
    f.socket.send(stop ? { type: "input", pane_id: f.pane, text: "\u001b", stop: true } : { type: "input", pane_id: f.pane, text: "\u001b" });
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "sending"));
    await f.state("blocked");
    expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "agent_blocked" });
    await f.waitBytes("\u001b"); expect(f.bytes()).toBe("\u001b");
  }, 30_000);

  it("does not turn an automatic next turn into a steer if new work begins after paste", async () => {
    const f = await setup("new-work-gap", "claude", "› Message\n", { submitDelayMs: 750 }); const message = await f.queue(1, "must not steer");
    await f.state("idle"); await f.waitBytes("\u001b[201~"); await f.state("working");
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "uncertain"));
    expect(f.bytes()).toBe(paste("must not steer"));
  }, 30_000);

  it("holds rather than flushing when a newly sent turn never starts", async () => {
    const f = await setup("timeout", "claude", "› Message\n", { pendingStartTimeoutMs: 150 });
    const first = await f.queue(1, "first"); const second = await f.queue(2, "held second");
    await f.state("idle"); await f.removed(first.id);
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === second.id && item.state === "held" && item.error?.code === "pending_turn_unconfirmed"));
    // the bridge's Enter has gone to herdr, but the recorder in the pane may not have logged it yet
    await f.waitBytes("\r"); expect(f.bytes()).toBe(`${paste("first")}\r`);
  }, 30_000);

  it("rejects ordinary queue input and Send now at a visible password prompt despite a working state", async () => {
    const f = await setup("password-before-input"); const message = await f.queue(1, "ordinary message");
    await f.showScreen("Password:");
    await herdrRpc("pane.report_agent", { pane_id: f.pane, source: "manual", agent: "claude", state: "working" });
    expect((await sessionSnapshot()).panes.find((pane) => pane.pane_id === f.pane)?.agent_status).toBe("working");
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "another ordinary message", payload: "unused", delivery: "queue" });
    expect(await f.socket.result(2)).toMatchObject({ ok: false, code: "agent_blocked" });
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "agent_blocked" });
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("cancels Enter when a passphrase prompt appears after the pending message was pasted", async () => {
    const f = await setup("passphrase-gap", "claude", "› Message\n", { submitDelayMs: 750 });
    const message = await f.queue(1, "ordinary message");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await f.waitBytes("\u001b[201~"); await f.showScreen("Enter passphrase:");
    await herdrRpc("pane.report_agent", { pane_id: f.pane, source: "manual", agent: "claude", state: "working" });
    expect((await sessionSnapshot()).panes.find((pane) => pane.pane_id === f.pane)?.agent_status).toBe("working");
    expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "submit_changed" });
    await f.socket.wait((frame) => frame.type === "pending-messages" && frame.messages.some((item: PendingMessage) => item.id === message.id && item.state === "uncertain"));
    expect(f.bytes()).toBe(paste("ordinary message"));
  }, 30_000);

  for (const automatic of [false, true]) for (const transition of ["observe", "detach"] as const) {
    it(`permanently cancels ${automatic ? "automatic" : "explicit"} delivery after ${transition} and recovery`, async () => {
      const f = await setup(`cancel-${automatic}-${transition}`, "claude", "› Message\n", { submitDelayMs: 750 });
      await f.another(); // Keep the same shared attachment alive through detach/reattach.
      const message = await f.queue(1, "cancel this commit");
      if (automatic) await f.state("idle");
      else f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
      await f.waitBytes("\u001b[201~");
      const from = f.socket.seen.length;
      if (transition === "observe") {
        f.socket.send({ type: "role", mode: "observe" });
        await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "observe", from);
        f.socket.send({ type: "role", mode: "interact" });
        await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "interact", from);
      } else {
        f.socket.send({ type: "detach", pane_id: f.pane });
        f.socket.send({ type: "attach", pane_id: f.pane, cols: 100, rows: 30 });
        await f.socket.wait((frame) => frame.type === "input-ready" && frame.pane_id === f.pane && frame.ready !== false, from);
      }
      if (!automatic) expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "submit_changed" });
      // A later serialized request proves the cancelled dispatch has finished, not
      // merely that hold() published an uncertain state during the paste gap.
      f.socket.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
      expect(await f.socket.result(20)).toMatchObject({ ok: true });
      await f.waitBytes("barrier\r");
      expect(f.bytes()).toBe(`${paste(message.text)}barrier\r`);
      expect(f.socket.seen.some((frame) => frame.type === "pending-messages" && frame.removed?.some((item: any) => item.id === message.id && item.outcome === "sent"))).toBe(false);
      expect(f.socket.seen.filter((frame) => frame.type === "pending-messages").at(-1)?.messages).toContainEqual(expect.objectContaining({ id: message.id, state: "uncertain" }));
    }, 30_000);
  }

  it("cancels a captured lease while acceptance waits behind earlier input", async () => {
    const f = await setup("acceptance-lease", "claude", "› Message\n", { submitDelayMs: 750 });
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    await f.waitBytes("barrier");
    f.socket.send({ type: "submit", id: 2, pane_id: f.pane, text: "must not enqueue", payload: "unused", delivery: "queue" });
    f.socket.send({ type: "role", mode: "observe" });
    await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "observe");
    f.socket.send({ type: "role", mode: "interact" });
    await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "interact");
    expect(await f.socket.result(2)).toMatchObject({ ok: false, code: "pending_lease_lost" });
    await f.waitBytes("barrier\r");
    expect(f.socket.seen.some((frame) => frame.type === "pending-messages")).toBe(false);
    expect(f.bytes()).toBe("barrier\r");
  }, 30_000);

  it("cancels ready-at-arrival queue input when its owner disconnects after paste", async () => {
    const f = await setup("ready-close", "claude", "› Message\n", { submitDelayMs: 750 });
    const keeper = await f.another();
    await f.state("idle");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "ready close", payload: "unused", delivery: "queue" });
    await f.waitBytes("\u001b[201~");
    await f.socket.disconnect();
    keeper.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await keeper.result(20)).toMatchObject({ ok: true });
    await f.waitBytes("barrier\r");
    expect(f.bytes()).toBe(`${paste("ready close")}barrier\r`);
  }, 30_000);

  it("rechecks a new secret prompt before committing ready-at-arrival queue input", async () => {
    const f = await setup("ready-secret", "claude", "› Message\n", { submitDelayMs: 750 });
    await f.state("idle");
    f.socket.send({ type: "submit", id: 1, pane_id: f.pane, text: "ordinary text", payload: "unused", delivery: "queue" });
    await f.waitBytes("\u001b[201~");
    await f.showScreen("Enter passphrase:");
    expect(await f.socket.result(1)).toMatchObject({ ok: false, code: "submit_changed" });
    expect(f.bytes()).toBe(paste("ordinary text"));
  }, 30_000);

  // Claude Code queues what Enter commits during a turn; its Ctrl+Enter sends it at once (#737).
  // The stand-in asks for modifyOtherKeys as Claude Code does, so herdr types Ctrl+Enter as xterm does.
  it("steers Claude with Ctrl+Enter and Codex with Enter without Escape", async () => {
    const ctrlEnter = "\u001b[27;5;13~";
    const f = await setup("steer-claude", "claude", "\\x1b[>4;2m› Message\n");
    const steer = await f.queue(1, "steer now"); const next = await f.queue(2, "next turn");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: steer.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: true }); await f.waitBytes(ctrlEnter);
    expect(f.bytes()).toBe(`${paste("steer now")}${ctrlEnter}`);
    await f.state("idle"); await f.removed(next.id); await f.waitBytes(`${paste("next turn")}\r`);
    expect(f.bytes()).toBe(`${paste("steer now")}${ctrlEnter}${paste("next turn")}\r`);

    const codex = await setup("steer-codex", "codex", "\\x1b[>4;2m› Message\n");
    const other = await codex.queue(1, "codex steer");
    codex.socket.send({ type: "pending-action", id: 10, pane_id: codex.pane, pending_id: other.id, action: "steer" });
    await codex.waitBytes("\r");
    await codex.showScreen(codexSteering("codex steer"));
    expect(await codex.socket.action(10)).toMatchObject({ ok: true });
    expect(codex.bytes()).toBe(`${paste("codex steer")}\r`);
  }, 45_000);

  // The paste and its key are written only once herdr's connect resolves; the sender's right is asked
  // again there (#666). Refused before the paste nothing was typed; refused before the key, the paste was.
  it("types nothing when the sender's lease lapses while the paste's connect is awaited", async () => {
    const f = await setup("guard-paste", "claude", "› Message\n");
    const message = await f.queue(1, "never pasted");
    const hold = holdConnect("text");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await hold.reached;
    f.socket.send({ type: "role", mode: "observe" }); await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "observe");
    f.socket.send({ type: "role", mode: "interact" }); await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "interact");
    hold.release();
    const answer = await f.socket.action(10);
    expect(answer.ok).toBe(false); expect(answer.code).not.toBe("submit_changed");
    f.socket.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await f.socket.result(20)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r");
    expect(f.bytes()).toBe("barrier\r");
    expect(f.socket.seen.filter((frame) => frame.type === "pending-messages").at(-1)?.messages).toContainEqual(expect.objectContaining({ id: message.id, state: "held" }));
  }, 30_000);

  it("withholds the committing key when the sender's lease lapses while its connect is awaited", async () => {
    const f = await setup("guard-enter", "claude", "› Message\n");
    const message = await f.queue(1, "pasted only");
    const hold = holdConnect("keys");
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    await hold.reached; await f.waitBytes("\u001b[201~");
    f.socket.send({ type: "role", mode: "observe" }); await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "observe");
    f.socket.send({ type: "role", mode: "interact" }); await f.socket.wait((frame) => frame.type === "role-ack" && frame.mode === "interact");
    hold.release();
    expect(await f.socket.action(10)).toMatchObject({ ok: false, code: "submit_changed" });
    f.socket.send({ type: "submit", id: 20, pane_id: f.pane, text: "barrier", payload: "barrier", typed: true });
    expect(await f.socket.result(20)).toMatchObject({ ok: true }); await f.waitBytes("barrier\r");
    expect(f.bytes()).toBe(`${paste("pasted only")}barrier\r`);
    expect(f.socket.seen.filter((frame) => frame.type === "pending-messages").at(-1)?.messages).toContainEqual(expect.objectContaining({ id: message.id, state: "uncertain" }));
  }, 30_000);
});

/**
 * A create request's first message (POST /api/workspace/create and /api/tab/create `first_message`):
 * the bridge's own pending message for the new pane, queued through the same path as a connection's
 * queued message but owned by the bridge, so a connection's loss never holds it, a page that attaches
 * later is told it, and it goes exactly once, through a connection that has the pane attached, when the
 * agent is first ready. queueFirstMessage is what the create routes call once the agent started.
 */
/** Resolves once `done` holds, checked at each change to the files under the test's root (a recorder's log, a screen). */
function written(done: () => boolean, what: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (): boolean => { if (!done()) return false; clearTimeout(timer); watcher.close(); resolve(); return true; };
    const watcher = watch(root, finish);
    const timer = setTimeout(() => { watcher.close(); reject(new Error(what)); }, ms);
    finish();
  });
}

describe("a create request's first message", () => {
  const rule = "\u2500".repeat(60);
  const footer = "[Haiku 4.5] \u2502 project";
  const listed = (reader: Socket, pane: string, id: string, state = "queued") => reader.wait((frame) => frame.type === "pending-messages" && frame.pane_id === pane
    && frame.messages.some((item: PendingMessage) => item.id === id && item.state === state));
  /**
   * Resolves once the drains of `pane` asked for so far have run, a rerun included. The pane's work runs in
   * order, and a second first message for it is refused there after what is ahead. A drain asked for while
   * one runs runs again after it, which is behind the first refusal: the second refusal waits for it too.
   */
  const drained = async (server: ReturnType<typeof createServer>, pane: string): Promise<void> => {
    for (let step = 0; step < 2; step += 1) await expect(server.queueFirstMessage(pane, "SECOND", "claude")).rejects.toMatchObject({ code: "pending_limit" });
  };
  /**
   * Resolves once herdr's snapshot names `agent` (null: none) in `pane`. herdr's own detection and a
   * reported state change it at their own pace, so the snapshot is read now and again after each status
   * or roster frame `reader` gets from `from` on, never on a timer.
   */
  const herdrNames = async (reader: Socket, pane: string, agent: string | null, from: number): Promise<void> => {
    for (let at = from; ;) {
      if (((await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent ?? null) === agent) return;
      const frame = await reader.wait((candidate) => (candidate.type === "pane-status" && candidate.pane_id === pane) || candidate.type === "session-changed", at);
      at = reader.seen.indexOf(frame) + 1;
    }
  };
  /**
   * Resolves once the bridge has learned what runs in `pane` while herdr names `agent` there: then a
   * connection attaching the pane drains it, and drained() waits for that drain.
   */
  const learned = async (server: ReturnType<typeof createServer>, reader: Socket, pane: string, agent: string, from: number, sockets: Socket[]): Promise<void> => {
    await herdrNames(reader, pane, agent, from);
    const probe = new Socket(server.port); sockets.push(probe);
    await probe.attach(pane);
    await drained(server, pane);
  };

  it("is told to the attached connection and typed once, when the agent is first ready, never again at a later turn's end", async () => {
    const f = await setup("first-once");
    const message = await f.server.queueFirstMessage(f.pane, "FIRST-MESSAGE", "claude", await f.socket.connection());
    expect(message).toMatchObject({ text: "FIRST-MESSAGE", state: "queued" });
    expect(message.request_id).toBeLessThan(0); // no connection submitted it
    await listed(f.socket, f.pane, message.id);
    expect(f.bytes()).toBe(""); // control: nothing typed while the agent works
    const removed = f.removed(message.id);
    await f.state("idle");
    await removed;
    await f.waitBytes(`${paste("FIRST-MESSAGE")}\r`);
    // the next turn's end sends nothing more: a marker queued after it is the next thing typed
    await f.state("working");
    const marker = await f.queue(1, "MARKER");
    const markerSent = f.removed(marker.id);
    await f.state("idle");
    await markerSent;
    await f.waitBytes(`${paste("MARKER")}\r`);
    expect(f.bytes()).toBe(`${paste("FIRST-MESSAGE")}\r${paste("MARKER")}\r`);
  }, 30_000);

  it("is not typed into Claude Code's open rewind dialog: it waits, and goes once the dialog is closed", async () => {
    const f = await setup("first-rewind-open");
    // Claude Code 2.1.304's confirm step on a Summarize row (recorded): an add-context field, where a
    // message and its Enter would summarize the conversation
    const dialog = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-confirm-apple-summarize-from-40.txt", import.meta.url), "utf8");
    await f.showScreen(dialog, "4. Never mind");
    const message = await f.server.queueFirstMessage(f.pane, "FIRST-OVER-REWIND", "claude", await f.socket.connection());
    await f.state("idle");
    const held = await listed(f.socket, f.pane, message.id, "held");
    expect(held.messages.find((item: PendingMessage) => item.id === message.id).error.code).toBe("rewind_dialog_open");
    expect(f.bytes()).toBe("");
    // closed in the terminal: Send now types it once
    await f.showScreen(`  \u273b Cooked for 1s\n${rule}\n\u276f \u001b[2mrun the tests\u001b[0m\n${rule}\n  ${footer}\n`, footer);
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: true });
    await f.removed(message.id);
    await f.waitBytes(`${paste("FIRST-OVER-REWIND")}\r`);
  }, 30_000);

  it("is held, never typed on its own, once the page that sent it disconnects before the agent is ready: a device attaching later in Terminal or Chat gets Send now or Discard", async () => {
    const f = await setup("first-requester-gone");
    const message = await f.server.queueFirstMessage(f.pane, "FIRST-GONE", "claude", await f.socket.connection());
    await listed(f.socket, f.pane, message.id);
    await f.socket.disconnect();
    // another device, in the terminal lens: told the message, held for an explicit send
    const terminal = await f.another();
    const held = await listed(terminal, f.pane, message.id, "held");
    expect(held.messages.find((item: PendingMessage) => item.id === message.id).error.code).toBe("first_message_unattended");
    // the agent rests: the turn's end types the next waiting message (the terminal device's own), never the held one
    terminal.send({ type: "submit", id: 7, pane_id: f.pane, text: "MARKER", payload: "unused\r", delivery: "queue" });
    const queued = await terminal.result(7);
    expect(queued.ok).toBe(true);
    const markerSent = f.removed(queued.pending.id, "sent", terminal);
    await f.state("idle", terminal);
    await markerSent;
    await f.waitBytes(`${paste("MARKER")}\r`);
    expect(f.bytes()).toBe(`${paste("MARKER")}\r`);
    // and in the chat lens: still held there; its Send now types it, once
    const chat = await f.another(true, true);
    await listed(chat, f.pane, message.id, "held");
    chat.send({ type: "pending-action", id: 12, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await chat.action(12)).toMatchObject({ ok: true });
    await f.removed(message.id, "sent", chat);
    await f.waitBytes(`${paste("FIRST-GONE")}\r`);
    expect(f.bytes()).toBe(`${paste("MARKER")}\r${paste("FIRST-GONE")}\r`);
    // a page attaching after that is told the receipt, not the message
    const later = await f.another();
    const receipt = await later.wait((frame) => frame.type === "pending-messages" && frame.pane_id === f.pane && frame.removed?.some((entry: any) => entry.id === message.id && entry.outcome === "sent"));
    expect(receipt.messages.some((item: PendingMessage) => item.id === message.id)).toBe(false);
  }, 30_000);

  it("is held from the start when the request names no page connection, and Discard ends it", async () => {
    const f = await setup("first-no-requester");
    const message = await f.server.queueFirstMessage(f.pane, "FIRST-NOBODY", "claude");
    expect(message).toMatchObject({ state: "held", error: { code: "first_message_unattended" } });
    await listed(f.socket, f.pane, message.id, "held");
    f.socket.send({ type: "pending-action", id: 13, pane_id: f.pane, pending_id: message.id, action: "discard" });
    expect(await f.socket.action(13)).toMatchObject({ ok: true });
    await f.removed(message.id, "discarded");
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("holds one first message per pane: a second for the same pane is refused, whatever other panes hold", async () => {
    const f = await setup("first-per-pane");
    const requester = await f.socket.connection();
    await f.server.queueFirstMessage(f.pane, "FIRST-ONE", "claude", requester);
    await expect(f.server.queueFirstMessage(f.pane, "FIRST-TWO", "claude", requester)).rejects.toMatchObject({ code: "pending_limit" });
  }, 30_000);

  it("is bound to the agent process it was queued under: a replacement of the same kind in its terminal gets it held with pending_target_changed", async () => {
    const f = await setup("first-replaced", "claude", "SESSION1", {}, true);
    const first = (await herdrClient.paneProcessInfo(f.pane))?.foreground_processes?.find((entry) => entry.name === "claude");
    if (!first) throw new Error("SESSION1 has no foreground claude process");
    const message = await f.server.queueFirstMessage(f.pane, "FIRST-FOR-SESSION-1", "claude", await f.socket.connection());
    const started = new Promise<void>((resolve, reject) => {
      const watcher = watch(root, () => {
        if (!existsSync(f.replacementLog)) return;
        clearTimeout(timeout); watcher.close(); resolve();
      });
      const timeout = setTimeout(() => { watcher.close(); reject(new Error("SESSION2 did not start")); }, 10_000);
    });
    globalThis.process.kill(first.pid, "SIGKILL");
    await started;
    const replacement = (await herdrClient.paneProcessInfo(f.pane))?.foreground_processes?.find((entry) => entry.name === "claude");
    expect(replacement?.pid).not.toBe(first.pid); // control: the process really changed, in the same terminal
    const held = listed(f.socket, f.pane, message.id, "held");
    await f.state("idle");
    expect((await held).messages.find((item: PendingMessage) => item.id === message.id).error.code).toBe("pending_target_changed");
    expect(readFileSync(f.replacementLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("")).toBe("");
  }, 30_000);

  it("is bound to the agent session it was queued under: a /resume in the same process before its page attaches gets it held with pending_target_changed, never typed", async () => {
    const f = await setup("first-resumed");
    let sessionId = "11111111-1111-4111-8111-111111111111";
    // the recorder runs as `claude`; its PID record is supplied, so no real Claude store is read
    const session = spyOn(claudeStore, "claudeForegroundSession").mockImplementation(async (processes) =>
      processes.some((entry) => entry.name === "claude") ? sessionId : null);
    try {
      // the page that sends the request is connected and has not attached the new pane yet
      const page = await f.another(false);
      const process = (await herdrClient.paneProcessInfo(f.pane))?.foreground_processes?.[0]?.pid;
      const message = await f.server.queueFirstMessage(f.pane, "FIRST-FOR-A", "claude", await page.connection());
      // /resume in the terminal: Claude's PID record names another session, in the same process
      sessionId = "22222222-2222-4222-8222-222222222222";
      expect((await herdrClient.paneProcessInfo(f.pane))?.foreground_processes?.[0]?.pid).toBe(process); // control: the same process
      const held = listed(f.socket, f.pane, message.id, "held");
      await page.attach(f.pane);
      await f.state("idle");
      expect((await held).messages.find((item: PendingMessage) => item.id === message.id).error.code).toBe("pending_target_changed");
      expect(f.bytes()).toBe("");
    } finally { session.mockRestore(); }
  }, 30_000);

  it("is held, so the pane's other messages are not stuck behind it, once the page that sent it leaves the pane while still connected", async () => {
    const f = await setup("first-requester-left");
    const message = await f.server.queueFirstMessage(f.pane, "FIRST-LEFT", "claude", await f.socket.connection());
    await listed(f.socket, f.pane, message.id);
    const device = await f.another();
    const held = listed(device, f.pane, message.id, "held");
    f.socket.send({ type: "detach", pane_id: f.pane });
    expect((await held).messages.find((item: PendingMessage) => item.id === message.id).error.code).toBe("first_message_unattended");
    // the other device's next-turn message goes at the turn's end
    device.send({ type: "submit", id: 7, pane_id: f.pane, text: "MARKER", payload: "unused\r", delivery: "queue" });
    const queued = await device.result(7);
    expect(queued.ok).toBe(true);
    const markerSent = f.removed(queued.pending.id, "sent", device);
    await f.state("idle", device);
    await markerSent;
    await f.waitBytes(`${paste("MARKER")}\r`);
    expect(f.bytes()).toBe(`${paste("MARKER")}\r`);
    // the first message waits for Send now or Discard: Send now types it once
    device.send({ type: "pending-action", id: 12, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await device.action(12)).toMatchObject({ ok: true });
    await f.removed(message.id, "sent", device);
    await f.waitBytes(`${paste("FIRST-LEFT")}\r`);
    expect(f.bytes()).toBe(`${paste("MARKER")}\r${paste("FIRST-LEFT")}\r`);
  }, 30_000);

  it("is held over a draft typed in Claude's input box, as a connection's own queued message is, and goes on Send now from the attached connection", async () => {
    const f = await setup("first-draft");
    await f.showScreen(`  \u273b Cooked for 1s\n${rule}\n\u276f half a thought typed in the terminal\n${rule}\n  ${footer}\n`, footer);
    const message = await f.server.queueFirstMessage(f.pane, "FIRST-DRAFT", "claude", await f.socket.connection());
    await listed(f.socket, f.pane, message.id);
    await f.state("idle");
    const held = await listed(f.socket, f.pane, message.id, "held");
    expect(held.messages.find((item: PendingMessage) => item.id === message.id).error.code).toBe("input_draft");
    expect(f.bytes()).toBe("");
    // the draft sent or cleared in the terminal, the attached connection's Send now delivers it
    await f.showScreen(`  \u273b Cooked for 1s\n${rule}\n\u276f \u001b[2mrun the tests\u001b[0m\n${rule}\n  ${footer} \n`, `${footer} `);
    f.socket.send({ type: "pending-action", id: 10, pane_id: f.pane, pending_id: message.id, action: "steer" });
    expect(await f.socket.action(10)).toMatchObject({ ok: true });
    await f.removed(message.id);
    await f.waitBytes(`${paste("FIRST-DRAFT")}\r`);
  }, 30_000);

  /**
   * Through the real POST /api/tab/create: the route queues the message while herdr detects no agent in
   * the new pane yet, as right after a real launch. The launch itself is stood in for (`launches`); the
   * recorder then starts in the pane under the name of the agent that comes up.
   */
  const launched = async (label: string, comesUp: string) => {
    const created = await herdrRpc<{ workspace: { workspace_id: string } }>("workspace.create", { label: `ovis-test-pending-${label}`, cwd: root, focus: false });
    const entry: (typeof active)[number] = { stop: () => {}, sockets: [], workspace: created.workspace.workspace_id }; active.push(entry);
    const server = createServer({ port: 0, stateDir: join(root, `state-${label}`) });
    entry.stop = server.stop;
    // the page's connection is open before its Start, as the app's is: the request names it
    const socket = new Socket(server.port); entry.sockets.push(socket);
    standInLaunch = true;
    const res = await fetch(`http://localhost:${server.port}/api/tab/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: created.workspace.workspace_id, cwd: root, agent: { kind: "claude" }, first_message: `FIRST-${label}`, first_message_connection: await socket.connection() }),
    }).finally(() => { standInLaunch = false; });
    expect(res.status).toBe(200);
    const tab = await res.json() as { pane_id: string; agent_started: boolean; first_message: { id: string } | null };
    expect(tab.agent_started).toBeTrue();
    expect(tab.first_message).not.toBeNull();
    expect(launches.at(-1)).toBe("claude");
    const pane = tab.pane_id;
    // the case's own control: the route queued it while herdr named no agent in the pane
    expect((await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent ?? null).toBeNull();
    await socket.attach(pane);
    await listed(socket, pane, tab.first_message!.id);
    const log = join(root, `${label}.jsonl`);
    const screenFile = join(root, `${label}.screen`);
    writeFileSync(screenFile, "");
    if (!existsSync(join(root, comesUp))) { copyFileSync(process.execPath, join(root, comesUp)); chmodSync(join(root, comesUp), 0o755); }
    const bytes = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("") : "";
    const recorder = written(() => existsSync(log), "recorder did not start", 10_000);
    await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${join(root, comesUp)}' '${join(root, "record.cjs")}' '${log}' '\u203a Message' '${screenFile}'\n` });
    await recorder;
    return { pane, socket, id: tab.first_message!.id, bytes };
  };

  it("queued by the create route before herdr detects the launched agent, is typed once when that agent is first ready", async () => {
    const f = await launched("first-launched", "claude");
    const sent = f.socket.wait((frame) => frame.type === "pending-messages" && frame.pane_id === f.pane && frame.removed?.some((entry: any) => entry.id === f.id && entry.outcome === "sent"));
    await herdrRpc("pane.report_agent", { pane_id: f.pane, source: "manual", agent: "claude", state: "idle" });
    await sent;
    await written(() => f.bytes().endsWith(`${paste("FIRST-first-launched")}\r`), "input timeout", 8_000);
    expect(f.bytes()).toBe(`${paste("FIRST-first-launched")}\r`);
  }, 30_000);

  it("queued for one launched agent, is held, not typed, when another agent comes up in its terminal", async () => {
    const f = await launched("first-other", "codex");
    await herdrRpc("pane.report_agent", { pane_id: f.pane, source: "manual", agent: "codex", state: "idle" });
    const held = await listed(f.socket, f.pane, f.id, "held");
    expect(held.messages.find((item: PendingMessage) => item.id === f.id).error.code).toBe("pending_target_changed");
    // Send now refuses it as well: it was never meant for this agent
    f.socket.send({ type: "pending-action", id: 12, pane_id: f.pane, pending_id: f.id, action: "steer" });
    expect(await f.socket.action(12)).toMatchObject({ ok: false, code: "pending_target_changed" });
    expect(f.bytes()).toBe("");
  }, 30_000);

  it("queued while the shell was still in front, is bound to the agent the launch brought up: a same-kind replacement before its page attaches gets it held, never typed", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string } }>("workspace.create", { label: "ovis-test-pending-first-launch-replaced", cwd: root, focus: false });
    const entry: (typeof active)[number] = { stop: () => {}, sockets: [], workspace: created.workspace.workspace_id }; active.push(entry);
    const server = createServer({ port: 0, stateDir: join(root, "state-first-launch-replaced") });
    entry.stop = server.stop;
    // the page is connected and attaches the new pane only later; another device has it attached throughout
    const page = new Socket(server.port); entry.sockets.push(page);
    standInLaunch = true;
    const res = await fetch(`http://localhost:${server.port}/api/tab/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: created.workspace.workspace_id, cwd: root, agent: { kind: "claude" }, first_message: "FIRST-FOR-LAUNCHED", first_message_connection: await page.connection() }),
    }).finally(() => { standInLaunch = false; });
    const tab = await res.json() as { pane_id: string; first_message: { id: string } };
    const pane = tab.pane_id;
    expect((await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent ?? null).toBeNull(); // control: queued with no agent named
    const device = new Socket(server.port); entry.sockets.push(device);
    await device.attach(pane);
    // the launched agent comes up as the shell's child; when it ends, the shell runs another of the same kind
    const launchedLog = join(root, "first-launch-replaced-1.jsonl");
    const replacementLog = join(root, "first-launch-replaced-2.jsonl");
    const screenFile = join(root, "first-launch-replaced.screen");
    writeFileSync(screenFile, "");
    const recorder = (log: string) => `'${join(root, "claude")}' '${join(root, "record.cjs")}' '${log}' '\u203a Message' '${screenFile}'`;
    const up = written(() => existsSync(launchedLog), "the launched agent did not start", 10_000);
    const before = device.seen.length;
    await herdrRpc("pane.send_text", { pane_id: pane, text: `${recorder(launchedLog)}; exec ${recorder(replacementLog)}\n` });
    await up;
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
    await learned(server, device, pane, "claude", before, entry.sockets);
    const launched = (await herdrClient.paneProcessInfo(pane))?.foreground_processes?.find((entry) => entry.name === "claude");
    if (!launched) throw new Error("the launched agent has no foreground process");
    const replaced = written(() => existsSync(replacementLog), "the replacement did not start", 10_000);
    globalThis.process.kill(launched.pid, "SIGKILL");
    await replaced;
    expect((await herdrClient.paneProcessInfo(pane))?.foreground_processes?.find((entry) => entry.name === "claude")?.pid).not.toBe(launched.pid); // control
    await page.attach(pane);
    const held = listed(page, pane, tab.first_message.id, "held");
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
    expect((await held).messages.find((item: PendingMessage) => item.id === tab.first_message.id).error.code).toBe("pending_target_changed");
    expect(readFileSync(replacementLog, "utf8")).toBe("");
  }, 30_000);

  it("queued for a launched agent that came up and then quit before it went, is held for Send now or Discard, never left waiting and never typed", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string } }>("workspace.create", { label: "ovis-test-pending-first-launch-quit", cwd: root, focus: false });
    const entry: (typeof active)[number] = { stop: () => {}, sockets: [], workspace: created.workspace.workspace_id }; active.push(entry);
    const server = createServer({ port: 0, stateDir: join(root, "state-first-launch-quit") });
    entry.stop = server.stop;
    const page = new Socket(server.port); entry.sockets.push(page);
    standInLaunch = true;
    const res = await fetch(`http://localhost:${server.port}/api/tab/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: created.workspace.workspace_id, cwd: root, agent: { kind: "claude" }, first_message: "FIRST-FOR-QUIT", first_message_connection: await page.connection() }),
    }).finally(() => { standInLaunch = false; });
    const tab = await res.json() as { pane_id: string; first_message: { id: string } };
    const pane = tab.pane_id;
    // another device has the pane attached throughout; the page attaches once the agent has quit
    const device = new Socket(server.port); entry.sockets.push(device);
    await device.attach(pane);
    await drained(server, pane);
    // the launched agent comes up as the shell's child, and is learned at its first status event
    const log = join(root, "first-launch-quit.jsonl");
    const screenFile = join(root, "first-launch-quit.screen");
    writeFileSync(screenFile, "");
    // the shell marks the agent's end once it is back in front
    const ended = join(root, "first-launch-quit.ended");
    const up = written(() => existsSync(log), "the launched agent did not start", 10_000);
    const before = device.seen.length;
    await herdrRpc("pane.send_text", { pane_id: pane, text: `'${join(root, "claude")}' '${join(root, "record.cjs")}' '${log}' '\u203a Message' '${screenFile}'; : > '${ended}'\n` });
    await up;
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
    await learned(server, device, pane, "claude", before, entry.sockets);
    const launched = (await herdrClient.paneProcessInfo(pane))?.foreground_processes?.find((process) => process.name === "claude");
    if (!launched) throw new Error("the launched agent has no foreground process");
    // the user quits it: the shell is back in front, and herdr names no agent there (its own detection may
    // still name it a while: the message is held either way, at the pane's next event)
    const shell = (await herdrClient.paneProcessInfo(pane))?.shell_pid;
    const quit = written(() => existsSync(ended), "the launched agent did not end", 10_000);
    globalThis.process.kill(launched.pid, "SIGKILL");
    await quit;
    await herdrRpc("pane.release_agent", { pane_id: pane, source: "manual", agent: "claude" });
    expect(shell).not.toBe(launched.pid); // control: the agent was the shell's child, so the shell is back
    const held = listed(page, pane, tab.first_message.id, "held");
    await page.attach(pane);
    const message = (await held).messages.find((item: PendingMessage) => item.id === tab.first_message.id);
    expect(message.error.code).toBe("pending_target_changed");
    // Send now refuses it, Discard ends it, and nothing was ever typed
    page.send({ type: "pending-action", id: 21, pane_id: pane, pending_id: tab.first_message.id, action: "steer" });
    expect(await page.action(21)).toMatchObject({ ok: false, code: "pending_target_changed" });
    page.send({ type: "pending-action", id: 22, pane_id: pane, pending_id: tab.first_message.id, action: "discard" });
    expect(await page.action(22)).toMatchObject({ ok: true });
    expect(readFileSync(log, "utf8")).toBe("");
  }, 30_000);

  it("held from the start, still learns its launched agent: once that agent came up and quit, Send now answers pending_target_changed, not that it is not up yet", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string } }>("workspace.create", { label: "ovis-test-pending-first-held-quit", cwd: root, focus: false });
    const entry: (typeof active)[number] = { stop: () => {}, sockets: [], workspace: created.workspace.workspace_id }; active.push(entry);
    const server = createServer({ port: 0, stateDir: join(root, "state-first-held-quit") });
    entry.stop = server.stop;
    // the request names no page connection: held from the start
    standInLaunch = true;
    const res = await fetch(`http://localhost:${server.port}/api/tab/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: created.workspace.workspace_id, cwd: root, agent: { kind: "claude" }, first_message: "FIRST-HELD-QUIT" }),
    }).finally(() => { standInLaunch = false; });
    const tab = await res.json() as { pane_id: string; first_message: { id: string } };
    const pane = tab.pane_id;
    const device = new Socket(server.port); entry.sockets.push(device);
    await device.attach(pane);
    expect((await listed(device, pane, tab.first_message.id, "held")).messages[0].error.code).toBe("first_message_unattended");
    await drained(server, pane);
    const log = join(root, "first-held-quit.jsonl");
    const screenFile = join(root, "first-held-quit.screen");
    writeFileSync(screenFile, "");
    const ended = join(root, "first-held-quit.ended");
    const up = written(() => existsSync(log), "the launched agent did not start", 10_000);
    const before = device.seen.length;
    await herdrRpc("pane.send_text", { pane_id: pane, text: `'${join(root, "claude")}' '${join(root, "record.cjs")}' '${log}' '\u203a Message' '${screenFile}'; : > '${ended}'\n` });
    await up;
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
    await learned(server, device, pane, "claude", before, entry.sockets);
    const launched = (await herdrClient.paneProcessInfo(pane))?.foreground_processes?.find((process) => process.name === "claude");
    if (!launched) throw new Error("the launched agent has no foreground process");
    const quit = written(() => existsSync(ended), "the launched agent did not end", 10_000);
    globalThis.process.kill(launched.pid, "SIGKILL");
    await quit;
    await herdrRpc("pane.release_agent", { pane_id: pane, source: "manual", agent: "claude" });
    device.send({ type: "pending-action", id: 31, pane_id: pane, pending_id: tab.first_message.id, action: "steer" });
    expect(await device.action(31)).toMatchObject({ ok: false, code: "pending_target_changed" });
    device.send({ type: "pending-action", id: 32, pane_id: pane, pending_id: tab.first_message.id, action: "discard" });
    expect(await device.action(32)).toMatchObject({ ok: true });
    expect(readFileSync(log, "utf8")).toBe("");
  }, 30_000);

  it("held from the start, says pending_target_changed instead of the page being gone once its launched agent quit, and Send now answers the same", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string } }>("workspace.create", { label: "ovis-test-pending-first-held-reason", cwd: root, focus: false });
    const entry: (typeof active)[number] = { stop: () => {}, sockets: [], workspace: created.workspace.workspace_id }; active.push(entry);
    const server = createServer({ port: 0, stateDir: join(root, "state-first-held-reason") });
    entry.stop = server.stop;
    standInLaunch = true;
    const res = await fetch(`http://localhost:${server.port}/api/tab/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: created.workspace.workspace_id, cwd: root, agent: { kind: "claude" }, first_message: "FIRST-HELD-REASON" }),
    }).finally(() => { standInLaunch = false; });
    const tab = await res.json() as { pane_id: string; first_message: { id: string } };
    const pane = tab.pane_id;
    const device = new Socket(server.port); entry.sockets.push(device);
    await device.attach(pane);
    expect((await listed(device, pane, tab.first_message.id, "held")).messages[0].error.code).toBe("first_message_unattended");
    await drained(server, pane);
    const log = join(root, "first-held-reason.jsonl");
    const screenFile = join(root, "first-held-reason.screen");
    writeFileSync(screenFile, "");
    const ended = join(root, "first-held-reason.ended");
    const up = written(() => existsSync(log), "the launched agent did not start", 10_000);
    const before = device.seen.length;
    await herdrRpc("pane.send_text", { pane_id: pane, text: `'${join(root, "claude")}' '${join(root, "record.cjs")}' '${log}' '\u203a Message' '${screenFile}'; : > '${ended}'\n` });
    await up;
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
    await learned(server, device, pane, "claude", before, entry.sockets);
    const launched = (await herdrClient.paneProcessInfo(pane))?.foreground_processes?.find((process) => process.name === "claude");
    if (!launched) throw new Error("the launched agent has no foreground process");
    const quit = written(() => existsSync(ended), "the launched agent did not end", 10_000);
    globalThis.process.kill(launched.pid, "SIGKILL");
    await quit;
    await herdrRpc("pane.release_agent", { pane_id: pane, source: "manual", agent: "claude" });
    // the card's reason follows the hold's: a connection attaching the pane drains it, as any event of the pane does
    const reason = device.wait((frame) => frame.type === "pending-messages" && frame.pane_id === pane
      && frame.messages.some((item: PendingMessage) => item.id === tab.first_message.id && item.state === "held" && item.error?.code === "pending_target_changed"));
    const probe = new Socket(server.port); entry.sockets.push(probe);
    await probe.attach(pane);
    await reason;
    device.send({ type: "pending-action", id: 41, pane_id: pane, pending_id: tab.first_message.id, action: "steer" });
    expect(await device.action(41)).toMatchObject({ ok: false, code: "pending_target_changed" });
    expect(readFileSync(log, "utf8")).toBe("");
  }, 30_000);

  it("bound to a launch that runs behind a wrapper in front of the pane, is typed once into that agent, not held", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string } }>("workspace.create", { label: "ovis-test-pending-first-wrapped", cwd: root, focus: false });
    const entry: (typeof active)[number] = { stop: () => {}, sockets: [], workspace: created.workspace.workspace_id }; active.push(entry);
    const server = createServer({ port: 0, stateDir: join(root, "state-first-wrapped") });
    entry.stop = server.stop;
    const page = new Socket(server.port); entry.sockets.push(page);
    const pane = (await herdrRpc<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>("tab.create", { workspace_id: created.workspace.workspace_id, cwd: root, focus: false })).root_pane.pane_id;
    await page.attach(pane);
    // a wrapper that does not exec its agent (a shim, `sh -c` with more to run) stays in front of it
    const log = join(root, "first-wrapped.jsonl");
    const screenFile = join(root, "first-wrapped.screen");
    writeFileSync(screenFile, "");
    const up = written(() => existsSync(log), "the wrapped agent did not start", 10_000);
    const before = page.seen.length;
    await herdrRpc("pane.send_text", { pane_id: pane, text: `sh -c "'${join(root, "claude")}' '${join(root, "record.cjs")}' '${log}' '\u203a Message' '${screenFile}'; true"\n` });
    await up;
    const foreground = (await herdrClient.paneProcessInfo(pane))?.foreground_processes ?? [];
    const agent = foreground.find((process) => process.name === "claude");
    if (!agent) throw new Error("the wrapped agent is not in front of the pane");
    expect(foreground[0]?.pid).not.toBe(agent.pid); // control: herdr lists the wrapper before the agent
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
    await herdrNames(page, pane, "claude", before);
    // queued as the create route queues it for a shell-started launch: bound to the process the launch saw come up
    const message = await server.queueFirstMessage(pane, "FIRST-WRAPPED", "claude", await page.connection(), agent.pid);
    const sent = page.wait((frame) => frame.type === "pending-messages" && frame.pane_id === pane && frame.removed?.some((item: any) => item.id === message.id && item.outcome === "sent"));
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
    await sent;
    const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
    await written(() => bytes().endsWith(`${paste("FIRST-WRAPPED")}\r`), "input timeout", 8_000);
    expect(bytes()).toBe(`${paste("FIRST-WRAPPED")}\r`);
  }, 30_000);

  it("whose page leaves during its own automatic send, is held for Send now or Discard, never re-queued ahead of the pane's other messages", async () => {
    const f = await setup("first-left-mid-send", "codex");
    const message = await f.server.queueFirstMessage(f.pane, "FIRST-MID", "codex", await f.socket.connection());
    await listed(f.socket, f.pane, message.id);
    const device = await f.another();
    device.send({ type: "submit", id: 7, pane_id: f.pane, text: "MARKER", payload: "unused\r", delivery: "queue" });
    const queued = await device.result(7);
    expect(queued.ok).toBe(true);
    // the automatic send's own screen read, inside its checks (pendingContext), waits until the page has left
    const realRead = herdrClient.paneRead;
    let reached!: () => void; const atRead = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void; const released = new Promise<void>((resolve) => { release = resolve; });
    const read = spyOn(herdrClient, "paneRead").mockImplementation(async (options) => {
      if (options.paneId === f.pane && options.source === "detection" && new Error().stack?.includes("pendingContext")) { reached(); await released; }
      return realRead(options);
    });
    try {
      await f.state("idle", device);
      await atRead;
      // the page leaves the pane; its role's answer says the server has taken the detach
      const from = f.socket.seen.length;
      f.socket.send({ type: "detach", pane_id: f.pane });
      f.socket.send({ type: "role", mode: "interact" });
      await f.socket.wait((frame) => frame.type === "role-ack", from);
      // an answerable prompt is on the screen when the read goes on: the send ends agent_blocked
      await f.showScreen(approval);
      const held = listed(device, f.pane, message.id, "held");
      release();
      expect((await held).messages.find((item: PendingMessage) => item.id === message.id).error.code).toBe("first_message_unattended");
    } finally { release(); read.mockRestore(); }
    // the pane's other message goes once the prompt is gone
    await f.showScreen("\u203a Message\n");
    await f.state("working", device);
    const markerSent = f.removed(queued.pending.id, "sent", device);
    await f.state("idle", device);
    await markerSent;
    await f.waitBytes(`${paste("MARKER")}\r`);
    expect(f.bytes()).toBe(`${paste("MARKER")}\r`);
  }, 30_000);

  it("queued for a launch that died before any event saw it, is held when an agent of the same kind the user starts comes up, never typed into it", async () => {
    const created = await herdrRpc<{ workspace: { workspace_id: string } }>("workspace.create", { label: "ovis-test-pending-first-launch-died", cwd: root, focus: false });
    const entry: (typeof active)[number] = { stop: () => {}, sockets: [], workspace: created.workspace.workspace_id }; active.push(entry);
    const server = createServer({ port: 0, stateDir: join(root, "state-first-launch-died") });
    entry.stop = server.stop;
    const page = new Socket(server.port); entry.sockets.push(page);
    // the launch says which process it brought up, and that process has ended before the pane's first event
    const died = Bun.spawn(["true"]);
    await died.exited;
    standInLaunch = true; standInPid = died.pid;
    const res = await fetch(`http://localhost:${server.port}/api/tab/create`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: created.workspace.workspace_id, cwd: root, agent: { kind: "claude" }, first_message: "FIRST-FOR-DIED", first_message_connection: await page.connection() }),
    }).finally(() => { standInLaunch = false; standInPid = null; });
    const tab = await res.json() as { pane_id: string; first_message: { id: string } };
    expect(Object.keys(tab).sort()).toEqual(["agent_started", "first_message", "pane_id", "workspace_id"]); // the launch's process is not in the answer
    const pane = tab.pane_id;
    const device = new Socket(server.port); entry.sockets.push(device);
    await device.attach(pane);
    await drained(server, pane);
    // the user starts an agent of the same kind in the shell
    const log = join(root, "first-launch-died.jsonl");
    const screenFile = join(root, "first-launch-died.screen");
    writeFileSync(screenFile, "");
    const up = written(() => existsSync(log), "the user's agent did not start", 10_000);
    const before = device.seen.length;
    await herdrRpc("pane.send_text", { pane_id: pane, text: `'${join(root, "claude")}' '${join(root, "record.cjs")}' '${log}' '\u203a Message' '${screenFile}'\n` });
    await up;
    const held = listed(device, pane, tab.first_message.id, "held");
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
    await learned(server, device, pane, "claude", before, entry.sockets);
    expect((await held).messages.find((item: PendingMessage) => item.id === tab.first_message.id).error.code).toBe("pending_target_changed");
    // its page attaches and the agent rests: nothing is typed into the user's agent
    await page.attach(pane);
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
    await drained(server, pane);
    expect(readFileSync(log, "utf8")).toBe("");
  }, 30_000);

  it("is discarded by an attached connection, and then never typed", async () => {
    const f = await setup("first-discard");
    const message = await f.server.queueFirstMessage(f.pane, "FIRST-DISCARD", "claude", await f.socket.connection());
    await listed(f.socket, f.pane, message.id);
    f.socket.send({ type: "pending-action", id: 11, pane_id: f.pane, pending_id: message.id, action: "discard" });
    expect(await f.socket.action(11)).toMatchObject({ ok: true });
    await f.removed(message.id, "discarded");
    const marker = await f.queue(2, "AFTER-DISCARD");
    const markerSent = f.removed(marker.id);
    await f.state("idle");
    await markerSent;
    await f.waitBytes(`${paste("AFTER-DISCARD")}\r`);
    expect(f.bytes()).toBe(`${paste("AFTER-DISCARD")}\r`);
  }, 30_000);
});
