import { noInstalledNotes, noUpdateNotes, readInstalledNotes, readUpdateNotes, REVISION, unmanagedUpdateStatus, type InstalledNotes, type UpdateNotes, type UpdateRequest, type UpdateStatus } from "../shared/update.ts";
import { join } from "node:path";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";

export interface UpdateService {
  status(): UpdateStatus;
  /** what the available update brings, from the supervisor's last check */
  notes(): UpdateNotes;
  /** what the last update brought, from the supervisor that runs it */
  installed(): InstalledNotes;
  request(request: UpdateRequest): void;
  /** The commit the client build in the served `dist/` was made from (see `servedRevision`); absent when unmanaged. */
  servedRevision?(): Promise<string | null>;
}

/**
 * The commit the client build in `<directory>/dist` was made from, read from the `build.json` the
 * build writes (vite.config.ts) each time a tab asks. The bridge serves `dist/` from its directory
 * on every request, so a source checkout rebuilt under it (a plugin reinstall, or `git pull` and a
 * build) is served at once while the server still runs the revision it started with: a tab
 * reloaded then must already be told that only a restart helps. Only a build written after
 * `since` (the bridge's start) counts: one already there was not replaced under the server, and a
 * restart would not change it (a pull without a build, then a restart). A build older than the
 * file, or outside Git, answers null too.
 */
export function servedRevision(directory: string, since = Date.now()): () => Promise<string | null> {
  const file = join(directory, "dist", "build.json");
  return async () => {
    try {
      const build = Bun.file(file);
      if (build.lastModified < since) return null;
      const revision = (await build.json() as { revision?: unknown }).revision;
      return typeof revision === "string" && /^[0-9a-f]{40,64}$/.test(revision) ? revision : null;
    } catch { return null; }
  };
}

/** The bridge's line to the supervisor that runs it: the process's IPC channel, or a test's stand-in. */
export interface SupervisorChannel {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
}

/** Only the managed entrypoint connects IPC; importing createServer in tests does not. */
export function connectUpdater(channel?: SupervisorChannel): UpdateService {
  let status = unmanagedUpdateStatus();
  let notes = noUpdateNotes();
  let installed = noInstalledNotes();
  const managed = Boolean(process.send) && process.env["OVIS_MANAGED"] === "1";
  const supervisor = channel ?? (managed ? { send: (message: unknown) => process.send?.(message), onMessage: (listener: (message: unknown) => void) => process.on("message", listener) } : null);
  if (supervisor) {
    supervisor.onMessage((message: unknown) => {
      const value = message as { type?: string; status?: UpdateStatus; notes?: unknown; installed?: unknown };
      if (value?.type !== "update-status" || !value.status) return;
      // installs are offered only where the supervisor says itself that it installs the exact
      // revision asked for: an older one would install whatever its own check finds
      const { revision_bound_install: bound, ...told } = value.status;
      status = bound === true ? { ...told, revision_bound_install: true } : told;
      // a supervisor older than the notes sends none: the one being replaced, or a fallback
      notes = readUpdateNotes(value.notes);
      installed = readInstalledNotes(value.installed);
    });
    supervisor.send({ type: "update-status-request" });
  }
  return {
    status: () => status,
    notes: () => notes,
    installed: () => installed,
    // an install goes as a message an older supervisor does not know, never as its unbound `install`
    request: (request) => supervisor?.send(request.command === "install"
      ? { type: "update-install-revision", expected_revision: request.expected_revision }
      : { type: "update-command", command: "check" }),
    // the supervisor starts the bridge in the directory it serves: the release's, or the source checkout
    ...(managed ? { servedRevision: servedRevision(process.cwd()) } : {}),
  };
}

/**
 * Whether an update POST came from this app's own controls. A custom header is not
 * submit-able by an HTML form. Cross-origin preflights are refused (no CORS headers);
 * Sec-Fetch-Site also rejects browser CSRF.
 */
export function updateRequestAllowed(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  let sameHost = true;
  try { if (origin) sameHost = new URL(origin).host === url.host; } catch { sameHost = false; }
  return request.headers.get("x-herdr-update") === "1" && sameHost && (site === null || site === "same-origin") && !url.search;
}

/**
 * The status with `served_revision`: the commit of the client build a reload loads, once it differs
 * from the revision the server runs; null while they match or the build names none.
 */
async function withServed(status: UpdateStatus, service?: UpdateService): Promise<UpdateStatus> {
  if (!status.managed || !status.current_revision || !service?.servedRevision) return status;
  const served = await service.servedRevision();
  return { ...status, served_revision: served !== null && served !== status.current_revision ? served : null };
}

/** An install's body is one revision: more than this is not one. */
const INSTALL_BODY_LIMIT = 1024;

/** The revision an install asks for, from a JSON body of at most INSTALL_BODY_LIMIT bytes; null when it names none. */
async function expectedRevision(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > INSTALL_BODY_LIMIT) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    const revision = isJsonObject(body) ? body["expected_revision"] : null;
    return typeof revision === "string" && REVISION.test(revision) ? revision : null;
  } catch { return null; }
}

const running = (status: UpdateStatus) => ["checking", "building", "restarting"].includes(status.phase);

/**
 * `where` adds where this server answers to GET /api/updates (UpdateStatus.port, serving_url): passed
 * only for the connection server's bridge token, which cannot read GET /api/access (#2191).
 */
export function handleUpdateRequest(request: Request, pathname: string, service?: UpdateService,
  where?: () => Promise<Pick<UpdateStatus, "port" | "serving_url">>): Response | Promise<Response> {
  const status = service?.status() ?? unmanagedUpdateStatus();
  const reply = (body: unknown, code = 200) => {
    const response = jsonResponse(body, code);
    response.headers.set("cache-control", "no-store");
    return response;
  };
  const fail = (code: string, message: string, http: number) => reply({ error: { code, message } }, http);
  if (pathname === "/api/updates" && request.method === "GET") {
    setRequestRoute(pathname);
    // a failed lookup leaves the status as it was: the connection server then asks /api/access as of an older server
    return Promise.all([withServed(status, service), where?.().catch(() => undefined)]).then(([value, at]) => reply(at ? { ...value, ...at } : value));
  }
  if (pathname === "/api/updates/notes" && request.method === "GET") { setRequestRoute(pathname); return reply(service?.notes() ?? noUpdateNotes()); }
  if (pathname === "/api/updates/installed" && request.method === "GET") { setRequestRoute(pathname); return reply(service?.installed() ?? noInstalledNotes()); }
  if (request.method !== "POST" || (pathname !== "/api/updates/check" && pathname !== "/api/updates/install")) {
    return fail("method_not_allowed", "Use GET /api/updates, /api/updates/notes or /api/updates/installed, or POST /api/updates/check or /install", 405);
  }
  setRequestRoute(pathname);
  if (!updateRequestAllowed(request)) return fail("invalid_update_request", "Use the update controls from this app.", 403);
  if (!service || !status.managed) return fail("updates_unmanaged", status.blocked_reason ?? "Updates unavailable", 409);
  const busy = () => fail("update_busy", "An update operation is already running.", 409);
  if (pathname.endsWith("/check")) {
    if (running(status)) return busy();
    service.request({ command: "check" });
    return reply({ accepted: true }, 202);
  }
  // an install is consent to one release: the one the person was shown, named by its commit
  return expectedRevision(request).then((expected) => {
    if (expected === null) return fail("invalid_update_install", "Name the expected_revision of the update on offer.", 400);
    const now = service.status();
    if (running(now)) return busy();
    if (now.revision_bound_install !== true) return fail("update_restart_required", "Restart the app before installing an update from here.", 409);
    if (now.blocked_reason || !now.available) return fail("update_unavailable", now.blocked_reason ?? "No update is available. Check again first.", 409);
    if (now.latest_revision !== expected) return fail("update_offer_changed", "A different update is on offer now. Review it, then update again.", 409);
    service.request({ command: "install", expected_revision: expected });
    return reply({ accepted: true }, 202);
  });
}
