import { basename, isAbsolute } from "node:path";
import { accessSync, constants, readFileSync, readlinkSync, statSync } from "node:fs";
import type { CodexRestartResponse, CodexRestartTarget } from "../shared/codex-restart.ts";
import { shellCommandLine } from "./shell-agent.ts";
import { certainProcessCodexHome, codexProcessesOf, codexTranscriptPath, paneCodexHomePlaced, readRange, sameDirectory } from "./codex.ts";
import { codexQueuedMessagePreviews, queuedQuestionCount } from "./codex-queue.ts";
import { codexRestartArgs } from "./codex-restart-args.ts";
import { codexSteeringPending } from "./codex-steering.ts";
import { agentProcesses } from "./conversation.ts";
import { agentGet, HerdrError, paneGet, paneProcessInfo, paneRead, paneSendText, sessionSnapshot } from "./herdr/client.ts";
import { processAlive, processStartedAt } from "./process-start.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";

export const CODEX_RESTART_PATH = "/api/pane/codex-restart";
const running = new Set<string>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function plainShell(pid: number): boolean {
  const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  return /(?:^|\/)\-?(?:bash|zsh|dash|sh|fish)$/.test(argv[0] ?? "")
    && argv.slice(1).every((arg) => /^-(?:[il]+|-login|-noprofile|-norc|-no-config)$/.test(arg));
}

function idleShell(pid: number, birth: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return processStartedAt(pid) === birth && fields[2] === fields[5]
      && plainShell(pid);
  } catch { return false; }
}

class RestartError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

function sessionId(path: string): string {
  const record: unknown = JSON.parse(readRange(path, 0, 64 * 1024).split("\n")[0] ?? "");
  if (record !== null && typeof record === "object" && "payload" in record) {
    const payload = record.payload;
    if (payload !== null && typeof payload === "object" && "id" in payload && typeof payload.id === "string" && UUID.test(payload.id)) return payload.id;
  }
  throw new RestartError("codex_session_unknown", "The current Codex conversation could not be identified. Open Terminal and check it before restarting.");
}

/** All ownership and launch checks finish before the first signal. */
async function inspect(paneId: string, configured?: string) {
  if (process.platform !== "linux") throw new RestartError("codex_restart_unsupported", "Restart Codex currently requires a Linux pane. Resume this session in Terminal.");
  const snapshot = await sessionSnapshot();
  const pane = snapshot.panes.find((item) => item.pane_id === paneId);
  if (!pane || (pane.agent ?? pane.agent_session?.agent) !== "codex") throw new RestartError("codex_not_running", "This pane is not running Codex.");
  const info = await paneProcessInfo(paneId);
  const candidates = (await codexProcessesOf(paneId)).list.filter((entry) => codexRestartArgs(entry.argv ?? [], "session") !== null);
  const chosen = agentProcesses(candidates, "codex")[0] ?? candidates.at(-1);
  const birth = chosen ? processStartedAt(chosen.pid) : null;
  const shellBirth = info?.shell_pid ? processStartedAt(info.shell_pid) : null;
  if (!chosen || birth === null || shellBirth === null || !info?.shell_pid || info.shell_pid === chosen.pid) throw new RestartError("codex_restart_unsupported", "This Codex process cannot be safely restarted in the same pane.");
  if (!plainShell(info.shell_pid)) throw new RestartError("codex_restart_unsupported", "This pane does not have a supported interactive shell. Resume Codex in Terminal.");
  const home = await certainProcessCodexHome(chosen.pid, chosen.argv ?? []);
  const shellHome = await certainProcessCodexHome(info.shell_pid, []);
  if (home === null || shellHome === null || !sameDirectory(home, shellHome) || (configured !== undefined && !sameDirectory(home, configured))) {
    throw new RestartError("codex_restart_unsupported", "The pane's shell cannot reopen the same Codex store. Restart this session in Terminal.");
  }
  const cwd = pane.foreground_cwd ?? pane.cwd;
  const path = cwd ? await codexTranscriptPath(paneId, cwd, home, snapshot.panes) : null;
  if (path === null) throw new RestartError("codex_session_unknown", "The current Codex conversation could not be identified. Open Terminal and check it before restarting.");
  const id = sessionId(path);
  const screen = await paneRead({ paneId, source: "recent", lines: 100, stripAnsi: true });
  if (codexSteeringPending(screen.text) || codexQueuedMessagePreviews(screen.text).length > 0 || queuedQuestionCount(screen.text) > 0) throw new RestartError("codex_queue_present", "Codex has queued messages or questions. Send or remove them before restarting.");
  for (const peer of snapshot.panes.filter((item) => item.pane_id !== paneId && item.agent === "codex")) {
    const peerCwd = peer.foreground_cwd ?? peer.cwd;
    if (!peerCwd) continue;
    const peerHome = await paneCodexHomePlaced(peer.pane_id);
    if (!peerHome.placed || !sameDirectory(peerHome.home, home)) continue;
    const peerPath = await codexTranscriptPath(peer.pane_id, peerCwd, home, snapshot.panes);
    if (peerPath !== null && (peerPath === path || basename(peerPath).includes(id))) throw new RestartError("codex_session_in_use", "Another pane is using this Codex conversation. Close that client before restarting.");
  }
  const args = codexRestartArgs(chosen.argv ?? [], id);
  if (args === null) throw new RestartError("codex_restart_unsupported", "This Codex launch command cannot be resumed safely.");
  let executable = readlinkSync(`/proc/${chosen.pid}/exe`);
  try { accessSync(executable, constants.X_OK); }
  catch {
    const installed = chosen.argv?.[0];
    const unavailable = () => new RestartError("codex_restart_unsupported", "The Codex executable was removed and no installed replacement is available. Reinstall Codex before restarting this session.");
    if (!executable.endsWith(" (deleted)") || !installed || !isAbsolute(installed)) throw unavailable();
    try {
      if (!statSync(installed).isFile()) throw unavailable();
      accessSync(installed, constants.X_OK);
    } catch { throw unavailable(); }
    executable = installed;
  }
  accessSync("/usr/bin/env", constants.X_OK);
  const script = /(?:^|\/)(?:node|bun|sh|bash|dash|zsh)$/.test(chosen.argv?.[0] ?? "") ? chosen.argv?.[1] : undefined;
  if (script !== undefined && !script.startsWith("/")) throw new RestartError("codex_restart_unsupported", "This Codex script has no certain absolute path. Resume it in Terminal.");
  const command = shellCommandLine("posix", "/usr/bin/env", [`CODEX_HOME=${home}`, executable, ...(script ? [script] : []), ...args]);
  // Fish reads backslashes inside single quotes differently; native agent.start refuses them too.
  if (/fish$/.test(readFileSync(`/proc/${info.shell_pid}/cmdline`, "utf8").split("\0")[0] ?? "") && command.includes("\\")) throw new RestartError("codex_restart_unsupported", "This launch needs quoting that fish cannot safely preserve. Resume Codex in Terminal.");
  if (/[\u0000-\u001f\u007f]/.test(command)) throw new RestartError("codex_restart_unsupported", "This Codex launch contains an unsupported control character.");
  const target: CodexRestartTarget = { pane_id: paneId, terminal_id: pane.terminal_id, process_id: chosen.pid, process_started_at: birth, session_id: id };
  return { target, command, home, shell: { pid: info.shell_pid, birth: shellBirth } };
}

async function restart(expected: CodexRestartTarget, configured?: string): Promise<CodexRestartResponse> {
  if (running.has(expected.pane_id)) throw new RestartError("codex_restart_in_progress", "Codex is already being restarted in this pane.");
  running.add(expected.pane_id);
  try {
    const current = await inspect(expected.pane_id, configured);
    if (Object.keys(current.target).some((key) => Reflect.get(current.target, key) !== Reflect.get(expected, key))) throw new RestartError("codex_restart_stale", "The pane or conversation changed. Cancel and open Restart Codex again.");
    const live = await paneGet(expected.pane_id);
    const liveCwd = live.foreground_cwd ?? live.cwd;
    const livePath = liveCwd ? await codexTranscriptPath(expected.pane_id, liveCwd, current.home, undefined, false, false, undefined, false) : null;
    if (live.terminal_id !== expected.terminal_id || livePath === null || sessionId(livePath) !== expected.session_id) throw new RestartError("codex_restart_stale", "The conversation changed before Codex could be restarted.");
    if (processStartedAt(expected.process_id) !== expected.process_started_at) throw new RestartError("codex_restart_stale", "The Codex process changed before it could be restarted.");
    process.kill(expected.process_id, "SIGTERM");
    const deadline = Date.now() + 10_000;
    while (processStartedAt(expected.process_id) === expected.process_started_at && processAlive(expected.process_id)) {
      if (Date.now() >= deadline) throw new RestartError("codex_stop_pending", "Codex has not exited yet. Check Terminal before trying again.");
      await Bun.sleep(100);
    }
    let pane = await paneGet(expected.pane_id);
    for (;;) {
      const foreground = await paneProcessInfo(expected.pane_id);
      if (pane.terminal_id !== expected.terminal_id || foreground?.shell_pid !== current.shell.pid) throw new RestartError("codex_restart_stale", "The terminal changed while Codex was stopping. No new command was sent.");
      if (foreground.foreground_process_group_id === current.shell.pid && (await codexProcessesOf(expected.pane_id)).list.length === 0) break;
      if (Date.now() >= deadline) throw new RestartError("codex_stop_pending", "The pane has not returned to its shell. Check Terminal before trying again.");
      await Bun.sleep(100);
      pane = await paneGet(expected.pane_id);
    }
    await paneSendText(expected.pane_id, `\u0005\u0015${current.command}\r`, undefined, () => idleShell(current.shell.pid, current.shell.birth));
    for (const readyBy = Date.now() + 10_000;;) {
      try {
        const agent = await agentGet(expected.pane_id);
        const clients = (await codexProcessesOf(expected.pane_id)).list;
        const resumed = pane.cwd ? await codexTranscriptPath(expected.pane_id, pane.foreground_cwd ?? pane.cwd, current.home) : null;
        if (agent.agent === "codex" && clients.some((client) => client.pid !== expected.process_id && codexRestartArgs(client.argv ?? [], expected.session_id) !== null)
          && resumed !== null && sessionId(resumed) === expected.session_id) return { pane_id: expected.pane_id, session_id: expected.session_id };
      } catch (error) {
        if (!(error instanceof HerdrError) || error.code !== "agent_not_found") throw error;
      }
      if (Date.now() >= readyBy) throw new RestartError("codex_resume_failed", "The restarted Codex could not be verified. Check Terminal.", 502);
      await Bun.sleep(100);
    }
  } finally { running.delete(expected.pane_id); }
}

export async function handleCodexRestartRequest(request: Request, url: URL, configured?: string): Promise<Response> {
  setRequestRoute(CODEX_RESTART_PATH);
  try {
    if (request.method === "GET") {
      const pane = url.searchParams.get("pane_id");
      if (!pane) return badRequest("missing_pane_id", "pane_id is required");
      return jsonResponse((await inspect(pane, configured)).target, 200, { "cache-control": "no-store" });
    }
    if (request.method !== "POST") return badRequest("method_not_allowed", "use GET or POST");
    const body = await readJsonObject<Partial<CodexRestartTarget>>(request);
    if (body instanceof Response) return body;
    if (typeof body.pane_id !== "string" || !body.pane_id || typeof body.terminal_id !== "string" || !body.terminal_id
      || typeof body.session_id !== "string" || !UUID.test(body.session_id) || typeof body.process_id !== "number" || !Number.isSafeInteger(body.process_id) || body.process_id <= 0
      || typeof body.process_started_at !== "number" || !Number.isFinite(body.process_started_at) || body.process_started_at <= 0) return badRequest("invalid_restart_target", "Confirm the current Codex session before restarting it");
    return jsonResponse(await restart({ pane_id: body.pane_id, terminal_id: body.terminal_id, session_id: body.session_id, process_id: body.process_id, process_started_at: body.process_started_at }, configured));
  } catch (error) {
    if (error instanceof RestartError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
