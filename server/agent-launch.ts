/**
 * Starting the agent a create request names in the pane herdr just made: the request's own check
 * of `agent`, then the start, which retries a pane whose shell is not up yet and a name another
 * agent took. Workspace, tab and worktree creation share it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { freeAgentName } from "./agent-name.ts";
import { launchedAgents } from "./launched-agents.ts";
import { isShellAgentKind, startShellAgent, type ShellAgentLocator } from "./shell-agent.ts";
import { agentStart, HerdrError, sessionSnapshot } from "./herdr/client.ts";
import { requestFault } from "./http.ts";
import { agentStartArgs } from "./claude-settings-file.ts";
import { DSH_EFFORTS, launchArgsFault } from "../shared/launch-rules.ts";
import { hcMachine } from "./herdr-core/runtime.ts";
import { userHome } from "./user-home.ts";

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
 * A dsh-tui launch's arguments without `--effort <level>`, which dsh-tui 0.20.0 has no flag for, and the level they
 * named. Read as launchArgsFault reads them: only before `--` (what follows is passed on as it is), and a level
 * outside DSH_EFFORTS is no level, so nothing the check would refuse is ever saved.
 */
export function dshEffortArgs(args: readonly string[]): { args: string[]; effort: string | undefined } {
  const rest: string[] = [];
  let effort: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") { rest.push(...args.slice(at)); break; }
    let value: string | undefined;
    if (arg === "--effort") value = args[++at] ?? "";
    else if (arg.startsWith("--effort=")) value = arg.slice("--effort=".length);
    else { rest.push(arg); continue; }
    effort = (DSH_EFFORTS as readonly string[]).includes(value) ? value : undefined;
  }
  return { args: rest, effort };
}

/**
 * Starts dsh-tui with its `--effort <level>` saved to `<home>/.dsh-tui/effort.json` instead, the file dsh-tui's own
 * `/effort <id>` writes and its boot reads (lib/types/effortPrefs.js), so the session starts on it and later ones
 * keep it, as after `/effort`; a /settings "default reasoning effort" set in dsh-tui still outranks it there. The
 * file is written just before the command is typed, since dsh-tui reads it as it boots, and put back as it was when
 * the start fails, unless something else wrote it meanwhile (even the same level). One file serves every dsh-tui and
 * none takes a level of its own, so two launches at about the same time may both start on the later level. With no
 * home a chosen level cannot be saved, so dsh-tui is not started.
 */
async function startDshTui(paneId: string, args: string[], options: { locator?: ShellAgentLocator }, home: string): Promise<number | null> {
  const { args: rest, effort } = dshEffortArgs(args);
  if (effort === undefined) return startShellAgent("dsh-tui", paneId, rest, options);
  if (home === "") throw new Error("the effort level could not be saved to ~/.dsh-tui/effort.json: this server has no home folder (HOME is not set)");
  const file = join(home, ".dsh-tui", "effort.json");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const written = JSON.stringify({ effort }, null, 2);
  mkdirSync(join(home, ".dsh-tui"), { recursive: true });
  writeFileSync(file, written);
  // the file as this launch left it: a rewrite with the same level changes its times, if not its bytes
  const same = (stats: Stats, then: Stats): boolean => stats.ino === then.ino && stats.size === then.size && stats.mtimeMs === then.mtimeMs && stats.ctimeMs === then.ctimeMs;
  const ours = statSync(file);
  try {
    return await startShellAgent("dsh-tui", paneId, rest, options);
  } catch (error) {
    try {
      // only this launch's own write is taken back: a level written (or a file removed) meanwhile stays
      if (existsSync(file) && same(statSync(file), ours) && readFileSync(file, "utf8") === written) {
        if (before === null) rmSync(file);
        else writeFileSync(file, before);
      }
    } catch (restoreError) {
      console.warn(`dsh-tui effort: ${file} could not be put back (${restoreError instanceof Error ? restoreError.message : String(restoreError)})`);
    }
    throw error;
  }
}

/**
 * Starts a checked `agent` in a pane herdr just made. A failure is answered, not thrown: the
 * workspace, tab or worktree around the pane is there either way. `launched` is told the pid of
 * the process a shell-started agent came up as, when one is seen in front of the pane; `locator`
 * is the one `/api/agents` offered it from. `options` stands in for this PC's platform, the
 * folder Claude Code's settings files go to and the user's home, for a test.
 */
export async function agentLaunch(paneId: string, agent: AgentPayload, launched?: (pid: number) => void, locator?: ShellAgentLocator, options: { platform?: string; settingsDir?: string; home?: string } = {}): Promise<{ agent_started: true } | { agent_started: false; error: { code: string; message: string } }> {
  try {
    const kind = agent.kind as string;
    const args = agent.args as string[] | undefined;
    if (isShellAgentKind(kind)) {
      // another machine of the core: its path would be this PC's, and its start is never seen there (no pids)
      if (hcMachine() !== null) return { agent_started: false, error: { code: "other_machine", message: `${kind} starts only on the PC that runs Ovis` } };
      const shellOptions = locator ? { locator } : {};
      const pid = kind === "dsh-tui" && args !== undefined
        ? await startDshTui(paneId, args, shellOptions, options.home ?? userHome())
        : await startShellAgent(kind, paneId, args, shellOptions);
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
      error: requestFault(error, "agent_start_failed"),
    };
  }
}
