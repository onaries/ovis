import type { HerdrPane, PaneBackgroundAgentDetail } from "../shared/protocol.ts";
import { backgroundAgentDetail, backgroundCommand, validDetailId, within, type ClaudeSubagentStatus } from "./claude-subagents.ts";
import { badRequest, conflictResponse, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";

export const BACKGROUND_AGENT_PATH = "/api/pane/background-agent";

export interface BackgroundAgentDeps {
  /** the pane as herdr has it now; throws herdr's pane_not_found */
  paneGet: (paneId: string) => Promise<HerdrPane>;
  /** whether the pane is OmO's, whatever herdr names it: its tasks have no transcript to open */
  omoPane: (paneId: string) => boolean;
  claudeAgents: Pick<ClaudeSubagentStatus, "ensure" | "sessionOf">;
  /** the read itself (backgroundAgentDetail); a test holds it to change the pane's session while it is out */
  read?: (parentPath: string, agentId: string) => ReturnType<typeof backgroundAgentDetail> | Promise<ReturnType<typeof backgroundAgentDetail>>;
  now?: () => number;
}

type Session = "omo" | "other" | { path: string; live: boolean; startedAt: number | null } | null;

/**
 * GET /api/pane/background-agent?pane_id=&agent_id=: what a running Claude Code subagent's own
 * transcript holds, read-only and bounded (claude-subagents.ts backgroundAgentDetail). The pane
 * is looked up as herdr has it now, before the read and again after it: the answer is the
 * selected pane's session's, and a pane that moved to another session meanwhile is told so
 * (409 background_target_changed) rather than shown the other session's agent. The caller names
 * a pane and an agent id only: the store, the session and the files are the server's to resolve,
 * and the id is a plain word before it names a file. An OmO pane (one herdr may name `claude`),
 * any other agent's pane and a Claude background command have no transcript to open (501), even
 * where files bear the command's id; a session not found yet, or whose files cannot be read as they
 * are, is 503.
 */
export async function handleBackgroundAgentRequest(request: Request, url: URL, deps: BackgroundAgentDeps): Promise<Response> {
  setRequestRoute(BACKGROUND_AGENT_PATH);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  const paneId = url.searchParams.get("pane_id");
  const agentId = url.searchParams.get("agent_id");
  if (!paneId) return badRequest("missing_pane_id", "pane_id query parameter is required");
  if (!agentId) return badRequest("missing_agent_id", "agent_id query parameter is required");
  if (!validDetailId(agentId)) return badRequest("invalid_agent_id", "agent_id must be a word of letters, digits, - and _, at most 128 characters");
  const session = async (): Promise<Session> => {
    if (deps.omoPane(paneId)) return "omo";
    const pane = await deps.paneGet(paneId);
    if (pane.agent !== "claude") return "other";
    // a session the background lookup has not got to yet is looked up here, for a second at most
    await within(1000, deps.claudeAgents.ensure(pane));
    return deps.claudeAgents.sessionOf(paneId);
  };
  try {
    const before = await session();
    if (before === "omo" || before === "other") return unsupported("details can be read for a Claude Code subagent only");
    if (before === null) return unavailable("the pane's Claude session is not known yet");
    // a background command of the session has no transcript of its own: its output is a screen's, which is never read
    if (backgroundCommand(before.path, agentId)) return unsupported("a background command's output is not read");
    const read = await (deps.read ?? backgroundAgentDetail)(before.path, agentId);
    const after = await session();
    if (typeof after !== "object" || after === null || after.path !== before.path) return conflictResponse("background_target_changed", "the pane no longer runs the session the agent belongs to");
    if ("refusal" in read) {
      if (read.refusal === "unavailable") return unavailable("the session's files cannot be read as they are");
      return jsonResponse({ error: { code: "background_agent_not_found", message: "no such subagent in the pane's session" } }, 404);
    }
    const answer: PaneBackgroundAgentDetail = { ...read.detail, server_time: new Date((deps.now ?? Date.now)()).toISOString() };
    return jsonResponse(answer);
  } catch (error) {
    return errorResponse(error);
  }
}

const unsupported = (message: string): Response => jsonResponse({ error: { code: "background_detail_unsupported", message } }, 501);
const unavailable = (message: string): Response => jsonResponse({ error: { code: "background_store_unavailable", message } }, 503);
