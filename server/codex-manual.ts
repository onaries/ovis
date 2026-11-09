import { readlinkSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { CodexManualState, CodexManualTarget } from "../shared/codex-manual.ts";
import { asCodexTitle, certainProcessCodexHome, codexOpenRollout, codexProcessesOf, codexRolloutPath, codexTranscriptPath, openCodexStore, readRange, resumedThread, sameDirectory, storedCwdCondition, titledThread } from "./codex.ts";
import { codexRestartArgs } from "./codex-restart-args.ts";
import { agentGet, herdrSocketPath, paneGet, paneProcessInfo, sameSocket, sessionSnapshot } from "./herdr/client.ts";
import { badRequest, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { processStartedAt } from "./process-start.ts";
import { listSessions } from "./session-history.ts";

export const CODEX_MANUAL_PATH = "/api/pane/codex-manual";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Live = Awaited<ReturnType<typeof inspect>>;
type Binding = { readonly live: Live; readonly sessionId: string; readonly since: number; readonly threads: readonly string[] };
const bindings = new Map<string, Binding>();
let mutations: Promise<void> = Promise.resolve();
const key = (paneId: string) => JSON.stringify([sameSocket(herdrSocketPath()), paneId]);

class ManualError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

function targetOf(value: unknown): CodexManualTarget | null {
  if (value === null || typeof value !== "object") return null;
  if (!("pane_id" in value) || typeof value.pane_id !== "string" || !value.pane_id
    || !("terminal_id" in value) || typeof value.terminal_id !== "string" || !value.terminal_id
    || !("process_id" in value) || typeof value.process_id !== "number" || !Number.isSafeInteger(value.process_id) || value.process_id <= 0
    || !("process_started_at" in value) || typeof value.process_started_at !== "number" || !Number.isFinite(value.process_started_at) || value.process_started_at <= 0) return null;
  return { pane_id: value.pane_id, terminal_id: value.terminal_id, process_id: value.process_id, process_started_at: value.process_started_at };
}

function sameTarget(a: CodexManualTarget, b: CodexManualTarget): boolean {
  return a.pane_id === b.pane_id && a.terminal_id === b.terminal_id && a.process_id === b.process_id && a.process_started_at === b.process_started_at;
}

function nativeTitle(title: string | null | undefined): string {
  return asCodexTitle(title ?? "").replace(/^(?:[\u2800-\u28ff●○◉*|/\\-]\s+)+/, "").split(" | ")
    .filter((item) => !/^(?:working|thinking|running|idle|done|ready|waiting(?: for .*)?|needs input|interrupted)$/i.test(item)).join(" | ");
}

async function inspect(paneId: string, configured?: string) {
  const socketKey = key(paneId);
  const [pane, info] = await Promise.all([paneGet(paneId), paneProcessInfo(paneId)]);
  const candidates = (await codexProcessesOf(paneId, info ?? null)).list.filter(({ argv = [] }) => codexRestartArgs(argv, "manual-display") !== null);
  const chosen = candidates.length === 1 ? candidates[0] : undefined;
  const birth = chosen === undefined ? null : processStartedAt(chosen.pid);
  if (chosen === undefined || birth === null || !pane.terminal_id) throw new ManualError("codex_manual_identity_unknown", "The live Codex process could not be identified.");
  const [namedHome, agent] = await Promise.all([certainProcessCodexHome(chosen.pid, chosen.argv ?? []), agentGet(paneId)]);
  const home = namedHome === null ? null : realpathSync(namedHome);
  const namedCwd = pane.foreground_cwd ?? pane.cwd;
  const cwd = namedCwd && isAbsolute(namedCwd) ? realpathSync(namedCwd) : null;
  const actualCwd = process.platform === "linux" ? readlinkSync(`/proc/${chosen.pid}/cwd`)
    : info?.foreground_processes?.find((entry) => entry.pid === chosen.pid)?.cwd;
  if (home === null || !isAbsolute(home) || !cwd || !isAbsolute(cwd) || !actualCwd || !sameDirectory(cwd, actualCwd)
    || (configured !== undefined && !sameDirectory(home, realpathSync(configured)))) throw new ManualError("codex_manual_store_unknown", "The Codex store or working directory could not be verified.");
  if (processStartedAt(chosen.pid) !== birth || socketKey !== key(paneId)) throw new ManualError("codex_manual_stale", "The Codex process changed. Open the conversation picker again.");
  const target: CodexManualTarget = { pane_id: paneId, terminal_id: pane.terminal_id, process_id: chosen.pid, process_started_at: birth };
  const report = agent.agent_session?.agent === "codex" ? agent.agent_session : null;
  return { target, home, cwd, socketKey, title: nativeTitle(agent.terminal_title_stripped ?? agent.terminal_title),
    report: report === null ? "" : JSON.stringify([report.kind, report.value]), reported: report, argv: chosen.argv ?? [] };
}

function headerId(path: string, home: string): string | null {
  const checked = codexRolloutPath(path, home);
  if (checked === null) return null;
  const header: unknown = JSON.parse(readRange(checked, 0, 256 * 1024).split("\n")[0] ?? "");
  if (header === null || typeof header !== "object" || !("payload" in header)) return null;
  const payload = header.payload;
  return payload !== null && typeof payload === "object" && "id" in payload && typeof payload.id === "string" && UUID.test(payload.id) ? payload.id.toLowerCase() : null;
}

function storeProof(live: Live, sessionId: string, since: number) {
  const opened = openCodexStore(live.home);
  try {
    const rows = opened.db.query<{ id: string; rollout_path: string; cwd: string; archived: number; agent_role: string | null; source?: string }, [string]>(
      "SELECT id, rollout_path, cwd, archived, agent_role, source FROM threads WHERE id = ? COLLATE NOCASE LIMIT 2",
    ).all(sessionId);
    const row = rows.length === 1 ? rows[0] : undefined;
    const path = row === undefined ? null : codexRolloutPath(row.rollout_path, live.home);
    if (row === undefined || row.archived !== 0 || row.agent_role != null || (row.source !== undefined && !["cli", "vscode"].includes(row.source))
      || !sameDirectory(row.cwd, live.cwd) || path === null || headerId(path, live.home) !== sessionId) throw new ManualError("codex_manual_invalid_session", "This ID does not identify an interactive conversation in this Codex store and folder.", 400);
    const { where, params } = storedCwdCondition(live.cwd);
    const threads = opened.db.query<{ id: string; source?: string }, (string | number)[]>(
      `SELECT id, source FROM threads WHERE ${where} AND archived = 0 AND agent_role IS NULL AND source IN ('cli', 'vscode') AND created_at >= ? LIMIT 65`,
    ).all(...params, since).map((item) => item.id.toLowerCase());
    if (threads.length > 64) throw new ManualError("codex_manual_busy", "Too many recent conversations to verify this connection. Try again after activity settles.");
    opened.settled();
    return { path, threads };
  } finally { opened.db.close(); }
}

function reportedId(live: Live): string | null {
  const report = live.reported;
  if (report?.kind === "id" && UUID.test(report.value)) return report.value.toLowerCase();
  return report?.kind === "path" ? headerId(report.value, live.home) : null;
}

async function nativeId(live: Live): Promise<string | null> {
  const path = await codexOpenRollout(live.target.pane_id, live.cwd, live.home)
    ?? await codexTranscriptPath(live.target.pane_id, live.cwd, live.home, undefined, false, false, undefined, false);
  return path === null ? null : headerId(path, live.home);
}

async function validBinding(live: Live): Promise<{ path: string; sessionId: string } | null> {
  const binding = bindings.get(live.socketKey);
  if (binding === undefined) return null;
  try {
    const old = binding.live;
    const titleId = titledThread(live.title);
    if (!sameTarget(old.target, live.target) || !sameDirectory(old.home, live.home) || !sameDirectory(old.cwd, live.cwd)
      || (live.title !== old.title && (titleId === null || !binding.sessionId.startsWith(titleId)))
      || (live.report !== old.report && reportedId(live) !== binding.sessionId)) throw new ManualError("codex_manual_stale", "The native conversation changed.");
    const proof = storeProof(live, binding.sessionId, binding.since);
    if (proof.threads.some((id) => id !== binding.sessionId && !binding.threads.includes(id))) throw new ManualError("codex_manual_stale", "A new conversation may have started.");
    const native = await nativeId(live);
    if (native !== null && native !== binding.sessionId) throw new ManualError("codex_manual_stale", "Automatic detection identified another conversation.");
    const current = await inspect(live.target.pane_id, live.home);
    if (!sameTarget(live.target, current.target) || current.title !== live.title || current.report !== live.report || !sameDirectory(current.cwd, live.cwd)) throw new ManualError("codex_manual_stale", "The pane changed while its conversation was checked.");
    return bindings.get(live.socketKey) === binding ? { path: proof.path, sessionId: binding.sessionId } : null;
  } catch {
    if (bindings.get(live.socketKey) === binding) bindings.delete(live.socketKey);
    return null;
  }
}

async function claimedElsewhere(live: Live, sessionId: string): Promise<boolean> {
  const snapshot = await sessionSnapshot();
  for (const pane of snapshot.panes) {
    if (pane.pane_id === live.target.pane_id) continue;
    let peer: Live;
    try { peer = await inspect(pane.pane_id); }
    catch (error) { if (error instanceof ManualError && error.code === "codex_manual_identity_unknown") continue; throw error; }
    if (!sameDirectory(peer.home, live.home)) continue;
    const peerPath = await codexOpenRollout(peer.target.pane_id, peer.cwd, peer.home);
    if (resumedThread([peer.argv])?.toLowerCase() === sessionId || reportedId(peer) === sessionId
      || titledThread(peer.title) === sessionId || (await validBinding(peer))?.sessionId === sessionId
      || (peerPath !== null && headerId(peerPath, peer.home) === sessionId)) return true;
  }
  return false;
}

export async function manualCodexTranscript(paneId: string, home: string): Promise<{ path: string; sessionId: string } | null> {
  const socketKey = key(paneId);
  if (!bindings.has(socketKey)) return null;
  try {
    const live = await inspect(paneId, home);
    if (live.socketKey !== socketKey) return null;
    const binding = bindings.get(socketKey);
    if (binding !== undefined && await claimedElsewhere(live, binding.sessionId)) {
      if (bindings.get(socketKey) === binding) bindings.delete(socketKey);
      return null;
    }
    return await validBinding(live);
  } catch {
    bindings.delete(socketKey);
    return null;
  }
}

function sessionLabels(live: Live, sessions: CodexManualState["sessions"]): CodexManualState["sessions"] {
  if (sessions.length === 0) return sessions;
  try {
    const opened = openCodexStore(live.home);
    try {
      const columns = new Set(opened.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('threads')").all().map((column) => column.name));
      const title = columns.has("title") ? "substr(nullif(trim(title), ''), 1, 200)" : "NULL";
      const first = columns.has("first_user_message") ? "substr(nullif(trim(first_user_message), ''), 1, 400)" : "NULL";
      const folder = storedCwdCondition(live.cwd);
      const found = opened.db.query<{ id: string; title: string | null; firstMessage: string | null }, string[]>(
        `SELECT id, ${title} AS title, ${first} AS firstMessage FROM threads WHERE (${folder.where}) AND id IN (${sessions.map(() => "?").join(", ")})`,
      ).all(...folder.params, ...sessions.map((session) => session.id));
      opened.settled();
      const labels = new Map(found.map((row) => [row.id, row]));
      return sessions.map((session) => ({ ...session, title: labels.get(session.id)?.title ?? session.title,
        firstMessage: session.firstMessage ?? labels.get(session.id)?.firstMessage ?? null }));
    } finally { opened.db.close(); }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return sessions;
  }
}

async function state(live: Live): Promise<CodexManualState> {
  const selected = await manualCodexTranscript(live.target.pane_id, live.home);
  const sessions = sessionLabels(live, listSessions("codex", live.cwd, { codexHome: live.home }));
  const current = await inspect(live.target.pane_id, live.home);
  if (!sameTarget(live.target, current.target) || !sameDirectory(live.cwd, current.cwd) || live.title !== current.title || live.report !== current.report) throw new ManualError("codex_manual_stale", "The pane changed while its conversations were listed.");
  return { target: live.target, cwd: live.cwd, session_id: selected?.sessionId ?? null, sessions };
}

export async function handleCodexManualRequest(request: Request, url: URL, options: { readOnly: boolean; codexHome?: string; changed?: (paneId: string) => void }): Promise<Response> {
  setRequestRoute(CODEX_MANUAL_PATH);
  if (options.readOnly) return jsonResponse({ error: { code: "read_only", message: "Watch access cannot list or connect conversations." } }, 403);
  try {
    if (request.method === "GET") {
      const paneId = url.searchParams.get("pane_id");
      if (!paneId) return badRequest("missing_pane_id", "pane_id is required");
      return jsonResponse(await state(await inspect(paneId, options.codexHome)), 200, { "cache-control": "no-store" });
    }
    if (request.method !== "POST" && request.method !== "DELETE") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET, POST or DELETE." } }, 405);
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const target = targetOf(body.target);
    if (target === null) return badRequest("invalid_manual_target", "Confirm the live Codex process before connecting a conversation.");
    const id = body.session_id;
    if (request.method === "POST" && (typeof id !== "string" || !UUID.test(id))) return badRequest("invalid_session_id", "A full conversation UUID is required.");
    const sessionId = typeof id === "string" ? id.toLowerCase() : "";
    const pending = mutations.then(async () => {
      const live = await inspect(target.pane_id, options.codexHome);
      if (!sameTarget(target, live.target)) throw new ManualError("codex_manual_stale", "The pane or Codex process changed. Open the conversation picker again.");
      if (request.method === "POST") {
        const since = Math.floor(Date.now() / 1000) - 1;
        const proof = storeProof(live, sessionId, since);
        const native = await nativeId(live);
        if (native !== null && native !== sessionId) throw new ManualError("codex_manual_native_conflict", "Automatic detection already identifies another conversation.");
        if (await claimedElsewhere(live, sessionId)) throw new ManualError("codex_manual_session_in_use", "Another pane is using this conversation.");
        const current = await inspect(target.pane_id, live.home);
        if (!sameTarget(target, current.target) || live.title !== current.title || live.report !== current.report || !sameDirectory(live.cwd, current.cwd)
          || key(target.pane_id) !== live.socketKey) throw new ManualError("codex_manual_stale", "The pane changed while its conversation was checked.");
        const finalProof = storeProof(current, sessionId, since);
        if (finalProof.threads.some((thread) => thread !== sessionId && !proof.threads.includes(thread))) throw new ManualError("codex_manual_stale", "A new conversation may have started.");
        bindings.delete(live.socketKey);
        if (bindings.size >= 64) {
          const oldest = bindings.keys().next().value;
          if (oldest !== undefined) bindings.delete(oldest);
        }
        bindings.set(live.socketKey, { live: current, sessionId, since, threads: proof.threads });
      } else bindings.delete(live.socketKey);
      options.changed?.(target.pane_id);
      return jsonResponse(await state(live), 200, { "cache-control": "no-store" });
    });
    mutations = pending.then(() => {}, () => {});
    return await pending;
  } catch (error) {
    if (error instanceof ManualError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return jsonResponse({ error: { code: "codex_manual_unavailable", message: "The live Codex conversation could not be verified. Open the picker again." } }, 409);
  }
}
