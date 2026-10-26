import { apiFetch as fetch } from "./api-request-id.ts";
import type { PreferencesChange, SharedPreferences } from "../../shared/preferences.ts";
import type { SeenFinish } from "../../shared/seen.ts";
import { resumeConnectionTraces } from "./connectionTrace.ts";
import { machinePath, type BridgeHealth, type HerdrIdentity, type Machine, type MachineRoster, type SetupAction, type SetupJob, type SetupRequest } from "../../shared/machines.ts";
import type {
  WorkspaceMoved,
  AgentKind,
  AgentRenameRequest,
  CommandOutcome,
  ConversationResponse,
  CreateWorktreeRequest,
  CreateTabRequest,
  CreateWorkspaceRequest,
  DirectoryCreated,
  DirectoryListing,
  FileInfo,
  FocusPaneRequest,
  HealthAuth,
  IntegrationsResponse,
  LanExposure,
  InteractivePrompt,
  MoveTabRequest,
  MoveTabToWorkspaceRequest,
  TabMoved,
  TabMovedToWorkspace,
  OmoActivity,
  PaneBackgroundAgentDetail,
  OpenWorktreeRequest,
  PairedDevice,
  PairingCode,
  PaneDirection,
  PaneInfo,
  PanePlan,
  PanePromptResponse,
  PaneReadResult,
  PaneResized,
  RepoBranchComparison,
  RepoDiffFileList,
  RepoDiffRepositories,
  RepoDiffFilePatch,
  RepoDiffRefs,
  RepoDiffScope,
  PaneSplit,
  PaneSwapped,
  PaneZoomed,
  PaneFindRequest,
  PaneFindResponse,
  PlanStep,
  ProjectFavicon,
  PromptAnswer,
  PushKey,
  PortalStatus,
  RemoteAccess,
  RemoveWorktreeRequest,
  ResizePaneRequest,
  SessionHistoryAgent,
  SessionHistoryResponse,
  SessionResumeRequest,
  SessionResumeResponse,
  SessionSnapshot,
  SetSplitRatioRequest,
  SlashCommand,
  SplitPaneDirection,
  SplitPaneRequest,
  SwapPaneRequest,
  TabCreated,
  UpdateInstallRequest,
  UsageReport,
  WorkspaceCreated,
  PluginActionRequest,
  PluginActionResult,
  PluginActions,
  PluginActionsResponse,
  WorktreeListing,
  WorktreeOpened,
  WorktreeRemoved,
  ZoomPaneRequest,
} from "../../shared/protocol.ts";
import { SUPPORTED_AGENT_KINDS } from "../../shared/supported-agents.ts";
import type { PaneScrollInfo } from "../../shared/herdr-api.generated.ts";
import { readInstalledNotes, readUpdateNotes, type HerdrUpdateStatus, type InstalledNotes, type UpdateNotes, type UpdateRequest, type UpdateStatus } from "../../shared/update.ts";
import type { AlertPrefs } from "../../shared/notify-policy.ts";
import type { TelemetryChange, TelemetryStatus } from "../../shared/telemetry.ts";
import type { VoiceConfigUpdate, VoiceStatus } from "../../shared/voice.ts";
import { MAX_ATTACHMENT_BYTES } from "../../shared/attachments.ts";
import { t } from "./i18n.ts";
import { chatReadDeadlineMs, withChatReadDeadline } from "./chatReadDeadline.ts";
import { movingHerdrFocus } from "./followFocus.ts";
import type { UsageLoginAccounts, UsageLoginProvider, UsageLoginRequest, UsageLoginStarted } from "../../shared/usage-login.ts";

export function fetchUsageLoginProviders(signal: AbortSignal): Promise<{ providers: readonly UsageLoginProvider[] }> {
  return getJson("/api/usage/login", { signal });
}

export function fetchUsageLoginAccounts(provider: string, signal: AbortSignal): Promise<UsageLoginAccounts> {
  return getJson(`/api/usage/login?provider=${encodeURIComponent(provider)}`, { signal });
}

export function startUsageLogin(request: UsageLoginRequest): Promise<UsageLoginStarted> {
  return getJson<UsageLoginStarted>("/api/usage/login", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: AbortSignal.timeout(30_000),
  });
}

/** Settings → Phone: what Tailscale on the server's PC already serves, or the command to run. */
export function fetchRemoteAccess(): Promise<RemoteAccess> {
  return getJson<RemoteAccess>("/api/access");
}

/** The sidebar's plan meters; `refresh` asks the providers again instead of the server's recent answer. */
export function fetchUsage(refresh = false): Promise<UsageReport> {
  return getJson<UsageReport>(refresh ? "/api/usage?refresh=1" : "/api/usage");
}

/** Local server's CLIProxyAPI controls; secrets are only ever sent, never read back. */
export function cliProxyRequest<T>(path = "", init: RequestInit = {}): Promise<T> {
  return getJson<T>(`/api/cliproxy${path}`, { ...init, cache: "no-store", signal: init.signal ?? AbortSignal.timeout(60_000) });
}

export function fetchUpdateStatus(): Promise<UpdateStatus> {
  return getJson<UpdateStatus>("/api/updates");
}

/** What the available update brings. A server older than the notes answers with an error. */
export async function fetchUpdateNotes(): Promise<UpdateNotes> {
  return readUpdateNotes(await getJson<unknown>("/api/updates/notes"));
}

/** What the last update brought. A server older than the question answers with an error. */
export async function fetchInstalledNotes(): Promise<InstalledNotes> {
  return readInstalledNotes(await getJson<unknown>("/api/updates/installed"));
}

/** A check goes without a body; an install names the release the person was offered. */
export async function requestUpdate(request: UpdateRequest): Promise<void> {
  const url = `/api/updates/${request.command}`;
  const response = await fetch(url, request.command === "install"
    ? { method: "POST", headers: { "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ expected_revision: request.expected_revision } satisfies UpdateInstallRequest) }
    : { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Settings → Updates: herdr itself, on the PC the server runs on. */
export function fetchHerdrUpdate(): Promise<HerdrUpdateStatus> {
  return getJson<HerdrUpdateStatus>("/api/herdr/update");
}

export async function requestHerdrUpdate(): Promise<void> {
  const url = "/api/herdr/update";
  const response = await fetch(url, { method: "POST", headers: { "x-herdr-update": "1" } });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Settings → Phone & devices: Portal's public address for the server's PC. */
export function fetchPortal(): Promise<PortalStatus> {
  return getJson<PortalStatus>("/api/portal");
}

export async function requestPortal(action: "start" | "stop", relay?: string): Promise<void> {
  const url = `/api/portal/${action}`;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(relay === undefined ? {} : { relay }) });
  if (!response.ok) throw await errorFrom(url, response);
}

/** Anonymous install and update counts; null from a server that sends none (404). */
/** What every browser of this server shares (shared/preferences.ts); null where the server predates it. */
export async function fetchPreferences(): Promise<SharedPreferences | null> {
  try { return await getJson<SharedPreferences>("/api/preferences"); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

export async function savePreferences(body: PreferencesChange): Promise<SharedPreferences> {
  const url = "/api/preferences";
  const response = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as SharedPreferences;
}

/**
 * Tells every browser of this server that this one presented a finish (shared/seen.ts). A server
 * that predates it (404) or a watching device (403) keeps the read to this browser.
 */
export async function shareSeen(finish: SeenFinish): Promise<void> {
  const url = "/api/seen";
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(finish) });
  if (response.ok || response.status === 404 || response.status === 403) return;
  throw await errorFrom(url, response);
}

export async function fetchTelemetry(): Promise<TelemetryStatus | null> {
  try { return await getJson<TelemetryStatus>("/api/telemetry"); }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error; }
}

export async function changeTelemetry(change: TelemetryChange): Promise<TelemetryStatus> {
  const url = "/api/telemetry";
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(change) });
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as TelemetryStatus;
}

/**
 * A non-2xx answer from the Ovis API. `code` is the server's error-envelope
 * code when it sent one, so callers can branch on `status` (401 = the token gate)
 * without parsing the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** the server's own words, without the URL and status the message starts with */
  readonly detail: string;

  constructor(url: string, status: number, detail: string, code: string | null) {
    super(`${url} failed (${status}): ${detail}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A 404 for the route itself, not for what it was asked about: a PC whose bridge is from before
 * the route, whose answer the local server passes through (server/machine-api.ts). What herdr
 * refuses comes with a code of its own (pane_not_found).
 */
export const routeMissing = (error: unknown): boolean => error instanceof ApiError && error.status === 404 && error.code === "not_found";

/**
 * The PC proxy's fixed words for another PC's answer it would not pass on (server/remote-json.ts),
 * in the UI language: they are the detail every error surface shows beside its own sentence.
 */
const UNUSABLE_ANSWER: Readonly<Record<string, () => string>> = {
  remote_response_too_large: () => t("The other PC's answer was larger than this app accepts"),
  remote_response_invalid: () => t("The other PC's answer could not be read"),
};

async function errorFrom(url: string, response: Response): Promise<ApiError> {
  let detail = response.statusText;
  let code: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.message) detail = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    /* non-JSON error body */
  }
  if (code !== null && Object.hasOwn(UNUSABLE_ANSWER, code)) detail = UNUSABLE_ANSWER[code]!();
  return new ApiError(url, response.status, detail, code);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as T;
}

export async function fetchSession(machineId = "local"): Promise<SessionSnapshot> {
  const body = await getJson<{ snapshot: SessionSnapshot }>(machinePath(machineId, "session"));
  return body.snapshot;
}

/** PCs whose herdr rejected `recent_unwrapped`: an older herdr, read row by row from then on. */
const wrappedOnly = new Set<string>();

/**
 * GET /api/pane/read as the chat view reads it: herdr's own scrollback (up to
 * `lines`), ANSI-stripped text. herdr owns scrollback — the attach stream cannot
 * serve history, so the transcript reads it back instead. `recent_unwrapped`
 * rejoins the rows the terminal soft-wrapped, so a line reflows to the chat's
 * width instead of breaking where the pty's columns ended.
 */
export async function fetchPaneTranscript(paneId: string, lines: number, machineId = "local"): Promise<PaneReadResult> {
  const read = async (source: "recent" | "recent_unwrapped"): Promise<PaneReadResult> => {
    const query = new URLSearchParams({ pane_id: paneId, source, format: "text", lines: String(lines) });
    return (await withChatReadDeadline((signal) => getJson<{ read: PaneReadResult }>(machinePath(machineId, `pane/read?${query.toString()}`), { signal }), chatReadDeadlineMs(machineId))).read;
  };
  if (wrappedOnly.has(machineId)) return read("recent");
  try {
    return await read("recent_unwrapped");
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "invalid_request") throw error;
    wrappedOnly.add(machineId);
    return read("recent");
  }
}

/** Which turns (ConversationResponse.cursor): the page `before` a cursor, not past `since`; the newest ones `from` a held start. */
export type ConversationPageQuery = { before?: string; since?: string; from?: string; limit?: number; /** Revalidate a new finish without borrowing another key's 304. */ fresh?: boolean };

/**
 * The last answer per newest-page conversation URL and its ETag. The chat reads it again on
 * every transcript push (at most every 2s), every send and status edge, and a 10s backstop
 * (2s without pushes),
 * and a newest page can be megabytes: an unchanged one comes back as a bodyless 304,
 * and the chat gets the very same object back, which tells it nothing changed. An
 * older page (`before`) is asked for once, so it keeps no ETag and takes no slot.
 *
 * A count alone does not bound what a tab holds: sixteen polled panes is a small number of
 * bodies, each as large as the server makes it, so the cache also gives up its oldest entries
 * once the answers together pass a byte budget. The answer just fetched is never given up for
 * that (it is the one the caller is about to read), the panes after it go first.
 */
interface ConversationAnswer {
  etag: string;
  body: ConversationResponse;
  /** the body's rough size: what the count cap alone cannot bound */
  bytes: number;
}
const conversationAnswers = new Map<string, ConversationAnswer>();
const CONVERSATION_ANSWERS_KEPT = 16;
/** …and this much of them, about four ordinary conversation pages each. */
const CONVERSATION_ANSWERS_BYTES = 8 * 1024 * 1024;

/**
 * The body a cache entry carries: the server's own count when it sends one for the body as it is,
 * else the JSON we parsed. A compressed answer's length counts the bytes on the wire, not these.
 */
export function conversationAnswerBytes(body: ConversationResponse, contentLength: string | null, contentEncoding: string | null = null): number {
  const declared = Number(contentLength);
  const identity = contentEncoding === null || contentEncoding.trim().toLowerCase() === "identity";
  if (identity && Number.isFinite(declared) && declared > 0) return declared;
  return JSON.stringify(body)?.length ?? 0;
}

/** Drops the least recently used answers until the cache is back inside both caps. */
function trimConversationAnswers(keep: string): void {
  let total = 0;
  for (const answer of conversationAnswers.values()) total += answer.bytes;
  while (conversationAnswers.size > CONVERSATION_ANSWERS_KEPT || total > CONVERSATION_ANSWERS_BYTES) {
    const oldest = conversationAnswers.keys().next().value;
    if (oldest === undefined || oldest === keep) break;
    total -= conversationAnswers.get(oldest)!.bytes;
    conversationAnswers.delete(oldest);
  }
}

function conversationUrl(paneId: string, machineId: string, page: ConversationPageQuery): string {
  const query = new URLSearchParams({ pane_id: paneId });
  if (page.before !== undefined) query.set("before", page.before);
  if (page.since !== undefined) query.set("since", page.since);
  if (page.from !== undefined) query.set("from", page.from);
  if (page.limit !== undefined) query.set("limit", String(page.limit));
  return machinePath(machineId, `pane/conversation?${query.toString()}`);
}

/**
 * The newest page last answered for this pane (no page query), without asking the server: a chat
 * that mounts draws it at once while its read revalidates it. It leaves the cache order alone.
 */
export function peekPaneConversation(paneId: string, machineId = "local", page: ConversationPageQuery = {}): ConversationResponse | undefined {
  return conversationAnswers.get(conversationUrl(paneId, machineId, page))?.body;
}

/** GET /api/pane/conversation: structured turns, or scrollback fallback; `page` as ConversationResponse.cursor describes. */
export async function fetchPaneConversation(paneId: string, machineId = "local", page: ConversationPageQuery = {}): Promise<ConversationResponse> {
  const url = conversationUrl(paneId, machineId, page);
  const polled = page.before === undefined;
  const known = polled ? conversationAnswers.get(url) : undefined;
  const { response, body } = await withChatReadDeadline(async (signal) => {
    const response = await fetch(url, { cache: "no-store", signal, ...(known && !page.fresh ? { headers: { "if-none-match": known.etag } } : {}) });
    if (response.status === 304 && known) return { response, body: known.body };
    if (!response.ok) throw await errorFrom(url, response);
    return { response, body: (await response.json()) as ConversationResponse };
  }, chatReadDeadlineMs(machineId));
  // Cache changes occur after the bounded read: a late, aborted answer cannot replace it.
  if (response.status === 304 && known) {
    conversationAnswers.delete(url);
    conversationAnswers.set(url, known);
    return body;
  }
  const etag = response.headers.get("etag");
  if (!polled) return body;
  conversationAnswers.delete(url);
  if (etag !== null) {
    conversationAnswers.set(url, { etag, body, bytes: conversationAnswerBytes(body, response.headers.get("content-length"), response.headers.get("content-encoding")) });
    trimConversationAnswers(url);
  }
  return body;
}

export interface HealthInfo {
  ok: boolean;
  herdr: HerdrIdentity;
  web_ui?: { boot_id: string | null; revision: string | null };
  /** Absent only on a server that predates the token gate. */
  auth?: HealthAuth;
  /** present only while this server is reachable beyond this PC with no token and nothing paired */
  lan_exposure?: LanExposure;
}

export async function fetchHealth(): Promise<HealthInfo> {
  return await getJson<HealthInfo>("/api/health");
}

/**
 * POST /api/auth. Resolves once the server has set its HttpOnly session cookie;
 * there is nothing to store client-side. Throws ApiError (401 `invalid_token`) on
 * a mismatch.
 */
export async function authenticate(token: string): Promise<void> {
  const response = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw await errorFrom("/api/auth", response);
  resumeConnectionTraces();
}

/** POST /api/devices/pair: the code shown on the PC, once; the server answers with this device's own HttpOnly cookie. */
export async function pairDevice(code: string, label: string): Promise<void> {
  const response = await fetch("/api/devices/pair", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ code, label }) });
  if (!response.ok) throw await errorFrom("/api/devices/pair", response);
  resumeConnectionTraces();
}

export async function fetchDevices(): Promise<PairedDevice[]> {
  return (await getJson<{ devices: PairedDevice[] }>("/api/devices")).devices;
}

export async function startPairing(): Promise<PairingCode> {
  return (await sendJson("/api/devices/pair/start", "POST", {})).json();
}

export async function renameDevice(id: string, label: string): Promise<PairedDevice> {
  return (await sendJson(`/api/devices/${encodeURIComponent(id)}`, "PATCH", { label })).json();
}

export async function revokeDevice(id: string): Promise<void> {
  await sendJson(`/api/devices/${encodeURIComponent(id)}`, "DELETE", {});
}

/** DELETE /api/auth: clears the session and device cookies, so the next health check reports the gate again. */
export async function signOut(): Promise<void> {
  const response = await fetch("/api/auth", { method: "DELETE" });
  if (!response.ok) throw await errorFrom("/api/auth", response);
}

/** Chunked btoa: the naive one-liner blows the stack on multi-MB screenshots. */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Megabytes to one decimal, rounded up: a file just over the limit never reads as the limit itself. */
const megabytes = (bytes: number): string => `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MB`;

/** A file over the attachment limit. Its message is what the person reads: the file, its size, the limit. */
export class AttachmentTooLargeError extends Error {
  readonly fileName: string;
  readonly size: number;

  constructor(fileName: string, size: number) {
    super(t("Too large to attach: {name} ({size}). A file can be up to {limit}.", { name: fileName, size: megabytes(size), limit: megabytes(MAX_ATTACHMENT_BYTES) }));
    this.name = "AttachmentTooLargeError";
    this.fileName = fileName;
    this.size = size;
  }
}

/** Throws for a file the server would refuse, before any of it is read or sent. */
export function assertAttachable(file: Blob): void {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(file instanceof File && file.name ? file.name : file.type || "file", file.size);
}

/**
 * POST /api/pane/image: stores one pasted or file-picked image next to the pane and
 * resolves to the absolute path the prompt should reference (the composer inserts
 * `@path`). AttachmentTooLargeError for a file over the limit, with nothing sent;
 * ApiError 413 image_too_large from a server whose limit is lower.
 */
/** Any file: an image is stored as a paste, anything else under its own (sanitised) name. */
export async function uploadPaneImage(paneId: string, image: Blob, machineId = "local"): Promise<string> {
  assertAttachable(image);
  const data_base64 = base64FromBytes(new Uint8Array(await image.arrayBuffer()));
  const response = await fetch(machinePath(machineId, "pane/image"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify({ pane_id: paneId, content_type: image.type, data_base64, ...(image instanceof File ? { name: image.name } : {}) }),
  });
  if (!response.ok) throw await errorFrom(machinePath(machineId, "pane/image"), response);
  return ((await response.json()) as { path: string }).path;
}

async function sendJson(url: string, method: "POST" | "PATCH" | "DELETE", body: unknown): Promise<Response> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFrom(url, response);
  return response;
}

/** GET /api/plugins/actions: the PC's herdr plugins and the actions it can run. */
export async function fetchPluginActions(machineId = "local"): Promise<PluginActions[]> {
  return (await getJson<PluginActionsResponse>(machinePath(machineId, "plugins/actions"))).plugins;
}

/** POST /api/plugin/action: runs one plugin action, against the pane named when there is one. */
export async function runPluginAction(request: PluginActionRequest, machineId = "local"): Promise<PluginActionResult> {
  const response = await sendJson(machinePath(machineId, "plugin/action"), "POST", request);
  return (await response.json()) as PluginActionResult;
}

/** GET /api/plugin/action: where a run the POST answered `running` for stands now. */
export async function fetchPluginActionStatus(pluginId: string, logId: string, machineId = "local"): Promise<PluginActionResult> {
  return getJson<PluginActionResult>(machinePath(machineId, `plugin/action?plugin_id=${encodeURIComponent(pluginId)}&log_id=${encodeURIComponent(logId)}`));
}

/** GET /api/pane/scroll: where the pane's viewport sits in its history (null: herdr reports none). */
export async function fetchPaneScroll(paneId: string, machineId = "local"): Promise<PaneScrollInfo | null> {
  return (await getJson<{ scroll: PaneScrollInfo | null }>(machinePath(machineId, `pane/scroll?pane_id=${encodeURIComponent(paneId)}`))).scroll;
}

/** POST /api/pane/scroll: moves the viewport; herdr redraws the attached terminal. */
export async function scrollPane(paneId: string, offsetFromBottom: number, machineId = "local"): Promise<PaneScrollInfo | null> {
  const response = await sendJson(machinePath(machineId, "pane/scroll"), "POST", { pane_id: paneId, offset_from_bottom: offsetFromBottom });
  return ((await response.json()) as { scroll: PaneScrollInfo | null }).scroll;
}

export async function findPane(request: PaneFindRequest, machineId = "local"): Promise<PaneFindResponse> {
  return (await sendJson(machinePath(machineId, "pane/find"), "POST", request)).json();
}

/** A cell in a pane's whole history: rows count from the top of the scrollback. */
export interface PaneTextPoint { row: number; col: number }

/** GET /api/pane/selection: the text between two history cells, both inclusive, wrapped lines joined. */
export async function fetchPaneSelection(paneId: string, anchor: PaneTextPoint, cursor: PaneTextPoint, machineId = "local"): Promise<string> {
  const query = new URLSearchParams({
    pane_id: paneId,
    anchor_row: String(anchor.row), anchor_col: String(anchor.col),
    cursor_row: String(cursor.row), cursor_col: String(cursor.col),
  });
  return (await getJson<{ text: string }>(machinePath(machineId, `pane/selection?${query.toString()}`))).text;
}

/**
 * POST /api/pane/close: closes the pane in herdr itself (the `pane.close` RPC).
 * The sidebar updates on its own when the server's session-changed broadcast lands;
 * a failure (e.g. the pane already gone) throws ApiError and the 5s poll reconciles.
 */
export async function closePane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/close"), "POST", { pane_id: paneId });
}

/** POST /api/pane/focus: herdr brings this pane and its tab/workspace to the front. */
export async function focusPane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/focus"), "POST", { pane_id: paneId } satisfies FocusPaneRequest);
}

/** POST /api/pane/rename: sets the pane's label in herdr (an empty label clears it). */
export async function renamePane(paneId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/rename"), "POST", { pane_id: paneId, label });
}

/** POST /api/agent/rename: the live name of the agent in the pane, what `herdr agent prompt <name>` addresses; null clears it. */
export async function renameAgent(paneId: string, name: string | null, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "agent/rename"), "POST", { pane_id: paneId, name } satisfies AgentRenameRequest);
}

/**
 * POST /api/pane/split: a new pane beside this one in herdr (its prefix+v / prefix+-), answered as
 * herdr lists it. herdr's focus stays put unless `focus` asks for the new pane, which the caller then
 * opens itself (movingHerdrFocus); the sidebar and the tab strip learn of it from the server's
 * session-changed broadcast.
 */
export async function splitPane(paneId: string, direction: SplitPaneDirection, focus = false, machineId = "local"): Promise<PaneInfo> {
  const request = sendJson(machinePath(machineId, "pane/split"), "POST", { pane_id: paneId, direction, ...(focus ? { focus: true } : {}) } satisfies SplitPaneRequest)
    .then(async (response) => ((await response.json()) as PaneSplit).pane);
  return focus ? movingHerdrFocus(machineId, request) : request;
}

/** POST /api/pane/zoom: herdr's prefix+z on that pane; `zoomed` is the tab's state after it. */
export async function zoomPane(paneId: string, mode: ZoomPaneRequest["mode"] = "toggle", machineId = "local"): Promise<PaneZoomed> {
  const response = await sendJson(machinePath(machineId, "pane/zoom"), "POST", { pane_id: paneId, mode } satisfies ZoomPaneRequest);
  return (await response.json()) as PaneZoomed;
}

/** POST /api/pane/swap: the pane and its neighbour on that side change places; `changed` false when it has none there. */
export async function swapPane(paneId: string, direction: PaneDirection, machineId = "local"): Promise<PaneSwapped> {
  const response = await sendJson(machinePath(machineId, "pane/swap"), "POST", { pane_id: paneId, direction } satisfies SwapPaneRequest);
  return (await response.json()) as PaneSwapped;
}

/** POST /api/pane/swap: an explicit same-tab swap; leave its temporary focus events to the caller. */
export async function swapPaneWith(paneId: string, targetPaneId: string, machineId = "local"): Promise<PaneSwapped> {
  const request = sendJson(machinePath(machineId, "pane/swap"), "POST", { pane_id: paneId, target_pane_id: targetPaneId } satisfies SwapPaneRequest)
    .then(async (response) => (await response.json()) as PaneSwapped);
  return movingHerdrFocus(machineId, request);
}

/** POST /api/layout/ratio: set the split identified by its binary path to the dragged ratio. */
export async function setSplitRatio(tabId: string, path: boolean[], ratio: number, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "layout/ratio"), "POST", { tab_id: tabId, path, ratio } satisfies SetSplitRatioRequest);
}

/** POST /api/pane/resize: the border the pane shares with a neighbour moves that way, by herdr's default share (0.05) of the split the border belongs to. */
export async function resizePane(paneId: string, direction: PaneDirection, machineId = "local"): Promise<PaneResized> {
  const response = await sendJson(machinePath(machineId, "pane/resize"), "POST", { pane_id: paneId, direction } satisfies ResizePaneRequest);
  return (await response.json()) as PaneResized;
}

/** POST /api/pane/clear: clears the pane's terminal screen in herdr. */
export async function clearPane(paneId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/clear"), "POST", { pane_id: paneId });
}

/** GET /api/agents: of the agent kinds herdr can start, the ones this app supports and that PC has installed, for the new-session dialog. */
export async function fetchAgentKinds(machineId = "local"): Promise<AgentKind[]> {
  // filtered here, not on the server: a remote PC's older bridge still answers every manifest,
  // and says nothing of what is installed, so its supported kinds are all offered
  return (await getJson<{ agents: AgentKind[] }>(machinePath(machineId, "agents"))).agents.filter((agent) => SUPPORTED_AGENT_KINDS.has(agent.kind) && agent.installed !== false);
}

/** GET /api/integrations: herdr's agent integrations on that PC and whether each is installed. */
export async function fetchIntegrations(machineId = "local"): Promise<IntegrationsResponse["integrations"]> {
  return (await getJson<IntegrationsResponse>(machinePath(machineId, "integrations"))).integrations;
}

/** GET /api/workspace/directories: the folders in `path` (empty: home), for the folder browser. */
export async function fetchDirectories(path: string, hidden: boolean, machineId = "local", files = false, paneId: string | null = null): Promise<DirectoryListing> {
  const query = new URLSearchParams({ path, ...(hidden ? { hidden: "1" } : {}), ...(files ? { files: "1" } : {}), ...(paneId ? { pane_id: paneId } : {}) });
  return getJson<DirectoryListing>(machinePath(machineId, `workspace/directories?${query.toString()}`));
}

/** POST /api/workspace/directories: makes the folder `name` inside `path`, for the folder browser's New folder. */
export async function createDirectory(path: string, name: string, machineId = "local"): Promise<DirectoryCreated> {
  const response = await sendJson(machinePath(machineId, "workspace/directories"), "POST", { path, name });
  return (await response.json()) as DirectoryCreated;
}

function fileQuery(path: string, paneId: string | null): string {
  return new URLSearchParams({ path, ...(paneId ? { pane_id: paneId } : {}) }).toString();
}

/**
 * GET /api/fs/stat: a file to open; `path` is absolute, `~/…` or relative to the pane's
 * folder. A bare name that several files under the folder end in answers with them.
 */
export async function fetchFileInfo(path: string, paneId: string | null, machineId = "local"): Promise<FileInfo | { candidates: string[] }> {
  const url = machinePath(machineId, `fs/stat?${fileQuery(path, paneId)}`);
  const response = await fetch(url);
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: { candidates?: unknown } } | null;
    if (Array.isArray(body?.error?.candidates)) return { candidates: body.error.candidates.map(String) };
  }
  if (!response.ok) throw await errorFrom(url, response);
  return (await response.json()) as FileInfo;
}

/** GET /api/fs/favicon: the icon the project in folder `root` keeps, or null, in one request. */
export async function fetchProjectFavicon(root: string, machineId = "local"): Promise<FileInfo | null> {
  return (await getJson<ProjectFavicon>(machinePath(machineId, `fs/favicon?${new URLSearchParams({ root }).toString()}`))).icon;
}

/** GET /api/fs/file: the file itself, streamed (ranges for media); `download` saves it instead. */
export function fileUrl(path: string, paneId: string | null, machineId = "local", download = false): string {
  return machinePath(machineId, `fs/file?${fileQuery(path, paneId)}${download ? "&download=1" : ""}`);
}

/**
 * Which repository and which two of its states: the pane's folder (or `directory`, read when the
 * pane is gone), and the working tree against the index, the index against HEAD, two commits, or
 * the working tree against the merge base of a chosen base and HEAD.
 */
export interface RepoDiffQuery {
  paneId: string | null;
  directory: string | null;
  scope: RepoDiffScope;
  /** `commit`: the list's hashes, so a file is read from the same comparison; `branch`: the base to list from */
  base: string | null;
  head: string | null;
  /** `branch` only: the identity the list answered with, which a patch is read from instead of the base's name */
  comparison: RepoBranchComparison | null;
}

function repoDiffQuery(query: RepoDiffQuery): URLSearchParams {
  const pinned = query.scope === "branch" && query.comparison !== null;
  return new URLSearchParams({
    ...(query.paneId ? { pane_id: query.paneId } : {}),
    ...(query.directory ? { directory: query.directory } : {}),
    scope: query.scope,
    ...((query.scope === "commit" || query.scope === "branch") && !pinned && query.base ? { base: query.base } : {}),
    ...(query.scope === "commit" && query.head ? { head: query.head } : {}),
    ...(pinned ? { comparison: JSON.stringify(query.comparison) } : {}),
  });
}

/** GET /api/workspace/diff/repositories: bounded repository discovery on the owning PC. */
export async function fetchRepoDiffRepositories(query: Pick<RepoDiffQuery, "paneId" | "directory">, children: boolean, depth: number, machineId = "local"): Promise<RepoDiffRepositories> {
  const params = repoDiffQuery({ ...query, scope: "workspace", base: null, head: null, comparison: null });
  params.set("children", children ? "1" : "0");
  params.set("depth", String(depth));
  return getJson<RepoDiffRepositories>(machinePath(machineId, `workspace/diff/repositories?${params.toString()}`));
}

/** GET /api/workspace/diff/refs: the repository's branches, for choosing a base; nothing is fetched. */
export async function fetchRepoDiffRefs(query: Pick<RepoDiffQuery, "paneId" | "directory">, machineId = "local"): Promise<RepoDiffRefs> {
  const params = new URLSearchParams({ ...(query.paneId ? { pane_id: query.paneId } : {}), ...(query.directory ? { directory: query.directory } : {}) });
  return getJson<RepoDiffRefs>(machinePath(machineId, `workspace/diff/refs?${params.toString()}`));
}

/** GET /api/workspace/diff/files: the files a comparison changed, with their status and counts. */
export async function fetchRepoDiffFiles(query: RepoDiffQuery, machineId = "local"): Promise<RepoDiffFileList> {
  return getJson<RepoDiffFileList>(machinePath(machineId, `workspace/diff/files?${repoDiffQuery(query).toString()}`));
}

/** GET /api/workspace/diff/file: one changed file's patch, as git prints it, or why there is none. */
export async function fetchRepoDiffFile(query: RepoDiffQuery, path: string, oldPath: string | null, machineId = "local"): Promise<RepoDiffFilePatch> {
  const params = repoDiffQuery(query);
  params.set("path", path);
  if (oldPath !== null) params.set("old_path", oldPath);
  return getJson<RepoDiffFilePatch>(machinePath(machineId, `workspace/diff/file?${params.toString()}`));
}

export type { CreateTabRequest, CreateWorkspaceRequest } from "../../shared/protocol.ts";

/**
 * POST /api/workspace/create: a new herdr workspace (and an agent started in its root
 * pane when `agent` is given). Slow when an agent starts: herdr waits for the agent's
 * interactive prompt (up to 60s) before answering.
 */
export async function createWorkspace(request: CreateWorkspaceRequest, machineId = "local"): Promise<WorkspaceCreated> {
  const response = await sendJson(machinePath(machineId, "workspace/create"), "POST", request);
  return (await response.json()) as WorkspaceCreated;
}

/** POST /api/worktree/create: a git worktree of the workspace's repository, opened as a workspace grouped with it. */
export async function createWorktree(request: CreateWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/create"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

/** GET /api/worktree/list: every checkout of the workspace's repository, with the workspace each is open in. */
export function listWorktrees(workspaceId: string, machineId = "local"): Promise<WorktreeListing> {
  return getJson<WorktreeListing>(`${machinePath(machineId, "worktree/list")}?workspace_id=${encodeURIComponent(workspaceId)}`);
}

/** POST /api/worktree/open: an existing checkout as a workspace; the one it already has when it is open. */
export async function openWorktree(request: OpenWorktreeRequest, machineId = "local"): Promise<WorktreeOpened> {
  const response = await sendJson(machinePath(machineId, "worktree/open"), "POST", request);
  return (await response.json()) as WorktreeOpened;
}

/**
 * GET /api/sessions/history: the earlier sessions of `agent` in the workspace's folder, newest first;
 * never cached. `paneId` is the pane the list was asked for from: Claude's are that pane's store's.
 */
export function fetchSessionHistory(workspaceId: string, agent: SessionHistoryAgent, machineId = "local", paneId: string | null = null): Promise<SessionHistoryResponse> {
  const query = new URLSearchParams({ workspace_id: workspaceId, agent, ...(paneId === null ? {} : { pane_id: paneId }) });
  return getJson<SessionHistoryResponse>(`${machinePath(machineId, "sessions/history")}?${query.toString()}`, { cache: "no-store" });
}
/** POST /api/sessions/resume: a Claude row's Resume, in the store it was listed from. */
export async function resumeSession(request: SessionResumeRequest, machineId = "local"): Promise<SessionResumeResponse> {
  const response = await sendJson(machinePath(machineId, "sessions/resume"), "POST", request);
  return (await response.json()) as SessionResumeResponse;
}
/**
 * Whether the PC's bridge has the session history route, asked without a query so no session is
 * listed: a bridge that has it refuses the query (400), one from before it answers not_found (404).
 * Any other refusal (403 for a device that only watches) still says the route is there; a PC that
 * could not be asked rejects, so the caller asks again when it comes back.
 */
export async function sessionHistoryOffered(machineId = "local"): Promise<boolean> {
  try { await getJson(machinePath(machineId, "sessions/history")); return true; }
  catch (error) {
    if (routeMissing(error)) return false;
    if (error instanceof ApiError && error.status < 500) return true;
    throw error;
  }
}
/** POST /api/tab/create: another tab in an existing workspace, with the same agent launch. */
export async function createTab(request: CreateTabRequest, machineId = "local"): Promise<TabCreated> {
  const response = await sendJson(machinePath(machineId, "tab/create"), "POST", request);
  return (await response.json()) as TabCreated;
}

/** POST /api/tab/rename: the tab's name in herdr; an empty one is refused. */
export async function renameTab(tabId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "tab/rename"), "POST", { tab_id: tabId, label });
}

/** Move within its workspace without changing the selected pane or tab. */
export async function moveTab(tabId: string, insertIndex: number, machineId = "local"): Promise<TabMoved> {
  const request: MoveTabRequest = { tab_id: tabId, insert_index: insertIndex };
  const response = await sendJson(machinePath(machineId, "tab/move"), "POST", request);
  return (await response.json()) as TabMoved;
}

/** A one-pane tab into a new tab of another workspace; its pane answers under its new ID. */
export async function moveTabToWorkspace(tabId: string, workspaceId: string, machineId = "local"): Promise<TabMovedToWorkspace> {
  const request: MoveTabToWorkspaceRequest = { tab_id: tabId, workspace_id: workspaceId };
  const response = await sendJson(machinePath(machineId, "tab/move-to-workspace"), "POST", request);
  return (await response.json()) as TabMovedToWorkspace;
}

/** POST /api/tab/close: the tab and every pane in it; a workspace's last tab takes the workspace with it. */
export async function closeTab(tabId: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "tab/close"), "POST", { tab_id: tabId });
}

export async function renameWorkspace(workspaceId: string, label: string, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/rename"), "POST", { workspace_id: workspaceId, label });
}

/**
 * POST /api/workspace/move: places the workspace at `insertIndex` in herdr's order (the sidebar order).
 * The receipt says which move this was in that PC's server's order (lib/workspaceOrder.ts).
 */
export async function moveWorkspace(workspaceId: string, insertIndex: number, machineId = "local"): Promise<WorkspaceMoved> {
  const response = await sendJson(machinePath(machineId, "workspace/move"), "POST", { workspace_id: workspaceId, insert_index: insertIndex });
  return (await response.json().catch(() => ({ ok: true }))) as WorkspaceMoved;
}

/** closeGroup takes the repository's open worktree workspaces with it; herdr refuses to close over them otherwise. */
export async function closeWorkspace(workspaceId: string, machineId = "local", closeGroup = false): Promise<void> {
  await sendJson(machinePath(machineId, "workspace/close"), "POST", { workspace_id: workspaceId, ...(closeGroup ? { close_group: true } : {}) });
}

/** POST /api/worktree/remove: deletes the checkout and closes its workspace; the branch stays. */
export async function removeWorktree(request: RemoveWorktreeRequest, machineId = "local"): Promise<WorktreeRemoved> {
  const response = await sendJson(machinePath(machineId, "worktree/remove"), "POST", request);
  return (await response.json()) as WorktreeRemoved;
}

/** GET /api/pane/commands: the slash commands the pane's agent understands (built-in + custom). */
export async function fetchPaneCommands(paneId: string, machineId = "local"): Promise<SlashCommand[]> {
  return (await getJson<{ commands: SlashCommand[] }>(machinePath(machineId, `pane/commands?pane_id=${encodeURIComponent(paneId)}`))).commands;
}

/**
 * GET /api/agent/commands?agent=&cwd=: the commands `agent` would offer in `cwd` before any pane runs it
 * (the new workspace and tab dialogs list its skills), read from the bridge's tables and the folder; no
 * process is started for it. A folder of null asks for the agent's own and the user's skills alone.
 */
export async function fetchAgentCommands(agent: string, cwd: string | null, machineId = "local"): Promise<SlashCommand[]> {
  const query = new URLSearchParams({ agent, ...(cwd === null || cwd.trim() === "" ? {} : { cwd }) });
  return (await getJson<{ commands: SlashCommand[] }>(`${machinePath(machineId, "agent/commands")}?${query.toString()}`)).commands;
}

/** GET /api/pane/omo-tasks: the background tasks and workflows the pane's OmO session started, and that PC's clock. */
export async function fetchPaneOmoActivity(paneId: string, machineId = "local"): Promise<{ tasks: OmoActivity["tasks"]; runs: OmoActivity["runs"]; serverTime: string | null }> {
  const activity = await getJson<Partial<OmoActivity>>(machinePath(machineId, `pane/omo-tasks?pane_id=${encodeURIComponent(paneId)}`));
  // a bridge from before workflows answers tasks only
  return { tasks: activity.tasks ?? [], runs: activity.runs ?? [], serverTime: activity.server_time ?? null };
}

/**
 * GET /api/pane/background-agent: what a running Claude Code subagent's own transcript holds now,
 * read-only and bounded (its dispatch prompt, its prose and the tools it called), for the
 * background-task list's detail sheet. The PC resolves the session and the files: the caller
 * names a pane and the agent id the list gave it, nothing else.
 */
export async function fetchPaneBackgroundAgent(paneId: string, agentId: string, machineId = "local"): Promise<PaneBackgroundAgentDetail> {
  const query = new URLSearchParams({ pane_id: paneId, agent_id: agentId });
  return await getJson<PaneBackgroundAgentDetail>(machinePath(machineId, `pane/background-agent?${query.toString()}`));
}

/** GET /api/pane/plan: the plan the pane's Claude Code or Codex session keeps, and that PC's clock. */
export async function fetchPanePlan(paneId: string, machineId = "local"): Promise<{ steps: PlanStep[] | null; serverTime: string | null }> {
  const answer = await getJson<Partial<PanePlan>>(machinePath(machineId, `pane/plan?pane_id=${encodeURIComponent(paneId)}`));
  return { steps: answer.plan?.steps ?? null, serverTime: answer.server_time ?? null };
}

/** GET /api/pane/files: paths under the pane's cwd matching `query`, for @-mentions. */
export async function fetchPaneFiles(paneId: string, query: string, limit = 20, machineId = "local"): Promise<string[]> {
  const params = new URLSearchParams({ pane_id: paneId, q: query, limit: String(limit) });
  return (await getJson<{ files: string[] }>(machinePath(machineId, `pane/files?${params.toString()}`))).files;
}

/** GET /api/pane/prompt: the agent's interactive menu currently on screen, or null. */
export async function fetchPanePrompt(paneId: string, machineId = "local"): Promise<InteractivePrompt | null> {
  return (await fetchPanePromptState(paneId, machineId)).prompt;
}

/** The waiting prompt, and with none, the next prompt the agent suggests; restored is a send the agent put back in its input box when it was cancelled; outcomes are the pane's tracked command sends (older servers send none of the three). */
export async function fetchPanePromptState(paneId: string, machineId = "local"): Promise<{ prompt: InteractivePrompt | null; suggestion: string | null; restored: string | null; outcomes: CommandOutcome[]; compacting: boolean; runtimeError: "model_capacity" | null }> {
  const body = await getJson<PanePromptResponse>(machinePath(machineId, `pane/prompt?pane_id=${encodeURIComponent(paneId)}`));
  return {
    prompt: body.prompt,
    compacting: body.compacting === true,
    runtimeError: body.runtime_error === "model_capacity" ? body.runtime_error : null,
    suggestion: typeof body.suggestion === "string" && body.suggestion !== "" ? body.suggestion : null,
    restored: typeof body.restored === "string" && body.restored !== "" ? body.restored : null,
    outcomes: Array.isArray(body.outcomes) ? body.outcomes : [],
  };
}

/** POST /api/pane/prompt/answer: ApiError 409 `prompt_changed` when the menu moved on. */
export async function answerPanePrompt(answer: PromptAnswer, machineId = "local"): Promise<void> {
  await sendJson(machinePath(machineId, "pane/prompt/answer"), "POST", answer);
}

/** GET /api/push: the server's VAPID key, the `applicationServerKey` this device subscribes with. */
export async function fetchPushKey(): Promise<string> {
  return (await getJson<PushKey>("/api/push")).public_key;
}

/** `alerts`: what this device wants to hear about; the server applies it to every alert it sends here. */
export async function registerPushSubscription(subscription: PushSubscriptionJSON, alerts?: AlertPrefs): Promise<void> {
  await sendJson("/api/push/subscribe", "POST", alerts === undefined ? { subscription } : { subscription, alerts });
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  await sendJson("/api/push/subscribe", "DELETE", { endpoint });
}

/** One confirmation push to this device only; ApiError 502 `push_failed` when the push service refused it. */
export async function sendTestPush(endpoint: string): Promise<void> {
  await sendJson("/api/push/test", "POST", { endpoint });
}

export function fetchBridgeHealth(): Promise<BridgeHealth> { return getJson("/api/health?scope=bridge"); }
export async function fetchMachines(signal?: AbortSignal): Promise<Machine[]> {
  const response = await fetch("/api/machines", { signal });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return ((await response.json()) as { machines: Machine[] }).machines;
}
/**
 * GET /api/machines?verify_source_boot: the roster, and the boot id of the server behind `machineId`
 * proved during this very request (shared/protocol.ts). Null when the server proves nothing: a
 * refusal, or an older server that ignored the query. Bounded to 20 s, and ended by `signal`.
 */
export async function verifySourceBoot(machineId: string, signal: AbortSignal): Promise<{ machines: Machine[]; boot_id: string } | null> {
  const path = `/api/machines?verify_source_boot=${encodeURIComponent(machineId)}`;
  // joined by hand: AbortSignal.any needs Safari 17.4, and without this check a PC's order never
  // leaves an old epoch after its server restarts
  const bounded = new AbortController();
  const end = () => bounded.abort();
  const timer = setTimeout(end, 20_000);
  if (signal.aborted) end();
  else signal.addEventListener("abort", end, { once: true });
  try {
    const response = await fetch(path, { signal: bounded.signal, cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as MachineRoster;
    const proof = body.verified_source_boot;
    return proof?.machine_id === machineId && typeof proof.boot_id === "string" && proof.boot_id !== "" ? { machines: body.machines, boot_id: proof.boot_id } : null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", end);
  }
}
export async function machineRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/machines${path}`, { method, headers: { "content-type": "application/json", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw await errorFrom("/api/machines", response);
  return response.json();
}
export const startMachineSetup = (request: SetupRequest) => machineRequest<SetupJob>("/setup", "POST", request);
export const fetchMachineSetup = (id: string) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`);
export const answerMachineSetup = (id: string, action: SetupAction) => machineRequest<SetupJob>(`/setup/${encodeURIComponent(id)}`, "POST", action);

/** GET /api/voice: whether the server holds a key; the key itself never comes back. */
export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  const response = await fetch("/api/voice", { cache: "no-store" });
  if (!response.ok) throw await errorFrom("/api/voice", response);
  return (await response.json()) as VoiceStatus;
}

/** PUT /api/voice/config: ApiError 409 `key_from_env` when the key comes from OVIS_OPENAI_API_KEY. */
export async function saveVoiceConfig(update: VoiceConfigUpdate): Promise<VoiceStatus> {
  const response = await fetch("/api/voice/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
  if (!response.ok) throw await errorFrom("/api/voice/config", response);
  return (await response.json()) as VoiceStatus;
}
