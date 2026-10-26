/**
 * GET /api/pane/omo-tasks: an OmO pane's background tasks and workflows, or a Claude Code or
 * OpenCode pane's subagents, read through the trackers the server core owns. The dispatcher in index.ts runs the
 * access gate first.
 */
import { claudeSubagents, type ClaudeSubagentStatus, within } from "./claude-subagents.ts";
import { paneGet } from "./herdr/client.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import { processAlive, type OmoStatus } from "./omo-status.ts";
import { omoRuns, omoTasks } from "./omo-tasks.ts";
import type { CodexBackgroundTasks } from "./codex-background.ts";
import type { SessionPlans } from "./session-plan.ts";
import type { OmoTask } from "../shared/protocol.ts";
import type { OpencodeSubagentStatus } from "./opencode-subagents.ts";

/** The core's own trackers: the route reads them and never makes its own. */
export type TaskTrackers = { omo: Pick<OmoStatus, "sessionOf">; claudeAgents: Pick<ClaudeSubagentStatus, "sessionOf" | "ensure">;
  opencodeAgents: Pick<OpencodeSubagentStatus, "sessionOf" | "ensure" | "tasksOf" | "beginRead">;
  codexTasks?: Pick<CodexBackgroundTasks, "poll" | "tasksWithUsage">; plans?: Pick<SessionPlans, "ensure" | "codexPathOf"> };

/** The answer for the background tasks route, or null when the path is not it. */
export async function handleTasksRequest(request: Request, url: URL, pathname: string, { omo, claudeAgents, opencodeAgents, codexTasks, plans }: TaskTrackers): Promise<Response | null> {
  if (pathname === "/api/pane/omo-tasks") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    // server_time: the browser's clock can differ from this PC's, and the list says how long tasks ran
    const server_time = new Date().toISOString();
    if (omo.sessionOf(paneId) === null) {
      let codex = false;
      let checked = false;
      let found: OmoTask[] = [];
      const discover = claudeAgents.sessionOf(paneId) === null && opencodeAgents.sessionOf(paneId) === null;
      if ((codexTasks && plans) || discover) await within(1000, (async () => {
        const begun = discover ? opencodeAgents.beginRead() : null;
        const pane = await paneGet(paneId);
        checked = true;
        if (pane.agent === "codex" && codexTasks && plans) {
          codex = true;
          await plans.ensure(pane, true);
          const path = plans.codexPathOf(pane);
          codexTasks.poll(paneId, path);
          const tasks = path === null ? [] : await codexTasks.tasksWithUsage(paneId);
          const after = await paneGet(paneId);
          found = after.agent === "codex" && omo.sessionOf(paneId) === null && plans.codexPathOf(after) === path && path !== null ? tasks : [];
        } else if (begun !== null) {
          opencodeAgents.ensure(pane, begun);
          await claudeAgents.ensure(pane);
        }
      })());
      if (codex) return jsonResponse({ tasks: found, runs: [], server_time });
      if (codexTasks && plans && !checked) return jsonResponse({ tasks: [], runs: [], server_time });
    }
    // An OpenCode pane's list is read while the event loop goes on, and the pane may come to run another session,
    // OmO or Claude Code meanwhile: what it runs is told again after the read, and a list is given only for that
    for (let tries = 0; tries < 3; tries++) {
      const session = omo.sessionOf(paneId);
      if (session !== null) return jsonResponse({ tasks: omoTasks(session.cwd, session.sessionId, processAlive), runs: omoRuns(session.cwd, session.sessionId), server_time });
      // an OpenCode pane's subagents are its child sessions; of a pane that ran both, the one it runs now
      const opencode = opencodeAgents.sessionOf(paneId);
      if (opencode === null || (!opencode.live && claudeAgents.sessionOf(paneId)?.live === true)) {
        const claude = claudeAgents.sessionOf(paneId);
        return jsonResponse({ tasks: claude === null ? [] : claudeSubagents(claude.path, claude.live, Date.now(), claude.startedAt), runs: [], server_time });
      }
      const read = await opencodeAgents.tasksOf(paneId);
      // the session the list is of (the one asked about, when there is no list to give)
      const bound = read?.read ?? opencode;
      const current = opencodeAgents.sessionOf(paneId);
      const same = current !== null && current.path === bound.path && current.session === bound.session && current.live === bound.live;
      if (same && omo.sessionOf(paneId) === null && (current.live || claudeAgents.sessionOf(paneId)?.live !== true)) {
        return jsonResponse({ tasks: read?.tasks ?? [], runs: [], server_time, ...(read !== null && read.unlisted > 0 ? { more_running: read.unlisted } : {}) });
      }
    }
    // a pane that kept moving: nothing is told for sure; the client asks again
    return jsonResponse({ tasks: [], runs: [], server_time });
  }
  return null;
}
