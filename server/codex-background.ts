import type { CodexSubagentCall, OmoTask, PaneBackgroundAgentDetail } from "../shared/protocol.ts";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { plain, readLines } from "./claude-subagents.ts";
import { codexSubagentCalls, codexSubagentNotification, codexSubagentReplies } from "./codex-subagents.ts";
import { codexOutputText, codexRolloutPath, paneCodexHome } from "./codex.ts";

const READ_BYTES = 8 * 1024 * 1024;
const LIMIT = 200;
const RECENT_MS = 24 * 60 * 60 * 1000;
type Row = Record<string, unknown>;
const row = (value: unknown): Row => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
type Call = { name: string; input: string; at: string | null };
type Task = { task: OmoTask; prompt: string; result: string | null; resultCut: boolean };
type Read = {
  path: string; identity: string; offset: number; skipping: boolean; behind: boolean;
  session: string | null; tasks: Map<string, Task>; calls: Map<string, Call>; cells: Map<string, Call>;
};

/** Parent-reported lifecycle, with cumulative child usage from Codex's read-only thread store. */
export class CodexBackgroundTasks {
  private readonly panes = new Map<string, Read>();
  private readonly counts = new Map<string, number>();

  constructor(private readonly changed: (paneId: string, count: number) => void, private readonly now = Date.now, private readonly codexHome?: string) {}

  poll(paneId: string, path: string | null): void {
    const stat = path === null ? null : plain(path);
    if (path === null || stat === null) {
      this.panes.delete(paneId);
      this.publish(paneId, 0);
      return;
    }
    let read = this.panes.get(paneId);
    if (!read || read.path !== path || read.identity !== stat.id || read.offset > stat.size) {
      read = { path, identity: stat.id, offset: 0, skipping: false, behind: true, session: null, tasks: new Map(), calls: new Map(), cells: new Map() };
      this.panes.set(paneId, read);
    }
    if (read.offset < stat.size) {
      const state = read;
      const done = readLines(path, read.offset, stat.size, READ_BYTES, (line) => this.line(state, line), read.skipping);
      read.offset = done.offset;
      read.skipping = done.skipping;
      read.behind = done.failed === true || done.more;
    }
    this.publish(paneId, this.tasksOf(paneId).filter((task) => task.status === "running").length);
  }

  countOf(paneId: string): number { return this.counts.get(paneId) ?? 0; }

  tasksOf(paneId: string): OmoTask[] {
    const read = this.panes.get(paneId);
    if (!read || read.behind) return [];
    const recent = [...read.tasks.values()].map(({ task }) => task)
      .filter((task) => task.status === "running" || Date.parse(task.ended_at ?? "") >= this.now() - RECENT_MS);
    const running = recent.filter((task) => task.status === "running");
    const ended = recent.filter((task) => task.status !== "running")
      .sort((left, right) => Date.parse(right.ended_at ?? "") - Date.parse(left.ended_at ?? "")).slice(0, 10);
    return [...running, ...ended].map((task) => ({ ...task }));
  }

  async tasksWithUsage(paneId: string): Promise<OmoTask[]> {
    const read = this.panes.get(paneId);
    if (!read || read.behind || read.session === null || this.tasksOf(paneId).length === 0) return [];
    const session = read.session;
    const home = await paneCodexHome(paneId, this.codexHome);
    if (this.panes.get(paneId) !== read || read.session !== session || read.behind) return [];
    const tasks = this.tasksOf(paneId);
    if (tasks.length === 0 || codexRolloutPath(read.path, home) !== read.path) return tasks;
    let db: Database | undefined;
    try {
      db = new Database(join(home, "state_5.sqlite"), { readonly: true, create: false });
      const rows = db.query<{ id: string; tokens_used: number; source: string }, string[]>(
        `SELECT id, tokens_used, source FROM threads WHERE id IN (${tasks.map(() => "?").join(", ")})`,
      ).all(...tasks.map((task) => task.id));
      const usage = new Map<string, number>();
      for (const child of rows) {
        let source: Row;
        try { source = row(JSON.parse(child.source)); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
        const parent = row(row(source["subagent"])["thread_spawn"])["parent_thread_id"];
        if (parent === session && Number.isSafeInteger(child.tokens_used) && child.tokens_used >= 0) usage.set(child.id, child.tokens_used);
      }
      return tasks.map((task) => ({ ...task, tokens: usage.get(task.id) ?? null }));
    } catch {
      // Older or unavailable stores leave usage unknown, without hiding the parent's task list.
      return tasks;
    } finally { db?.close(); }
  }

  detail(paneId: string, agentId: string): { detail: Omit<PaneBackgroundAgentDetail, "server_time"> } | { refusal: "missing" | "unavailable" } {
    const read = this.panes.get(paneId);
    if (!read || read.behind || read.session === null) return { refusal: "unavailable" };
    const found = read.tasks.get(agentId);
    if (!found) return { refusal: "missing" };
    return { detail: {
      agent_id: agentId, session_id: read.session, title: found.task.title, agent: found.task.category,
      prompt: found.prompt || null,
      events: found.result === null ? [] : [{ kind: "text", text: found.result.slice(0, 16_000), at: found.task.ended_at }],
      truncated: found.prompt.length >= 20_000 || found.resultCut,
      incomplete: read.skipping,
      limits: { max_read_bytes: READ_BYTES, max_output_bytes: 144_000, max_events: 1 },
    } };
  }

  private publish(paneId: string, count: number): void {
    const previous = this.counts.get(paneId) ?? 0;
    if (count === 0) this.counts.delete(paneId); else this.counts.set(paneId, count);
    if (previous !== count) this.changed(paneId, count);
  }

  private line(read: Read, line: string): void {
    let entry: Row;
    try { entry = row(JSON.parse(line)); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
    const payload = row(entry["payload"]);
    const stamp = text(entry["timestamp"]);
    const at = Number.isFinite(Date.parse(stamp)) ? stamp : null;
    if (entry["type"] === "session_meta") {
      // Resuming a parent does not resume its old in-process children.
      if (read.session !== null) for (const found of read.tasks.values()) if (found.task.status === "running") {
        found.task.status = "lost"; found.task.ended_at = at;
      }
      read.session = text(payload["id"]).slice(0, 128) || null;
      read.calls.clear(); read.cells.clear();
      return;
    }
    if ((entry["type"] === "event_msg" && payload["type"] === "user_message")
      || (entry["type"] === "response_item" && payload["type"] === "message" && payload["role"] === "user")) {
      const body = entry["type"] === "event_msg" ? text(payload["message"]) : codexOutputText(payload["content"]);
      const notification = codexSubagentNotification(body, []);
      if (notification?.kind === "task_result") for (const result of notification.tasks) {
        const found = read.tasks.get(result.id);
        if (!found) continue;
        found.task.status = result.status;
        found.task.ended_at = at;
        found.result = result.result;
        found.resultCut = result.result_cut === true;
      }
      return;
    }
    if (entry["type"] !== "response_item") return;
    if (payload["type"] === "function_call" || payload["type"] === "custom_tool_call") {
      const name = text(payload["name"]);
      const input = text(payload["arguments"]) || text(payload["input"]);
      const calls = codexSubagentCalls(name, input);
      if (calls.length > 0) read.calls.set(text(payload["call_id"]), { name, input, at });
      else if (name === "wait") {
        let args: Row;
        try { args = row(JSON.parse(input)); } catch (error) { if (error instanceof SyntaxError) return; throw error; }
        const origin = read.cells.get(text(args["cell_id"]));
        if (origin) read.calls.set(text(payload["call_id"]), origin);
      }
      while (read.calls.size > 256) { const first = read.calls.keys().next().value; if (first === undefined) break; read.calls.delete(first); }
      return;
    }
    if (payload["type"] !== "function_call_output" && payload["type"] !== "custom_tool_call_output") return;
    const id = text(payload["call_id"]), call = read.calls.get(id);
    if (!call) return;
    read.calls.delete(id);
    const output = codexOutputText(payload["output"]);
    const answers = codexSubagentReplies(output);
    const accepted = answers.length > 0 && !answers.some((answer) => Object.hasOwn(answer, "error") || answer["isError"] === true);
    const agents = codexSubagentCalls(call.name, call.input, output);
    for (const agent of agents) this.apply(read, agent, call.at, at, accepted);
    for (const answer of answers) {
      for (const [agentId, value] of Object.entries(row(answer["status"]))) {
        const found = read.tasks.get(agentId);
        const state = row(value);
        const result = text(state["completed"]) || text(state["errored"]);
        if (found && result) { found.result = result.slice(0, 16_000); found.resultCut = result.length > 16_000; }
      }
    }
    const closing = agents.filter((agent) => agent.operation === "close");
    const previous = answers.filter((answer) => Object.hasOwn(answer, "previous_status"));
    const target = closing.length === 1 ? closing[0]?.agent_id : null;
    const found = target ? read.tasks.get(target) : undefined;
    if (found && previous.length === 1) {
      const state = row(previous[0]?.["previous_status"]);
      const result = text(state["completed"]) || text(state["errored"]);
      if (result) { found.result = result.slice(0, 16_000); found.resultCut = result.length > 16_000; }
    }
    const cell = /^Script running with cell ID ([^\s]+)/m.exec(output)?.[1];
    if (cell) {
      read.cells.set(cell, call);
      while (read.cells.size > 256) { const first = read.cells.keys().next().value; if (first === undefined) break; read.cells.delete(first); }
    } else for (const [key, owner] of read.cells) if (owner === call) read.cells.delete(key);
  }

  private apply(read: Read, agent: CodexSubagentCall, started: string | null, at: string | null, accepted: boolean): void {
    if (!agent.agent_id) return;
    const id = agent.agent_id;
    if (agent.operation === "spawn" && !read.tasks.has(id)) {
      if (read.tasks.size >= LIMIT) {
        const ended = [...read.tasks].find(([, value]) => value.task.status !== "running");
        if (!ended) return;
        read.tasks.delete(ended[0]);
      }
      read.tasks.set(id, { task: {
        id, title: agent.nickname || agent.title || id, category: agent.agent_type, model: null,
        status: "running", started_at: started, ended_at: null, turns: null, tool_calls: null, tokens: null, detail_kind: "codex-subagent",
      }, prompt: agent.prompt, result: null, resultCut: false });
    }
    const found = read.tasks.get(id);
    if (!found) return;
    if (accepted && agent.operation === "followup") {
      found.prompt = agent.prompt;
      found.task.title = agent.title || found.task.title;
      found.task.category = agent.agent_type ?? found.task.category;
      found.task.started_at = started ?? at;
      found.task.status = "running"; found.task.ended_at = null; found.result = null; found.resultCut = false;
    }
    if ((agent.operation === "resume" || agent.operation === "wait") && (agent.status === "running" || agent.status === "pending_init")) {
      found.task.status = "running"; found.task.ended_at = null; found.result = null; found.resultCut = false;
    }
    if (agent.status === "completed" || agent.status === "errored" || agent.status === "shutdown" || agent.status === "not_found" || agent.status === "interrupted") {
      found.task.status = agent.status === "completed" ? "completed" : agent.status === "errored" ? "failed" : agent.status === "not_found" ? "lost" : "cancelled";
      found.task.ended_at = at;
    } else if (agent.operation === "close" && agent.status !== null && found.task.status === "running") {
      found.task.status = "cancelled"; found.task.ended_at = at;
    }
  }
}
