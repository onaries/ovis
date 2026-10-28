import type { DevicePairedEvent, Machine, MachineEvent, MachineRoster, SetupAction, SetupRequest } from "../shared/machines.ts";
import type { AgentRowTokens } from "../shared/pane-tokens.ts";
import type { SharedPreferences } from "../shared/preferences.ts";
import type { PanePromptResponse, SessionSnapshot } from "../shared/protocol.ts";
import type { SeenFinish } from "../shared/seen.ts";
import { MachineManager } from "./machines.ts";
import { canSendSecret, sameOrigin } from "./machine-security.ts";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { crossSiteFileRead } from "./file-view.ts";
import { decidedRowTokens, reportedTokenValues, snapshotWithoutHiddenTokens, withoutHiddenTokens } from "./herdr-sidebar.ts";
import { parseJson, readCapped, REMOTE_LIMITS, RemoteResponseInvalid, RemoteResponseTooLarge } from "./remote-json.ts";

const fail = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status);

/**
 * A PC route whose answer can take longer than the proxy's usual 75 s: a worktree's creation waits on
 * git and then an agent's start, and a resume on the agent's start and then the check of its store.
 */
export const slowMachinePath = (path: string): boolean => path === "worktree/create" || path === "sessions/resume";

/**
 * A path no route is spelled as: an empty segment (`//`, or a trailing `/`) or an encoded separator.
 * Path checks match the canonical spelling, and the PC proxy drops empty segments before it
 * forwards, so such a path must be no route at all rather than "some other route".
 */
export const nonCanonicalPath = (pathname: string): boolean => pathname.includes("//") || (pathname.length > 1 && pathname.endsWith("/")) || /%2f|%5c/i.test(pathname);
export const MACHINE_PROXY_PATH = /^(?:session|sessions\/(?:history|resume)|agents|integrations|pane\/(?:read|scroll|find|selection|conversation(?:\/image|\/tool-output)?|commands|files|omo-tasks|background-agent|plan|prompt|prompt\/answer|input|keys|close|rename|image|split|zoom|swap|resize|clear|focus)|workspace\/(?:create|rename|move|close|directories|diff\/files|diff\/file|diff\/repositories|diff\/refs)|worktree\/(?:create|list|open|remove)|tab\/(?:create|rename|close|move|move-to-workspace)|layout\/ratio|agent\/(?:rename|commands)|plugins\/actions|plugin\/action|fs\/(?:stat|file|favicon))$/;


/**
 * A PC that could not be reached. A timed-out or aborted call is not a broken connection:
 * the PC is there and the answer did not come in time (or the client gave up first), so it
 * says so, and the cause is logged either way — the cause is the only thing that tells a
 * slow PC from an offline one.
 */
function transportFailure(id: string, path: string, error: unknown): Response {
  const timedOut = error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
  console.error(`machine proxy ${id}${path}: ${timedOut ? "timed out" : "unreachable"}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  return timedOut
    ? fail("machine_timeout", "The PC did not answer in time; retry after reconnecting", 504)
    : fail("machine_unavailable", "The PC connection was interrupted; retry after reconnecting", 502);
}

/**
 * An answer this app will not pass on: too large to hold, or unreadable where it must be redacted.
 * Its fixed message names none of it; the browser shows it in the UI language by the code (src/lib/api.ts).
 */
function unusableAnswer(id: string, path: string, error: RemoteResponseTooLarge | RemoteResponseInvalid): Response {
  const tooLarge = error instanceof RemoteResponseTooLarge;
  console.error(`machine proxy ${id}${path}: ${tooLarge ? "answer too large" : "answer unreadable"}`);
  return fail(tooLarge ? "remote_response_too_large" : "remote_response_invalid", error.message, 502);
}

export async function handleMachineRequest(request: Request, manager: MachineManager, onRevoke?: (close: () => void) => () => void,
  preferences?: { get(): SharedPreferences; subscribe(listener: (preferences: SharedPreferences) => void): () => void }, readOnly = false,
  herdrSidebar?: { get(): AgentRowTokens | null; subscribe(listener: (agents: AgentRowTokens | null) => void): () => void },
  seen?: { list(): SeenFinish[]; subscribe(listener: (finish: SeenFinish) => void): () => void },
  /** durable device enrollments (server/devices.ts), already without the ones this stream's own device made */
  pairings?: { subscribe(listener: (event: DevicePairedEvent) => void): () => void }): Promise<Response> {
  const url = new URL(request.url);
  // A PC's file opens as this PC's /api/fs/file does, from any navigation: reading it changes
  // nothing, and Chrome on Android shows a PDF in the viewer's frame as an "Open" button whose
  // navigation is cross-site. Every other PC route still answers only this app.
  const fileRead = ["GET", "HEAD"].includes(request.method) && /^\/api\/machines\/[^/]+\/fs\/file$/.test(url.pathname);
  if (!fileRead && !sameOrigin(request)) return fail("invalid_origin", "Use PC controls from this app", 403);
  // a navigation may open a PC's file from anywhere; another page loading it as a picture may not
  if (fileRead && crossSiteFileRead(request)) return fail("cross_site", "A file is read from this app or opened in a tab, not loaded by another page", 403);
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("x-herdr-machine") !== "1") return fail("invalid_machine_request", "Use PC controls from this app", 403);
  // an empty segment is never a route: dropping it would forward `<id>//fs/file` as `fs/file`
  if (nonCanonicalPath(url.pathname)) return fail("not_found", "not found", 404);
  const parts = url.pathname.slice("/api/machines".length).split("/").filter(Boolean);
  try {
    if (!parts.length && request.method === "GET") {
      setRequestRoute("/api/machines");
      const asked = url.searchParams.getAll("verify_source_boot");
      // as the machine events tell it: without the token values herdr's rows hide (withoutHiddenTokens)
      const shown = () => withoutHiddenTokens(herdrSidebar?.get() ?? null, manager.list());
      if (asked.length === 0) return jsonResponse({ machines: shown() } satisfies MachineRoster);
      if (asked.length > 1 || asked[0] === "") return fail("invalid_query", "verify_source_boot names one PC", 400);
      const machineId = asked[0]!;
      const proof = await manager.verifySourceBoot(machineId, request.signal);
      if ("refused" in proof) {
        if (proof.refused === "unknown") return fail("machine_not_found", "PC not found", 404);
        const response = fail("source_unverified", proof.refused === "interval" ? "This PC's server was asked a moment ago; ask again shortly" : "This PC's server could not be verified now", 503);
        response.headers.set("cache-control", "no-store");
        if (proof.refused === "interval") response.headers.set("retry-after", "1");
        return response;
      }
      return jsonResponse({ machines: shown(), verified_source_boot: { machine_id: machineId, boot_id: proof.boot_id } } satisfies MachineRoster, 200, { "cache-control": "no-store" });
    }
    if (parts[0] === "events" && parts.length === 1 && request.method === "GET") {
      setRequestRoute("/api/machines/events");
      let stop: (() => void) | undefined;
      let stopPreferences: (() => void) | undefined;
      let stopSidebar: (() => void) | undefined;
      let stopSeen: (() => void) | undefined;
      let stopPairings: (() => void) | undefined;
      let unwatchDevice: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let close = () => {};
      const cleanup = () => {
        stop?.(); stopPreferences?.(); stopSidebar?.(); stopSeen?.(); stopPairings?.(); unwatchDevice?.(); clearInterval(heartbeat);
        request.signal.removeEventListener("abort", close);
      };
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          close = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch {} };
          unwatchDevice = onRevoke?.(close);
          if (closed) return;
          const send = (text: string) => { if (closed) return; if ((controller.desiredSize ?? 0) < -4) { close(); return; } try { controller.enqueue(encoder.encode(text)); } catch { close(); } };
          // herdr's sidebar rows are this PC's config, as herdr's own sidebar takes the client's for every PC.
          // A roster leaves without the values their hide rules hide (withoutHiddenTokens), so no browser holds one;
          // the rules' decisions (decidedRowTokens) go first, in the same write, showing the values of this roster and
          // of the one the browser holds until it lands, and hiding any other where a rule hides, as a value kept from
          // a roster told under other rows. New rows are told with the roster again under them.
          // Read before listening: a change this read finds is told to the browsers already listening, and to this one once.
          let rows = herdrSidebar?.get() ?? null;
          let reported = new Map<string, Set<string>>();
          let roster: Machine[] | undefined;
          let toldSidebar: string | undefined;
          const sidebarFrame = (...values: Map<string, Set<string>>[]): string => {
            if (!herdrSidebar) return "";
            const told = JSON.stringify({ type: "herdr-sidebar", agents: decidedRowTokens(rows, ...values) } satisfies MachineEvent);
            if (told === toldSidebar) return "";
            toldSidebar = told;
            return `data: ${told}\n\n`;
          };
          const sendSidebar = () => { const frame = sidebarFrame(reported); if (frame) send(frame); };
          const sendRoster = (machines: Machine[]) => {
            roster = machines;
            const shown = withoutHiddenTokens(rows, machines);
            const incoming = reportedTokenValues(shown);
            const frame = sidebarFrame(reported, incoming);
            reported = incoming;
            send(`${frame}data: ${JSON.stringify({ type: "machines", machines: shown } satisfies MachineEvent)}\n\n`);
          };
          stop = manager.subscribe((event) => {
            if (event.type === "machines") { sendRoster(event.machines); return; }
            // a PC's own snapshot, relayed as it came: told as the roster is, without what the rows hide
            const told = event.type === "machine-message" && event.message.type === "snapshot"
              ? { ...event, message: { ...event.message, snapshot: snapshotWithoutHiddenTokens(rows, event.message.snapshot) } }
              : event;
            send(`data: ${JSON.stringify(told)}\n\n`);
          });
          // the shared preferences ride the same stream, one connection per browser; the document
          // opens it, so a page that reconnects (or whose GET lost a race) holds the latest
          const sendPreferences = (shared: SharedPreferences) => send(`data: ${JSON.stringify({ type: "preferences", preferences: shared } satisfies MachineEvent)}\n\n`);
          stopPreferences = preferences?.subscribe(sendPreferences);
          if (preferences) sendPreferences(preferences.get());
          sendSidebar();
          stopSidebar = herdrSidebar?.subscribe((next) => { rows = next; if (roster) sendRoster(roster); else sendSidebar(); });
          const sendSeen = (finishes: SeenFinish[]) => send(`data: ${JSON.stringify({ type: "seen", finishes } satisfies MachineEvent)}\n\n`);
          if (seen) sendSeen(seen.list());
          stopSeen = seen?.subscribe((finish) => sendSeen([finish]));
          // a device paired after this stream opened: the one event, as it happens (nothing is replayed on reconnect)
          stopPairings = pairings?.subscribe((event) => send(`data: ${JSON.stringify(event satisfies MachineEvent)}\n\n`));
          if (closed) { cleanup(); return; }
          heartbeat = setInterval(() => send(": heartbeat\n\n"), 15_000);
          request.signal.addEventListener("abort", close, { once: true });
          if (request.signal.aborted) close();
        },
        cancel() { close(); },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
    }
    if (parts[0] === "setup") {
      if (parts.length === 1 && request.method === "POST") { setRequestRoute("/api/machines/setup"); return jsonResponse(manager.setup(await request.json() as SetupRequest), 202); }
      if (parts.length === 2) {
        setRequestRoute("/api/machines/setup/:job_id");
        const job = manager.job(parts[1]!);
        if (!job) return fail("job_not_found", "Setup job not found", 404);
        if (request.method === "POST") {
          const action = await request.json() as SetupAction;
          if (!isJsonObject(action)) return fail("invalid_body", "Expected a setup action", 400);
          if (action.action === "answer" && job.challenge?.kind === "secret" && !canSendSecret(request)) return fail("https_required", "Passwords and key passphrases require HTTPS or localhost", 403);
          manager.action(parts[1]!, action);
        } else if (request.method === "DELETE") manager.action(parts[1]!, { action: "cancel" });
        else if (request.method !== "GET") return fail("method_not_allowed", "Use GET, POST or DELETE", 405);
        return jsonResponse(manager.job(parts[1]!));
      }
    }
    if (parts[0] === "settings" && parts.length === 1) {
      setRequestRoute("/api/machines/settings");
      if (request.method === "GET") return jsonResponse(manager.settings());
      if (request.method !== "PATCH") return fail("method_not_allowed", "Use GET or PATCH", 405);
      const patch = await request.json();
      if (!isJsonObject(patch)) return fail("invalid_body", "Expected PC settings", 400);
      return jsonResponse(manager.updateSettings(patch));
    }
    const id = parts[0]!;
    if (parts.length === 2 && parts[1] === "update-bridge" && request.method === "POST") { setRequestRoute("/api/machines/:machine_id/update-bridge"); return jsonResponse(manager.updateBridge(id), 202); }
    if (parts.length === 1 && request.method === "PATCH") {
      setRequestRoute("/api/machines/:machine_id");
      const patch = await request.json();
      if (!isJsonObject(patch)) return fail("invalid_body", "Expected a PC update", 400);
      manager.patch(id, patch); return jsonResponse({ ok: true });
    }
    if (parts.length === 1 && request.method === "DELETE") { setRequestRoute("/api/machines/:machine_id"); manager.remove(id); return jsonResponse({ ok: true }); }
    const path = parts.slice(1).join("/");
    // earlier sessions carry their first prompts, and a folder's command files name what is in it (the new-tab
    // dialog's agent commands): never asked for a watching device with the PC's credential
    if (readOnly && (path === "sessions/history" || path === "agent/commands")) return fail("read_only", "this device can only watch", 403);
    if (MACHINE_PROXY_PATH.test(path)) {
      // `path` is a finite endpoint literal, never the machine id or an arbitrary suffix.
      setRequestRoute(`/api/machines/:machine_id/${path}`);
      // a connection that may only watch is refused here as well as at the access check, by the same rule
      // (index.ts `mutating`): it writes nothing on another PC
      if (readOnly && !["GET", "HEAD", "OPTIONS"].includes(request.method)) return fail("read_only", "this device can only watch", 403);
      const endpoint = manager.endpoint(id);
      if (!endpoint) {
        // a chat opened while the PC waits to reconnect asks it to try now, not after its delay
        manager.retryNow(id);
        return fail("machine_offline", "This PC is disconnected", 503);
      }
      // Explicit header allowlist: cookies, browser Authorization, forwarded headers
      // and remote Set-Cookie never cross this boundary. No arbitrary target URLs.
      const headers = new Headers({ authorization: `Bearer ${endpoint.token}` });
      const contentType = request.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
      // a remote conversation answers 304 when unchanged, as a local one does
      const ifNoneMatch = request.headers.get("if-none-match");
      if (ifNoneMatch) headers.set("if-none-match", ifNoneMatch);
      const abort = new AbortController();
      if (path === "fs/file") {
        // a file (a video, say) streams through, with its ranges, never held here; it can
        // play for longer than any request timeout
        const range = request.headers.get("range");
        if (range) headers.set("range", range);
        try {
          const response = await fetch(`${endpoint.url}/api/${path}${url.search}`, { method: request.method, headers, redirect: "error", signal: request.signal });
          const passed = new Headers({ "cache-control": "private, no-store" });
          for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "content-disposition", "content-security-policy", "x-content-type-options"]) {
            const value = response.headers.get(name);
            if (value) passed.set(name, value);
          }
          return new Response(response.body, { status: response.status, headers: passed });
        } catch (error) { return transportFailure(id, path, error); }
      }
      // A watching device gets a plan card as the PC's screen shows it, never Claude's plan file:
      // the PC is asked for that (`plan=0`), and a PC that ignores the ask loses the file here.
      const watchedPrompt = readOnly && path === "pane/prompt";
      const target = new URL(`${endpoint.url}/api/${path}${url.search}`);
      if (watchedPrompt) target.searchParams.set("plan", "0");
      const untrack = manager.trackTerminal(id, () => abort.abort());
      // a move's PC reads its roster again once the move is confirmed, so its receipt is soon shown
      const moved = path === "workspace/move" && request.method === "POST" ? manager.refreshAfterMove(id) : null;
      try {
        const response = await fetch(target, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body, redirect: "error", signal: AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(slowMachinePath(path) ? 165_000 : 75_000)]) });
        if (moved && response.ok) moved();
        const etag = response.headers.get("etag");
        // held whole before it is passed on (and parsed, for a watcher's prompt), so only up to a size
        let body: Uint8Array<ArrayBuffer> | null = response.status === 304 ? null : await readCapped(response, watchedPrompt ? REMOTE_LIMITS.watchedPrompt : REMOTE_LIMITS.proxy);
        if (watchedPrompt && response.ok && body) {
          const answer = parseJson<PanePromptResponse>(body);
          if (answer.prompt?.plan_file !== undefined) {
            // the body is the plan file's text and the screen's is not in the answer: the card keeps
            // its question and options, without a body
            const { plan_file: _planFile, ...card } = answer.prompt;
            answer.prompt = { ...card, body: null };
          }
          if (answer.outcomes) answer.outcomes = answer.outcomes.map(({ preview: _preview, result_text: _resultText, ...outcome }) => outcome);
          body = new TextEncoder().encode(JSON.stringify(answer));
        }
        // a PC's session as the roster tells it, without the token values this server's rows hide (#2160)
        // any method the PC answers with a body (its route takes them all); a HEAD's is empty
        if (path === "session" && response.ok && body && body.byteLength > 0) {
          const answer = parseJson<{ snapshot?: SessionSnapshot }>(body);
          const shown = answer.snapshot && snapshotWithoutHiddenTokens(herdrSidebar?.get() ?? null, answer.snapshot);
          if (shown && shown !== answer.snapshot) body = new TextEncoder().encode(JSON.stringify({ ...answer, snapshot: shown }));
        }
        return new Response(body, { status: response.status, headers: {
          "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...(etag ? { etag } : {}),
        } });
      } catch (error) {
        if (error instanceof RemoteResponseTooLarge || error instanceof RemoteResponseInvalid) return unusableAnswer(id, path, error);
        return transportFailure(id, path, error);
      }
      finally { untrack(); }
    }
    return fail("not_found", "Unknown PC endpoint", 404);
  } catch (e) { return fail("machine_request_failed", e instanceof Error ? e.message : String(e), 400); }
}
