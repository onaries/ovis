import { afterEach, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexBackgroundTasks } from "./codex-background.ts";
import { SessionPlans } from "./session-plan.ts";
import { handleBackgroundAgentRequest } from "./background-agent.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import * as herdr from "./herdr/client.ts";
import { handleTasksRequest } from "./tasks-routes.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = "2026-10-26T01:00:00Z";
const id = "11111111-1111-4111-8111-111111111111";
const entry = (payload: unknown, type = "response_item") => JSON.stringify({ type, timestamp: at, payload }) + "\n";
const call = (name: string, args: unknown, call_id = "call") => entry({ type: "function_call", name, arguments: JSON.stringify(args), call_id });
const output = (value: unknown, call_id = "call") => entry({ type: "function_call_output", output: JSON.stringify(value), call_id });
const spawn = () => call("multi_agent_v1__spawn_agent", { agent_type: "explorer", message: "Inspect task lifecycle" }) + output({ agent_id: id, nickname: "Explorer" });
function fixture(body = spawn()) {
  const root = mkdtempSync(join(tmpdir(), "ovis-codex-tasks-")); roots.push(root);
  const path = join(root, "rollout.jsonl");
  writeFileSync(path, entry({ id: "parent" }, "session_meta") + body);
  const counts: number[] = [];
  const tracker = new CodexBackgroundTasks((_pane, count) => counts.push(count), () => Date.parse(at));
  tracker.poll("pane", path);
  return { path, tracker, counts };
}

it("counts only acknowledged spawns and exposes their assigned task", () => {
  const { path, tracker } = fixture(call("multi_agent_v1__spawn_agent", { message: "Inspect task lifecycle" }));
  expect(tracker.countOf("pane")).toBe(0);
  appendFileSync(path, output({ agent_id: id, nickname: "Explorer" })); tracker.poll("pane", path);
  expect(tracker.tasksOf("pane")).toMatchObject([{ id, title: "Explorer", status: "running", detail_kind: "codex-subagent" }]);
  expect(tracker.detail("pane", id)).toMatchObject({ detail: { session_id: "parent", prompt: "Inspect task lifecycle" } });
});

it("records reported completion and leaves it completed when closed", () => {
  const { path, tracker, counts } = fixture();
  appendFileSync(path, call("multi_agent_v1__close_agent", { target: id }) + output({ previous_status: { completed: "Lifecycle verified" } }));
  tracker.poll("pane", path);
  expect(tracker.tasksOf("pane")[0]?.status).toBe("completed");
  expect(counts).toEqual([1, 0]);
  expect(tracker.detail("pane", id)).toMatchObject({ detail: { events: [{ text: "Lifecycle verified" }] } });
});

it("accepts native text-content blocks in a code-mode spawn receipt", () => {
  const script = 'text(await tools.multi_agent_v1__spawn_agent({agent_type:"explorer",message:"Inspect task lifecycle"}));';
  const { tracker } = fixture(entry({ type: "custom_tool_call", name: "exec", input: script, call_id: "spawn" })
    + entry({ type: "custom_tool_call_output", call_id: "spawn", output: [{ type: "text", text: "Script completed\nOutput:" }, { type: "text", text: JSON.stringify({ agent_id: id, nickname: "Explorer" }) }] }));
  expect(tracker.countOf("pane")).toBe(1);
  expect(tracker.tasksOf("pane")).toMatchObject([{ id, title: "Explorer" }]);
});

it("reads completion carried only as a native user response item", () => {
  const message = `<subagent_notification>${JSON.stringify({ agent_path: id, status: { completed: "Native completion" } })}</subagent_notification>`;
  const { tracker } = fixture(spawn() + entry({ type: "message", role: "user", content: [{ type: "input_text", text: message }] }));
  expect(tracker.countOf("pane")).toBe(0);
  expect(tracker.detail("pane", id)).toMatchObject({ detail: { events: [{ text: "Native completion" }] } });
});

it("does not claim a rejected close stopped a child", () => {
  const { path, tracker } = fixture();
  appendFileSync(path, call("multi_agent_v1__close_agent", { target: id }) + output({ error: "permission denied" })); tracker.poll("pane", path);
  expect(tracker.countOf("pane")).toBe(1);
});

it("can resume an explicitly completed child", () => {
  const { path, tracker } = fixture(spawn() + call("multi_agent_v1__wait_agent", { targets: [id] }) + output({ status: { [id]: { completed: "Done" } } }));
  expect(tracker.countOf("pane")).toBe(0);
  appendFileSync(path, call("multi_agent_v1__resume_agent", { id }) + output({ status: "running" })); tracker.poll("pane", path);
  expect(tracker.countOf("pane")).toBe(1);
});

it("accepts native completion only for a child spawned by this parent", () => {
  const note = (agent_path: string) => entry({ type: "user_message", message: `<subagent_notification>${JSON.stringify({ agent_path, status: { completed: "Verified" } })}</subagent_notification>` }, "event_msg");
  const { tracker } = fixture(spawn() + note("foreign") + note(id));
  expect(tracker.tasksOf("pane")).toHaveLength(1);
  expect(tracker.detail("pane", id)).toMatchObject({ detail: { events: [{ kind: "text", text: "Verified" }] } });
  expect(tracker.detail("pane", "foreign")).toEqual({ refusal: "missing" });
});

it("drops the old pane's assignments when its session changes or becomes unknown", () => {
  const { path, tracker, counts } = fixture();
  const other = join(path, "..", "other.jsonl"); writeFileSync(other, entry({ id: "other" }, "session_meta"));
  tracker.poll("pane", other);
  expect(tracker.tasksOf("pane")).toEqual([]);
  expect(tracker.detail("pane", id)).toEqual({ refusal: "missing" });
  tracker.poll("pane", null);
  expect(counts).toEqual([1, 0]);
});

it("waits for a complete appended record and loses in-process children across parent resume", () => {
  const { path, tracker } = fixture();
  const resume = entry({ id: "parent" }, "session_meta");
  appendFileSync(path, resume.slice(0, -1)); tracker.poll("pane", path);
  expect(tracker.countOf("pane")).toBe(1);
  appendFileSync(path, "\n"); tracker.poll("pane", path);
  expect(tracker.tasksOf("pane")[0]?.status).toBe("lost");
});

it("reads a code-mode spawn that finishes in a later exec cell", () => {
  const script = 'const a = await tools.multi_agent_v1__spawn_agent({agent_type:"explorer",message:"Inspect task lifecycle"}); text(a);';
  const { path, tracker } = fixture(entry({ type: "custom_tool_call", name: "exec", input: script, call_id: "spawn" }) + entry({ type: "custom_tool_call_output", call_id: "spawn", output: "Script running with cell ID cell-1" }));
  appendFileSync(path, call("wait", { cell_id: "cell-1" }, "cell") + output({ agent_id: id, nickname: "Explorer" }, "cell")); tracker.poll("pane", path);
  expect(tracker.countOf("pane")).toBe(1);
});

const pane = (session = "parent"): HerdrPane => ({ pane_id: "pane", workspace_id: "w", tab_id: "t", terminal_id: "term", focused: false, revision: 1, agent: "codex", agent_status: "working", agent_session: { agent: "codex", source: "herdr:codex", kind: "id", value: session } });

it("uses the existing plan poll for counts, clears a changed session before lookup completes", async () => {
  const { path, tracker } = fixture();
  let release: ((value: string | null) => void) | undefined;
  const plans = new SessionPlans({ claudePath: () => null, codexPath: async (seen) => seen.agent_session?.value === "parent" ? path : new Promise((resolve) => { release = resolve; }),
    onChange: () => {}, onCodexTranscript: (id, path) => tracker.poll(id, path) });
  await plans.refresh([pane()]); plans.poll();
  expect(tracker.countOf("pane")).toBe(1);
  const pending = plans.refresh([pane("replacement")]);
  plans.poll();
  expect(tracker.countOf("pane")).toBe(0);
  expect(plans.codexPathOf(pane("replacement"))).toBeNull();
  release?.(null); await pending;
  expect(tracker.tasksOf("pane")).toEqual([]);
});

it("waits for an existing lookup of the same session before answering a foreground request", async () => {
  const { path } = fixture();
  let release: ((value: string | null) => void) | undefined;
  const plans = new SessionPlans({ claudePath: () => null, codexPath: () => new Promise((resolve) => { release = resolve; }), onChange: () => {} });
  const first = plans.ensure(pane(), true);
  let answered = false;
  const second = plans.ensure(pane(), true).then(() => { answered = true; });
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(answered).toBe(false);
  } finally { release?.(path); await Promise.all([first, second]); }
  expect(plans.codexPathOf(pane())).toBe(path);
});

for (const asked of [false, true]) it(`invalidates an old session even while its ${asked ? "requested" : "periodic"} lookup is already in flight`, async () => {
  const { path, tracker } = fixture();
  let now = 0, calls = 0;
  let release: ((value: string | null) => void) | undefined;
  const plans = new SessionPlans({ claudePath: () => null,
    codexPath: async () => ++calls === 1 ? path : new Promise((resolve) => { release = resolve; }),
    now: () => now, relocateMs: 1, onChange: () => {}, onCodexTranscript: (id, path) => tracker.poll(id, path) });
  await plans.refresh([pane()]); plans.poll();
  now = 10;
  const old = plans.ensure(pane(), asked);
  await plans.refresh([pane("replacement")]); plans.poll();
  expect(tracker.countOf("pane")).toBe(0);
  release?.(path); await old; plans.poll();
  expect(tracker.tasksOf("pane")).toEqual([]);
  expect(plans.codexPathOf(pane())).toBeNull();
});

it("starts a followup assignment afresh without mixing the first result into it", () => {
  const { path, tracker } = fixture(spawn() + call("wait_agent", { targets: [id] }) + output({ status: { [id]: { completed: "First result" } } }));
  const next = "2026-10-26T01:01:00Z";
  appendFileSync(path, call("followup_task", { agent_id: id, message: "Second assignment" }).replace(at, next) + output({}).replace(at, next));
  tracker.poll("pane", path);
  expect(tracker.countOf("pane")).toBe(1);
  expect(tracker.tasksOf("pane")[0]).toMatchObject({ status: "running", started_at: next, ended_at: null });
  expect(tracker.detail("pane", id)).toMatchObject({ detail: { prompt: "Second assignment", events: [] } });
  appendFileSync(path, entry({ type: "user_message", message: `<subagent_notification>${JSON.stringify({ agent_path: id, status: { completed: "Second result" } })}</subagent_notification>` }, "event_msg"));
  tracker.poll("pane", path);
  expect(tracker.detail("pane", id)).toMatchObject({ detail: { prompt: "Second assignment", events: [{ text: "Second result" }] } });
});

it("does not reopen an assignment when its followup is refused", () => {
  const { path, tracker } = fixture(spawn() + call("wait_agent", { targets: [id] }) + output({ status: { [id]: { completed: "First result" } } }));
  appendFileSync(path, call("followup_task", { agent_id: id, message: "Refused assignment" }) + output({ error: "not allowed" }));
  tracker.poll("pane", path);
  expect(tracker.countOf("pane")).toBe(0);
  expect(tracker.detail("pane", id)).toMatchObject({ detail: { prompt: "Inspect task lifecycle", events: [{ text: "First result" }] } });
});

it("orders recent outcomes by when they ended, regardless of their spawn order", () => {
  const other = "22222222-2222-4222-8222-222222222222";
  const ended = (agent_path: string, timestamp: string) => entry({ type: "user_message", message: `<subagent_notification>${JSON.stringify({ agent_path, status: { completed: "Done" } })}</subagent_notification>` }, "event_msg").replace(at, timestamp);
  const { tracker } = fixture(spawn() + spawn().replaceAll(id, other) + ended(other, "2026-10-26T01:01:00Z") + ended(id, "2026-10-26T01:02:00Z"));
  expect(tracker.tasksOf("pane").map((task) => task.id)).toEqual([id, other]);
});

it("serves Codex assignments through the existing detail route and rejects foreign ids", async () => {
  const { path, tracker } = fixture();
  const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => path, onChange: () => {} });
  const read = (id: string) => {
    const url = new URL(`http://localhost/api/pane/background-agent?pane_id=pane&agent_id=${id}`);
    return handleBackgroundAgentRequest(new Request(url), url, { paneGet: async () => pane(), omoPane: () => false,
      claudeAgents: { ensure: async () => { throw new Error("Wrong agent tracker"); }, sessionOf: () => null }, codexTasks: tracker, plans });
  };
  const response = await read(id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ agent_id: id, session_id: "parent", prompt: "Inspect task lifecycle" });
  expect((await read("foreign")).status).toBe(404);
  expect((await read("..%2Foutside")).status).toBe(400);
});

it("rejects a Codex detail when the pane changes session during the read", async () => {
  const { path, tracker } = fixture();
  const other = join(path, "..", "other.jsonl"); writeFileSync(other, entry({ id: "replacement" }, "session_meta") + spawn());
  const plans = new SessionPlans({ claudePath: () => null, codexPath: async (seen) => seen.agent_session?.value === "parent" ? path : other, onChange: () => {} });
  let asks = 0;
  const url = new URL(`http://localhost/api/pane/background-agent?pane_id=pane&agent_id=${id}`);
  const response = await handleBackgroundAgentRequest(new Request(url), url, { paneGet: async () => pane(asks++ === 0 ? "parent" : "replacement"), omoPane: () => false,
    claudeAgents: { ensure: async () => {}, sessionOf: () => null }, codexTasks: tracker, plans });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "background_target_changed" } });
});

it("lists Codex tasks through the existing route, not through the Claude tracker", async () => {
  const { path, tracker } = fixture();
  const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => path, onChange: () => {} });
  const get = spyOn(herdr, "paneGet").mockImplementation(async () => pane());
  const url = new URL("http://localhost/api/pane/omo-tasks?pane_id=pane");
  try {
    const response = await handleTasksRequest(new Request(url), url, url.pathname, {
      omo: { sessionOf: () => null }, claudeAgents: { sessionOf: () => null, ensure: async () => { throw new Error("Wrong agent tracker"); } },
      plans, codexTasks: tracker,
    });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ tasks: [{ id, title: "Explorer", status: "running" }], runs: [] });
  } finally { get.mockRestore(); }
});

it("returns no Codex list from a pane that moved sessions during its lookup", async () => {
  const { path, tracker } = fixture();
  const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => path, onChange: () => {} });
  let asks = 0;
  const get = spyOn(herdr, "paneGet").mockImplementation(async () => pane(asks++ === 0 ? "parent" : "replacement"));
  const url = new URL("http://localhost/api/pane/omo-tasks?pane_id=pane");
  try {
    const response = await handleTasksRequest(new Request(url), url, url.pathname, {
      omo: { sessionOf: () => null }, claudeAgents: { sessionOf: () => null, ensure: async () => {} }, plans, codexTasks: tracker,
    });
    expect(await response?.json()).toMatchObject({ tasks: [], runs: [] });
  } finally { get.mockRestore(); }
});
