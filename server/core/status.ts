/**
 * Pane status as clients and web push see it: the completion tracker, OmO's, GJC's and Claude's
 * own status, background waits, plans, the machine roster and the one collector that feeds them.
 */
import { join } from "node:path";
import type { AgentStatus, HerdrPane, PlanSummary, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import { alertStatus, paneAlertsMuted, paneTitle } from "../../shared/notify-policy.ts";
import { BackgroundWait } from "../background-wait.ts";
import { ClaudeSubagentStatus } from "../claude-subagents.ts";
import { codexOpenRollout, paneCodexHome } from "../codex.ts";
import { startStatusCollector } from "../collector.ts";
import { CompletionTracker, type OmoRest } from "../completion.ts";
import { Finishes } from "../finishes.ts";
import { claudePanePid, claudePaneSession, forgetPaneTranscriptState } from "../conversation.ts";
import { releaseOpenCodePane, trackVerifiedOpenCodePanes } from "../opencode-native.ts";
import type { DeviceStore } from "../devices.ts";
import { createGjcStatus, gjcPanes, readOmoSnapshot, reconcileProviderStatus } from "../gjc-status.ts";
import type { HerdrMachineProfile } from "../herdr-profiles.ts";
import { paneGet, sessionSnapshot } from "../herdr/client.ts";
import { resolveAgent } from "../pane-context.ts";
import { launchedAgents } from "../launched-agents.ts";
import { bridgeAgentNews, MachineManager } from "../machines.ts";
import { omoPanes } from "../omo.ts";
import { OMO_ALIASES, OmoStatus } from "../omo-status.ts";
import type { OrderSequence } from "../order-sequence.ts";
import type { PendingInputs } from "../pending-input.ts";
import type { PreferenceStore } from "../preferences.ts";
import { promptWaitEnded, type OpenCodePromptState } from "../prompt.ts";
import { type AlertTiming, createPushService, defaultStateDir } from "../push.ts";
import { SessionPlans } from "../session-plan.ts";
import type { Telemetry } from "../telemetry.ts";
import type { UsageLoginService } from "../usage-login.ts";
import type { UsageService } from "../usage.ts";
import { type Client, send } from "./connections.ts";

/** a focus or reconnect re-reads the panes for the daily active message at most this often */
const VISIT_READ_MS = 10 * 60_000;

export function createStatusHub<Owner, Lease>({ options, devices, preferences, clients, present, pending, drainPending, holdPendingPane, usage, usageLogin }: {
  options: {
    stateDir?: string;
    codexHome?: string;
    telemetry?: Telemetry;
    machines?: boolean;
    herdrProfiles?: () => Promise<HerdrMachineProfile[]>;
    alertTiming?: Partial<AlertTiming>;
    pushLoopbackHttp?: boolean;
    backgroundWait?: { grace: number; limit: number };
    statusNow?: () => number;
    openCodeState?: OpenCodePromptState;
    /** this server's workspace-order counter (server/order-sequence.ts); createServer makes the one there is */
    orderSequence?: OrderSequence;
  };
  devices: DeviceStore;
  /** the preferences every browser shares (server/preferences.ts): web push reads the muted panes from it */
  preferences: PreferenceStore;
  clients: Set<Client>;
  present: Set<Client>;
  /** the pending messages' status and lifetime calls, whoever owns them (a connection, or the bridge for a first message) */
  pending: PendingInputs<Owner, Lease>;
  drainPending: (paneId: string) => void;
  holdPendingPane: (paneId: string, fault: { code: string; message: string }) => void;
  usage: UsageService;
  usageLogin: UsageLoginService;
}) {
  const push = createPushService({
    stateDir: options.stateDir ?? defaultStateDir(),
    timing: options.alertTiming,
    now: options.statusNow,
    loopbackHttp: options.pushLoopbackHttp === true,
    canDeliver: (id) => id === null || (id === undefined ? !devices.gated : devices.has(id)),
    inUse: () => present.size > 0,
    // the persisted list, read as each alert is scheduled and again as it goes out
    muted: (machineId, paneId) => paneAlertsMuted(preferences.get().muted_panes, machineId, paneId),
    lookupTitle: async (paneId) => {
      return paneTitle(await paneGet(paneId));
    },
  });
  // a mute made while an alert waits calls it off, so an unmute cannot resurrect an old finish
  const stopMutes = preferences.subscribe(() => push.mutesChanged());

  /** `done` for agents herdr loses track of (server/completion.ts), kept across restarts */
  const completions = new CompletionTracker(join(options.stateDir ?? defaultStateDir(), "completions.json"));
  const finishes = new Finishes();
  /** OmO panes get their status from OmO's session files: herdr reports none for them (server/omo-status.ts) */
  const omo = new OmoStatus({
    discover: (panes) => omoPanes(panes),
    snapshot: sessionSnapshot,
    onChange: (paneId, derived, background, turn, rest) => omoChanged(paneId, derived, background, turn, rest),
    // herdr called it `claude` or `pi` until now: what it finished under that name is its own
    // a wait another agent left is not OmO's; one OmO held before it was missed a while goes on
    onFound: (paneId, again) => { completions.adopt(paneId, "omo", OMO_ALIASES); if (!again) waits.forget(paneId); },
  });
  const omoSnapshot = () => readOmoSnapshot(sessionSnapshot, omo);
  /** GJC panes get their status from gjc's own transcript: herdr's `working` can be a provider child's (server/gjc-status.ts) */
  const gjc = createGjcStatus({
    discover: (panes) => gjcPanes(panes),
    snapshot: omoSnapshot,
    onChange: (paneId, derived, _background, turn, rest) => gjcChanged(paneId, derived, turn, rest),
    onFound: (paneId) => completions.adopt(paneId, "gjc", []),
  }, omo);
  /** Claude panes whose turn ended while work it started runs in the background (server/background-wait.ts) */
  const waits = new BackgroundWait(options.statusNow ?? Date.now, options.backgroundWait);
  /** the pane whose status event is reading its background work now: that event sends the one frame and alert of it */
  let settling: string | null = null;
  /** Claude panes count the subagents and commands they run as background tasks, read from the session's own files (server/claude-subagents.ts) */
  const claudeAgents = new ClaudeSubagentStatus({
    resolve: claudePaneSession,
    pid: claudePanePid,
    onReset: (paneId) => {
      const held = waits.waiting(paneId);
      waits.reset(paneId);
      claudeAgentsChanged(paneId, 0, 0, null, held);
    },
    onChange: (paneId, running, turnRunning, promptAt) => claudeAgentsChanged(paneId, running, turnRunning, promptAt),
  });
  /** the plan each Claude Code, Codex and OmO pane keeps, for the sidebar's progress (server/session-plan.ts) */
  const plans = new SessionPlans({
    claudePath: (paneId) => claudeAgents.sessionOf(paneId)?.path ?? null,
    omoPath: (paneId) => omo.pathOf(paneId),
    // only what is certain without reading the screen: the chat's own matching stays the chat's
    codexPath: async (pane) => codexOpenRollout(pane.pane_id, pane.cwd, await paneCodexHome(pane.pane_id, options.codexHome)),
    onChange: (paneId, summary) => planChanged(paneId, summary),
  });
  /** herdr's snapshot with OmO's and GJC's own status in it: what the completion tracker and web push are given */
  const rawSnapshot = async (): Promise<SessionSnapshot> => {
    const promptCheckpoint = options.openCodeState?.checkpoint();
    const snapshot = await omoSnapshot();
    await gjc.refresh(snapshot.panes);
    const named = gjc.apply(omo.apply(snapshot));
    // not waited for: finding a transcript costs process calls, and a snapshot must not wait on them.
    // The plans come after: a Claude pane's transcript is the one the subagent tracker found
    void claudeAgents.refresh(named.panes).catch(() => undefined).then(() => plans.refresh(named.panes)).catch(() => undefined);
    // an agent this server started has had no turn yet: its start screen is no work (launched-agents.ts)
    for (const pane of named.panes) pane.agent_status = launchedAgents.settle(pane.pane_id, pane.agent_status);
    options.openCodeState?.reconcile(named.panes, promptCheckpoint);
    return named;
  };
  const backgroundOf = (paneId: string): number => omo.backgroundOf(paneId) || claudeAgents.countOf(paneId);
  /** the snapshot clients get: finishes settled, OmO panes named, background tasks, waits and plan progress */
  const clientSnapshot = async (): Promise<SessionSnapshot> => {
    // the order this read can show is the one of the moves confirmed before it starts: taken before any wait,
    // and again by a read started afresh below
    const order = options.orderSequence?.read();
    const epoch = finishes.epoch;
    const snapshot = await completions.readSnapshot(rawSnapshot);
    // A read spanning a proven daemon replacement belongs to neither generation. Read afresh.
    if (epoch !== finishes.epoch) return clientSnapshot();
    const settled = finishes.snapshot({
      ...snapshot,
      panes: snapshot.panes.map((pane) => {
        const background = backgroundOf(pane.pane_id);
        const waiting = waits.waiting(pane.pane_id);
        const plan = plans.summaryOf(pane.pane_id);
        return background > 0 || waiting || plan !== null ? { ...pane, ...(background > 0 ? { background_tasks: background } : {}), ...(waiting ? { background_wait: true as const } : {}), ...(plan !== null ? { plan } : {}) } : pane;
      }),
    }, completions);
    return order ? { ...settled, ...order } : settled;
  };
  /**
   * A browser visit for the daily active message: the call is made now so the visit's day is the
   * trigger's, the panes are read after. Nothing is read while telemetry cannot send; a socket open
   * passes the snapshot it fetches anyway, and other visits read the panes at most every
   * VISIT_READ_MS (in between they still count the day, with the kinds already known).
   */
  let visitReadAt = -Infinity;
  function countVisit(snapshot?: ReturnType<typeof clientSnapshot>): void {
    const telemetry = options.telemetry;
    if (!telemetry?.counting()) return;
    let agents: Promise<(string | null)[]> | (string | null)[] = [];
    if (snapshot || Date.now() - visitReadAt >= VISIT_READ_MS) {
      visitReadAt = Date.now();
      agents = (snapshot ?? clientSnapshot()).then((read) => read.panes.map((pane) => resolveAgent(pane).agent));
    }
    void telemetry.active(agents)
      .catch((error) => console.error(`telemetry: the visit was not counted (${error instanceof Error ? error.message : String(error)})`));
  }
  /** A pane's status frame: every one says whether the pane waits on its turn's background work. */
  const paneStatus = (paneId: string, status: AgentStatus, about: { background_tasks?: number; plan?: PlanSummary | null } = {}): ServerMessage =>
    ({ type: "pane-status", pane_id: paneId, agent_status: status, ...finishes.status(paneId, status), ...about, ...(waits.waiting(paneId) ? { background_wait: true as const } : {}) });
  const machines = options.machines === false ? null : new MachineManager(options.stateDir ?? defaultStateDir(), push, completions, clientSnapshot, { bootId: options.orderSequence?.epoch });
  if (machines && options.herdrProfiles) machines.watchHerdrProfiles(options.herdrProfiles);

  function broadcastAll(message: ServerMessage): void {
    machines?.localMessage(message);
    for (const client of clients) send(client, message);
  }
  /** A broken state file must cost the alert, never the server (an unhandled rejection would). */
  const logPushError = (error: unknown): void => {
    console.error(`web push: ${error instanceof Error ? error.message : String(error)}`);
  };

  /** Status of EVERY pane, attached or not: one collector feeds all connected clients and web push. */
  function omoChanged(paneId: string, derived: AgentStatus, background: number, turn: boolean, rest: OmoRest | undefined): void {
    // OmO's own turn, which herdr's status never shows: back at work, its form has had its answer
    if (turn && derived === "working") promptWaitEnded(paneId);
    // a background task starting or ending is no turn: the status stands, and nothing is alerted.
    // A turn that ended in an error is at rest, not finished; an answer after it is a finish (#687)
    const status = turn ? completions.observe(paneId, derived, "omo", rest) : completions.current(paneId) ?? completions.observe(paneId, derived, "omo");
    if (turn) { pending.status(paneId, status); drainPending(paneId); }
    // a turn that ended while tasks its session started still run waits on them, as a Claude
    // pane's does (background-wait.ts): BG, not DONE, and a finish alerted once the work is over.
    // The count first: a turn that ends in the same read as its tasks were counted is held at once.
    // No time limit: the count drops a task whose host died, and a task's end wakes OmO
    const held = waits.waiting(paneId);
    waits.running(paneId, background, null, false);
    if (turn) waits.status(paneId, status);
    broadcastAll(paneStatus(paneId, status, { background_tasks: background }));
    if (turn || waits.waiting(paneId) !== held) push.onStatus(paneId, alertStatus(status, waits.waiting(paneId))).catch(logPushError);
  }

  /**
   * A GJC pane's own turn, which herdr's provider-child status never shows: back at work, its
   * form has had its answer. gjc keeps no background records to count, so a change is always a
   * turn, and an idle read after work is the finish — one ended in an error is not (#687).
   */
  function gjcChanged(paneId: string, derived: AgentStatus, turn: boolean, rest: OmoRest | undefined): void {
    if (turn && derived === "working") promptWaitEnded(paneId);
    const status = turn ? completions.observe(paneId, derived, "gjc", rest) : completions.current(paneId) ?? completions.observe(paneId, derived, "gjc");
    if (turn) { pending.status(paneId, status); drainPending(paneId); }
    broadcastAll(paneStatus(paneId, status));
    if (turn) push.onStatus(paneId, status).catch(logPushError);
  }

  /**
   * A Claude pane's subagents or background commands started or ended: no turn, so the status
   * stands. Nothing is alerted unless the pane began or stopped waiting on its turn's work at rest:
   * the alerts took it for working meanwhile, so a wait that ends with no turn after it is that
   * turn's finish, told then.
   */
  function claudeAgentsChanged(paneId: string, running: number, turnRunning: number, promptAt: number | null, resetHold = false): void {
    const changed = waits.running(paneId, turnRunning, promptAt) || resetHold;
    if (paneId === settling) return;
    const status = completions.current(paneId);
    // a pane never reported here carries its count in the next snapshot
    if (status === undefined) return;
    broadcastAll(paneStatus(paneId, status, { background_tasks: running }));
    if (changed) push.onStatus(paneId, alertStatus(status, waits.waiting(paneId))).catch(logPushError);
  }

  /** A wait ran out (its work ended and no turn followed, or it was held as long as one is): the status it stood for. */
  function waitsRanOut(): void {
    for (const paneId of waits.tick()) {
      const status = completions.current(paneId);
      if (status === undefined) continue;
      broadcastAll(paneStatus(paneId, status));
      push.onStatus(paneId, alertStatus(status, waits.waiting(paneId))).catch(logPushError);
    }
  }

  /** A pane's plan moved on: keep its current status and background wait, and alert nothing. */
  function planChanged(paneId: string, plan: PlanSummary | null): void {
    const status = completions.current(paneId);
    if (status !== undefined) broadcastAll(paneStatus(paneId, status, { plan }));
  }

  // a bridge (no roster of its own) tells its connection server instead (#555)
  const bridgeAgents = machines ? null : bridgeAgentNews(() => broadcastAll({ type: "session-changed" }));

  const collector = startStatusCollector({
    onStatus: (paneId, read, agent, replay) => {
      if (agent !== "opencode") {
        options.openCodeState?.forget(paneId);
        // no longer an OpenCode pane: it holds OpenCode's event stream open no more
        releaseOpenCodePane(paneId);
      }
      const raw = launchedAgents.settle(paneId, read);
      gjc.poll();
      // read back from a snapshot around a gap between subscriptions. An OmO pane's status there
      // is OmO's own or herdr's by turns (server/omo-status.ts), and a difference is no change;
      // a GJC pane's may be a provider child's while gjc's own transcript is tracked
      if (replay && (omo.runs(paneId) || gjc.tracks(paneId) || !completions.replayed(paneId, raw, replay))) return;
      // Native OmO discovery owns the pane even when herdr names its provider child.
      if (reconcileProviderStatus(omo, gjc, { pane_id: paneId, agent })) completions.forget(paneId);
      // the frame below names no agent: one herdr names anew is read into the roster now. An OmO
      // pane is `omo` in every snapshot, whatever herdr calls it in an event
      const named = [{ pane_id: paneId, agent: omo.runs(paneId) ? "omo" : gjc.runs(paneId) ? "gjc" : agent }];
      if (machines) machines.localAgents(named); else bridgeAgents!.status(named);
      // herdr says `claude/idle` for an OmO pane whatever it does, and a provider child's work for
      // a GJC one while its transcript is tracked: their own status stands, and no Claude turn waits there
      // (an OmO pane's wait on its background tasks is omoChanged's)
      if (omo.tracks(paneId)) return;
      if (gjc.tracks(paneId)) {
        waits.forget(paneId);
        return;
      }
      // back at work, the agent has had its answer, maybe from a terminal: the same prompt on
      // its screen after this is another asking, which an answer to the old card must not take.
      // Only for a status that counts: a replay that changed nothing and herdr's word on an OmO
      // pane (omoChanged has OmO's own) end no asking
      if (raw === "working") promptWaitEnded(paneId);
      // an agent herdr lost on the way still works and finishes as such (server/completion.ts);
      // an OmO pane whose session is not known keeps herdr's status, under its own name
      const status = completions.observe(paneId, raw, omo.runs(paneId) ? "omo" : gjc.runs(paneId) ? "gjc" : agent);
      pending.status(paneId, status); drainPending(paneId);
      // a Claude turn that ended holds on its background work: what it started is read now, while
      // the pane is still taken for the status before (work that ended before the turn did holds
      // nothing), and this frame says all of it, so none says the pane finished first
      const claude = agent === "claude" && !omo.runs(paneId);
      if (claude) {
        settling = paneId;
        try { claudeAgents.poll(paneId); } finally { settling = null; }
        waits.status(paneId, status);
      } else waits.forget(paneId);
      broadcastAll(paneStatus(paneId, status, claude ? { background_tasks: claudeAgents.countOf(paneId) } : {}));
      push.onStatus(paneId, alertStatus(status, waits.waiting(paneId))).catch(logPushError);
    },
    // a finish reported as done, now in front at herdr's terminal: seen, idle again
    onFocus: (paneId) => {
      // The split canvas follows herdr's focused pane (also the sole visible pane while zoomed).
      broadcastAll({ type: "session-changed" });
      // a browser set to follow herdr's focus opens the pane (#311)
      broadcastAll({ type: "pane-focused", pane_id: paneId });
      if (!completions.seen(paneId)) return;
      pending.status(paneId, "idle"); drainPending(paneId);
      broadcastAll(paneStatus(paneId, "idle"));
      push.onStatus(paneId, alertStatus("idle", waits.waiting(paneId))).catch(logPushError);
    },
    onBaseline: (panes) => {
      // A resting baseline never reholds old work after a bridge restart.
      for (const pane of panes) if (pane.agent === "claude") waits.seed(pane.pane_id, pane.agent_status);
      push.seed(panes.map((pane) => ({ ...pane, agent_status: alertStatus(pane.agent_status, waits.waiting(pane.pane_id)) })));
      for (const pane of panes) {
        // A fast mirrored client may queue before the collector's first baseline. A
        // known ready baseline can schedule a fresh guarded check even when the tracker
        // still remembers working; an unknown baseline never supplies that permission.
        const status = pane.agent_status === "idle" || pane.agent_status === "done" ? pane.agent_status : completions.current(pane.pane_id) ?? pane.agent_status;
        pending.status(pane.pane_id, status); drainPending(pane.pane_id);
      }
    },
    // a pane created a moment ago got its agent after the roster's own read of it. After the
    // snapshot's replays: a roster read before them could show a finish ahead of its status frame
    onReconciled: (panes) => { if (machines) machines.localAgents(panes); else bridgeAgents!.reconciled(panes); },
    // the tracker first: what it makes of each pane (a finish after work is done, not idle) is
    // what the alerts are measured against from here, or the next event would alert of it
    onResync: (panes, newer) => {
      finishes.resync(completions, panes, newer);
      const settled = (pane: HerdrPane): AgentStatus => completions.current(pane.pane_id) ?? pane.agent_status;
      for (const pane of panes) { pending.status(pane.pane_id, settled(pane)); drainPending(pane.pane_id); }
      for (const pane of panes) if (!newer.has(pane.pane_id) && pane.agent === "claude") waits.status(pane.pane_id, settled(pane));
      push.resync(panes.map((pane) => ({ ...pane, agent_status: alertStatus(settled(pane), waits.waiting(pane.pane_id)) })), newer);
    },
    onPaneEnded: (paneId) => {
      options.openCodeState?.forget(paneId);
      releaseOpenCodePane(paneId);
      finishes.ended(paneId);
      if (usageLogin.ended(paneId)) usage.invalidate();
      holdPendingPane(paneId, { code: "pane_not_found", message: "The pane ended; its pending messages were not sent" });
      pending.forget(paneId);
      waits.forget(paneId);
      completions.forget(paneId);
      // the terminal is gone, so is whatever its chat parsed (server/conversation.ts)
      forgetPaneTranscriptState(paneId);
      bridgeAgents?.ended(paneId);
      broadcastAll({ type: "pane-exited", pane_id: paneId });
      push.onEnded(paneId).catch(logPushError);
    },
    onStructureChange: () => broadcastAll({ type: "session-changed" }),
  }, { snapshot: rawSnapshot });
  omo.start();
  gjc.start();
  claudeAgents.start();
  const waitTimer = setInterval(waitsRanOut, 1000);
  waitTimer.unref?.();
  plans.start();

  // a verified OpenCode pane is tracked like a usage-login pane: closing it reaches onPaneEnded above
  const untrackOpenCode = trackVerifiedOpenCodePanes((paneId) => collector.trackPane(paneId));
  const tracked = { ...collector, stop() { untrackOpenCode(); stopMutes(); collector.stop(); } };

  return { push, omo, gjc, claudeAgents, plans, clientSnapshot, countVisit, machines, broadcastAll, logPushError, collector: tracked, waitTimer };
}
