import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { MachineEvent } from "../shared/machines.ts";
import { handleMachineRequest, machineEventsClock, machineEventsQueuedBytes } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

// The agreed policy, written out rather than read from the code: raising either must fail here.
const STREAM_BYTES = 4 * 1024 * 1024;
const TOTAL_BYTES = 32 * 1024 * 1024;
const CEILING_BYTES = 64 * 1024 * 1024;
const STALL_MS = 30_000;

// the streams' clock, moved on by each test instead of waiting, and given back after it
const realNow = machineEventsClock.now;
let clock = 0;
beforeEach(() => { clock = 0; machineEventsClock.now = () => clock; });
afterEach(() => { machineEventsClock.now = realNow; });

/** A roster stand-in that tells every open stream, as the status hub tells the real one. */
function managerStandIn() {
  const listeners = new Set<(event: MachineEvent) => void>();
  const manager = { subscribe: (listener: (event: MachineEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as MachineManager;
  return {
    manager, emit: (event: MachineEvent) => { for (const listener of [...listeners]) listener(event); }, listening: () => listeners.size,
    /** the stream opened last, by its listener: whether it still listens */
    newest: () => { const listener = [...listeners].at(-1); return () => listener !== undefined && listeners.has(listener); },
    /** the streams open now, by their listeners: how many of them still listen */
    group: () => { const now = [...listeners]; return () => now.filter((listener) => listeners.has(listener)).length; },
  };
}

const status = (index: number): MachineEvent => ({
  type: "machine-message", machine_id: "local",
  message: { type: "pane-status", pane_id: `p${index}`, agent_status: "working", finish_epoch: "e", finish_id: 0 },
});
const large = (bytes: number): MachineEvent => ({
  type: "machine-message", machine_id: "local",
  message: { type: "pane-status", pane_id: "x".repeat(bytes), agent_status: "idle", finish_epoch: "e", finish_id: 0 },
});
const frameBytes = (event: MachineEvent): number => `data: ${JSON.stringify(event)}\n\n`.length;

async function open(manager: MachineManager, onRevoke?: (end: () => void) => () => void) {
  const abort = new AbortController();
  const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager, onRevoke);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: MachineEvent[] = [];
  /** reads until `count` events have come: "open", or how the stream ended ("ended" delivers what it held, "failed" drops it) */
  const readUntil = async (count: number): Promise<"open" | "ended" | "failed"> => {
    while (events.length < count) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await reader.read(); } catch { return "failed"; }
      if (chunk.done) return "ended";
      buffer += decoder.decode(chunk.value, { stream: true });
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
      }
    }
    return "open";
  };
  const close = async () => { abort.abort(); await reader.cancel().catch(() => undefined); };
  /** the browser goes away, its reader left as it was */
  const leave = () => abort.abort();
  return { events, readUntil, close, leave };
}

describe("the machine events stream", () => {
  it("keeps a browser that reads on through a burst of status frames written before it caught up", async () => {
    const { manager, emit } = managerStandIn();
    const stream = await open(manager);
    try {
      // a burst is told before the browser reads any of it: every frame is written before it reads one
      for (let index = 0; index < 300; index++) emit(status(index));
      expect(await stream.readUntil(300)).toBe("open");
      expect(stream.events.map((event) => event.type === "machine-message" && event.message.type === "pane-status" ? event.message.pane_id : null))
        .toEqual(Array.from({ length: 300 }, (_, index) => `p${index}`));
      emit(status(300));
      expect(await stream.readUntil(301)).toBe("open");
    } finally {
      await stream.close();
    }
  });

  it("keeps a stream open after a frame larger than its allowance, as a roster of thousands of panes is", async () => {
    const { manager, emit } = managerStandIn();
    const stream = await open(manager);
    try {
      emit(large(STREAM_BYTES + 1024));
      for (let index = 0; index < 20; index++) emit(status(index));
      expect(await stream.readUntil(21)).toBe("open");
      emit(status(20));
      expect(await stream.readUntil(22)).toBe("open");
    } finally {
      await stream.close();
    }
  });

  it("gives a stream that opens with a roster larger than every stream's budget that roster and what follows it", async () => {
    const { manager, emit } = managerStandIn();
    const stream = await open(manager);
    try {
      emit(large(TOTAL_BYTES + 1024 * 1024));
      for (let index = 0; index < 20; index++) emit(status(index));
      expect(await stream.readUntil(21)).toBe("open");
    } finally {
      await stream.close();
    }
  });

  it("gives seven browsers opening together a 5,000-pane roster each, ending none of them", async () => {
    const { manager, emit, listening } = managerStandIn();
    const streams = await Promise.all(Array.from({ length: 7 }, () => open(manager)));
    try {
      emit(large(5_339_058));
      emit(status(0));
      expect(listening()).toBe(7);
      for (const stream of streams) expect(await stream.readUntil(2)).toBe("open");
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });

  it("ends a revoked device's stream cleanly while it keeps up, and drops what waits for one that stopped reading", async () => {
    const { manager, emit } = managerStandIn();
    const revokes: (() => void)[] = [];
    const onRevoke = (end: () => void) => { revokes.push(end); return () => undefined; };
    const reading = await open(manager, onRevoke);
    const stalled = await open(manager, onRevoke);
    try {
      emit(status(0));
      expect(await reading.readUntil(1)).toBe("open");
      for (let index = 1; index < 100; index++) emit(status(index));
      expect(await reading.readUntil(100)).toBe("open");
      for (const revoke of revokes) revoke();
      expect(await reading.readUntil(101)).toBe("ended");
      expect(await stalled.readUntil(1)).toBe("failed");
    } finally {
      await Promise.all([reading.close(), stalled.close()]);
    }
  });

  it("ends a stream that stopped reading past 4 MiB, and drops what waited for it", async () => {
    const { manager, emit, listening } = managerStandIn();
    const stream = await open(manager);
    try {
      const within = Math.floor(STREAM_BYTES / frameBytes(status(0)));
      for (let sent = 0; sent < within; sent++) emit(status(0));
      expect(listening()).toBe(1);
      // the frame that would take it past 4 MiB ends it
      emit(status(0));
      expect(listening()).toBe(0);
      // errored, not closed: the 4 MiB that waited is not still handed to a browser that stopped reading
      expect(await stream.readUntil(1)).toBe("failed");
      expect(stream.events).toEqual([]);
      expect(machineEventsQueuedBytes()).toBe(0);
    } finally {
      await stream.close();
    }
  });

  it("gives a large frame room only while it waits: once read, the stream is held to 4 MiB again", async () => {
    const { manager, emit, listening } = managerStandIn();
    const stream = await open(manager);
    try {
      emit(large(2 * STREAM_BYTES));
      expect(await stream.readUntil(1)).toBe("open");
      const within = Math.floor(STREAM_BYTES / frameBytes(status(0)));
      for (let sent = 0; sent < within; sent++) emit(status(0));
      expect(listening()).toBe(1);
      emit(status(0));
      emit(status(0));
      expect(listening()).toBe(0);
    } finally {
      await stream.close();
    }
  });

  it("ends a stream that stopped reading with a second large frame waiting behind the first", async () => {
    const { manager, emit, listening } = managerStandIn();
    const stream = await open(manager);
    try {
      emit(large(STREAM_BYTES + 1024));
      expect(listening()).toBe(1);
      // the second is backlog the first does not cover, counted as it comes: larger than the whole total, it ends the stream
      emit(large(TOTAL_BYTES + 1024));
      expect(listening()).toBe(0);
      expect(machineEventsQueuedBytes()).toBe(0);
    } finally {
      await stream.close();
    }
  });

  it("ends the streams that stopped reading, the one holding the most first, never one sent its frames just now", async () => {
    const { manager, emit, listening, group, newest } = managerStandIn();
    const size = frameBytes(status(0));
    // five streams at 3.9 MiB, then five at 3.0 MiB: 34.5 MiB, all of it just sent
    const more = await Promise.all(Array.from({ length: 5 }, () => open(manager)));
    const moreListen = group();
    for (let sent = 0; sent < Math.floor(0.9 * 1024 * 1024 / size); sent++) emit(status(0));
    const less = await Promise.all(Array.from({ length: 5 }, () => open(manager)));
    for (let sent = 0; sent < Math.floor(3.0 * 1024 * 1024 / size); sent++) emit(status(0));
    try {
      expect(listening()).toBe(10);
      clock += STALL_MS;
      const late = await open(manager);
      const lateListens = newest();
      try {
        emit(status(0));
        expect(listening()).toBe(10);
        // one of the five holding 3.9 MiB went, and none of those holding 3.0 MiB
        expect(moreListen()).toBe(4);
        expect(lateListens()).toBe(true);
        expect(machineEventsQueuedBytes()).toBeLessThanOrEqual(TOTAL_BYTES);
      } finally {
        await late.close();
      }
    } finally {
      await Promise.all([...more, ...less].map((stream) => stream.close()));
    }
  });

  it("holds every stream together to 64 MiB while none has stopped reading, and to 32 MiB once they have", async () => {
    const { manager, emit, listening } = managerStandIn();
    // twelve browsers that stopped reading, watching devices or not: 12 x 3.5 MiB would be 42 MiB
    const stalled = await Promise.all(Array.from({ length: 12 }, () => open(manager)));
    try {
      const frames = Math.floor(3.5 * 1024 * 1024 / frameBytes(status(0)));
      for (let sent = 0; sent < frames; sent++) {
        emit(status(0));
        expect(machineEventsQueuedBytes()).toBeLessThanOrEqual(CEILING_BYTES);
      }
      expect(listening()).toBe(12);
      clock += STALL_MS;
      emit(status(0));
      expect(machineEventsQueuedBytes()).toBeLessThanOrEqual(TOTAL_BYTES);
      expect(listening()).toBeLessThan(12);
      expect(listening()).toBeGreaterThan(0);
      const healthy = await open(manager);
      try {
        for (let index = 0; index < 300; index++) emit(status(index));
        expect(await healthy.readUntil(300)).toBe("open");
        expect(machineEventsQueuedBytes()).toBeLessThanOrEqual(TOTAL_BYTES);
      } finally {
        await healthy.close();
      }
    } finally {
      await Promise.all(stalled.map((stream) => stream.close()));
    }
    expect(machineEventsQueuedBytes()).toBe(0);
  });

  it("counts large frames in the total: 128 browsers sent a 5.3 MB roster each hold 64 MiB at once, 32 MiB once stopped", async () => {
    const { manager, emit, listening } = managerStandIn();
    const streams = await Promise.all(Array.from({ length: 128 }, () => open(manager)));
    try {
      emit(large(5_339_058));
      expect(machineEventsQueuedBytes()).toBeLessThanOrEqual(CEILING_BYTES);
      expect(listening()).toBeLessThan(128);
      expect(listening()).toBeGreaterThan(0);
      clock += STALL_MS;
      emit(status(0));
      expect(machineEventsQueuedBytes()).toBeLessThanOrEqual(TOTAL_BYTES);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
    expect(machineEventsQueuedBytes()).toBe(0);
  });

  it("never ends a browser that reads on, however much it has waiting, while fresh streams fill the total", async () => {
    const { manager, emit, listening, newest } = managerStandIn();
    const steady = await open(manager);
    const steadyListens = newest();
    const mib = Math.floor(1024 * 1024 / frameBytes(status(0)));
    try {
      // 2 MiB waiting, then each second 1 MiB more and 1 MiB read: its queue never empties
      for (let sent = 0; sent < 2 * mib; sent++) emit(status(0));
      for (let second = 0; second < 31; second++) {
        clock += 1000;
        for (let sent = 0; sent < mib; sent++) emit(status(0));
        expect(await steady.readUntil(steady.events.length + mib)).toBe("open");
      }
      // eleven streams opened now take the total past 32 MiB while it reads on
      const fresh = await Promise.all(Array.from({ length: 11 }, () => open(manager)));
      try {
        for (let step = 0; step < 6; step++) {
          for (let sent = 0; sent < mib / 2; sent++) emit(status(0));
          expect(await steady.readUntil(steady.events.length + Math.floor(mib / 2))).toBe("open");
        }
        expect(machineEventsQueuedBytes()).toBeGreaterThan(TOTAL_BYTES);
        expect(steadyListens()).toBe(true);
        expect(listening()).toBe(12);
      } finally {
        await Promise.all(fresh.map((stream) => stream.close()));
      }
    } finally {
      await steady.close();
    }
  });

  it("lets every stream together reach 64 MiB and no further while none has stopped reading", async () => {
    const { manager, emit } = managerStandIn();
    // twenty fresh streams fed 3.9 MiB each would be 78 MiB
    const streams = await Promise.all(Array.from({ length: 20 }, () => open(manager)));
    try {
      let most = 0;
      for (let sent = 0; sent < Math.floor(3.9 * 1024 * 1024 / frameBytes(status(0))); sent++) {
        emit(status(0));
        most = Math.max(most, machineEventsQueuedBytes());
      }
      // reached to within one small frame of the ceiling, never past it
      expect(most).toBeLessThanOrEqual(CEILING_BYTES);
      expect(most).toBeGreaterThan(CEILING_BYTES - 1024);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });

  it("drops what waited for a browser that went away, so the streams opened after it get the whole total", async () => {
    const { manager, emit, listening } = managerStandIn();
    const gone = await open(manager);
    const size = frameBytes(status(0));
    for (let sent = 0; sent < Math.floor(3.9 * 1024 * 1024 / size); sent++) emit(status(0));
    gone.leave();
    expect(listening()).toBe(0);
    expect(machineEventsQueuedBytes()).toBe(0);
    expect(await gone.readUntil(1)).toBe("failed");
    const next = await Promise.all(Array.from({ length: 8 }, () => open(manager)));
    try {
      for (let sent = 0; sent < Math.floor(3.9 * 1024 * 1024 / size); sent++) emit(status(0));
      clock += STALL_MS;
      emit(status(0));
      expect(listening()).toBe(8);
    } finally {
      await Promise.all(next.map((stream) => stream.close()));
    }
  });
});
