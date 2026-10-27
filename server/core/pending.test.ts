import { afterAll, afterEach, expect, it, mock } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import * as herdr from "../herdr/client.ts";
import * as pi from "../pi.ts";
import type { SightingFacts } from "../input-guard.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";
import type { TerminalSighting } from "./terminals.ts";

const roots: string[] = [];
const paths = new Map<string, string>();
const originalProcessInfo = herdr.paneProcessInfo;
const { paneSendText, paneSendKeys, paneRead } = herdr;
const originalTranscriptPath = pi.piTranscriptPath;
let lookup: { at: "identity" | "transcript"; entered: () => void; release: Promise<void> } | null = null;
type Processes = { shell_pid: number; foreground_processes: { pid: number; name: string }[] };
/** what herdr's process read answers for a pane a case sets up */
const processes = new Map<string, Processes>();
/** each text, key, screen read or pty write the bridge asks for in such a pane, where no herdr answers */
const calls: string[] = [];
mock.module("../herdr/client.ts", () => ({
  ...herdr,
  paneProcessInfo: async (paneId: string) => {
    if (paneId === "p" && lookup?.at === "identity") {
      const held = lookup; lookup = null;
      held.entered(); await held.release;
    }
    return processes.get(paneId) ?? { foreground_processes: [], shell_pid: null };
  },
  paneSendText: async (...args: Parameters<typeof paneSendText>) => {
    if (!processes.has(args[0])) return paneSendText(...args);
    calls.push(`text ${args[0]}`);
  },
  paneSendKeys: async (...args: Parameters<typeof paneSendKeys>) => {
    if (!processes.has(args[0])) return paneSendKeys(...args);
    calls.push(`keys ${args[0]}`);
  },
  paneRead: async (...args: Parameters<typeof paneRead>) => {
    if (!processes.has(args[0].paneId)) return paneRead(...args);
    calls.push(`read ${args[0].paneId}`);
    throw new Error("no herdr answers here");
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
afterEach(() => { lookup = null; paths.clear(); processes.clear(); calls.length = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => {
  mock.module("../herdr/client.ts", () => ({ ...herdr, paneProcessInfo: originalProcessInfo, paneSendText, paneSendKeys, paneRead }));
  mock.module("../pi.ts", () => ({ ...pi, piTranscriptPath: originalTranscriptPath }));
});

it.each(["delivery first", "withdrawal first", "ambiguous delivery first", "ambiguous plain discard"] as const)("serializes held-copy resend and Edit against one disposition: %s", async (order) => {
  const ambiguous = order.startsWith("ambiguous");
  const frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>();
  const client = (): Client => {
    const output: ServerMessage[] = [];
    const owner = { data: connectionData({ deviceId: "device", readOnly: false }), getBufferedAmount: () => 0,
      send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
    clients.add(owner); frames.set(owner, output); return owner;
  };
  const first = client(), second = client(), typed: string[] = [];
  let queue = Promise.resolve<unknown>(undefined);
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(task); queue = next; return next;
  };
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const delivery = createPendingDelivery({
    options: {}, clients, attachments: new Map(), serialize, lastTyped: new Map(),
    sight: () => { throw new Error("withdrawal takes no input lease"); },
    submitText: async (_pane, text) => {
      entered.resolve(); await release.promise; typed.push(text);
      if (ambiguous) throw new herdr.HerdrError("submit_changed", "Enter may have reached the terminal");
    },
    authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", agent: null, agent_status: "idle" }] }) as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const item = delivery.pending.enqueue(first, "p", 1, "held text", null, { agent: "claude", terminalId: "p", session: null }, true);
  const resend = () => delivery.pendingFrames.submit(second, {
    type: "submit", id: 2, pane_id: "p", text: item.message.text, payload: item.message.text, delivery: "immediate", resend_id: item.message.id,
  });
  const edit = () => delivery.pendingFrames["pending-action"](first, {
    type: "pending-action", id: 3, pane_id: "p", pending_id: item.message.id, action: "discard",
    ...(order !== "ambiguous plain discard" ? { withdrawal_only: true as const } : {}),
  });
  if (order !== "withdrawal first") {
    const sending = resend();
    await entered.promise;
    const editing = edit();
    release.resolve();
    await Promise.all([sending, editing]);
  } else {
    await edit();
    release.resolve();
    await resend();
  }
  const removals = frames.get(first)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : []);
  if (ambiguous) {
    expect(removals.some((receipt) => receipt.outcome === "discarded" || receipt.outcome === "sent")).toBe(false);
    expect(frames.get(first)!.flatMap((frame) => frame.type === "pending-messages" ? frame.messages : []))
      .toContainEqual(expect.objectContaining({ id: item.message.id, state: "uncertain", error: expect.objectContaining({ code: "submit_changed" }) }));
  } else {
    expect(removals.length).toBeGreaterThan(0);
    expect(removals.every((receipt) => receipt.id === item.message.id && receipt.outcome === (order === "delivery first" ? "sent" : "discarded"))).toBe(true);
  }
  expect(typed).toEqual(order !== "withdrawal first" ? ["held text"] : []);
  expect(frames.get(second)!.find((frame) => frame.type === "submit-result" && frame.id === 2)).toMatchObject({ ok: order === "delivery first" });
  if (order === "ambiguous delivery first") {
    expect(removals).toEqual([]);
    expect(delivery.pending.list(first, "p")).toMatchObject([{ id: item.message.id, state: "uncertain" }]);
    expect(frames.get(first)!.find((frame) => frame.type === "pending-result" && frame.id === 3)).toMatchObject({ ok: false, code: "pending_uncertain" });
  } else {
    expect(delivery.pending.list(first, "p")).toEqual([]);
    if (ambiguous) expect(removals).toEqual([{ id: item.message.id, outcome: "dismissed" }]);
  }
});

it.each(["before close", "after close", "overlapping reload", "same live browser", "no device", "read-only", "detach", "wrong browser", "wrong device", "revoked", "expired", "pending cap", "completed cap", "confirmation budget"] as const)(
  "resumes only exact, authorized Pi presentation receipts: %s", async (when) => {
    const root = mkdtempSync(join(tmpdir(), "ovis-pi-resume-")); roots.push(root);
    const path = join(root, "session.jsonl"); paths.set("p", path);
    writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "session" }) + "\n"
      + JSON.stringify({ type: "message", id: "base", parentId: null, message: { role: "assistant", content: [] } }) + "\n");
    const token = crypto.randomUUID(), frames = new Map<Client, ServerMessage[]>(), clients = new Set<Client>();
    const client = (deviceId: string | undefined = when === "no device" ? undefined : "device", receiptResumeId: string = token, readOnly = false): Client => {
      const output: ServerMessage[] = [];
      const owner = { data: connectionData({ deviceId, readOnly }), getBufferedAmount: () => 0,
        send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
      owner.data.attached.set("p", { keepSize: false, receiptResumeId });
      clients.add(owner); frames.set(owner, output); return owner;
    };
    const first = client(), typed: string[] = [], revoked = new Set<Client>();
    let queue = Promise.resolve<unknown>(undefined);
    const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => {
      const next = queue.catch(() => {}).then(task); queue = next; return next;
    };
    const delivery = createPendingDelivery({
      options: { piReceiptLimit: 1 }, clients, attachments: new Map(), serialize, lastTyped: new Map(),
      sight: () => { throw new Error("presentation never takes an input lease"); },
      submitText: async (_pane, text) => { typed.push(text); },
      authorizeSocket: (owner) => { if (revoked.has(owner)) throw new Error("revoked"); },
      clientSnapshot: async () => ({ panes: [{ pane_id: "p", terminal_id: "p", agent: "pi", agent_status: "idle" }] }) as SessionSnapshot,
      omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
    });
    await delivery.pendingFrames.submit(first, { type: "submit", id: 1, pane_id: "p", text: "same", payload: "same", delivery: "immediate" });
    await serialize("p", () => {});
    const sent = frames.get(first)!.flatMap((frame) => frame.type === "pending-messages" ? frame.messages : [])
      .find((message) => message.error?.code === "pi_transcript_pending")!;
    expect(sent).toBeDefined();
    if (when === "confirmation budget") {
      // An oversized partial record is permanently beyond this receipt's scan budget.
      appendFileSync(path, "x".repeat(16 * 1024 * 1024 + 1));
      await delivery.reconcilePiDeliveries("p");
      expect(frames.get(first)!.flatMap((frame) => frame.type === "pending-messages" ? frame.messages : [])
        .some((message) => message.id === sent.id && message.error?.code === "transcript_unconfirmed")).toBe(true);
      // A small, valid tail lets a new send capture its own bounded anchor.
      appendFileSync(path, "\n" + JSON.stringify({ type: "message", id: "new-base", parentId: "base", message: { role: "assistant", content: [] } }) + "\n");
      await delivery.pendingFrames.submit(first, { type: "submit", id: 2, pane_id: "p", text: "released", payload: "released", delivery: "immediate" });
      expect(frames.get(first)!.find((frame) => frame.type === "submit-result" && frame.id === 2)).toMatchObject({ ok: true });
      await serialize("p", () => {});
      await delivery.reconcilePiDeliveries("p");
      await delivery.pendingFrames["pending-action"](first, { type: "pending-action", id: 3, pane_id: "p", pending_id: sent.id, action: "discard" });
      expect(frames.get(first)!.find((frame) => frame.type === "pending-result" && frame.id === 3)).toMatchObject({ ok: true });
      await delivery.pendingFrames.submit(first, { type: "submit", id: 4, pane_id: "p", text: "still full", payload: "still full", delivery: "immediate" });
      expect(frames.get(first)!.find((frame) => frame.type === "submit-result" && frame.id === 4)).toMatchObject({ ok: false, code: "pending_limit" });
      expect(typed).toEqual(["same", "released"]);
      return;
    }
    const append = () => appendFileSync(path, JSON.stringify({ type: "message", id: "ours", parentId: "base",
      message: { role: "user", content: [{ type: "text", text: "same" }] } }) + "\n");
    if (when === "pending cap") {
      let lastToken = "";
      for (let index = 0; index < 1025; index++) {
        lastToken = crypto.randomUUID();
        const owner = client("device", lastToken);
        await delivery.pendingFrames.submit(owner, { type: "submit", id: index + 10, pane_id: "p", text: "waiting", payload: "waiting", delivery: "immediate" });
        await serialize("p", () => {});
        clients.delete(owner); delivery.closeConnection(owner);
      }
      const dropped = client("device", lastToken);
      delivery.attached(dropped, "p");
      await serialize("p", () => {});
      expect(frames.get(dropped)!.filter((frame) => frame.type === "pending-messages")).toEqual([]);
      expect(typed).toHaveLength(1026);
      return;
    }
    if (when === "completed cap") {
      append(); await delivery.reconcilePiDeliveries("p");
      let parent = "ours", lastId = "";
      for (let index = 0; index < 1025; index++) {
        await delivery.pendingFrames.submit(first, { type: "submit", id: index + 10, pane_id: "p", text: `turn-${index}`, payload: `turn-${index}`, delivery: "immediate" });
        await serialize("p", () => {});
        lastId = `entry-${index}`;
        appendFileSync(path, JSON.stringify({ type: "message", id: lastId, parentId: parent, message: { role: "user", content: [{ type: "text", text: `turn-${index}` }] } }) + "\n");
        parent = lastId;
        await delivery.reconcilePiDeliveries("p");
      }
      clients.delete(first); delivery.closeConnection(first);
      const resumed = client(); delivery.attached(resumed, "p");
      await serialize("p", () => {});
      const removals = frames.get(resumed)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : []);
      expect(removals).toHaveLength(1024);
      expect(removals.some((item) => item.id === sent.id)).toBe(false);
      expect(typed).toHaveLength(1026);
      return;
    }
    if (when === "before close") { append(); await delivery.reconcilePiDeliveries("p"); }
    if (when === "revoked") revoked.add(first);
    const overlap = when === "overlapping reload" ? client() : undefined;
    if (overlap) delivery.attached(overlap, "p");
    if (when === "detach") first.data.attached.delete("p");
    else if (when !== "same live browser") { clients.delete(first); delivery.closeConnection(first); }
    if (when === "expired") {
      const original = Date.now;
      Date.now = () => original() + 11 * 60 * 1000;
      try { await delivery.reconcilePiDeliveries("p"); } finally { Date.now = original; }
    }
    if (when !== "before close" && when !== "after close") append();
    const next = when === "detach" ? first : overlap ?? client(when === "wrong device" ? "different" : when === "no device" ? undefined : "device", when === "wrong browser" ? crypto.randomUUID() : token, when === "read-only");
    if (when === "detach") first.data.attached.set("p", { keepSize: false, receiptResumeId: token });
    delivery.attached(next, "p");
    await serialize("p", () => {});
    if (when === "after close") {
      await delivery.pendingFrames.submit(next, { type: "submit", id: 2, pane_id: "p", text: "blocked", payload: "blocked", delivery: "immediate" });
      expect(frames.get(next)!.find((frame) => frame.type === "submit-result" && frame.id === 2)).toMatchObject({ ok: false, code: "pending_limit" });
      append();
    }
    await delivery.reconcilePiDeliveries("p");
    const consumed = frames.get(next)!.flatMap((frame) => frame.type === "pending-messages" ? frame.removed ?? [] : [])
      .filter((item) => item.id === sent.id && item.outcome === "consumed");
    expect(consumed.length > 0).toBe(["before close", "after close", "overlapping reload", "no device", "detach"].includes(when));
    if (when === "same live browser") expect(frames.get(next)!.flatMap((frame) => frame.type === "pending-messages" ? frame.messages : [])).toEqual([]);
    expect(typed).toEqual(["same"]);
    if (when === "after close") {
      await delivery.pendingFrames.submit(next, { type: "submit", id: 3, pane_id: "p", text: "released", payload: "released", delivery: "immediate" });
      expect(frames.get(next)!.find((frame) => frame.type === "submit-result" && frame.id === 3)).toMatchObject({ ok: true });
      expect(typed).toEqual(["same", "released"]);
    }
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

// pids no process of this PC has: their start is read as unknown, as for an ended process
const SHELL = 4_194_001, AGENT = 4_194_002;
const shellIn = (name: string): Processes => ({ shell_pid: SHELL, foreground_processes: [{ pid: SHELL, name }] });
const agentIn: Processes = { shell_pid: SHELL, foreground_processes: [{ pid: AGENT, name: "codex" }] };
const READY: SightingFacts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 80 };
it.each([
  ["learned at an event, then left with the shell back in front under herdr's name for it", "event", "bash", "first_message_launch_ended"],
  ["bound at its queueing, then left before any event with the shell back in front under herdr's name for it", "queueing", "bash", "first_message_launch_ended"],
  ["bound at its queueing, then replaced by an agent of its kind exec'd at the shell's pid", "queueing", "codex", "pending_target_changed"],
] as const)("a first message whose launched agent was %s is held with that reason, keeps it, is refused by Send now, and is never typed", async (_case, bound, front, code) => {
  let named: string | null = null;
  /** what runs in the pane from the `leaveAt`-th identity read on (each starts with the session snapshot) */
  let snapshots = 0, leaveAt = 0, left: Processes | null = null;
  const frames: ServerMessage[] = [];
  const owner = {
    data: connectionData({ deviceId: undefined, readOnly: false }),
    getBufferedAmount: () => 0,
    send: (value: string) => { frames.push(JSON.parse(value)); return 1; },
  } as Client;
  owner.data.attached.set("L", { keepSize: false });
  const queues = new Map<string, Promise<unknown>>();
  const serialize = <T>(pane: string, task: () => T | Promise<T>): Promise<T> => {
    const run = (queues.get(pane) ?? Promise.resolve()).catch(() => {}).then(task);
    queues.set(pane, run);
    return run;
  };
  const delivery = createPendingDelivery({
    options: {}, clients: new Set([owner]), attachments: new Map(),
    // a page attached and ready to type, so that only the message's own checks keep it from the pane
    sight: (): TerminalSighting => ({ origin: null, pty: null, claim: null, facts: () => READY, write: (data: string) => { calls.push(`pty ${data}`); } }),
    serialize, lastTyped: new Map(),
    submitText: async (pane) => { calls.push(`submit ${pane}`); },
    authorizeSocket: () => {},
    clientSnapshot: async () => {
      if (++snapshots === leaveAt && left) processes.set("L", left);
      return { panes: [{ pane_id: "L", terminal_id: "L", agent: named, agent_status: "working" }] } as SessionSnapshot;
    },
    omo: { sessionOf: () => null },
    SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  /** a pane event: its drain, and every drain it asks for, has run */
  const event = async () => { delivery.drainPending("L"); await serialize("L", () => {}); };
  const reasons = () => frames.flatMap((frame) => frame.type === "pending-messages" && frame.pane_id === "L" ? frame.messages.map((item) => item.error?.code) : []);
  let message;
  if (bound === "event") {
    // queued while the shell is still in front; the agent comes up under herdr's name, and an event learns it
    processes.set("L", shellIn("bash"));
    message = await delivery.queueFirstMessage("L", "FIRST", "codex");
    processes.set("L", agentIn); named = "codex";
    await event();
    processes.set("L", shellIn(front));
  } else {
    // the launch names its process, which the reads at its queueing see in front under herdr's name; from the
    // next identity read on, whichever drain makes it, it is gone
    named = "codex";
    processes.set("L", agentIn);
    leaveAt = 2; left = shellIn(front);
    message = await delivery.queueFirstMessage("L", "FIRST", "codex", null, AGENT);
  }
  await event();
  // the first reason it is held with once its agent is gone
  expect(reasons().find((reason) => reason === "first_message_launch_ended" || reason === "pending_target_changed")).toBe(code);
  // an agent that ended: herdr lets go of its name, and the card keeps its reason
  if (code === "first_message_launch_ended") { named = null; await event(); }
  expect(reasons().at(-1)).toBe(code);
  const steer = async (id: number, launchEnded: boolean) => {
    await delivery.pendingFrames["pending-action"](owner, { type: "pending-action", id, pane_id: "L", pending_id: message.id, action: "steer", ...(launchEnded ? { launch_ended: true as const } : {}) });
    return frames.find((frame) => frame.type === "pending-result" && frame.id === id);
  };
  expect(await steer(1, true)).toMatchObject({ ok: false, code });
  // an older client, which takes a code it does not know as maybe typed, gets the one it knows
  expect(await steer(2, false)).toMatchObject({ ok: false, code: "pending_target_changed" });
  await serialize("L", () => {});
  expect(reasons().at(-1)).toBe(code);
  expect(calls).toEqual([]);
});

it("keeps the owner's held row sendable when its own Send now fails before anything is typed", async () => {
  const output: ServerMessage[] = [];
  const owner = { data: connectionData({ deviceId: "device", readOnly: false }), getBufferedAmount: () => 0,
    send: (value: string) => { output.push(JSON.parse(value)); return 1; } } as Client;
  owner.data.attached.set("p", { keepSize: false });
  let queue = Promise.resolve<unknown>(undefined);
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const next = queue.catch(() => {}).then(task); queue = next; return next; };
  const typed: string[] = [];
  const delivery = createPendingDelivery({
    options: {}, clients: new Set([owner]), attachments: new Map(), serialize, lastTyped: new Map(),
    sight: (): TerminalSighting => ({ origin: null, pty: null, claim: null, facts: () => READY, write: () => {} }),
    submitText: async (_pane, text) => { typed.push(text); },
    authorizeSocket: () => {},
    // herdr unreachable before any write: the dispatch's own answer says nothing was typed
    clientSnapshot: async (): Promise<SessionSnapshot> => { throw new Error("herdr unreachable before any write"); },
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 45_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const item = delivery.pending.enqueue(owner, "p", 1, "held text", null as never, { agent: null, terminalId: "p", session: null }, true);
  await delivery.pendingFrames["pending-action"](owner, { type: "pending-action", id: 10, pane_id: "p", pending_id: item.message.id, action: "steer" });
  expect(output.find((frame) => frame.type === "pending-result" && frame.id === 10)).toMatchObject({ ok: false, code: "submit_failed" });
  expect(typed).toEqual([]);
  expect(delivery.pending.list(owner, "p")[0]?.state).toBe("held");
  expect(() => delivery.pending.enqueue(owner, "p", 2, "another", null as never, { agent: null, terminalId: "p", session: null })).not.toThrow();
});
