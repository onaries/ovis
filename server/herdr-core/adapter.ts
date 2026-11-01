import { existsSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import type { Socket } from "bun";
import { AGENT_LABELS } from "../agents-routes.ts";
import { LINE_BYTES, makeLineReader } from "../herdr/client.ts";
import { SHELL_AGENTS, shellCommandLine } from "../shell-agent.ts";
import { type HcConnection, HcError } from "./connection.ts";
import { agentInfoOf, agentStatusOf, buildSnapshot, type HcTerminal, hcKeyName, HERDR_PROTOCOL, isRecord, keyBytes, LAYOUT_DOC, OTHER_WORKSPACE_ID, processInfoOf, SPACE_LABEL, TAB_LABEL, TAB_NAME_LABEL, WORKSPACE_NAME_LABEL } from "./snapshot.ts";
import type { SessionSnapshot } from "../../shared/herdr-api.generated.ts";

/**
 * herdr's socket API, answered from herdr-core. The server talks to herdr through one client
 * (server/herdr/client.ts) whose callers read herdr's session snapshot, panes, screens and status
 * events; this adapter listens where that client connects (HERDR_SOCKET) and answers the methods a
 * terminal view needs from hc, so none of those callers learns a second runtime:
 *
 * - `ping`, `session.snapshot`, `pane.get`, `agent.get`, `pane.process_info` and `pane.read` from
 *   hc's terminal records, the app's layout document and `terminal.read`;
 * - `pane.send_text` as bytes typed into the terminal, over a short attach stream at the
 *   terminal's own grid (hc has no other way to type raw bytes, and a viewer at the current size
 *   resizes nothing);
 * - `pane.send_keys` as those keys' bytes in the same way, or hc's `terminal.keys` for a key that
 *   only hc can encode for the program's keyboard mode;
 * - `agent.prompt` as hc's `terminal.send` (paste and Enter, refused while the program is blocked);
 * - `events.subscribe` from hc's own event stream: status changes per pane, and terminal and layout
 *   changes as herdr's lifecycle events.
 *
 * Everything else (workspaces, tabs, splits, focus, worktrees, plugins) belongs to the Herdr app's
 * window and is refused as `unsupported`. The live terminal itself is `hc attach`, which the server
 * runs in place of `herdr terminal attach` (server/core/terminal-process.ts).
 *
 * As herdr does, each request has a connection of its own that ends with its answer; only an
 * events subscription stays open.
 */

interface Request { id: string; method: string; params: Record<string, unknown> }
type Reply = { result: unknown } | { error: { code: string; message: string } };

class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Ovis's subscription types that are status, not structure. */
const STATUS_EVENT = "pane.agent_status_changed";
const NOT_STRUCTURE = new Set([STATUS_EVENT, "pane.focused", "pane.output_matched"]);
/** A status or layout notification must fit in 4 MiB, even across hc frames. */
const EVENT_LINE_BYTES = 4 * 1024 * 1024;

interface ConnectionState {
  read: (chunk: Uint8Array) => void;
  /** bytes the kernel did not take yet */
  queue: Uint8Array[];
  /** end once the queue is out */
  ending: boolean;
  /** an events subscription this connection holds on hc */
  unsubscribe: (() => void) | null;
  closed: boolean;
}

export interface HerdrCoreAdapter {
  /** where it listens: the server's HERDR_SOCKET */
  socketPath: string;
  stop: () => void;
}

export async function startHerdrCoreAdapter(hc: HcConnection, socketPath: string): Promise<HerdrCoreAdapter> {
  if (existsSync(socketPath)) {
    const live = await new Promise<boolean>((resolve, reject) => {
      const probe = createConnection(socketPath);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
        else reject(error);
      });
    });
    if (live) throw new Error("Another Ovis owns this state directory: the herdr-core socket is still listening");
    rmSync(socketPath, { force: true });
  }
  const answers = createAnswers(hc);
  const listener = Bun.listen<ConnectionState>({
    unix: socketPath,
    socket: {
      open(socket) {
        let first = true;
        socket.data = {
          queue: [],
          ending: false,
          unsubscribe: null,
          closed: false,
          read: makeLineReader(LINE_BYTES, (line) => {
            // one request per connection, as herdr reads it
            if (!first) return;
            first = false;
            const request = parseRequest(line);
            if (!request) { send(socket, `${JSON.stringify({ id: "", error: { code: "bad_frame", message: "not a herdr request" } })}\n`, true); return; }
            if (request.method === "events.subscribe") { void subscribe(hc, socket, request); return; }
            void answers(request).then((reply) => send(socket, `${JSON.stringify({ id: request.id, ...reply })}\n`, true));
          }, () => socket.end()),
        };
      },
      data(socket, chunk) {
        socket.data.read(chunk);
      },
      drain(socket) {
        flush(socket);
      },
      close(socket) {
        socket.data.closed = true;
        socket.data.unsubscribe?.();
      },
      error(socket) {
        socket.data.closed = true;
        socket.data.unsubscribe?.();
      },
    },
  });
  return {
    socketPath,
    stop: () => {
      listener.stop(true);
      rmSync(socketPath, { force: true });
    },
  };
}

function parseRequest(line: string): Request | null {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(frame) || typeof frame["id"] !== "string" || typeof frame["method"] !== "string") return null;
  return { id: frame["id"], method: frame["method"], params: isRecord(frame["params"]) ? frame["params"] : {} };
}

function send(socket: Socket<ConnectionState>, text: string, end = false): void {
  const state = socket.data;
  if (state.closed) return;
  state.queue.push(new TextEncoder().encode(text));
  if (end) state.ending = true;
  flush(socket);
}

function flush(socket: Socket<ConnectionState>): void {
  const state = socket.data;
  while (state.queue.length > 0) {
    const next = state.queue[0]!;
    const written = socket.write(next);
    if (written < next.length) {
      state.queue[0] = next.subarray(Math.max(0, written));
      return;
    }
    state.queue.shift();
  }
  if (state.ending) socket.end();
}

/** An agent whose command is not its kind, as the Herdr app runs it (herdr-app defaults/programs.json): the Cursor IDE is `cursor`. */
const AGENT_COMMANDS: Readonly<Record<string, string>> = { cursor: "cursor-agent" };

/**
 * A shell the start line is typed into, as hc reports a terminal started with no program
 * (`/bin/bash`, a login `-zsh`): the POSIX ones, and fish, which reads the same quoting for an
 * agent's name and plain arguments (nu does not).
 */
const SHELL = /(?:^|\/)-?(?:sh|bash|dash|zsh|ksh|mksh|ash|fish)$/u;
/** The flags a plain interactive shell may be started with; anything else (`-c`) runs a program in it. */
const SHELL_FLAGS = new Set(["-l", "--login", "-i"]);
const plainShell = (argv: readonly string[]): boolean => SHELL.test(argv[0] ?? "") && argv.slice(1).every((arg) => SHELL_FLAGS.has(arg));

/** How long a typed agent start may take to show in front of its shell. */
const AGENT_START_MS = 10_000;

function paneIdOf(params: Record<string, unknown>, field = "pane_id"): string {
  const value = params[field];
  if (typeof value !== "string" || value === "") throw new AdapterError("invalid_params", `${field} is required`);
  return value;
}

/** hc's refusal in herdr's words, where the server acts on them. */
function herdrCode(error: HcError, missing: string): string {
  switch (error.kind) {
    case "not_found": return missing;
    case "blocked": return "agent_blocked";
    case "unavailable": return "server_unavailable";
    case "timeout": return "timeout";
    // the line to hc ended or never spoke its protocol: hc cannot be reached, as a herdr socket nobody answers
    case "closed":
    case "bad_hello":
    case "bad_frame":
      return "connect_failed";
    default: return error.kind;
  }
}

function createAnswers(hc: HcConnection): (request: Request) => Promise<Reply> {
  const terminal = async (address: string, missing = "pane_not_found"): Promise<HcTerminal> => {
    const record = await hc.call<{ terminal: HcTerminal } | HcTerminal>("terminal.get", { terminal: address }).catch((error: unknown) => {
      throw error instanceof HcError ? new AdapterError(herdrCode(error, missing), error.message) : error;
    });
    const found = "terminal" in record ? record.terminal : record;
    if (found.state !== "live") throw new AdapterError(missing, `terminal ${address} has finished`);
    return found;
  };

  const snapshot = async (): Promise<SessionSnapshot> => {
    const [list, doc, hello] = await Promise.all([
      hc.call<{ terminals: HcTerminal[] }>("terminal.list", {}),
      hc.call<{ value: unknown }>("doc.get", { name: LAYOUT_DOC }),
      hc.hello(),
    ]);
    return buildSnapshot(list.terminals, doc.value, hello.version);
  };

  const paneOf = async (paneId: string, missing = "pane_not_found") => {
    const found = (await snapshot()).panes.find((pane) => pane.pane_id === paneId);
    if (!found) throw new AdapterError(missing, `pane ${paneId} not found`);
    return found;
  };

  /**
   * Bytes typed into the terminal, as a person at it would: over an attach at the grid hc says the
   * terminal has (a viewer that typed sets the size, so it must set this one), answered once hc
   * took the close that follows them, so what the caller does next comes after the bytes.
   */
  const type = async (paneId: string, bytes: string): Promise<void> => {
    const record = await terminal(paneId);
    const { result, channel } = await hc.open<{ channel: number; terminal?: HcTerminal }>("terminal.attach", { terminal: paneId, cols: record.cols, rows: record.rows }, { onData: () => {}, onClose: () => {} });
    // resized since it was looked up: type at the size it has now
    const now = result.terminal;
    if (now && (now.cols !== record.cols || now.rows !== record.rows)) channel.resize(now.cols, now.rows);
    channel.write(bytes);
    await channel.close();
  };

  /** Input to one pane in the order it was asked for: each attach and its bytes finish before the next. */
  const turns = new Map<string, Promise<unknown>>();
  const inTurn = <T>(paneId: string, work: () => Promise<T>): Promise<T> => {
    const run = (turns.get(paneId) ?? Promise.resolve()).then(work, work);
    const settled = run.then(() => {}, () => {});
    turns.set(paneId, settled);
    void settled.then(() => { if (turns.get(paneId) === settled) turns.delete(paneId); });
    return run;
  };

  /**
   * A shell hc keeps (a lost program comes back as a shell), labeled `labels`, answered as herdr
   * answers a new one: the workspace, tab and pane it shows as in the snapshot right after.
   */
  const startShell = async (params: Record<string, unknown>, labels: Record<string, string>) => {
    const env = isRecord(params["env"]) ? Object.fromEntries(Object.entries(params["env"]).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : undefined;
    const record = await hc.call<HcTerminal>("terminal.run", { keep: true, labels, ...(typeof params["cwd"] === "string" ? { cwd: params["cwd"] } : {}), ...(env ? { env } : {}) });
    const shown = await snapshot();
    const root_pane = shown.panes.find((pane) => pane.pane_id === record.address);
    const tab = root_pane && shown.tabs.find((candidate) => candidate.tab_id === root_pane.tab_id);
    const workspace = root_pane && shown.workspaces.find((candidate) => candidate.workspace_id === root_pane.workspace_id);
    if (!root_pane || !tab || !workspace) throw new AdapterError("internal", `hc started ${record.address}, but it is not in the snapshot`);
    return { workspace, tab, root_pane };
  };

  /**
   * Ends each terminal and removes its record, as closing a herdr pane does: all at once (a program
   * can take seconds to end), every one tried before the first failure is answered.
   */
  const end = async (addresses: string[]): Promise<void> => {
    const ended = await Promise.allSettled(addresses.map(async (address) => {
      await hc.call("terminal.kill", { terminal: address });
      await hc.call("terminal.rm", { terminal: address });
    }));
    const failed = ended.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failed) throw failed.reason;
  };

  const methods: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {
    async ping() {
      const hello = await hc.hello();
      return { version: hello.version, protocol: HERDR_PROTOCOL, capabilities: { direct_terminal_attach: true, runtime: "herdr-core" } };
    },
    async "session.snapshot"() {
      return { snapshot: await snapshot() };
    },
    async "pane.get"(params) {
      return { pane: await paneOf(paneIdOf(params)) };
    },
    async "agent.get"(params) {
      const pane = await paneOf(paneIdOf(params, "target"), "agent_not_found");
      if (!pane.agent) throw new AdapterError("agent_not_found", `no agent in pane ${pane.pane_id}`);
      return { type: "agent_info", agent: agentInfoOf(pane) };
    },
    async "pane.process_info"(params) {
      return { type: "pane_process_info", process_info: processInfoOf(await terminal(paneIdOf(params))) };
    },
    async "pane.read"(params) {
      const paneId = paneIdOf(params);
      const pane = await paneOf(paneId);
      const source = typeof params["source"] === "string" ? params["source"] : "visible";
      const format = typeof params["format"] === "string" ? params["format"] : "text";
      const recent = source === "recent" || source === "recent_unwrapped";
      const wanted = typeof params["lines"] === "number" && params["lines"] > 0 ? Math.floor(params["lines"]) : null;
      // hc reads the screen plus `lines` of history above it; herdr's recent read is the last `lines` lines
      const read = await hc.call<{ text: string; complete: boolean }>("terminal.read", { terminal: paneId, lines: recent ? wanted ?? 1000 : 0 });
      let text = read.text;
      if (recent && wanted !== null) {
        const rows = text.split("\n");
        if (rows.length > wanted) text = rows.slice(-wanted).join("\n");
      }
      // hc reads text only: plain text is an ANSI screen without colours
      return { read: { pane_id: paneId, workspace_id: pane.workspace_id, tab_id: pane.tab_id, source, format, text, revision: pane.revision, truncated: !read.complete } };
    },
    // herdr starts an agent by its kind (its command is its kind) from herdr's own manifests; hc has
    // none, so the kinds Ovis knows are offered, and the start types the command into the pane's
    // shell as a person would. Ovis's own shell-started agents are offered and started by the
    // server itself (shell-agent.ts), through pane.send_text.
    async "server.agent_manifests"() {
      const manifests = Object.keys(AGENT_LABELS).filter((agent) => !Object.hasOwn(SHELL_AGENTS, agent))
        .map((agent) => ({ agent, source: "herdr-core", source_kind: "herdr-core", local_override_shadowing_remote: false }));
      return { manifests };
    },
    async "agent.start"(params) {
      const paneId = paneIdOf(params);
      const kind = params["kind"];
      if (typeof kind !== "string" || !/^[a-z][a-z0-9-]*$/.test(kind)) throw new AdapterError("invalid_params", "kind is required");
      const args = Array.isArray(params["args"]) ? params["args"].filter((arg): arg is string => typeof arg === "string") : [];
      // a control character could end the quoted line early and type something else
      if (args.some((arg) => /[\u0000-\u001f\u007f]/.test(arg))) throw new AdapterError("invalid_params", "an argument holds a control character");
      const command = AGENT_COMMANDS[kind] ?? kind;
      // only into the pane's own shell, once hc has seen it in front: a running program would take
      // the line as its input (agent-launch.ts retries a busy pane while a new shell comes up). The
      // pane's input turn is held for the typing only, so nothing typed after waits on the start.
      await inTurn(paneId, async () => {
        const ready = await terminal(paneId);
        // the terminal's own program must be a plain shell: one the app started as a program (`claude`)
        // is in front of itself too, and `sh -c claude` (a template, a line) runs it under dash's pid.
        // Such a pane never takes a start: no retry
        const own = ready.argv ?? [];
        if (!plainShell(own)) throw new AdapterError("agent_pane_unsupported", `pane ${paneId} runs no shell of its own to start an agent in`);
        // fish reads a backslash inside single quotes as an escape: the argument would change
        const front = ready.foreground;
        const frontArgv = front?.argv ?? (front ? [front.name] : []);
        if ([own[0], frontArgv[0]].some((program) => /(?:^|\/)-?fish$/u.test(program ?? "")) && args.some((arg) => arg.includes("\\"))) throw new AdapterError("invalid_params", "fish would read a backslash in an argument differently");
        // and a plain shell in front now: a program it runs, or one it `exec`ed (same pid, `exec bash -c …` too), would take the line
        if (!ready.pid || front?.pid !== ready.pid || !plainShell(frontArgv)) throw new AdapterError("agent_pane_busy", `pane ${paneId} has no idle shell in front`);
        // Ctrl-U first: a line someone left half typed is cleared, not run with the command after it
        await type(paneId, `\u0015${shellCommandLine("posix", command, args)}\r`);
      });
      // started means the agent itself came up in front (hc samples it about twice a second): a
      // program or script named for the kind (`claude`, `node …/claude-code/cli.js`,
      // `codex-x86_64-…`). Not any program: a shell's command-not-found handler runs in front too,
      // and then the shell is back
      const deadline = Date.now() + AGENT_START_MS;
      let left = false;
      for (;;) {
        const now = await terminal(paneId);
        const front = now.foreground;
        if (front && front.pid !== now.pid) {
          left = true;
          const parts = [front.name, ...(front.argv ?? []).slice(0, 2)].flatMap((part) => part.split("/"));
          if (parts.some((part) => part === command || part.startsWith(`${command}-`) || part.startsWith(`${command}.`))) return { type: "agent_started", pane_id: paneId };
        } else if (left) throw new AdapterError("agent_start_failed", `${kind} did not start in pane ${paneId}`);
        if (Date.now() > deadline) throw new AdapterError("agent_start_failed", `${kind} did not come up in pane ${paneId}`);
        await Bun.sleep(100);
      }
    },
    async "pane.send_text"(params) {
      const text = params["text"];
      if (typeof text !== "string") throw new AdapterError("invalid_params", "text is required");
      const paneId = paneIdOf(params);
      await inTurn(paneId, () => type(paneId, text));
      return { type: "ok" };
    },
    async "pane.send_keys"(params) {
      const paneId = paneIdOf(params);
      const keys = Array.isArray(params["keys"]) ? params["keys"].filter((key): key is string => typeof key === "string") : [];
      await inTurn(paneId, async () => {
        // in order: a run of printable characters typed at once, a run of named keys and chords
        // through hc, which encodes them for the program's current keyboard modes
        let typed = "";
        let named: string[] = [];
        const sendRun = async () => {
          if (typed) { await type(paneId, typed); typed = ""; }
          if (named.length > 0) { await hc.call("terminal.keys", { terminal: paneId, keys: named }); named = []; }
        };
        for (const key of keys) {
          const bytes = keyBytes(key);
          if (bytes !== null ? named.length > 0 : typed !== "") await sendRun();
          if (bytes !== null) typed += bytes;
          else named.push(hcKeyName(key));
        }
        await sendRun();
      });
      return { type: "ok" };
    },
    async "agent.prompt"(params) {
      const paneId = paneIdOf(params, "target");
      const text = params["text"];
      if (typeof text !== "string") throw new AdapterError("invalid_params", "text is required");
      if (!(await paneOf(paneId, "agent_not_found")).agent) throw new AdapterError("agent_not_found", `no agent in pane ${paneId}`);
      await inTurn(paneId, () => hc.call("terminal.send", { terminal: paneId, text }, 30_000));
      return { type: "ok" };
    },
    // A new workspace or tab is a shell hc starts, labeled with its space and tab as the Herdr app
    // labels its own: the app adopts it there (herdr-app src/window.rs `reconcile`), and until
    // then, or without the app, the snapshot groups it by those labels (snapshot.ts `groups`).
    // Names live in the app's document, which Ovis never writes: a name given here is a label.
    async "workspace.create"(params) {
      const spaceId = `ovis-${crypto.randomUUID()}`;
      const label: Record<string, string> = typeof params["label"] === "string" && params["label"] ? { [WORKSPACE_NAME_LABEL]: params["label"] } : {};
      const pane = await startShell(params, { [SPACE_LABEL]: spaceId, [TAB_LABEL]: `ovis-${crypto.randomUUID()}`, ...label });
      return { type: "workspace_created", ...pane };
    },
    async "tab.create"(params) {
      const workspaceId = paneIdOf(params, "workspace_id");
      const shown = await snapshot();
      const workspace = shown.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
      if (!workspace && workspaceId !== OTHER_WORKSPACE_ID) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
      // a tab in a workspace starts where that workspace's first pane works, as herdr's does
      const cwd = typeof params["cwd"] === "string" ? params["cwd"] : shown.panes.find((pane) => pane.workspace_id === workspaceId)?.cwd ?? undefined;
      const label: Record<string, string> = typeof params["label"] === "string" && params["label"] ? { [TAB_NAME_LABEL]: params["label"] } : {};
      // "Other terminals" is no space of the app's: a tab there is a terminal of its own
      const space: Record<string, string> = workspaceId === OTHER_WORKSPACE_ID ? {} : { [SPACE_LABEL]: workspaceId, [TAB_LABEL]: `ovis-${crypto.randomUUID()}` };
      const { tab, root_pane } = await startShell({ ...params, ...(cwd ? { cwd } : {}) }, { ...space, ...label });
      return { type: "tab_created", tab, root_pane };
    },
    async "pane.close"(params) {
      await end([await paneOf(paneIdOf(params))].map((pane) => pane.pane_id));
      return { type: "ok" };
    },
    async "tab.close"(params) {
      const tabId = paneIdOf(params, "tab_id");
      const panes = (await snapshot()).panes.filter((pane) => pane.tab_id === tabId);
      if (panes.length === 0) throw new AdapterError("tab_not_found", `tab ${tabId} not found`);
      await end(panes.map((pane) => pane.pane_id));
      return { type: "ok" };
    },
    async "workspace.close"(params) {
      const workspaceId = paneIdOf(params, "workspace_id");
      // "Other terminals" is no workspace anyone made: its jobs and agents' workers close one by one
      if (workspaceId === OTHER_WORKSPACE_ID) throw new AdapterError("unsupported", "Other terminals holds terminals no workspace made: close them one by one");
      const panes = (await snapshot()).panes.filter((pane) => pane.workspace_id === workspaceId);
      if (panes.length === 0) throw new AdapterError("workspace_not_found", `workspace ${workspaceId} not found`);
      await end(panes.map((pane) => pane.pane_id));
      return { type: "ok" };
    },
  };

  return async (request) => {
    const method = methods[request.method];
    if (!method) return { error: { code: "unsupported", message: `${request.method} is not available on herdr-core: the Herdr app owns its workspaces, tabs and panes` } };
    try {
      return { result: await method(request.params) };
    } catch (error) {
      if (error instanceof AdapterError) return { error: { code: error.code, message: error.message } };
      if (error instanceof HcError) return { error: { code: herdrCode(error, "pane_not_found"), message: error.message } };
      // what failed is the server's own business: its log has it, the caller a plain reason
      console.error(`herdr-core adapter: ${request.method} failed:`, error);
      return { error: { code: "internal", message: `herdr-core could not answer ${request.method}` } };
    }
  };
}

/** One hc event notification (herdr-core schema/README.md, Events). */
interface HcEvent { type: string; terminal?: string; data?: Record<string, unknown> }

/**
 * An events subscription: herdr's acknowledgement once hc's own stream is open, so nothing that
 * happens after the server's next snapshot is missed, then herdr's frames for what hc reports. A
 * subscriber that fell behind on hc (`missed`), or a line to hc that ended, ends this connection:
 * the status collector reopens it and reads what it missed from a fresh snapshot.
 */
async function subscribe(hc: HcConnection, socket: Socket<ConnectionState>, request: Request): Promise<void> {
  const subscriptions = Array.isArray(request.params["subscriptions"]) ? request.params["subscriptions"].filter(isRecord) : [];
  const statusPanes = new Set(subscriptions.flatMap((entry) => entry["type"] === STATUS_EVENT && typeof entry["pane_id"] === "string" ? [entry["pane_id"]] : []));
  const structure = subscriptions.some((entry) => typeof entry["type"] === "string" && !NOT_STRUCTURE.has(entry["type"]));
  const ack = () => send(socket, `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
  if (statusPanes.size === 0 && !structure) {
    // focus only: hc has no focus to report, and the connection stays open as herdr's does
    ack();
    return;
  }
  let acknowledged = false;
  const queued: string[] = [];
  let ended = false;
  const emit = (event: string, data: Record<string, unknown>) => {
    const frame = `${JSON.stringify({ event, data })}\n`;
    if (acknowledged) send(socket, frame);
    else queued.push(frame);
  };
  /** Ends the subscription on both sides: hc's stream goes, and what was already written still reaches the reader. */
  const end = () => {
    if (ended) return;
    ended = true;
    socket.data.unsubscribe?.();
    socket.data.unsubscribe = null;
    if (!socket.data.closed) {
      socket.data.ending = true;
      flush(socket);
    }
  };
  const lifecycle = (event: string, type: string, paneId?: string) => {
    if (structure) emit(event, { type, ...(paneId ? { pane_id: paneId } : {}) });
  };
  const onEvent = (event: HcEvent) => {
    const paneId = event.terminal;
    switch (event.type) {
      case "status": {
        if (!paneId || !statusPanes.has(paneId)) return;
        const reported = event.data?.["status"];
        const status = isRecord(reported) && typeof reported["state"] === "string"
          ? { state: reported["state"], ...(typeof reported["app"] === "string" ? { app: reported["app"] } : {}) }
          : null;
        emit(STATUS_EVENT, { pane_id: paneId, agent_status: agentStatusOf(status), agent: status?.app || null });
        return;
      }
      case "created":
        lifecycle("pane.created", "pane_created", paneId);
        return;
      case "finished":
        lifecycle("pane.exited", "pane_exited", paneId);
        lifecycle("pane.closed", "pane_closed", paneId);
        return;
      case "removed":
        lifecycle("pane.closed", "pane_closed", paneId);
        return;
      case "lost":
      case "restarted":
        lifecycle("pane.updated", "pane_updated", paneId);
        return;
      case "labels":
        lifecycle("layout.updated", "layout_updated");
        return;
      case "doc":
        if (event.data?.["name"] === LAYOUT_DOC) lifecycle("layout.updated", "layout_updated");
        return;
      default:
        // title, size, foreground and turn change many times a second and show in the next snapshot
        return;
    }
  };
  const read = makeLineReader(EVENT_LINE_BYTES, (line) => {
    if (ended) return;
    let message: unknown;
    try { message = JSON.parse(line); } catch { end(); return; }
    if (!isRecord(message)) return;
    if (message["method"] === "missed") { end(); return; }
    const params = message["params"];
    if (message["method"] !== "event" || !isRecord(params) || typeof params["type"] !== "string") return;
    onEvent({ type: params["type"], ...(typeof params["terminal"] === "string" ? { terminal: params["terminal"] } : {}), ...(isRecord(params["data"]) ? { data: params["data"] } : {}) });
  }, () => {
    socket.data.unsubscribe?.();
    send(socket, `${JSON.stringify({ id: request.id, error: { code: "bad_frame", message: `hc event line exceeds ${EVENT_LINE_BYTES} bytes` } })}\n`, true);
  });
  try {
    const { channel } = await hc.open("events.subscribe", {}, { onData: read, onClose: end });
    // the herdr side went, or hc's stream did (`missed` can come with the answer), before the
    // acknowledgement: nothing is started, and hc's stream goes too
    if (ended || socket.data.closed || socket.data.ending) {
      void channel.close();
      end();
      return;
    }
    socket.data.unsubscribe = () => { void channel.close(); };
    ack();
    acknowledged = true;
    for (const frame of queued) send(socket, frame);
    queued.length = 0;
  } catch (error) {
    // whatever kept hc's stream from opening, the collector retries as it does for a herdr it cannot reach
    const message = error instanceof HcError ? error.message : "herdr-core could not open its event stream";
    if (!(error instanceof HcError)) console.error("herdr-core adapter: events.subscribe failed:", error);
    send(socket, `${JSON.stringify({ id: request.id, error: { code: "connect_failed", message } })}\n`, true);
  }
}
