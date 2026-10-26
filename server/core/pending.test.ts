import { afterAll, afterEach, expect, it, mock } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import * as herdr from "../herdr/client.ts";
import * as pi from "../pi.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";

const roots: string[] = [];
const paths = new Map<string, string>();
const originalProcessInfo = herdr.paneProcessInfo;
const originalTranscriptPath = pi.piTranscriptPath;
let lookup: { at: "identity" | "transcript"; entered: () => void; release: Promise<void> } | null = null;
mock.module("../herdr/client.ts", () => ({
  ...herdr,
  paneProcessInfo: async (paneId: string) => {
    if (paneId === "p" && lookup?.at === "identity") {
      const held = lookup; lookup = null;
      held.entered(); await held.release;
    }
    return { foreground_processes: [], shell_pid: null };
  },
}));
mock.module("../pi.ts", () => ({
  ...pi,
  piTranscriptPath: async (paneId: string) => {
    if (paneId === "p" && lookup?.at === "transcript") {
      const held = lookup; lookup = null;
      held.entered(); await held.release;
    }
    return { path: paths.get(paneId)! };
  },
}));
afterEach(() => { lookup = null; paths.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => {
  mock.module("../herdr/client.ts", () => ({ ...herdr, paneProcessInfo: originalProcessInfo }));
  mock.module("../pi.ts", () => ({ ...pi, piTranscriptPath: originalTranscriptPath }));
});

it.each(["identity", "transcript"] as const)("does not release another pane's slot after invalidation during %s lookup", async (at) => {
  const root = mkdtempSync(join(tmpdir(), "ovis-pending-capacity-")); roots.push(root);
  for (const pane of ["p", "q"]) {
    const path = join(root, `${pane}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: pane }) + "\n"
      + JSON.stringify({ type: "message", id: "a0", parentId: null, message: { role: "assistant", content: [] } }) + "\n");
    paths.set(pane, path);
  }
  const frames: ServerMessage[] = [], typed: string[] = [];
  const owner = {
    data: connectionData({ deviceId: undefined, readOnly: false }),
    getBufferedAmount: () => 0,
    send: (value: string) => { frames.push(JSON.parse(value)); return 1; },
  } as Client;
  for (const pane of ["p", "q"]) owner.data.attached.set(pane, { keepSize: false });
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(pane: string, task: () => T | Promise<T>): Promise<T> => {
    const run = (queues.get(pane) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(pane, run);
    return run;
  };
  const delivery = createPendingDelivery({
    options: { piReceiptLimit: 1 }, clients: new Set([owner]), attachments: new Map(),
    sight: () => { throw new Error("immediate sends do not take a pending lease"); },
    serialize, lastTyped: new Map(),
    submitText: async (_pane, text) => { typed.push(text); },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: ["p", "q"].map((pane_id) => ({
      pane_id, terminal_id: pane_id, agent: "pi", agent_status: "idle",
    })) }) as SessionSnapshot,
    omo: { sessionOf: () => null },
    SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const submit = async (id: number, pane: string, text: string) => {
    await delivery.pendingFrames.submit(owner, { type: "submit", id, pane_id: pane, text, payload: text, delivery: "immediate" });
    await serialize(pane, () => {});
    return frames.find((frame) => frame.type === "submit-result" && frame.id === id);
  };
  expect(await submit(1, "p", "old")).toMatchObject({ ok: true });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  lookup = { at, entered: entered.resolve, release: resume.promise };
  const running = delivery.reconcilePiDeliveries("p");
  try {
    await entered.promise;
    delivery.holdPendingPane("p", { code: "input_not_ready", message: "attachment restarting" });
    expect(await submit(2, "q", "new active")).toMatchObject({ ok: true });
    appendFileSync(paths.get("p")!, JSON.stringify({
      type: "message", id: "u1", parentId: "a0", message: { role: "user", content: [{ type: "text", text: "old" }] },
    }) + "\n");
  } finally { resume.resolve(); }
  await running;
  expect(await submit(3, "q", "must be rejected")).toMatchObject({ ok: false, code: "pending_limit" });
  expect(typed).toEqual(["old", "new active"]);
  expect(frames.some((frame) => frame.type === "pending-messages" && frame.pane_id === "p"
    && frame.removed?.some((item) => item.outcome === "consumed"))).toBe(false);
}, 10_000);
