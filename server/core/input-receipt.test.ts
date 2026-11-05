import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as client from "../herdr/client.ts";
import { type Client, connectionData } from "./connections.ts";
import { createInputLane } from "./input.ts";
import { KEY_SETTLE_MS, TYPED_SETTLE_MS } from "../index.ts";

afterEach(() => mock.restore());

type Told = { type: string; id?: number; pane_id?: string; ok?: boolean; code?: string };

function connection(told: Told[]): Client {
  return { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, send: (raw: string) => { told.push(JSON.parse(raw)); return 1; }, getBufferedAmount: () => 0, close: () => {} } as unknown as Client;
}

/**
 * Two connections on pane w:p1, attached and ready; `phone`'s key `left` is held at herdr until `answer`, so
 * typing sent meanwhile waits in the pane's queue (#2677).
 */
function lane(ready = true) {
  const typed: string[] = [];
  const told: Told[] = [];
  const phone = connection(told);
  const other = connection([]);
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready, held: false, currentHeld: false, mirror: false, cols: 80 };
  const sighting = { origin: "attach", pty: "pty", claim: "claim", facts: () => facts, write: (data: string) => { typed.push(`pty ${data}`); return true; } };
  let started!: () => void;
  const keyStarted = new Promise<void>((resolve) => { started = resolve; });
  let answer!: () => void;
  const herdrAnswers = new Promise<void>((resolve) => { answer = resolve; });
  let first = true;
  spyOn(client, "paneSendKeys").mockImplementation(async (_pane, keys) => {
    if (first) { first = false; started(); await herdrAnswers; }
    typed.push(`keys ${keys.join(",")}`);
  });
  spyOn(client, "paneSendText").mockImplementation(async (_pane, text) => { typed.push(`text ${text}`); });
  const clients = new Set([phone, other]);
  const { inputFrames } = createInputLane({
    TYPED_SETTLE_MS, KEY_SETTLE_MS, clients, sight: () => sighting, poke: () => {},
    terminalAttach: async () => false, terminalAttachKnown: () => true, mayType: () => true, authorizeSocket: () => {},
  });
  const results = () => told.filter((frame) => frame.type === "input-result");
  return { typed, results, clients, phone, other, inputFrames, keyStarted, answer };
}

it("answers queued typing with an id only once herdr typed it, and a connection that ended before its turn gets nothing typed", async () => {
  for (const disconnect of [false, true]) {
    const { typed, results, clients, phone, other, inputFrames, keyStarted, answer } = lane();
    const key = inputFrames.keys(phone, { type: "keys", pane_id: "w:p1", keys: ["left"] });
    await keyStarted;
    inputFrames.input(phone, { type: "input", pane_id: "w:p1", text: "echo hi", id: 7 });
    // read and queued, not typed: no receipt yet (a pong would already have come back)
    expect(results()).toEqual([]);
    if (disconnect) clients.delete(phone);
    const barrier = inputFrames.keys(other, { type: "keys", pane_id: "w:p1", keys: ["right"] });
    answer();
    await key;
    await barrier;
    if (disconnect) {
      // nothing typed outlives its connection; the browser holds what no receipt confirmed
      expect(typed).toEqual(["keys left", "keys right"]);
      expect(results()).toEqual([]);
    } else {
      expect(typed).toEqual(["keys left", "text echo hi", "keys right"]);
      expect(results()).toEqual([{ type: "input-result", id: 7, pane_id: "w:p1", ok: true }]);
    }
  }
});

it("answers typing written straight to the pty at once, a refusal with its code, and an input without an id not at all", () => {
  const live = lane();
  live.inputFrames.input(live.phone, { type: "input", pane_id: "w:p1", text: "a", id: 1 });
  live.inputFrames.input(live.phone, { type: "input", pane_id: "w:p1", text: "b" });
  expect(live.typed).toEqual(["pty a", "pty b"]);
  expect(live.results()).toEqual([{ type: "input-result", id: 1, pane_id: "w:p1", ok: true }]);
  const notReady = lane(false);
  notReady.inputFrames.input(notReady.phone, { type: "input", pane_id: "w:p1", text: "a", id: 2 });
  expect(notReady.typed).toEqual([]);
  expect(notReady.results()).toEqual([{ type: "input-result", id: 2, pane_id: "w:p1", ok: false, code: "input_not_ready" }]);
});
