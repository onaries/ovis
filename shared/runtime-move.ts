import type { SessionHistoryAgent } from "./session-history.ts";

/**
 * The move of this PC's whole herdr session to herdr-core (docs/runtime-move.md): all of it or
 * nothing. herdr itself is never closed or changed by a move; agents Ovis ends there are reopened on
 * their own conversation in their own pane if the move cannot finish.
 */

/** A tab's panes as herdr splits them: a pane, or a split whose `first` side is left (`right`) or on top (`down`). */
export type MoveNode = { pane: string } | { split: "right" | "down"; ratio: number; first: MoveNode; second: MoveNode };

/**
 * What becomes of one pane:
 * - `resume`: an idle agent whose conversation this PC's stores list; it is ended in herdr and reopens on it.
 *   `ended`: the person ended it already (the pane is a shell again and still names the conversation).
 * - `fresh`: an idle agent whose conversation cannot be told; it is ended in herdr and starts new in the same folder.
 * - `shell`: a shell with nothing running in front; a new shell starts in the same folder.
 * - `busy`: an agent at work or waiting for an answer, or a shell running a command: nothing moves until it is done.
 * - `needs_you`: an agent Ovis cannot end by itself (its input line cannot be read, so the exit could send
 *   text typed there); the person ends it, then the move can go and reopens its conversation.
 */
export type MoveVerdict =
  | { kind: "resume"; agent: SessionHistoryAgent; session_id: string; argv: string[]; ended: boolean }
  | { kind: "fresh"; agent: string }
  | { kind: "shell" }
  | { kind: "busy"; reason: "agent_working" | "agent_waiting" | "command_running"; agent: string | null; command: string | null }
  | { kind: "needs_you"; agent: string };

export interface MovePane {
  pane_id: string;
  cwd: string | null;
  /** the name the person gave the pane, else null */
  name: string | null;
  verdict: MoveVerdict;
}

export interface MoveTab {
  tab_id: string;
  name: string;
  root: MoveNode;
}

export interface MoveWorkspace {
  workspace_id: string;
  name: string;
  tabs: MoveTab[];
}

export interface MovePlan {
  workspaces: MoveWorkspace[];
  panes: MovePane[];
  /** no pane is `busy` or `needs_you`: the move can go now */
  ready: boolean;
  /** changes whenever anything the plan shows changes: a start names the plan it was shown */
  revision: string;
}

/**
 * Why no move is offered: the server does not serve herdr, the PC has no herdr-core or the runtime
 * cannot be switched from here, or the Herdr app is installed and may arrange the core itself.
 */
export type MoveUnavailable = "not_herdr" | "no_herdr_core" | "runtime_locked" | "herdr_app";

/**
 * Where the move is: `idle` (none asked for), `waiting` (asked for; it goes by itself once no pane is
 * busy), `moving` (ending agents, then building everything on herdr-core), `done` (the runtime is
 * switching to herdr-core), `rolled_back` (it could not finish: everything Ovis did is undone, `reason`
 * says why; `left` names the agents it could not reopen in herdr and why), `interrupted` (a server
 * stopped mid-move: see `left`).
 */
export type MoveStatus =
  | { state: "idle" }
  | { state: "waiting"; revision: string; stopping?: MoveStopping[] }
  | { state: "moving"; step: "ending_agents" | "building" | "starting_agents" | "switching"; done: number; total: number }
  | { state: "done" }
  | { state: "rolled_back" | "interrupted"; reason: string; left: { pane_id: string; agent: string; why: string }[] };

/**
 * `install`: no herdr-core is on this PC, and Ovis can install that version itself
 * (POST /api/runtime/move/install); once it is in, the move is offered.
 */
export type MovePlanResponse = ({ available: true; plan: MovePlan } | { available: false; reason: MoveUnavailable; install?: { version: string } }) & { status: MoveStatus };

/**
 * A shell pane the waiting move sent Ctrl+C to (POST /api/runtime/move/stop) whose command still runs;
 * `force`: a few seconds have passed since, so SIGTERM to that pane's foreground process group may follow.
 */
export interface MoveStopping {
  pane_id: string;
  force: boolean;
}

/**
 * POST /api/runtime/move/stop, only while the move waits and only for a shell pane running a command:
 * Ctrl+C into that pane's input lane, or with `force`, once offered, SIGTERM to its foreground process group.
 * `command`: the one the person was shown (the verdict's); another one running there now is not ended.
 */
export interface MoveStopRequest {
  pane_id: string;
  force?: boolean;
  command?: string;
}

/**
 * POST /api/runtime/move/stop-all with no token: the running commands End all and move now would end,
 * under a token for exactly that list. With the token: Ctrl+C to each, refused (`changed`) when the
 * list is no longer the one shown, so the person is asked again.
 */
export interface MoveStopAllOffer {
  token: string;
  panes: { pane_id: string; command: string }[];
}

export interface MoveStopAllRequest {
  token?: string;
}

/** POST /api/runtime/move: the plan's revision as shown. Busy panes make it wait; DELETE cancels a wait. */
export interface MoveStartRequest {
  revision: string;
}
