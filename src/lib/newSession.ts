/**
 * What the new workspace and tab dialogs start (#774, #1311): the agent of the create request for
 * the dialog's fields, with its launch arguments (lib/agentLaunchMode.ts), and where the first
 * message goes. Codex takes it as its own positional argument behind the end-of-options separator;
 * any other agent gets it as the request's `first_message`, which the bridge queues for the agent's
 * first ready turn through its pending path (server/core/pending.ts). Either way the request is the
 * one send: nothing is typed by this page afterwards.
 */
import type { CreateTabRequest, CreateWorkspaceRequest, WorkspaceCreated } from "../../shared/protocol.ts";
import type { ClaudeLaunchMode, CodexLaunchMode } from "./agentLaunchMode.ts";
import { firstPromptDelivery, launchAgent, launchCapabilities, launchChoiceFault } from "./agentLaunchMode.ts";

export interface NewSessionFields {
  /** the agent kind; "" is a plain shell */
  agent: string;
  model: string;
  effort: string;
  /** Claude Code's Ultracode switch; absent or false adds nothing */
  ultracode?: boolean;
  prompt: string;
}

export type FirstPrompt = { text: string; via: "positional" | "pending" };

export type NewSessionLaunch =
  | { agent: { kind: string; args?: string[] } | null; prompt: FirstPrompt | null }
  | { fault: "model" | "effort" | "ultracode" | "prompt" };

/** The create request's agent for the fields, or the first choice the launch does not take. */
export function newSessionLaunch(fields: NewSessionFields, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }): NewSessionLaunch {
  const fault = launchChoiceFault(fields.agent, fields);
  if (fault !== null) return { fault };
  const via = firstPromptDelivery(fields.agent, fields.prompt);
  const text = fields.prompt.trim();
  return {
    agent: launchAgent(fields.agent, modes, { model: fields.model, effort: fields.effort, ultracode: fields.ultracode, prompt: via === "positional" ? text : "" }),
    prompt: via === null ? null : { text, via },
  };
}

/**
 * The dialog's launch for its fields: a switch the agent's launch does not take is not shown, so it neither
 * blocks Start nor goes with the launch. The agent list can move the kind past the picker's resets, as when a
 * remembered Claude Code the PC no longer offers gives way to a shell with Ultracode left on.
 */
export function dialogLaunch(fields: NewSessionFields, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }): NewSessionLaunch {
  return newSessionLaunch({ ...fields, ultracode: fields.ultracode && launchCapabilities(fields.agent).ultracode }, modes);
}

/** The request's `first_message`: the prompt the bridge queues, or null when there is none or the agent takes it itself. */
export function firstMessageOf(launch: NewSessionLaunch): string | null {
  return "fault" in launch || launch.prompt?.via !== "pending" ? null : launch.prompt.text;
}

/** Where the dialog's Start makes the session: a tab in a workspace (its folder), or a workspace in `directory`. */
export interface NewSessionTarget {
  tab: { workspaceId: string; cwd: string | null } | null;
  directory: string;
  name: string;
}

/**
 * The create request for a launch. `first_message` only when there is one, with `connection`, this page's
 * connection to the PC (MachineSession.connection), as the one that may type it on its own.
 */
export function createRequest(target: NewSessionTarget, launch: Exclude<NewSessionLaunch, { fault: unknown }>, connection: string | null): CreateWorkspaceRequest | CreateTabRequest {
  const text = firstMessageOf(launch);
  const message = text === null ? {} : { first_message: text, ...(connection === null ? {} : { first_message_connection: connection }) };
  const label = target.name.trim() || null;
  return target.tab
    ? { workspace_id: target.tab.workspaceId, cwd: target.tab.cwd, label, agent: launch.agent, ...message }
    : { cwd: target.directory.trim() || null, label, agent: launch.agent, ...message };
}

/** The dialog's Start: one create in flight at a time (null when one already is), however often it is pressed. */
export function startNewSession<T>(guard: { run: <R>(task: () => Promise<R>) => Promise<R> | null }, request: CreateWorkspaceRequest | CreateTabRequest,
  create: (request: CreateWorkspaceRequest | CreateTabRequest) => Promise<T>): Promise<T> | null {
  return guard.run(() => create(request));
}

/**
 * What became of the request's first message: none was sent or the agent did not start (`none`), the bridge
 * queued it (`queued`), or the agent runs without it (`not_queued`), with the bridge's refusal, or none
 * from a bridge that predates `first_message` and answered without it.
 */
export type FirstMessageOutcome = { kind: "none" } | { kind: "queued" } | { kind: "not_queued"; error: { code: string; message: string } | null };

export function firstMessageOutcome(request: CreateWorkspaceRequest, result: WorkspaceCreated): FirstMessageOutcome {
  if (typeof request.first_message !== "string" || !result.agent_started) return { kind: "none" };
  const answer = result.first_message;
  if (answer && "id" in answer) return { kind: "queued" };
  return { kind: "not_queued", error: answer && "error" in answer ? answer.error : null };
}
