/**
 * GET /api/agent-catalog: every agent Ovis can install, with this PC's own official command for each
 * and whether it is installed here, at which version (server/agent-catalog-detect.ts). Read only:
 * nothing here installs, updates or signs in. The dispatcher in index.ts runs the access gate first.
 */
import { AGENT_CATALOG, catalogPlatform, catalogRow, type AgentCatalogResponse, type CatalogPlatform } from "../shared/agent-catalog.ts";
import type { AgentDetector } from "./agent-catalog-detect.ts";
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";

export async function agentCatalogFor(platform: CatalogPlatform | null, detector: AgentDetector): Promise<AgentCatalogResponse> {
  const agents = await Promise.all(AGENT_CATALOG.map(async (entry) => catalogRow(entry, platform, await detector.state(entry, platform))));
  return { platform, agents };
}

/** The answer for the catalog route, or null when the path is not it. */
export async function handleAgentCatalogRequest(request: Request, pathname: string, detector: AgentDetector, platform = catalogPlatform(process.platform)): Promise<Response | null> {
  if (pathname !== "/api/agent-catalog") return null;
  setRequestRoute(pathname);
  if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
  try {
    // what is installed changes under it (an install in a terminal tab): never kept by a browser
    return jsonResponse(await agentCatalogFor(platform, detector), 200, { "cache-control": "no-store" });
  } catch (error) {
    return errorResponse(error);
  }
}
