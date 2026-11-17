/** Machine notifications reuse the local terminal socket; old servers keep their SSE transport. */
import type { Machine, MachineEvent } from "../../shared/machines.ts";
import { CompactAgentsError, expandMachine, expandMachineEvent, type WireMachineEvent } from "../../shared/compact-agents.ts";
import type { HerdrSocket } from "./ws.ts";
import { keepEventStream, type EventStreamHandlers } from "./eventStream.ts";

type MachineEventHandlers = Omit<EventStreamHandlers, "message"> & {
  /** kept: the PCs in a roster whose snapshot is the roster's own (previous), as the event's could not be read */
  message(event: MachineEvent, kept: ReadonlySet<string>): void;
  /** the PC as the roster has it now: it stands in for one whose compact snapshot cannot be read */
  previous(machineId: string): Machine | undefined;
  /** these PCs' compact snapshots could not be read, after the event that kept their last ones: read them in full */
  unreadable(machineIds: readonly string[]): void;
};
export type MachineEventSocket = Pick<HerdrSocket, "on" | "onDisconnect" | "connect" | "machineEventsAvailable" | "outputStopped" | "setMachineEvents">;

/**
 * How long a connection may leave unsaid whether it carries machine events before SSE takes over: a
 * socket that cannot connect, or an older server whose snapshot fails, never says.
 */
export const MACHINE_EVENTS_SETTLE_MS = 5_000;

/**
 * Machine events over the local terminal socket while it carries them, and over SSE whenever it
 * does not: an older or rolled-back server, a connection that has not said within
 * MACHINE_EVENTS_SETTLE_MS, a socket stopped for output (4008, which reconnects only on an attach),
 * or a connection whose server ended the subscription. The next connection that offers them takes over again.
 */
export function keepMachineEvents(socket: MachineEventSocket, handlers: MachineEventHandlers,
  fallback: (handlers: EventStreamHandlers) => () => void = (callbacks) => keepEventStream("/api/machines/events?compact_agents=1", callbacks),
  wait: (run: () => void, ms: number) => () => void = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); }): () => void {
  let subscribed = false;
  let stopped = false;
  let endedByServer = false;
  let stopFallback: (() => void) | undefined;
  let stopWaiting: (() => void) | undefined;
  const settled = () => { stopWaiting?.(); stopWaiting = undefined; };
  // either transport: a PC whose compact snapshot cannot be read keeps its last one, and the others go on
  const deliver = (event: WireMachineEvent) => {
    const kept = new Set<string>();
    const read = <T>(machineId: string, expand: () => T, previous: () => T): T => {
      try { return expand(); } catch (error) {
        if (!(error instanceof CompactAgentsError)) throw error;
        kept.add(machineId);
        return previous();
      }
    };
    const payload = event.type === "machines"
      ? { ...event, machines: event.machines.map((machine) => read(machine.id, () => expandMachine(machine), () => ({ ...machine, snapshot: handlers.previous(machine.id)?.snapshot ?? null }))) }
      // the roster reads no pushed snapshot (it takes rosters): one that cannot be read is left out
      : read(event.type === "machine-message" ? event.machine_id : "", (): MachineEvent | null => expandMachineEvent(event), () => null);
    if (payload) handlers.message(payload, kept);
    if (kept.size > 0) handlers.unreadable([...kept]);
  };
  const openFallback = () => {
    settled();
    if (stopFallback) return;
    stopFallback = fallback({ ...handlers, message: (event) => {
      let wire: WireMachineEvent;
      try { wire = JSON.parse(event.data) as WireMachineEvent; } catch { return; }
      deliver(wire);
    } });
  };
  const choose = () => {
    if (stopped) return;
    const available = socket.machineEventsAvailable;
    if (available && !endedByServer) {
      settled();
      stopFallback?.(); stopFallback = undefined;
      if (subscribed) return;
      subscribed = true;
      handlers.opened();
      socket.setMachineEvents(true);
    } else if (available === false || endedByServer || socket.outputStopped) {
      openFallback();
    } else if (!stopFallback && !stopWaiting) {
      stopWaiting = wait(() => { stopWaiting = undefined; if (!stopped) openFallback(); }, MACHINE_EVENTS_SETTLE_MS);
    }
  };
  const lose = () => { if (subscribed) { subscribed = false; handlers.lost(); } };
  const offMessage = socket.on((message) => {
    if (stopped) return;
    if (message.type === "features" || message.type === "snapshot") choose();
    else if (message.type === "machine-event" && subscribed) deliver(message.event);
    else if (message.type === "machine-events-ended") { endedByServer = true; lose(); choose(); }
    // output stopped (4008): the socket waits for an attach, the sidebar does not
    else if (message.type === "error" && message.code === "output_stalled") choose();
  });
  const offDisconnect = socket.onDisconnect(() => {
    endedByServer = false;
    lose();
    choose();
  });
  choose();
  socket.connect();
  return () => {
    if (stopped) return;
    stopped = true;
    offMessage(); offDisconnect(); stopFallback?.(); settled();
    if (subscribed) socket.setMachineEvents(false);
  };
}
