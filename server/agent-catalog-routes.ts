/**
 * GET /api/agent-catalog: every agent Ovis can install, with this PC's own official command for each
 * and whether it is installed here, at which version (server/agent-catalog-detect.ts). Read only:
 * nothing here installs, updates or signs in. The dispatcher in index.ts runs the access gate first.
 */
import { AGENT_CATALOG, catalogPlatform, catalogRow, type AgentCatalogResponse, type CatalogPlatform } from "../shared/agent-catalog.ts";
import type { AgentDetector } from "./agent-catalog-detect.ts";
import { hcMachine } from "./herdr-core/runtime.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";

/** What this PC can tell about another machine of the core's agents: nothing (machine-bridge.ts). */
const UNKNOWN = { installed: null, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null } as const;
const OTHER_MACHINE = "Ovis cannot tell what this machine has installed: install agents from a terminal on it.";

export async function agentCatalogFor(platform: CatalogPlatform | null, detector: AgentDetector): Promise<AgentCatalogResponse> {
  const agents = await Promise.all(AGENT_CATALOG.map(async (entry) => catalogRow(entry, platform, await detector.state(entry, platform))));
  const problem = detector.pathProblem();
  return problem === null ? { platform, agents } : { platform, agents, path_problem: problem };
}

/** The answer for the catalog route, or null when the path is not it. */
/** `readOnly`: a watching device's request, which reads the catalog as kept and never has the shells run again */
export async function handleAgentCatalogRequest(request: Request, pathname: string, detector: AgentDetector, platform = catalogPlatform(process.platform), readOnly = false): Promise<Response | null> {
  if (pathname !== "/api/agent-catalog") return null;
  setRequestRoute(pathname);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  try {
    // what is installed changes under it (an install in a terminal tab): never kept by a browser
    // another machine of the core: its platform and installs are not this PC's, so neither is told
    const catalog: AgentCatalogResponse = hcMachine() !== null
      ? { platform: null, agents: AGENT_CATALOG.map((entry) => ({ ...catalogRow(entry, null, { ...UNKNOWN }), no_install: OTHER_MACHINE })) }
      // Check again (`?recheck=1`) has the shells' PATH read afresh first, the interactive one's too
      // (at most once per REREAD_GAP_MS, however often it is asked: shell-agent.ts)
      : await (!readOnly && new URL(request.url).searchParams.get("recheck") === "1" ? detector.refreshPath() : Promise.resolve()).then(() => agentCatalogFor(platform, detector));
    return jsonResponse(catalog, 200, { "cache-control": "no-store" });
  } catch (error) {
    return errorResponse(error);
  }
}
