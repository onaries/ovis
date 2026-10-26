/**
 * GET /api/pane/omo-tasks: an OmO pane's background tasks and workflows, or a Claude Code pane's
 * subagents, read through the trackers the server core owns. The dispatcher in index.ts runs the
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

/** The core's own trackers: the route reads them and never makes its own. */
export type TaskTrackers = { omo: Pick<OmoStatus, "sessionOf">; claudeAgents: Pick<ClaudeSubagentStatus, "sessionOf" | "ensure">;
  codexTasks?: Pick<CodexBackgroundTasks, "poll" | "tasksOf">; plans?: Pick<SessionPlans, "ensure" | "codexPathOf"> };

/** The answer for the background tasks route, or null when the path is not it. */
export async function handleTasksRequest(request: Request, url: URL, pathname: string, { omo, claudeAgents, codexTasks, plans }: TaskTrackers): Promise<Response | null> {
  if (pathname === "/api/pane/omo-tasks") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const paneId = url.searchParams.get("pane_id");
    if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
    const session = omo.sessionOf(paneId);
    // server_time: the browser's clock can differ from this PC's, and the list says how long tasks ran
    const server_time = new Date().toISOString();
    if (session === null) {
      let codex = false;
      let found: OmoTask[] = [];
      await within(1000, (async () => {
        if (codexTasks && plans) {
          const pane = await paneGet(paneId);
          if (pane.agent === "codex") {
            codex = true;
            await plans.ensure(pane, true);
            const path = plans.codexPathOf(pane);
            codexTasks.poll(paneId, path);
            const after = await paneGet(paneId);
            found = plans.codexPathOf(after) === path && path !== null ? codexTasks.tasksOf(paneId) : [];
          } else if (claudeAgents.sessionOf(paneId) === null) await claudeAgents.ensure(pane);
        } else if (claudeAgents.sessionOf(paneId) === null) await claudeAgents.ensure(await paneGet(paneId));
      })());
      if (codex) return jsonResponse({ tasks: found, runs: [], server_time });
      // a Claude pane's subagents, read from its session's files; nothing for any other pane.
      // Its transcript is found here if the background lookup has not got to it yet
      // (for a second at most: a slow herdr answers with what is known, and the next ask has the rest)
      // An unknown pane costs a fresh herdr lookup too; the client bounds its discovery retries.
      const claude = claudeAgents.sessionOf(paneId);
      return jsonResponse({ tasks: claude === null ? [] : claudeSubagents(claude.path, claude.live, Date.now(), claude.startedAt), runs: [], server_time });
    }
    return jsonResponse({ tasks: omoTasks(session.cwd, session.sessionId, processAlive), runs: omoRuns(session.cwd, session.sessionId), server_time });
  }
  return null;
}
