/**
 * Starting the agent a create request names in the pane herdr just made: the request's own check
 * of `agent`, then the start, which retries a pane whose shell is not up yet and a name another
 * agent took. Workspace, tab and worktree creation share it.
 */
import { freeAgentName } from "./agent-name.ts";
import { launchedAgents } from "./launched-agents.ts";
import { isShellAgentKind, startShellAgent, type ShellAgentLocator } from "./shell-agent.ts";
import { agentStart, HerdrError, sessionSnapshot } from "./herdr/client.ts";
import { agentStartArgs } from "./claude-settings-file.ts";
import { launchArgsFault } from "../shared/launch-rules.ts";

export type AgentPayload = { kind?: unknown; name?: unknown; args?: unknown };

/** What is wrong with a request's `agent`, in the API's words; null when it can be started. */
export function agentFault(agent: AgentPayload | undefined): string | null {
  if (agent === undefined) return null;
  if (typeof agent !== "object" || typeof agent.kind !== "string" || agent.kind.length === 0) return "agent.kind is required";
  if ((agent.name !== undefined && typeof agent.name !== "string")
    || (agent.args !== undefined && (!Array.isArray(agent.args) || !agent.args.every((arg) => typeof arg === "string")))) {
    return "agent.name must be a string and agent.args must be an array of strings";
  }
  // the dialog's model, effort and Codex prompt, checked as the dialog checks them: a client is not trusted to
  return agent.args === undefined ? null : launchArgsFault(agent.kind, agent.args as string[]);
}

/**
 * Starts a checked `agent` in a pane herdr just made. A failure is answered, not thrown: the
 * workspace, tab or worktree around the pane is there either way. `launched` is told the pid of
 * the process a shell-started agent came up as, when one is seen in front of the pane; `locator`
 * is the one `/api/agents` offered it from. `options` stands in for this PC's platform and the
 * folder Claude Code's settings files go to, for a test.
 */
export async function agentLaunch(paneId: string, agent: AgentPayload, launched?: (pid: number) => void, locator?: ShellAgentLocator, options: { platform?: string; settingsDir?: string } = {}): Promise<{ agent_started: true } | { agent_started: false; error: { code: string; message: string } }> {
  try {
    const kind = agent.kind as string;
    const args = agent.args as string[] | undefined;
    if (isShellAgentKind(kind)) {
      const pid = await startShellAgent(kind, paneId, args, locator ? { locator } : {});
      if (pid !== null) launched?.(pid);
    }
    else {
      const given = typeof agent.name === "string" && agent.name.length > 0 ? agent.name : null;
      // on Windows a Claude Code's inline JSON --settings goes as a file's path (server/claude-settings-file.ts)
      const startArgs = args === undefined ? undefined : agentStartArgs(kind, args, { platform: options.platform, dir: options.settingsDir });
      // herdr refuses a name another agent holds. Two creations at once can pick the same
      // free one: the refused one picks again. It also refuses a pane whose shell is not up
      // yet (`agent_pane_busy`, herdr 0.9.3), which a pane made a moment ago can be.
      const shellDeadline = Date.now() + 10_000;
      for (let attempt = 1; ; ) {
        try {
          await agentStart({
            name: given ?? freeAgentName(kind, (await sessionSnapshot()).agents.map((running) => running.name)),
            kind,
            paneId,
            ...(startArgs === undefined ? {} : { args: startArgs }),
            timeoutMs: 60_000,
          });
          break;
        } catch (error) {
          if (!(error instanceof HerdrError)) throw error;
          if (error.code === "agent_pane_busy" && Date.now() < shellDeadline) {
            await Bun.sleep(100);
            continue;
          }
          if (given !== null || attempt === 3 || error.code !== "agent_name_taken") throw error;
          attempt += 1;
        }
      }
    }
    launchedAgents.launched(paneId, kind);
    return { agent_started: true };
  } catch (error) {
    return {
      agent_started: false,
      error: {
        code: error instanceof HerdrError ? error.code : "agent_start_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
