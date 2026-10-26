import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import * as client from "../herdr/client.ts";
import * as omo from "../omo.ts";
import * as processStart from "../process-start.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";

const roots: string[] = [];
afterEach(() => { mock.restore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// An argv-silent custom OmO is known by its session holder alone; the bundled Claude SDK child it runs a turn in
// looks like omo by its path and exits when the turn ends, while the OmO and its session stay (#1545).
it("delivers a queued follow-up to a custom OmO whose SDK child exits at the end of the turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-pending-omo-holder-")); roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  const holders = join(agentDir, "sessions", omo.omoSessionFolder(cwd), "session-holders", "sess-1");
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, "41001.json"), JSON.stringify({ pid: 41001, processStartedAtMs: 1_000, cwd }));
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1_000);
  spyOn(omo, "processEnviron").mockReturnValue([`OMO_CODING_AGENT_DIR=${agentDir}`]);
  // herdr gives no per-process cwd here (macOS): the pane's own directory places the OmO
  const parent = { pid: 41001, name: "run", argv: ["/opt/team-ai/bin/run"] };
  const sdk = { pid: 41002, name: "claude", argv: ["/opt/node_modules/omo-ai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"] };
  let foreground = [parent, sdk];
  spyOn(client, "paneProcessInfo").mockImplementation(async () => ({ pane_id: "p", shell_pid: 41000, foreground_processes: foreground }));
  spyOn(client, "paneRead").mockResolvedValue({ text: "" } as Awaited<ReturnType<typeof client.paneRead>>);
  const writes: string[] = [];
  spyOn(client, "paneSendText").mockImplementation(async (_pane: string, text: string) => { writes.push(text); });
  spyOn(client, "paneSendKeys").mockResolvedValue(undefined);

  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "omo", agent_status: "working", cwd, focused: false, revision: 0 } as HerdrPane;
  const frames: ServerMessage[] = [];
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { frames.push(JSON.parse(value)); return 1; } } as Client;
  owner.data.attached.set("p", { keepSize: false });
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = tail.catch(() => {}).then(task); tail = run; return run; };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 120 };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(),
    sight: (() => ({ facts: () => facts, write: () => {} })) as unknown as Parameters<typeof createPendingDelivery>[0]["sight"],
    serialize, lastTyped: new Map(), submitText: async () => {}, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [pane] }) as unknown as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const settle = async () => { for (let turn = 0; turn < 6; turn++) { await tail.catch(() => {}); await new Promise(setImmediate); } };

  await delivery.pendingFrames.submit(owner, { type: "submit", id: 1, pane_id: "p", text: "FOLLOWUP", payload: "FOLLOWUP", delivery: "queue" });
  await settle();
  const queued = frames.find((frame) => frame.type === "submit-result") as Extract<ServerMessage, { type: "submit-result" }> | undefined;
  const item = delivery.pending.get(owner, "p", queued!.pending!.id)!;
  expect(item.identity.processPid).toBe(parent.pid);

  foreground = [parent];
  pane.agent_status = "idle";
  delivery.pending.status("p", "idle");
  delivery.drainPending("p");
  await settle();
  expect(item.message.error?.code).toBeUndefined();
  expect(writes).toEqual(["\x1b[200~FOLLOWUP\x1b[201~"]);
});
