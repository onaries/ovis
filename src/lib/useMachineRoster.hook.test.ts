import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, useCallback, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine, MachineEvent } from "../../shared/machines.ts";
import type { MachineSessionRegistry } from "./machineSession.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { getTransport, setTransport, type EventSourceLike } from "./transport.ts";
import { useRosterEvents, useRosterLoader } from "./useMachineRoster.ts";

const local = (state: Machine["state"] = "connected"): Machine => ({ id: "local", name: "This PC", kind: "local", enabled: true, state, error: null, snapshot: null });
const noop = () => {};
// The real loader and event hooks, with a tab's visibility and interval clock driven without sleeps.
describe("roster and health polling beside the event stream", () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const transport = getTransport();
  let renderer: ReactTestRenderer | undefined;
  let source: EventSourceLike & { readyState: number };
  let locked: boolean;
  let visibility: DocumentVisibilityState;
  let events: EventTarget;
  let now: number;
  let next: number;
  let timers: Map<number, { at: number; every: number; run(): void }>;
  let reads: string[];
  // The local terminal socket: it offers no machine events unless a test says so, so SSE carries them.
  let socketEvents: boolean | undefined;
  let socketListeners: Set<(message: ServerMessage) => void>;
  let disconnectListeners: Set<() => void>;
  const socket = {
    get machineEventsAvailable() { return socketEvents; }, outputStopped: false, connect: noop, setMachineEvents: noop,
    on(listener: (message: ServerMessage) => void) { socketListeners.add(listener); return () => { socketListeners.delete(listener); }; },
    onDisconnect(listener: () => void) { disconnectListeners.add(listener); return () => { disconnectListeners.delete(listener); }; },
  };
  const machineSessions = { get: () => ({ socket }), closeAll: noop } as unknown as MachineSessionRegistry;
  // what the server answers: health and this PC's state in a roster read
  let healthUp: boolean;
  let readState: Machine["state"];
  function Probe() {
    const lockedRef = useRef(locked); lockedRef.current = locked;
    const refetchTimer = useRef<number | null>(null);
    // as App's: the last health read's outcome
    const [healthFailing, setHealthFailing] = useState(false);
    const loadHealth = useCallback(async () => {
      await getTransport().fetch("/api/health?scope=bridge");
      setHealthFailing(!(await getTransport().fetch("/api/health")).ok);
    }, []);
    const loader = useRosterLoader({ locked, healthFailing, lockedRef, refetchTimer, loadHealth, rosterIn: noop, setMachines: noop, setMachineRosterLoaded: noop, setError: noop, setLocked: noop });
    useRosterEvents({
      ...loader, locked, machineSessions, onPaneMoved: noop, receivePreferencesRef: { current: noop }, onRoster: noop,
      setMachines: noop, rosterIn: noop, setMachineRosterLoaded: noop, machinesRef: { current: [] }, setRemotePairings: noop, setRemovedNotices: noop,
      onPaneStatus: noop, onPaneExited: noop, followFocusRef: { current: false },
      selectionRef: { current: { machineId: "local", paneId: null, generation: 0 } },
      splitShownRef: { current: false }, splitRef: { current: null }, pendingLink: { current: null },
      selectionHint: { current: null }, setSelectedPaneId: noop, setNotificationViewTarget: noop,
      setTerminalPeek: noop, setAutoSelected: noop, preferencesResubscribedRef: { current: noop },
      preferencesDisconnectedRef: { current: noop }, preferencesClosedRef: { current: noop },
      dropIn: noop, chime: noop, setPairedNotices: noop, setRelayPairings: noop, getTakeNotificationTargetRef: () => ({ current: noop }),
    });
    return null;
  }
  beforeEach(async () => {
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    locked = false; visibility = "visible"; now = 0; next = 1; timers = new Map(); reads = []; events = new EventTarget();
    socketEvents = false; socketListeners = new Set(); disconnectListeners = new Set(); healthUp = true; readState = "connected";
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { hash: "" },
      setInterval(run: () => void, every: number) { const id = next++; timers.set(id, { at: now + every, every, run }); return id; },
      clearInterval(id: number) { timers.delete(id); },
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    source = { readyState: 0, onopen: null, onmessage: null, onerror: null, addEventListener: noop, close: noop };
    setTransport({ ...transport, openEventSource: () => source, async fetch(input) {
      const path = String(input); reads.push(path);
      if (path === "/api/machines") return Response.json({ machines: [local(readState)] });
      return path === "/api/health" && !healthUp ? Response.json({ error: { code: "down" } }, { status: 500 }) : Response.json({ ok: true });
    } });
    await act(async () => { renderer = create(createElement(Probe)); });
    reads.length = 0; // opening reads are not part of the steady-state minute
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    setTransport(transport);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      due[1].at += due[1].every;
      await act(async () => { due[1].run(); });
    }
    now = end;
  }
  async function stream(update: "opened" | "lost" | "closed" | Machine[]) {
    await act(async () => {
      if (Array.isArray(update)) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: update }) }));
      else if (update === "opened") { source.readyState = 1; source.onopen?.(new Event("open")); }
      else { source.readyState = update === "lost" ? 0 : 2; source.onerror?.(new Event("error")); }
    });
  }
  async function onSocket(message: ServerMessage | "disconnect") {
    await act(async () => {
      if (message === "disconnect") for (const listener of [...disconnectListeners]) listener();
      else for (const listener of [...socketListeners]) listener(message);
    });
  }
  async function healthyStream() { await stream("opened"); await stream([local()]); }
  const counts = () => ["/api/machines", "/api/health", "/api/health?scope=bridge"].map((path) => reads.filter((read) => read === path).length);

  it("reduces an idle minute from 36 GETs to 6 only after an open stream pushes a connected local PC", async () => {
    await advance(60_000);
    expect(counts()).toEqual([12, 12, 12]);
    reads.length = 0;
    await healthyStream();
    await advance(60_000);
    expect(counts()).toEqual([2, 2, 2]);
  });

  it("does not trust an open stream or a successful REST roster without a pushed local PC", async () => {
    await stream("opened");
    await advance(10_000);
    expect(counts()).toEqual([2, 2, 2]);
    await stream([{ ...local(), id: "remote", kind: "ssh" }]);
    await advance(5_000);
    expect(counts()).toEqual([3, 3, 3]);
  });

  it("does not postpone the half-open backstop when identical rosters keep arriving", async () => {
    await healthyStream();
    for (let i = 0; i < 6; i++) { await advance(5_000); await stream([local()]); }
    expect(counts()).toEqual([1, 1, 1]);
    await advance(30_000); // no more pushes: EventSource cannot detect a missing heartbeat
    expect(counts()).toEqual([2, 2, 2]);
  });

  for (const failure of ["lost", "closed", "away", "missing"] as const) {
    it(`reads immediately and every five seconds when the stream is ${failure}`, async () => {
      await healthyStream();
      await advance(1_000);
      await stream(failure === "away" ? [local("disconnected")] : failure === "missing" ? [] : failure);
      expect(counts()).toEqual([1, 1, 1]);
      await advance(5_000);
      expect(counts()).toEqual([2, 2, 2]);
      await stream("opened"); // a reopen alone cannot reuse a roster from the lost stream
      if (failure === "lost" || failure === "closed") {
        await advance(5_000);
        expect(counts()).toEqual([3, 3, 3]);
      }
      await stream([local()]);
      reads.length = 0;
      await advance(29_999);
      expect(counts()).toEqual([0, 0, 0]);
      await advance(1);
      expect(counts()).toEqual([1, 1, 1]);
    });
  }

  it("slows down the same way when the local terminal socket carries the events, and reads at once when it drops", async () => {
    socketEvents = true;
    await onSocket({ type: "features", features: ["machine-events"] } as ServerMessage);
    await onSocket({ type: "machine-event", event: { type: "machines", machines: [local()] } satisfies MachineEvent } as ServerMessage);
    await advance(60_000);
    expect(counts()).toEqual([2, 2, 2]);
    reads.length = 0;
    socketEvents = undefined;
    await onSocket("disconnect");
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
  });

  it("does not keep the slow backstop on SSE's roster once the terminal socket takes over", async () => {
    await healthyStream();
    await advance(1_000);
    socketEvents = true;
    await onSocket({ type: "features", features: ["machine-events"] } as ServerMessage);
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
    await onSocket({ type: "machine-event", event: { type: "machines", machines: [local()] } satisfies MachineEvent } as ServerMessage);
    reads.length = 0;
    await advance(29_999);
    expect(counts()).toEqual([0, 0, 0]);
  });

  it("watches health every five seconds after a failed read while the stream stays healthy, and slows again once it answers", async () => {
    await healthyStream();
    healthUp = false;
    await advance(30_000);
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
    healthUp = true;
    await advance(5_000);
    expect(counts()).toEqual([3, 3, 3]);
    await advance(29_999);
    expect(counts()).toEqual([3, 3, 3]);
    await advance(1);
    expect(counts()).toEqual([4, 4, 4]);
  });

  it("returns to five seconds when a roster read shows this PC away under a silent open stream", async () => {
    await healthyStream();
    readState = "disconnected";
    await advance(30_000);
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
    readState = "connected";
    await advance(30_000); // a read alone never slows it again: that waits for a pushed roster
    expect(counts()).toEqual([8, 8, 8]);
  });

  it("watches health immediately and every five seconds while locked, without reading the roster", async () => {
    await healthyStream();
    await act(async () => { locked = true; renderer!.update(createElement(Probe)); });
    expect(counts()).toEqual([0, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([0, 2, 2]);
    await act(async () => { locked = false; renderer!.update(createElement(Probe)); });
    await advance(5_000);
    expect(counts()).toEqual([1, 3, 3]);
    await healthyStream();
    reads.length = 0;
    await advance(30_000);
    expect(counts()).toEqual([1, 1, 1]);
  });

  it("polls nothing hidden, catches up once on return and removes its timer on unmount", async () => {
    await healthyStream();
    visibility = "hidden";
    await act(async () => { events.dispatchEvent(new Event("visibilitychange")); });
    await advance(60_000);
    await stream("lost");
    await advance(5_000);
    expect(counts()).toEqual([0, 0, 0]);
    visibility = "visible";
    await act(async () => { events.dispatchEvent(new Event("visibilitychange")); });
    expect(counts()).toEqual([1, 1, 1]);
    await advance(5_000);
    expect(counts()).toEqual([2, 2, 2]);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(timers.size).toBe(0);
    reads.length = 0;
    await advance(60_000);
    expect(reads).toEqual([]);
  });
});
