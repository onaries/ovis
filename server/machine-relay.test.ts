import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { MachineRelay, RelayStallClock, upstreamCloseCode } from "./machine-relay.ts";
import type { MachineManager } from "./machines.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";

/** Samples every 100 ms like the relay's timer, returning the first close code. */
function run(clock: RelayStallClock, buffered: (at: number) => number, from: number, until: number): number {
  for (let at = from; at <= until; at += 100) {
    const code = clock.sample(buffered(at), at);
    if (code) return code;
  }
  return 0;
}

describe("RelayStallClock", () => {
  test("a few KB queued below the high-water mark for 3 s does not close", () => {
    expect(run(new RelayStallClock(), () => 8 * 1024, 0, 3000)).toBe(0);
    expect(run(new RelayStallClock(), () => OUTPUT_HIGH_BYTES - 1, 0, 3000)).toBe(0);
  });

  test("a stall at the high-water mark for 2 s closes with the explicit 4008, never a reconnect code", () => {
    const clock = new RelayStallClock();
    expect(clock.sample(OUTPUT_HIGH_BYTES, 0)).toBe(0);
    expect(clock.sample(OUTPUT_HIGH_BYTES + 1, OUTPUT_STALL_MS - 1)).toBe(0);
    expect(clock.sample(OUTPUT_HIGH_BYTES + 1, OUTPUT_STALL_MS)).toBe(OUTPUT_STALLED_CLOSE_CODE);
  });

  test("like this PC's rule, one sample below the high-water mark clears the clock", () => {
    const clock = new RelayStallClock();
    expect(clock.sample(OUTPUT_HIGH_BYTES, 0)).toBe(0);
    expect(clock.sample(OUTPUT_HIGH_BYTES - 1, 100)).toBe(0);
    expect(clock.sample(OUTPUT_HIGH_BYTES, 200)).toBe(0);
    expect(clock.sample(OUTPUT_HIGH_BYTES, 200 + OUTPUT_STALL_MS - 1)).toBe(0);
    expect(clock.sample(OUTPUT_HIGH_BYTES, 200 + OUTPUT_STALL_MS)).toBe(OUTPUT_STALLED_CLOSE_CODE);
  });

  test("buffering past the hard budget still closes at once as an overflow", () => {
    expect(new RelayStallClock().sample(OUTPUT_HARD_BYTES + 1, 0)).toBe(OUTPUT_STALLED_CLOSE_CODE);
  });
});

describe("upstreamCloseCode", () => {
  test("passes an upstream 4008 through unchanged and maps other ends to 1012", () => {
    expect(upstreamCloseCode(OUTPUT_STALLED_CLOSE_CODE)).toBe(OUTPUT_STALLED_CLOSE_CODE);
    expect(upstreamCloseCode(1006)).toBe(1012);
    expect(upstreamCloseCode(1000)).toBe(1012);
  });
});

describe("MachineRelay receipt isolation", () => {
  for (const readOnly of [false, true]) {
    test(`strips receipt resume IDs from every attach while preserving other fields (observe=${readOnly})`, async () => {
      const received: Record<string, unknown>[] = [];
      let resolve!: () => void;
      const delivered = new Promise<void>((done) => { resolve = done; });
      const upstream = Bun.serve({
        port: 0, hostname: "127.0.0.1",
        fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
        websocket: {
          message(_socket, raw) {
            const message = JSON.parse(String(raw));
            if (message.type !== "attach") return;
            received.push(message);
            if (received.length === 2) resolve();
          },
        },
      });
      const manager = {
        endpoint: () => ({ url: `http://127.0.0.1:${upstream.port}`, token: "shared-bridge-token" }),
        trackTerminal: () => () => {},
      } as unknown as MachineManager;
      const relay = new MachineRelay(manager, "pc", readOnly);
      try {
        await relay.ready;
        const attach = { type: "attach", pane_id: "p", cols: 93, rows: 37, flow_control: "ack", keep_size: true };
        const withResume = { ...attach, receipt_resume_id: "12345678-1234-4234-8234-123456789abc" };
        relay.message(JSON.stringify(withResume));
        relay.message(Buffer.from(JSON.stringify(withResume)));
        await delivered;
        expect(received).toEqual([attach, attach]);
        // Neither initial nor repeated remote attach can claim a retained receipt.
        expect(received.map((message) => message.receipt_resume_id)).toEqual([undefined, undefined]);
      } finally {
        relay.close();
        upstream.stop(true);
      }
    });
  }
});

describe("MachineRelay stall timer", () => {
  let upstream: Server<undefined>;
  beforeAll(() => {
    upstream = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
      websocket: { message() {} },
    });
  });
  afterAll(() => { upstream.stop(true); });

  /** A relay bound to a stub phone socket whose queue holds `buffered` bytes; `closes` records its close codes. */
  async function relayWithQueue(buffered: number) {
    const manager = {
      endpoint: () => ({ url: `http://127.0.0.1:${upstream.port}`, token: "test" }),
      trackTerminal: () => () => {},
    } as unknown as MachineManager;
    const relay = new MachineRelay(manager, "pc");
    await relay.ready;
    const closes: number[] = [];
    const client = {
      getBufferedAmount: () => buffered,
      send: () => 1,
      close: (code: number) => { closes.push(code); },
    } as unknown as ServerWebSocket<unknown>;
    relay.bind(client);
    return { relay, closes };
  }

  test("a few KB queued at the phone for 3 s does not close the relay", async () => {
    const { relay, closes } = await relayWithQueue(8 * 1024);
    for (let at = 0; at <= 3000; at += 100) relay.tick(at);
    expect(closes).toEqual([]);
    relay.close();
  });

  test("the high-water mark queued at the phone for the stall window closes with 4008", async () => {
    const { relay, closes } = await relayWithQueue(OUTPUT_HIGH_BYTES);
    for (let at = 0; at < OUTPUT_STALL_MS; at += 100) relay.tick(at);
    expect(closes).toEqual([]);
    relay.tick(OUTPUT_STALL_MS);
    expect(closes).toEqual([OUTPUT_STALLED_CLOSE_CODE]);
  });
});
