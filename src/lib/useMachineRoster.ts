import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { DevicePairedEvent, DeviceRemovedEvent, Machine, MachineEvent, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { ApiError, authenticate, fetchMachines, observePaneSessions, paneSessionEvents, paneSessionsMoving, verifySourceBoot } from "./api.ts";
import { passingFolder, recentDirectories } from "./recent-directories.ts";
import { keepMachineEvents } from "./machineEventStream.ts";
import { MachineSessionRegistry } from "./machineSession.ts";
import { receiveSeen } from "./seenFinishes.ts";
import { withPairedNotice } from "./pairedNotices.ts";
import { takeAuthTokenFromUrl } from "./authLink.ts";
import { applyPaneStatus } from "./snapshot.ts";
import { setAgentRowTokens } from "./agentRowTokens.ts";
import { stateWatch } from "./agentStateWatch.ts";
import { SnapshotRequests } from "./snapshotRequests.ts";
import { ReorderCoordinator } from "./workspaceOrder.ts";
import type { AppLink } from "./deepLink.ts";
import type { TerminalPeek } from "./terminalPeek.ts";
import type { NotificationTarget } from "./notificationTarget.ts";
import type { SelectionMark } from "./selectionMark.ts";
import { otherTargets, type SplitState } from "./split.ts";
import { deviceInUse, followsHerdrFocus, movingHerdrFocusOn } from "./followFocus.ts";
import { pruneWaitingSends } from "./sentWaiting.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { displayPaneTitle } from "../components/Sidebar.tsx";
import { useHeaderConnection, type HeaderConnection } from "./headerConnection.ts";
import type { usePreferencesSync } from "./preferencesSync.ts";
import type { useAlertSignals } from "./useAlertSignals.ts";

const POLL_MS = 5000;
const STREAM_BACKSTOP_MS = 30_000;
type RosterStreamUpdate = "opened" | "lost" | "closed" | Machine[];

/** The stream that feeds the roster: open now, and opened before since the page loaded (a first opening is no reconnect). */
export interface RosterLink { open: boolean; before: boolean }

/** The roster stream after an update; the same object when only a roster came, so nothing draws again for it. */
export function rosterLinkAfter(link: RosterLink, update: RosterStreamUpdate): RosterLink {
  if (Array.isArray(update)) return link;
  if (update === "opened") return link.open ? link : { open: true, before: true };
  return link.open ? { open: false, before: link.before } : link;
}

/** each object's keys in one order: an agent row restored from a compact one has its keys in another */
const sortedKeys = (_key: string, value: unknown): unknown => value !== null && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, (value as Record<string, unknown>)[key]]))
  : value;

/**
 * Polls and the event stream hand over fresh objects every few seconds even when nothing
 * changed; storing them re-rendered the whole app (the chat transcript included) each time.
 */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // the plain encoding first: equal data in the same key order (two rosters from one transport) and a change
  // of length end here. Sorting every object's keys costs about ten times as much, and runs for any two
  // encodings of the same length: equal data in another key order (a row restored from a compact one beside
  // a full read), and a change that keeps the length (working to blocked, idle to done, a counter's digits).
  const plain = JSON.stringify(a);
  const other = JSON.stringify(b);
  return plain === other || (plain?.length === other?.length && JSON.stringify(a, sortedKeys) === JSON.stringify(b, sortedKeys));
}
type PaneStatus = Extract<ServerMessage, { type: "pane-status" }>;

/** A pane status on its PC as the roster shows it: for an event as it comes, and for one held through a recovery read. */
function withPaneStatus(machine: Machine, message: PaneStatus): Machine {
  if (!machine.snapshot) return machine;
  const snapshot = applyPaneStatus(machine.snapshot, message.pane_id, message.agent_status, message.background_tasks, message.background_wait === true, message.plan, message.finish_id, message.finish_epoch, message.context);
  return snapshot === machine.snapshot ? machine : { ...machine, snapshot };
}

/** full reads a recovering PC may lose to its own newer messages: the one after them is applied anyway */
const RECOVERY_DROPS = 2;
/** pane statuses held per recovering PC to apply over that read; past this the oldest give way */
const RECOVERY_HELD = 64;
/** A PC whose compact snapshot could not be read: `entered` is its event count when this recovery began. */
interface Recovering { entered: number; dropped: number; held: { told: number; message: PaneStatus }[] }

/** trailing debounce for push-triggered refetches: bursts of events become one fetch */
const REFETCH_DEBOUNCE_MS = 500;

export function useRosterState() {
  const [machineSessions] = useState(() => new MachineSessionRegistry());
  useEffect(() => () => machineSessions.closeAll(), [machineSessions]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [machineRosterLoaded, setMachineRosterLoaded] = useState(false);
  return { machineSessions, machines, setMachines, machineRosterLoaded, setMachineRosterLoaded };
}

/**
 * Signing out closes every socket, as unmounting the sessions provider did: one kept open would
 * carry its old authority behind the sign-in gate and be reused by the next sign-in.
 */
export function useCloseSessionsWhenLocked(machineSessions: Pick<MachineSessionRegistry, "closeAll">, locked: boolean | null): void {
  useEffect(() => { if (locked) machineSessions.closeAll(); }, [machineSessions, locked]);
}

export function useRecentFolderMemory({ machines }: { machines: Machine[] }) {
  // New workspace's recent folders also know where a PC's panes are: kept behind the folders started in
  useEffect(() => {
    for (const machine of machines) {
      if (machine.state !== "connected" || !machine.snapshot) continue;
      // a worktree's checkout or a temporary folder is no project to start a workspace in
      const linked = machine.snapshot.workspaces.filter((workspace) => workspace.worktree?.is_linked_worktree);
      const inLinked = new Set(linked.map((workspace) => workspace.workspace_id));
      const worktrees = linked.map((workspace) => workspace.worktree!.checkout_path);
      recentDirectories.remember(machine.id, machine.snapshot.panes
        .filter((pane) => !pane.restore_error && !inLinked.has(pane.workspace_id) && !(pane.cwd && passingFolder(pane.cwd, worktrees)))
        .map((pane) => pane.cwd).reverse());
    }
  }, [machines]);
}

export function useMachinesRef({ machines }: { machines: Machine[] }) {
  const machinesRef = useRef(machines); machinesRef.current = machines;
  return { machinesRef };
}

export function useRosterError() {
  const [error, setError] = useState<string | null>(null);
  return { error, setError };
}

export function useRefetchTimer() {
  const refetchTimer = useRef<number | null>(null);
  return { refetchTimer };
}

const localConnectedIn = (machines: readonly Machine[]): boolean => machines.some((machine) => machine.id === "local" && machine.state === "connected");

export function useRosterLoader({ locked, healthFailing, rosterIn, setMachines, setMachineRosterLoaded, setError, setLocked, loadHealth, lockedRef, refetchTimer }: {
  locked: boolean | null;
  /** this PC's last health read failed: health is watched every five seconds until one answers */
  healthFailing: boolean;
  rosterIn: () => void;
  setMachines: Dispatch<SetStateAction<Machine[]>>;
  setMachineRosterLoaded: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setLocked: Dispatch<SetStateAction<boolean | null>>;
  loadHealth: () => Promise<void>;
  lockedRef: RefObject<boolean | null>;
  refetchTimer: RefObject<number | null>;
}) {
  const snapshotRequests = useRef(new SnapshotRequests());
  const stream = useRef({ open: false, localConnected: false });
  const polling = useRef<((readNow: boolean) => void) | null>(null);
  // What the stream that feeds the roster has to say, which the inbox mode's list says (components/InboxList.tsx):
  // its rows come from it, whether or not a pane is mounted under the list
  const [link, setLink] = useState<RosterLink>({ open: false, before: false });
  const rosterConnection: HeaderConnection = useHeaderConnection({ scope: "roster", reportedBy: "roster", connected: link.open, connectedBefore: link.before, outputStopped: false });
  const onRosterStream = useCallback((update: RosterStreamUpdate) => {
    setLink((previous) => rosterLinkAfter(previous, update));
    // the agents' state times go by what the page was told, and when (lib/agentStateWatch.ts)
    if (Array.isArray(update)) stateWatch.pushed();
    else stateWatch.subscription(update);
    const previous = stream.current.open && stream.current.localConnected;
    if (Array.isArray(update)) stream.current.localConnected = localConnectedIn(update);
    // Every opening, a switch from SSE to the terminal socket included, waits for its own first
    // roster (each subscription sends one at once) rather than trusting the last transport's.
    else if (update === "opened") stream.current = { open: true, localConnected: false };
    else stream.current = { open: false, localConnected: false };
    const slow = stream.current.open && stream.current.localConnected;
    // Repeated pushed rosters must not postpone the backstop. Leaving the slow backstop (a lost
    // local PC or stream) reads at once, then watches health as quickly as a tab without push; a
    // stream that never saw a connected local PC was polling every five seconds already.
    if (previous !== slow) polling.current?.(!slow && lockedRef.current !== true);
  }, []);
  // a failed health read is not something the stream tells: until one answers, the cadence is a tab's without push
  const healthFailingRef = useRef(healthFailing);
  useEffect(() => {
    if (healthFailingRef.current === healthFailing) return;
    healthFailingRef.current = healthFailing;
    polling.current?.(false);
  }, [healthFailing]);
  useEffect(() => {
    if (locked !== true) return;
    stream.current = { open: false, localConnected: false };
    polling.current?.(true);
  }, [locked]);
  // every PC's dragged workspace order, held until a roster read after its moves comes
  // (lib/workspaceOrder.ts): App's, so a Sidebar remount or PC switch cannot lose it. A roster load
  // once the moves settle may bring that roster sooner; it proves nothing by itself.
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const [reorderCoordinator] = useState(() => new ReorderCoordinator({ verify: verifySourceBoot, onSettled: () => void loadRef.current() }));
  // PCs shown with their last snapshot because their compact one could not be read (`machines`): until a full
  // read or a readable event brings them again, no other event stands for them. `told`: how many events told
  // something newer of each PC, so a full read stands for a PC only if none came while it was out
  const recovery = useRef({ machines: new Map<string, Recovering>(), told: new Map<string, number>() });
  /** full: a PC's compact snapshot could not be read, so this read asks for full rows */
  const read = useCallback(async (full: boolean) => {
    const started = reorderCoordinator.loadStarted();
    const asked = stateWatch.asked();
    // the PC events this read starts after: a roster read later names its panes' sessions as they are now
    const readAfter = paneSessionEvents();
    const toldBefore = new Map(recovery.current.told);
    try {
      await snapshotRequests.current.read(() => fetchMachines(undefined, full), (next) => {
        // a PC whose herdr was replaced leaves its panes' drafts and lenses before they are drawn
        paneLifetimes.observe(next, displayPaneTitle);
        pruneWaitingSends(next);
        // a pane's conversation answers stand for the session it was on: the chats read this roster's
        observePaneSessions(next, readAfter);
        // a read showing this PC away ends the slow backstop as a pushed roster would: a stream can
        // stay open and say nothing. Only a pushed roster starts it.
        if (stream.current.localConnected && !localConnectedIn(next)) {
          stream.current.localConnected = false;
          polling.current?.(false);
        }
        reorderCoordinator.roster(next, { kind: "load", started });
        for (const machine of next) recovery.current.machines.delete(machine.id);
        setMachines((previous) => sameData(previous, next) ? previous : next);
        rosterIn();
        stateWatch.read(asked);
        setMachineRosterLoaded(true);
        setError(null); setLocked(false);
      }, full ? (next) => {
        // overtaken by an event: a PC still recovering takes this read's snapshot only if no event told
        // something newer of it while the read was out; every other PC keeps what the events told. A PC whose
        // own messages keep overtaking its reads would never recover: after RECOVERY_DROPS such reads, the next
        // one begun in this recovery is applied anyway, with the pane statuses that came while it was out on top
        const { machines: waiting, told } = recovery.current;
        const recovered = next.flatMap((machine) => {
          const recovering = waiting.get(machine.id);
          if (!recovering) return [];
          const before = toldBefore.get(machine.id) ?? 0;
          if ((told.get(machine.id) ?? 0) !== before && (recovering.dropped < RECOVERY_DROPS || before < recovering.entered)) {
            recovering.dropped++;
            return [];
          }
          waiting.delete(machine.id);
          return [recovering.held.filter((held) => held.told > before).reduce((shown, held) => withPaneStatus(shown, held.message), machine)];
        });
        if (recovered.length === 0) return;
        paneLifetimes.observe(recovered, displayPaneTitle);
        pruneWaitingSends(recovered);
        observePaneSessions(recovered, readAfter);
        setMachines((previous) => previous.map((machine) => recovered.find((read) => read.id === machine.id) ?? machine));
      } : undefined);
    }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) { setLocked(true); return; }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rosterIn, reorderCoordinator]);
  const load = useCallback(() => read(false), [read]);
  loadRef.current = load;

  useEffect(() => {
    const tick = (): void => {
      // a hidden tab (or a phone app in the background) polls nothing; it catches up on return
      if (document.visibilityState === "hidden") return;
      void loadHealth();
      // a locked tab only watches health, so a token entered in another tab still unlocks it
      if (lockedRef.current !== true) void load();
    };
    let timer = 0;
    let disposed = false;
    const schedule = (readNow: boolean): void => {
      window.clearInterval(timer);
      if (readNow) tick();
      const slow = lockedRef.current !== true && !healthFailingRef.current && stream.current.open && stream.current.localConnected;
      timer = window.setInterval(tick, slow ? STREAM_BACKSTOP_MS : POLL_MS);
    };
    void (async (): Promise<void> => {
      // a bookmarked `#auth=<token>` link unlocks without typing; the fragment is
      // stripped before anything renders, and a stale token falls through to the
      // gate the first health check mounts
      const linkToken = takeAuthTokenFromUrl();
      if (linkToken !== null) await authenticate(linkToken).catch(() => undefined);
      if (disposed) return;
      polling.current = schedule;
      schedule(true);
    })();
    const onVisible = (): void => {
      if (document.visibilityState === "visible" && !disposed) schedule(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      polling.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, loadHealth]);

  // push-triggered refetches are debounced so an event burst becomes one fetch, a full one when any asked for it
  const refetchWanted = useRef({ full: false, plain: false });
  const scheduleRefetch = useCallback((full = false) => {
    refetchWanted.current[full ? "full" : "plain"] = true;
    if (refetchTimer.current !== null) return;
    refetchTimer.current = window.setTimeout(() => {
      refetchTimer.current = null;
      const wanted = refetchWanted.current;
      refetchWanted.current = { full: false, plain: false };
      // a full read is for PCs still recovering: once none is, only a plain one asked for is due
      const fullRead = wanted.full && recovery.current.machines.size > 0;
      if (lockedRef.current !== true && (fullRead || wanted.plain)) void read(fullRead);
    }, REFETCH_DEBOUNCE_MS);
  }, [read]);

  useEffect(() => () => {
    if (refetchTimer.current !== null) window.clearTimeout(refetchTimer.current);
  }, []);
  return { snapshotRequests, recovery, reorderCoordinator, load, scheduleRefetch, onRosterStream, rosterConnection };
}

export function useRosterEvents({ onPaneMoved, machineSessions, locked, onRosterStream, receivePreferencesRef, snapshotRequests, recovery, onRoster, reorderCoordinator, setMachines, rosterIn, setMachineRosterLoaded, machinesRef, onPaneStatus, onPaneExited, followFocusRef, selectionRef, splitShownRef, splitRef, pendingLink, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, scheduleRefetch, preferencesResubscribedRef, preferencesDisconnectedRef, preferencesClosedRef, dropIn, chime, setPairedNotices, setRelayPairings, setRemotePairings, setRemovedNotices, getTakeNotificationTargetRef }: {
  machineSessions: MachineSessionRegistry;
  locked: boolean | null;
  onRosterStream: (update: RosterStreamUpdate) => void;
  receivePreferencesRef: RefObject<ReturnType<typeof usePreferencesSync>["receive"]>;
  snapshotRequests: RefObject<SnapshotRequests>;
  /** the loader's PCs waiting for a full read (useRosterLoader) */
  recovery: RefObject<{ machines: Map<string, Recovering>; told: Map<string, number> }>;
  onRoster: ReturnType<typeof useAlertSignals>["onRoster"];
  reorderCoordinator: ReorderCoordinator;
  setMachines: Dispatch<SetStateAction<Machine[]>>;
  rosterIn: () => void;
  setMachineRosterLoaded: Dispatch<SetStateAction<boolean>>;
  machinesRef: RefObject<Machine[]>;
  onPaneStatus: ReturnType<typeof useAlertSignals>["onPaneStatus"];
  onPaneExited: ReturnType<typeof useAlertSignals>["onPaneExited"];
  /** herdr moved a pane of a PC under a new ID (the server's pane-moved, #1503) */
  onPaneMoved: (machineId: string, from: string, to: string) => void;
  followFocusRef: RefObject<boolean>;
  selectionRef: RefObject<SelectionMark>;
  splitShownRef: RefObject<boolean>;
  splitRef: RefObject<SplitState | null>;
  pendingLink: RefObject<AppLink | null>;
  selectionHint: RefObject<{ machine: string; pane: string; workspace: string } | null>;
  setSelectedPaneId: Dispatch<SetStateAction<string | null>>;
  setNotificationViewTarget: Dispatch<SetStateAction<NotificationTarget | null>>;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  scheduleRefetch: (full?: boolean) => void;
  preferencesResubscribedRef: RefObject<ReturnType<typeof usePreferencesSync>["resubscribed"]>;
  preferencesDisconnectedRef: RefObject<ReturnType<typeof usePreferencesSync>["disconnected"]>;
  preferencesClosedRef: RefObject<ReturnType<typeof usePreferencesSync>["closed"]>;
  dropIn: ReturnType<typeof useAlertSignals>["dropIn"];
  chime: ReturnType<typeof useAlertSignals>["chime"];
  setPairedNotices: Dispatch<SetStateAction<readonly DevicePairedEvent[]>>;
  /** relay pairings waiting for this PC's owner (components/RelayPairingPrompt.tsx) */
  setRelayPairings: Dispatch<SetStateAction<readonly RelayPairingRequest[]>>;
  /** devices asking to join the account through this PC (components/AccountApprovals.tsx) */
  setRemotePairings: Dispatch<SetStateAction<readonly RemotePairingRequest[]>>;
  /** devices removed from this PC (components/DevicePairedNotice.tsx, DeviceRemovedNotice) */
  setRemovedNotices: Dispatch<SetStateAction<readonly DeviceRemovedEvent[]>>;
  getTakeNotificationTargetRef: () => RefObject<(target: NotificationTarget) => void>;
}) {
  useCloseSessionsWhenLocked(machineSessions, locked);
  // The local socket watches every PC, even when no terminal is selected; older servers use SSE.
  useEffect(() => {
    if (locked !== false) return;
    const onMessage = (payload: MachineEvent, kept: ReadonlySet<string>) => {
      stateWatch.heard();
      const takeNotificationTargetRef = getTakeNotificationTargetRef();
      if (payload.type === "preferences") { receivePreferencesRef.current(payload.preferences); return; }
      if (payload.type === "herdr-sidebar") { setAgentRowTokens(payload.agents); return; }
      if (payload.type === "seen") { receiveSeen(payload.finishes); return; }
      // a device paired with this server: told once per enrollment, kept until read, the oldest giving way
      if (payload.type === "device-paired") { setPairedNotices((list) => withPairedNotice(list, payload)); return; }
      if (payload.type === "relay-pairings") { setRelayPairings(payload.pairings); return; }
      if (payload.type === "remote-pairings") { setRemotePairings(payload.pairings); return; }
      // a device removed from this PC: told once per removal, kept until read, the oldest giving way
      if (payload.type === "device-removed") { setRemovedNotices((list) => withPairedNotice(list, payload)); return; }
      // a PC kept with its last snapshot (its compact one could not be read) is not told by this event
      const fresh = payload.type === "machines" ? payload.machines.filter((machine) => !kept.has(machine.id)) : [];
      const vouches = payload.type !== "machines" || kept.size === 0 || fresh.length > 0;
      // A poll started before this event can carry an older roster or pane status.
      if (vouches) snapshotRequests.current.invalidate();
      // this event tells something newer of the PC than a full read already out: that read no longer stands for it
      const tell = (machineId: string) => { const { told } = recovery.current; told.set(machineId, (told.get(machineId) ?? 0) + 1); };
      if (payload.type === "machines") {
        // a readable roster for a PC ends its recovery: its data is good
        for (const machine of fresh) { tell(machine.id); recovery.current.machines.delete(machine.id); }
        if (vouches) onRosterStream(payload.machines);
        paneLifetimes.observe(payload.machines, displayPaneTitle);
        pruneWaitingSends(payload.machines);
        observePaneSessions(fresh);
        onRoster(payload.machines);
        reorderCoordinator.roster(payload.machines, { kind: "event" });
        setMachines((previous) => sameData(previous, payload.machines) ? previous : payload.machines);
        rosterIn();
        setMachineRosterLoaded(true);
        return;
      }
      tell(payload.machine_id);
      const recovering = recovery.current.machines.get(payload.machine_id);
      if (recovering) {
        // the read out now no longer stands for this PC, so one more is due; a pane status is kept to apply
        // over a read that is applied anyway (its only part of the roster a later read would undo)
        if (payload.message.type === "pane-status") {
          recovering.held.push({ told: recovery.current.told.get(payload.machine_id)!, message: payload.message });
          if (recovering.held.length > RECOVERY_HELD) recovering.held.shift();
        }
        scheduleRefetch(true);
      }
      const machine = machinesRef.current.find((m) => m.id === payload.machine_id);
      if (!machine) return;
      const message = payload.message;
      if (message.type === "pane-status") {
        onPaneStatus(machine, message, takeNotificationTargetRef);
        setMachines((list) => {
          let changed = false;
          const next = list.map((m) => {
            if (m.id !== machine.id) return m;
            const shown = withPaneStatus(m, message);
            if (shown !== m) changed = true;
            return shown;
          });
          return changed ? next : list;
        });
      }
      if (message.type === "pane-exited") {
        if (machine.id === "local") window.dispatchEvent(new Event("herdr-usage-changed"));
        onPaneExited(machine, message, takeNotificationTargetRef);
      }
      // herdr's own window moved to another pane: this device follows it when asked to. As an
      // automatic pick it raises no keyboard and adds no Back entry; a pane too new for the roster
      // is confirmed with its PC first, as a pane made here is (the selection effect below)
      if (message.type === "pane-focused" && followsHerdrFocus({
        enabled: followFocusRef.current, machineId: machine.id, paneId: message.pane_id, selection: selectionRef.current,
        splitOthers: splitShownRef.current ? otherTargets(splitRef.current) : [], linkPending: pendingLink.current !== null,
        busy: deviceInUse(selectionRef.current), ownMove: movingHerdrFocusOn(machine.id),
      })) {
        selectionHint.current = null;
        setSelectedPaneId(message.pane_id);
        setNotificationViewTarget(null); setTerminalPeek(null);
        setAutoSelected(true);
      }
      // told before the structure change of the move: the pane's state and view go to the new ID first
      if (message.type === "pane-moved") onPaneMoved(machine.id, message.from, message.to);
      if (message.type === "session-changed" || message.type === "pane-exited") {
        // until the roster after it comes, the panes' sessions are not known: no press read of the old one is taken
        paneSessionsMoving(machine.id);
        scheduleRefetch();
      }
    };
    const stop = keepMachineEvents(machineSessions.get("local").socket, {
      // opened or reopened: a shared-settings save paused by failures gets a new round
      opened: () => { onRosterStream("opened"); preferencesResubscribedRef.current(); },
      // lost (the browser reconnects by itself): a shared-settings save waits for that instead of retrying
      lost: () => { onRosterStream("lost"); preferencesDisconnectedRef.current(); },
      // the browser gave up on it (a proxy's 502 during a restart): a save nobody refused stops waiting for
      // it while a new one is opened, and a refused one waits for that one's opening document (after a 401
      // the next poll locks the app, which ends this effect and its wait)
      closed: () => { onRosterStream("closed"); preferencesClosedRef.current(); },
      message: onMessage,
      previous: (machineId) => machinesRef.current.find((machine) => machine.id === machineId),
      unreadable: (machineIds) => {
        const { machines: waiting, told } = recovery.current;
        for (const id of machineIds) if (!waiting.has(id)) waiting.set(id, { entered: told.get(id) ?? 0, dropped: 0, held: [] });
        scheduleRefetch(true);
      },
    });
    return () => { stop(); onRosterStream("closed"); };
  }, [machineSessions, locked, scheduleRefetch, dropIn, chime, reorderCoordinator, onRosterStream]);
}
