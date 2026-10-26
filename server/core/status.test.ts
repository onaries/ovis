import { afterAll, afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../../shared/protocol.ts";
import * as collector from "../collector.ts";
import * as conversation from "../conversation.ts";
import * as herdr from "../herdr/client.ts";
import * as service from "../opencode-service.ts";
import { connectionData, type Client } from "./connections.ts";

// herdr's status events come from the test, as the collector would hand them over
type Handlers = { onStatus: (paneId: string, status: string, agent: string) => void; onBaseline: (panes: unknown[]) => void };
let handlers: Handlers;
const originalCollector = collector.startStatusCollector;
mock.module("../collector.ts", () => ({
  ...collector,
  startStatusCollector: (seen: Handlers) => {
    handlers = seen;
    return { ready: Promise.resolve(), structureReady: Promise.resolve(), focusReady: Promise.resolve(), trackPane() {}, stop() {} };
  },
}));
const { createStatusHub } = await import("./status.ts");

const root = mkdtempSync(join(tmpdir(), "herdr-status-hub-"));
afterAll(() => {
  mock.module("../collector.ts", () => ({ ...collector, startStatusCollector: originalCollector }));
  rmSync(root, { recursive: true, force: true });
});
const stubs: { mockRestore(): void }[] = [];
afterEach(() => { for (const stub of stubs.splice(0)) stub.mockRestore(); });

// an OpenCode parent session whose one child runs, and a resting Claude session with a background subagent its prompt started
const at = Date.now() - 10_000;
const store = join(root, "opencode.db");
{
  const db = new Database(store, { create: true });
  db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, parent_id text, time_created integer);
    CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, data text)`);
  db.query("INSERT INTO session_v2 VALUES ('ses_child', 'ses_parent', ?)").run(at + 1000);
  const row = db.query("INSERT INTO session_message VALUES (?, ?, 'user', 1, ?, ?)");
  row.run("msg_parent", "ses_parent", at, JSON.stringify({ time: { created: at } }));
  row.run("msg_child", "ses_child", at + 1000, JSON.stringify({ time: { created: at + 1000 } }));
  db.close();
}
const CLAUDE = "11111111-1111-4111-8111-111111111111";
const transcript = join(root, `${CLAUDE}.jsonl`);
{
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  mkdirSync(join(root, CLAUDE, "subagents"), { recursive: true });
  writeFileSync(transcript, line({ type: "user", origin: { kind: "human" }, timestamp: new Date(at - 1000).toISOString(), permissionMode: "default", message: { role: "user", content: "go" } }));
  writeFileSync(join(root, CLAUDE, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: "review", toolUseId: "toolu_a1", requestShape: "background" }));
  writeFileSync(join(root, CLAUDE, "subagents", "agent-a1.jsonl"), line({ isSidechain: true, sessionId: CLAUDE, agentId: "a1", type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: "review" } }));
}

const base = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle" };
const opencode = (session: string | null) => ({ ...base, agent: "opencode", ...(session ? { agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: session } } : {}) });
const claude = { ...base, agent: "claude", agent_session: { agent: "claude", source: "hook", kind: "id", value: CLAUDE } };

let hubs = 0;
/** The status hub with herdr, OpenCode's service and the Claude lookup stood in for; what a browser and web push are sent. */
function hub() {
  let panes: unknown[] = [];
  let gate: Promise<void> | null = null;
  const answer = () => ({ agents: [], layouts: [], panes: structuredClone(panes), protocol: 1, tabs: [], version: "test", workspaces: [] });
  stubs.push(
    spyOn(herdr, "sessionSnapshot").mockImplementation(async () => { const read = answer(); if (gate) await gate; return read as never; }),
    spyOn(herdr, "paneGet").mockImplementation(async () => structuredClone(panes[0]) as never),
    spyOn(service, "readOpenCodeService").mockReturnValue(null),
    spyOn(conversation, "claudePaneSession").mockResolvedValue({ path: transcript, startedAt: null, pid: null } as never),
    spyOn(conversation, "claudePanePid").mockResolvedValue(null as never),
  );
  const frames: { type: string; agent_status?: string; background_tasks?: number; background_wait?: boolean }[] = [];
  const client = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (encoded: string) => { frames.push(JSON.parse(encoded)); return 1; } } as unknown as Client;
  const status = createStatusHub({
    options: { stateDir: join(root, `state${++hubs}`), opencodeDb: store, machines: false },
    devices: { gated: false, has: () => true, onPaired: () => {} } as never, preferences: { get: () => ({ muted_panes: [] }), subscribe: () => () => {} } as never,
    clients: new Set([client]), present: new Set(), pending: { status() {}, forget() {} } as never, drainPending() {}, holdPendingPane() {},
    usage: { invalidate() {} } as never, usageLogin: { ended: () => false } as never,
  });
  const alerts: string[] = [];
  stubs.push(spyOn(status.push, "onStatus").mockImplementation(async (_paneId: string, alert: string) => { alerts.push(alert); }));
  stubs.push({ mockRestore: () => { status.collector.stop(); status.omo.stop(); status.gjc.stop(); status.claudeAgents.stop(); status.opencodeAgents.stop(); status.plans.stop(); clearInterval(status.waitTimer); } });
  return {
    alerts,
    /** herdr's panes from now on, as a snapshot or a pane lookup reads them */
    herdrSays: (pane: unknown) => { panes = [pane]; },
    /** a snapshot, both trackers reading it (Claude's lookup awaited) */
    snapshot: async () => { await status.clientSnapshot(); await status.claudeAgents.refresh(panes as HerdrPane[]); },
    /** a snapshot whose read begins now and is answered when `open` is called */
    heldSnapshot: async () => {
      let open!: () => void;
      gate = new Promise((resolve) => { open = resolve; });
      const read = status.clientSnapshot();
      await new Promise((resolve) => setTimeout(resolve, 0));
      gate = null;
      return async () => { open(); await read; };
    },
    /** the pane's last status frame */
    last: () => {
      const frame = frames.filter((seen) => seen.type === "pane-status").at(-1);
      return { status: frame?.agent_status, tasks: frame?.background_tasks ?? 0, bg: frame?.background_wait === true };
    },
    /** the lookups and reads a status event set off */
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };
}

describe("the status hub's OpenCode subagents", () => {
  it("holds an OpenCode turn after Claude Code's on its subagent though its session is found after the turn, and calls its finish off", async () => {
    const h = hub();
    h.herdrSays(claude);
    handlers.onBaseline([claude]);
    await h.snapshot();
    handlers.onStatus("w1:p1", "working", "claude");
    handlers.onStatus("w1:p1", "idle", "claude");
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    // OpenCode's first turn there starts a subagent and ends before any snapshot
    h.herdrSays(opencode("ses_parent"));
    const from = h.alerts.length;
    handlers.onStatus("w1:p1", "working", "opencode");
    handlers.onStatus("w1:p1", "idle", "opencode");
    await h.settle();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    expect(h.alerts.slice(from).at(-1)).toBe("working");
    // the snapshot that follows, Claude's tracker letting go of the pane, keeps it
    await h.snapshot();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
  });

  it("keeps an OpenCode turn held though a snapshot read before its session was found is answered after", async () => {
    const h = hub();
    h.herdrSays(claude);
    handlers.onBaseline([claude]);
    await h.snapshot();
    handlers.onStatus("w1:p1", "working", "claude");
    handlers.onStatus("w1:p1", "idle", "claude");
    // what herdr says as a snapshot's read begins: OpenCode's home screen
    h.herdrSays(opencode(null));
    const answer = await h.heldSnapshot();
    h.herdrSays(opencode("ses_parent"));
    handlers.onStatus("w1:p1", "working", "opencode");
    await h.settle();
    await answer();
    handlers.onStatus("w1:p1", "idle", "opencode");
    await h.settle();
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
  });

  it("lets a Claude Code session that follows OpenCode's in the pane hold nothing of OpenCode's", async () => {
    const h = hub();
    h.herdrSays(opencode("ses_parent"));
    handlers.onBaseline([opencode("ses_parent")]);
    await h.snapshot();
    handlers.onStatus("w1:p1", "working", "opencode");
    handlers.onStatus("w1:p1", "idle", "opencode");
    expect(h.last()).toEqual({ status: "done", tasks: 1, bg: true });
    // a resting Claude session with a subagent running from before
    h.herdrSays(claude);
    await h.snapshot();
    handlers.onStatus("w1:p1", "idle", "claude");
    expect(h.last().bg).toBe(false);
  });
});
