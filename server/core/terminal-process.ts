/**
 * Starting a pane's terminal: the `herdr terminal attach` pty (or, where herdr cannot attach here,
 * the mirrored screen) shared by every client of the pane, its retries while herdr refuses, the
 * take-over a user asks for, and the new terminal a live handoff moves the pane to.
 */
import type { HerdrPane, ServerMessage } from "../../shared/protocol.ts";
import { AttachOutputTail, AttachStartupProbes, isTakeoverExit } from "../attach-output.ts";
import { HerdrError, herdrSocketPath, paneRead, paneSendText, sessionSnapshot } from "../herdr/client.ts";
import { MirrorSession } from "../mirror.ts";
import { ReplayBuffer } from "../output-window.ts";
import { PtySession } from "../pty/session.ts";
import { type Client, connectionOf } from "./connections.ts";

const MAX_REPLAY_BYTES = 128 * 1024;

/**
 * herdr's refusal of an attach while a read of the same terminal is in progress; it asks
 * for a retry. A read of more lines than an idle alt-screen agent (Codex) shows, like the
 * transcript match's 400, makes herdr scroll the agent's history back with wheel events:
 * up to 15 s, and 5 more to restore it (herdr 0.9, src/server/alt_screen_read.rs). A
 * 400-line read of an idle Codex pane took about a second, refusing every attach meanwhile.
 */
const ATTACH_READ_RACE_RE = /has a read in progress; retry/;
/**
 * herdr's refusal when another client holds the terminal's one attach slot. It is the attach's
 * last line, after its teardown: the same words earlier in the pane's own output are not it.
 */
const ATTACH_HELD_RE = /terminal attach failed: [^\r\n]*(?:already has an attached client|retry with --takeover)[^\r\n]*\s*$/;
/** how long refused attaches are retried: herdr's longest read of that kind */
export const ATTACH_RETRY_FOR_MS = 20_000;
const ATTACH_RETRY_MS = 50;
const ATTACH_RETRY_MAX_MS = 500;
/** a refused attach says so within milliseconds of its first bytes: those are held this long */
export const ATTACH_HOLD_MS = 100;
/**
 * What `herdr terminal attach` writes itself before herdr has answered, and as the teardown of a
 * refused one: terminal modes set and reset (mouse reporting off, the alternate screen on, then
 * off) and the cursor style restored (`ESC [ 0 SP q`), the last one maybe cut short. The answer
 * can come any time after them, later than the hold on a busy PC, and herdr writes its refusal
 * apart from the teardown before it, so they say nothing about whether the attach took and do
 * not start the hold. A refusal and a screen both begin with something else.
 */
const ATTACH_PREAMBLE_RE = /^(?:\x1b\[(?:\?[\d;]+[hl]|\d* q))*(?:\x1b(?:\[(?:\?[\d;]*|\d+ ?| )?)?)?$/;
/** how often a terminal another web bridge holds is tried again, while clients here still want it */
export const ATTACH_HELD_RETRY_MS = 3_000;
/**
 * herdr refusing an attach, its line (maybe not all of it yet) the last output, before the
 * exit has come. The same words earlier in the pane's own output, with more after them, are not it.
 */
const ATTACH_REFUSING_RE = /terminal attach failed[^\r\n]*\s*$/;
/** how long a refusal's exit is waited for before its output is taken for the pane's own */
const ATTACH_REFUSAL_EXIT_MS = 2_000;
export const ATTACH_HELD_MESSAGE = "Another web bridge has this pane open. It connects here as soon as that bridge lets go.";
/**
 * How long a pane whose attach herdr ended is looked up again before its terminal is taken for
 * ended. A live handoff (`herdr update --handoff`, `herdr server live-handoff`) moves every pane
 * to a new server under a new terminal id and cuts each attach with "server shut down", the
 * words a pane that exited gets too. Measured on herdr 0.9.3: the socket answers
 * server_unavailable for ~200 ms, then the pane is back under its new terminal; an exited
 * pane is gone from the snapshot within ~30 ms.
 */
export const ATTACH_RELOOKUP_FOR_MS = 5_000;
const ATTACH_RELOOKUP_MS = 100;
const ATTACH_RELOOKUP_MAX_MS = 500;
/** what a pane lookup answers for a pane that has no terminal to attach any more */
const PANE_GONE_CODES = new Set(["pane_not_found", "pane_not_restored", "no_terminal"]);

/** What a pane's attachment keeps whichever process it has. */
interface AttachmentState {
  ready: boolean;
  clients: Set<Client>;
  /** the pty's current grid: interact clients set it, observe clients adopt it */
  cols: number;
  rows: number;
  /** each interact client's own grid while it shows the terminal, the latest last (`release-size` hands the pty to it) */
  grids: Map<Client, { cols: number; rows: number }>;
  /** the client whose grid the pty took last: only its release may hand the pty on */
  driver?: Client;
  /** bounded tail so a client joining late still sees the current screen */
  replay: ReplayBuffer;
  /** when each client without ACKs (no OutputWindow) became blocked on its transport queue */
  stalled: Map<Client, number>;
  /** another web bridge holds herdr's one attach slot for this terminal: waiting for it to let go */
  held?: boolean;
  /** the stream ended after it was ready: until an attach takes again, the replay is the screen from before */
  recovering?: boolean;
  /** the next held or read-race retry; takeover and close both cancel it */
  retry?: ReturnType<typeof setTimeout>;
  /** the next look for the terminal a pane lives on after herdr ended its attach; a closed attachment cancels it */
  relookup?: ReturnType<typeof setTimeout>;
  /** clears one recovery budget only after its replacement attach stays alive to the budget's end */
  recovery?: ReturnType<typeof setTimeout>;
  /** a repaint asked of herdr for clients that joined with only the replay tail; a closed attachment cancels it */
  repaint?: ReturnType<typeof setTimeout>;
  /** when herdr was last asked to repaint (or redrew for a resize), for REPAINT_MIN_INTERVAL_MS */
  repaintedAt?: number;
}

/**
 * One live PTY per pane, shared by every client watching that pane.
 *
 * The terminal is a real `herdr terminal attach` on a PTY rather than repeated
 * `pane.read` snapshots, so the browser receives an actual byte stream: xterm.js
 * keeps screen state and selection, while herdr owns scrollback.
 */
export interface PtyAttachment extends AttachmentState {
  readonly kind: "pty";
  /** the attach the latest start made: each retry, take-over or handoff's new terminal replaces it */
  process: PtySession;
  /** a held terminal's next try takes the slot from the other bridge for this client (`take-over`) */
  takeOver?: (client: Client) => void;
}

/**
 * Where herdr cannot attach here, `process` repaints the pane's screen (server/mirror.ts) on the
 * pane's own grid: no browser resizes it, and there is no attach slot to take over.
 */
export interface MirrorAttachment extends AttachmentState {
  readonly kind: "mirror";
  process: MirrorSession;
  /** clients that attached before any screen went out: the first screen they get is their replay */
  unscreened: Set<Client>;
}

export type PaneAttachment = PtyAttachment | MirrorAttachment;

/**
 * The attach the server's clients share for each pane. `attachments` stays the server's: a callback
 * of an attachment that is no longer the pane's record does nothing.
 */
export function createSpawnAttachment({ attachments, retiringAttachments, terminalAttach, isStopped, closeAttachment, broadcast, sendOutput, reconcileOutput, holdPendingPane, inputReady, holdFor, heldRetry, retryFor, relookupFor }: {
  attachments: Map<string, PaneAttachment>;
  retiringAttachments: Map<string, Promise<void>>;
  terminalAttach: () => Promise<boolean>;
  /** the server's `stopped`: a creation still looking its terminal up when the server stops ends there */
  isStopped: () => boolean;
  closeAttachment: (paneId: string) => void;
  broadcast: (paneId: string, message: ServerMessage) => void;
  sendOutput: (client: Client, paneId: string, data: string, replay?: boolean) => void;
  reconcileOutput: (paneId: string) => void;
  holdPendingPane: (paneId: string, fault: { code: string; message: string }) => void;
  /** the attach took and input flows: a pending message waiting for a typist may go now */
  inputReady: (paneId: string) => void;
  holdFor: number;
  heldRetry: number;
  retryFor: number;
  relookupFor: number;
}) {
  async function terminalInfoFor(paneId: string, timeoutMs?: number): Promise<{ terminalId: string; rect: { width: number; height: number } | null }> {
    const snapshot = await sessionSnapshot(undefined, timeoutMs);
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    // herdr (0.9.3+) could not restore it after a restart: its terminal has no process
    // and an attach would only die with "not found". The client shows the reason instead.
    if (pane.restore_error) throw new HerdrError("pane_not_restored", pane.restore_error);
    const terminalId = (pane as HerdrPane & { terminal_id?: string }).terminal_id;
    if (!terminalId) throw new HerdrError("no_terminal", `pane ${paneId} has no terminal`);
    // the pane's grid as the operator's layout holds it: an observe connection must
    // create the pty at THIS size, never at the observer's own viewport
    const rect = snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === paneId)?.rect ?? null;
    return { terminalId, rect: rect ? { width: rect.width, height: rect.height } : null };
  }

  async function spawnAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    await retiringAttachments.get(paneId);
    const mirrored = !(await terminalAttach());
    const { terminalId, rect } = await terminalInfoFor(paneId);
    if (isStopped()) throw new HerdrError("server_stopped", "the web bridge stopped during attachment creation");
    // an observer-first attachment spawns at the pane's own grid (fallback 80x24 when
    // the layout has no rect for it): the attach must not seed the shared pty with a
    // watching phone's viewport
    const spawnCols = forObserver || mirrored ? (rect?.width ?? 80) : cols;
    const spawnRows = forObserver || mirrored ? (rect?.height ?? 24) : rows;
    const state = {
      clients: new Set<Client>(),
      cols: spawnCols,
      rows: spawnRows,
      replay: new ReplayBuffer(MAX_REPLAY_BYTES),
      stalled: new Map(),
      grids: new Map(),
    };

    if (mirrored) {
      const attachment: MirrorAttachment = { kind: "mirror", ready: true, process: undefined as unknown as MirrorSession, unscreened: new Set(), ...state };
      attachments.set(paneId, attachment);
      const mirror = new MirrorSession({
        cols: spawnCols,
        rows: spawnRows,
        size: async () => {
          const now = (await terminalInfoFor(paneId)).rect;
          return now ? { cols: now.width, rows: now.height } : null;
        },
        // the grid follows herdr's layout: the clients adopt the new size before the screen
        onResize: (cols, rows) => {
          if (attachments.get(paneId) !== attachment) return;
          attachment.cols = cols;
          attachment.rows = rows;
          broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows, fixed: true });
        },
        read: async () => (await paneRead({ paneId, source: "visible", format: "ansi" })).text,
        write: (data) => paneSendText(paneId, data),
        onData: (frame) => {
          if (attachments.get(paneId) !== attachment) return;
          for (const client of attachment.clients) sendOutput(client, paneId, frame, attachment.unscreened.delete(client));
          reconcileOutput(paneId);
        },
        onExit: (code) => {
          if (attachments.get(paneId) !== attachment) return;
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        },
      });
      attachment.process = mirror;
      return attachment;
    }

    const attachment: PtyAttachment = { kind: "pty", ready: false, process: undefined as unknown as PtySession, ...state };
    attachments.set(paneId, attachment);

    // No --takeover unless asked: another web bridge may own the exclusive attach slot.
    // Report that conflict without displacing it or the user's own TUI; a client here may
    // still take it on purpose (`take-over`), and the other bridge then waits in turn.
    // herdr also refuses an attach while a read of the same terminal is in progress ("has a
    // read in progress; retry"), and this server reads panes all the time (prompt polls,
    // transcript matches): an attach that races one, typically a phone reconnecting just as
    // Codex finished an answer, is started again for the same clients, for as long as such
    // a read can last, instead of ending their terminal.
    const forward = (data: string): void => {
      if (attachments.get(paneId) !== attachment) return;
      attachment.replay.append(data);
      for (const client of attachment.clients) sendOutput(client, paneId, data);
      reconcileOutput(paneId);
    };
    let retries = 0;
    let refusedSince: number | null = null;
    /** who asked the next start to take the slot; asked for while a try was still running, the one after it */
    let takeover: Client | null = null;
    let takeoverWanted: Client | null = null;
    /** A click counts only while its client is still here and may type: no later start acts for one that left or observes. */
    const mayTakeOver = (client: Client | null): client is Client =>
      client !== null && attachment.clients.has(client) && connectionOf(client).mode === "interact" && !connectionOf(client).closing;
    /** an attempt, live attach or terminal lookup is running: another start must wait */
    let trying = false;
    /** Starts at most one attempt, cancelling any scheduled retry before it can overlap. */
    const again = (): void => {
      if (attachments.get(paneId) !== attachment || trying) return;
      clearTimeout(attachment.retry);
      attachment.retry = undefined;
      if (attachment.clients.size === 0) {
        closeAttachment(paneId);
        return;
      }
      try {
        attachment.process = start();
      } catch (error) {
        const message = spawnFailure(paneId, error);
        broadcast(paneId, { type: "error", code: error instanceof HerdrError ? error.code : "command_failed", message, pane_id: paneId });
        broadcast(paneId, { type: "pty-exit", pane_id: paneId, code: null });
        closeAttachment(paneId);
      }
    };
    /** the terminal attached to: a pane keeps its id across a server handoff, its terminal does not */
    let attachedTerminal = terminalId;
    /** One budget persists across consecutive exits during recovery. Starting an attach never renews it. */
    let recoveryDeadline: number | null = null;
    let recoveryRetries = 0;
    const start = (): PtySession => {
      let takingOver = mayTakeOver(takeover) ? takeover : null;
      takeover = null;
      trying = true;
      let output = ""; // this attach's own last words: herdr's refusal is in them
      // its first bytes wait ATTACH_HOLD_MS: a refusal (herdr's setup, teardown and message)
      // is dropped then, never painted into the clients' terminal
      let held: string | null = "";
      let heldSince = 0;
      let holding = false;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      const probes = new AttachStartupProbes();
      const outputTail = new AttachOutputTail();
      let tailTimer: ReturnType<typeof setTimeout> | undefined;
      const flushTail = (taken = false): void => {
        clearTimeout(tailTimer);
        const data = outputTail.flush(taken);
        if (data) forward(data);
      };
      const publish = (data: string): void => {
        clearTimeout(tailTimer);
        const visible = outputTail.push(data);
        if (visible) forward(visible);
        // A pane may print the same bytes without exiting: never keep its text indefinitely.
        if (outputTail.pending) tailTimer = setTimeout(flushTail, holdFor);
      };
      /** ended before its exit came: what it still prints is no attach's */
      let retired = false;
      /** a synthetic retirement calls ended before killing; the process's later onExit is the same end */
      let endedOnce = false;
      const release = (): void => {
        clearTimeout(holdTimer);
        if (held === null) return;
        // a read that ended inside what could have been a probe is output after all
        const data = held + probes.flush();
        held = null;
        if (data) publish(data);
      };
      const took = (): void => {
        // a closed attachment's kill skips onExit, which would clear this timer: a newer
        // attachment on the pane must not hear this one's resume
        if (attachments.get(paneId) !== attachment) return;
        // a refusal whose exit comes late (a busy PC) is not an attach: resuming would free
        // the input to a pane another bridge may hold. Only output after it is an attach's.
        if (ATTACH_REFUSING_RE.test(output)) {
          if (Date.now() - heldSince < ATTACH_REFUSAL_EXIT_MS) {
            holdTimer = setTimeout(took, holdFor);
            return;
          }
          // its exit is overdue: this try ends here, as that exit would have ended it (a pane
          // whose own output ends the same way waits for more output on a later try)
          retired = true;
          session.kill();
          ended(null);
          return;
        }
        // A click is consumed by success, including an ordinary retry that won the slot.
        takeoverWanted = null;
        takeover = null;
        takingOver = null;
        // the attach took: a pane that waited for another bridge is this bridge's again
        if (attachment.held) {
          attachment.held = false;
          broadcast(paneId, { type: "attach-resumed", pane_id: paneId });
        }
        attachment.ready = true;
        attachment.recovering = false;
        broadcast(paneId, { type: "input-ready", pane_id: paneId });
        inputReady(paneId);
        release();
        // A replacement that only flashes ready before exiting must not create an endless series
        // of fresh recovery windows. Even one started near the deadline proves stable only by
        // remaining attached for a whole recovery window.
        if (recoveryDeadline !== null) {
          clearTimeout(attachment.recovery);
          const recovered = session;
          attachment.recovery = setTimeout(() => {
            attachment.recovery = undefined;
            if (attachments.get(paneId) !== attachment || attachment.process !== recovered || !attachment.ready) return;
            recoveryDeadline = null;
            recoveryRetries = 0;
          }, relookupFor);
        }
      };
      const ended = (code: number | null): void => {
        if (endedOnce) return;
        endedOnce = true;
        trying = false;
        clearTimeout(holdTimer);
        clearTimeout(tailTimer);
        clearTimeout(attachment.recovery);
        attachment.recovery = undefined;
        if (attachments.get(paneId) !== attachment) return;
        if (attachment.ready) {
          attachment.recovering = true;
          broadcast(paneId, { type: "input-ready", pane_id: paneId, ready: false });
          holdPendingPane(paneId, { code: "input_not_ready", message: "The pane's attachment is restarting; review pending messages before sending them" });
        }
        attachment.ready = false;
        const finish = (): void => {
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        };
        const now = Date.now();
        // displaced after attaching (herdr's last words): the read-race words may still be on its screen
        const displaced = code !== 0 && isTakeoverExit(output);
        const readRace = !displaced && code !== 0 && ATTACH_READ_RACE_RE.test(output);
        if (readRace) {
          if (recoveryDeadline !== null && now >= recoveryDeadline) {
            held = null;
            return finish();
          }
          const refusedDeadline = (refusedSince ??= now) + retryFor;
          const retryDeadline = recoveryDeadline ?? refusedDeadline;
          if (now < Math.min(refusedDeadline, retryDeadline)) {
            held = null;
            retries += 1;
            // An explicit request survives a read race only until an attach succeeds.
            takeover = mayTakeOver(takingOver) ? takingOver : takeoverWanted;
            takeoverWanted = null;
            const delay = Math.min(ATTACH_RETRY_MS * 2 ** (retries - 1), ATTACH_RETRY_MAX_MS, retryDeadline - now);
            attachment.retry = setTimeout(() => {
              attachment.retry = undefined;
              // The timer can run after its deadline. Do not start one more attach then wait for
              // that process to exit before applying the recovery limit.
              if (recoveryDeadline !== null && Date.now() >= recoveryDeadline) return finish();
              again();
            }, delay);
            return;
          }
        }
        if (displaced || (code !== 0 && ATTACH_HELD_RE.test(output))) {
          flushTail(displaced);
          held = null; // herdr's refusal is not the pane's output: never painted, and it repeats
          // waiting for the other bridge is not a read race: the next one gets its full budget
          refusedSince = null;
          retries = 0;
          // Another web bridge holds herdr's one attach slot (two bridges on one herdr, e.g. a
          // second install beside the first). Its attach is left alone; this pane waits for it
          // to let go, trying again while anyone here still has it open, instead of ending.
          if (!attachment.held) broadcast(paneId, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: paneId });
          attachment.held = true;
          // Displaced after attaching: a click this attach waited on is spent, only a new one takes it back.
          if (!displaced && mayTakeOver(takeoverWanted)) {
            takeover = takeoverWanted;
            takeoverWanted = null;
            again();
          } else {
            takeoverWanted = null;
            attachment.retry = setTimeout(again, heldRetry);
          }
          return;
        }
        takeoverWanted = null;
        takeover = null;
        takingOver = null;
        trying = true; // a live-handoff lookup owns the next start until it finishes
        release();
        flushTail();
        // herdr ended the attach, maybe not the pane: after a live handoff the pane lives on under
        // a new terminal, and a transient attach EOF may leave the same terminal live. One deadline
        // and exponential backoff span every replacement that also exits, so a broken attach command
        // cannot reset itself into an unbounded spawn loop.
        const firstRecovery = recoveryDeadline === null;
        const deadline = recoveryDeadline ??= Date.now() + relookupFor;
        const retryLookup = (): void => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return finish();
          const delay = Math.min(ATTACH_RELOOKUP_MS * 2 ** Math.min(recoveryRetries++, 8), ATTACH_RELOOKUP_MAX_MS, remaining);
          attachment.relookup = setTimeout(relookup, delay);
        };
        const relookup = (): void => {
          if (attachment.clients.size === 0) {
            closeAttachment(paneId);
            return;
          }
          if (Date.now() >= deadline) return finish();
          // a herdr that takes the request and never answers must not hold the terminal past the
          // deadline: the lookup gets what is left of it, not the RPC's own 10 s
          terminalInfoFor(paneId, Math.max(1, deadline - Date.now())).then(({ terminalId: now }) => {
            if (attachments.get(paneId) !== attachment) return;
            if (Date.now() >= deadline) return finish();
            if (attachment.clients.size === 0) {
              closeAttachment(paneId);
              return;
            }
            if (now !== attachedTerminal) {
              attachedTerminal = now;
              // a new terminal gets the whole read-race budget
              refusedSince = null;
              retries = 0;
            }
            // The exact same terminal id is positive liveness too: the attach process, not the pane,
            // ended. Restart its stream rather than waiting out the window and claiming the pane died.
            try {
              attachment.process = start();
            } catch (error) {
              const message = spawnFailure(paneId, error);
              broadcast(paneId, { type: "error", code: error instanceof HerdrError ? error.code : "command_failed", message, pane_id: paneId });
              finish();
            }
          }, (error: unknown) => {
            if (attachments.get(paneId) !== attachment) return;
            if (error instanceof HerdrError && PANE_GONE_CODES.has(error.code)) return finish();
            // herdr is between servers (server_unavailable, connect_failed) or not answering (timeout): ask again
            retryLookup();
          });
        };
        if (firstRecovery) relookup();
        else retryLookup();
      };
      const command = process.env["OVIS_HERDR_BIN"] || "herdr";
      // node-pty reports a command it cannot exec only as a silent exit 1, which reads as an
      // ended attach (#925): look it up on the PATH and from the home directory the sidecar uses.
      if (!Bun.which(command, { PATH: process.env["PATH"] ?? "", cwd: process.env["HOME"] ?? "/" })) {
        throw new HerdrError("attach_failed", `herdr could not be started: ${command} is not an executable on the server's PATH (set OVIS_HERDR_BIN to herdr's full path)`);
      }
      const session = new PtySession({
        command,
        // --takeover goes after the id: before it, herdr reads the id as an unknown option
        args: ["terminal", "attach", attachedTerminal, ...(takingOver ? ["--takeover"] : [])],
        // herdr's CLI reads HERDR_SOCKET_PATH, not HERDR_SOCKET: the stream must reach
        // the same session the RPCs talk to, or a named session's terminals are
        // looked up on the default socket and the attach dies.
        env: { HERDR_SOCKET_PATH: herdrSocketPath() },
        cols: attachment.cols,
        rows: attachment.rows,
        onData: (data) => {
          if (retired || attachments.get(paneId) !== attachment) return;
          // herdr's startup queries are the bridge's to answer: never readiness, broadcast or replay
          if (!holding && held !== null) {
            const before = held;
            const taken = probes.take(data, (text) => ATTACH_PREAMBLE_RE.test(before + text));
            if (taken.replies) session.write(taken.replies);
            data = taken.output;
          } else data = probes.flush() + data;
          if (!data) return;
          output = (output + data).slice(-1024);
          if (held === null) return publish(data);
          held += data;
          if (!holding && !ATTACH_PREAMBLE_RE.test(held)) {
            holding = true;
            heldSince = Date.now();
            holdTimer = setTimeout(took, holdFor);
          }
        },
        onExit: ended,
      });
      return session;
    };
    attachment.takeOver = (client) => {
      if (attachments.get(paneId) !== attachment || !attachment.held) return;
      if (trying) {
        takeoverWanted = client;
        return;
      }
      clearTimeout(attachment.retry);
      takeover = client;
      again();
    };
    try {
      attachment.process = start();
    } catch (error) {
      // Bun.spawn throws synchronously (node missing from PATH, fd or process limits): the
      // placeholder must go with it, or the next attach joins a record with no pty and
      // its close dereferences one (#154). The waiting attaches get the error in-band.
      attachments.delete(paneId);
      spawnFailure(paneId, error);
      throw error;
    }

    return attachment;
  }

  /** The attaching client sees the error in-band; the log is the only record the operator gets. */
  function spawnFailure(paneId: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`terminal attach for pane ${paneId} failed to start: ${message}`);
    return message;
  }

  return { spawnAttachment };
}
