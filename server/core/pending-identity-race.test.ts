import { afterEach, expect, it, mock, spyOn } from "bun:test";

import type { HerdrPane, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import * as client from "../herdr/client.ts";
import * as opencode from "../opencode-native.ts";
import * as processStart from "../process-start.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";

afterEach(() => { mock.restore(); });

type PendingFrame = Extract<ServerMessage, { type: "pending-messages" }>;

// The agent in front is replaced while a check's read is awaited: the read answers for the process that was there,
// and the message must not go to the one that came (#1986 gate G1). Birth read 2 is the check before the paste, birth
// read 3 the check before Enter, screen read 2 the screen that check reads before the paste, and the catalog the
// paste is prepared with after that check; each is held open until the replacement is in place.
it.each([
  { hold: "birth", call: 2, label: "the birth read before the paste", writes: [] as string[], state: "held" },
  { hold: "birth", call: 3, label: "the birth read before Enter", writes: ["paste 41001"] as string[], state: "uncertain" },
  { hold: "screen", call: 2, label: "the screen read before the paste", writes: [] as string[], state: "held" },
  { hold: "catalog", call: 1, label: "the catalog read before the paste", writes: [] as string[], state: "held" },
])("keeps a queued message from an agent that replaces its target during $label", async ({ hold, call, writes: expected, state }) => {
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<PendingFrame>();
  let births = 0;
  let screens = 0;
  let catalogs = 0;
  let foreground = [{ pid: 41001, name: "gjc", argv: ["gjc"] }];
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async (pid: number) => {
    if (++births === call && hold === "birth") { reached.resolve(); await release.promise; return 1_000; }
    return pid === 41001 ? 1_000 : 2_000;
  });
  spyOn(client, "paneProcessInfo").mockImplementation(async () => ({ pane_id: "p", shell_pid: 41000, foreground_processes: foreground }));
  spyOn(client, "paneRead").mockImplementation(async () => {
    if (++screens === call && hold === "screen") { reached.resolve(); await release.promise; }
    return { text: "" } as Awaited<ReturnType<typeof client.paneRead>>;
  });
  const skillsToType = opencode.openCodeSkillsToType;
  spyOn(opencode, "openCodeSkillsToType").mockImplementation(async (...args: Parameters<typeof skillsToType>) => {
    if (++catalogs === call && hold === "catalog") { reached.resolve(); await release.promise; }
    return await skillsToType(...args);
  });
  const writes: string[] = [];
  spyOn(client, "paneSendText").mockImplementation(async () => { writes.push(`paste ${foreground[0]!.pid}`); });
  spyOn(client, "paneSendKeys").mockImplementation(async (_pane: string, keys: string[]) => { writes.push(`${keys.join("+")} ${foreground[0]!.pid}`); });

  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "gjc", agent_status: "working", cwd: "/tmp", focused: false, revision: 0 } as HerdrPane;
  const owner = {
    data: connectionData({ deviceId: undefined, readOnly: false }),
    getBufferedAmount: () => 0,
    send: (value: string) => {
      const frame = JSON.parse(value) as ServerMessage;
      if (frame.type === "pending-messages" && (frame.removed?.length || frame.messages.some((message) => message.state === "held" || message.state === "uncertain"))) settled.resolve(frame);
      return 1;
    },
  } as Client;
  owner.data.attached.set("p", { keepSize: false });
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = tail.catch(() => {}).then(task); tail = run; return run; };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 120 };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(),
    sight: (() => ({ facts: () => facts, write: () => {} })) as unknown as Parameters<typeof createPendingDelivery>[0]["sight"],
    serialize, lastTyped: new Map(), submitText: async () => {}, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [{ ...pane }] }) as unknown as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });

  await delivery.pendingFrames.submit(owner, { type: "submit", id: 1, pane_id: "p", text: "FOLLOWUP", payload: "FOLLOWUP", delivery: "queue" });
  pane.agent_status = "idle";
  delivery.pending.status("p", "idle");
  delivery.drainPending("p");
  await reached.promise;
  foreground = [{ pid: 41002, name: "gjc", argv: ["gjc"] }];
  release.resolve();
  const frame = await settled.promise;

  expect(writes).toEqual(expected);
  expect(frame.removed ?? []).toEqual([]);
  expect(frame.messages.map((message) => message.state)).toEqual([state]);
});
