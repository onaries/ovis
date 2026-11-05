import { describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync } from "node:fs";
import type { HerdrPane, PaneContext, PlanSummary } from "../shared/protocol.ts";
import { paneAfterStatus } from "./machines.ts";
import { readPlan, SessionPlans } from "./session-plan.ts";
import { at, claude, file } from "./session-plan.fixture.ts";

const steps = (path: string) => (readPlan("claude-transcript", path) ?? []).map((step) => `${step.id}:${step.status}:${step.blocked_by.join(",")}`);

describe("SessionPlans", () => {
  const pane = (pane_id: string, agent: string, session = "s1"): HerdrPane => ({ pane_id, agent, cwd: "/w", agent_session: { kind: "id", value: session } } as unknown as HerdrPane);

  it("initializes an OmO plan from the todo tool answer", async () => {
    // Given a native session with a synthetic todo answer.
    const f = file("omo.jsonl");
    f.add({ type: "message", timestamp: at(1), message: { role: "toolResult", toolName: "todo", toolCallId: "t1", content: [{ type: "text", text: "Overall: 0/2 done\n  Build:\n    - [ ] Read (in progress)\n    - [ ] Fix" }] } });
    const deps = { claudePath: () => null, codexPath: async () => null, omoPath: () => f.path, onChange: () => {} };
    const plans = new SessionPlans(deps);
    // When the OmO pane is followed and polled.
    await plans.refresh([pane("omo1", "omo")]);
    plans.poll();
    // Then both the sidebar summary and plan panel receive the list.
    expect(plans.summaryOf("omo1")).toEqual({ done: 0, total: 2, current: "Read" });
    expect(plans.planOf(pane("omo1", "omo"))?.map((step) => step.label)).toEqual(["Read", "Fix"]);
  });

  const omo = async () => {
    const f = file("omo.jsonl");
    let sequence = 0;
    const answer = (text: string, toolName = "todo") => f.add({ type: "message", timestamp: at(++sequence), message: { role: "toolResult", toolName, toolCallId: `t${sequence}`, content: [{ type: "text", text }] } });
    answer("Overall: 0/2 done\n  Build:\n    - [ ] Read (in progress)\n    - [ ] Fix");
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => null, omoPath: () => f.path, onChange: () => {} });
    await plans.refresh([pane("omo1", "omo")]);
    plans.poll();
    return { plans, answer, f };
  };

  it("updates OmO progress when another todo answer is appended", async () => {
    // Given a polled native list.
    const { plans, answer } = await omo();
    // When one item finishes and the next starts.
    answer("Overall: 1/2 done\n  Build:\n    - [X] Read\n    - [ ] Fix (in progress)");
    plans.poll();
    // Then progress and step times follow the new answer.
    expect(plans.summaryOf("omo1")).toEqual({ done: 1, total: 2, current: "Fix" });
    expect(plans.planOf(pane("omo1", "omo"))).toMatchObject([
      { label: "Read", status: "completed", started_at: at(1), ended_at: at(2) },
      { label: "Fix", status: "in_progress", started_at: at(2), ended_at: null },
    ]);
  });

  it("retains the completed OmO plan when every task is done", async () => {
    // Given an initial native list.
    const { plans, answer } = await omo();
    // When the full answer marks both tasks done.
    answer("Overall: 2/2 done\n  Build:\n    - [X] Read\n    - [X] Fix");
    plans.poll();
    // Then the sidebar retains a completed count.
    expect(plans.summaryOf("omo1")).toEqual({ done: 2, total: 2, current: null });
  });

  it.each(["Todo list is empty.", "Todo list cleared."])("clears OmO progress when the answer says %s", async (empty) => {
    // Given an existing plan.
    const { plans, answer } = await omo();
    // When the native list is cleared.
    answer(empty);
    plans.poll();
    // Then neither surface keeps stale progress.
    expect(plans.summaryOf("omo1")).toBeNull();
    expect(plans.planOf(pane("omo1", "omo"))).toBeNull();
  });

  it.each([
    "Overall: 1/2 done\n  Build:\n    - [X] Read",
    "  Build:\n    - [X] Read\n… trimmed",
  ])("ignores a truncated OmO answer: %s", async (truncated) => {
    // Given an existing complete plan.
    const { plans, answer } = await omo();
    // When a cut-short answer is appended.
    answer(truncated);
    plans.poll();
    // Then its incomplete contents never replace the plan.
    expect(plans.summaryOf("omo1")).toEqual({ done: 0, total: 2, current: "Read" });
  });

  it("excludes dropped OmO work while keeping blocked work pending", async () => {
    // Given an existing plan.
    const { plans, answer } = await omo();
    // When one task is dropped and one is blocked.
    answer("Overall: 0/2 done\n  Build:\n    - [ ] Read (dropped)\n    - [ ] Fix (blocked: waiting)");
    plans.poll();
    // Then abandoned work does not inflate completion, and blocked work is not done.
    expect(plans.summaryOf("omo1")).toEqual({ done: 0, total: 1, current: null });
    expect(plans.planOf(pane("omo1", "omo"))?.map((step) => step.status)).toEqual(["pending"]);
  });

  it("ignores quoted OmO todos outside a todo tool result", async () => {
    // Given an existing plan.
    const { plans, answer, f } = await omo();
    // When prose, an assistant call and another tool quote a different list.
    const text = "  Fake:\n    - [X] Wrong";
    f.add({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "never-answered", name: "todo", arguments: { op: "done" } }, { type: "text", text }] } });
    answer(text, "read");
    plans.poll();
    // Then the answered todo alone remains authoritative.
    expect(plans.summaryOf("omo1")).toEqual({ done: 0, total: 2, current: "Read" });
  });

  it.each(["replaced", "unresolved"])("follows an OmO binding when it becomes %s", async (binding) => {
    // Given a tracked pane with an unchanged provider session id.
    const old = file("old.jsonl"), next = file("next.jsonl");
    const result = (label: string) => ({ type: "message", message: { role: "toolResult", toolName: "todo", content: [{ type: "text", text: `  Work:\n    - [ ] ${label}` }] } });
    old.add(result("Old work"));
    next.add(result("New work"));
    let path: string | null = old.path;
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => null, omoPath: () => path, onChange: () => {} });
    await plans.refresh([pane("omo1", "omo")]);
    plans.poll();
    // When discovery replaces or loses the native binding.
    path = binding === "replaced" ? next.path : null;
    await plans.refresh([pane("omo1", "omo")]);
    plans.poll();
    // Then the old session is never returned.
    expect(plans.planOf(pane("omo1", "omo"))?.map((step) => step.label) ?? null).toEqual(binding === "replaced" ? ["New work"] : null);
  });

  it("keeps a remote PC's plan as its frames say", () => {
    const frame = (plan?: PlanSummary | null) => ({ type: "pane-status" as const, pane_id: "p1", agent_status: "working" as const, ...(plan === undefined ? {} : { plan }) });
    const planned = paneAfterStatus({ ...pane("p1", "claude"), background_tasks: 1 }, frame({ done: 1, total: 2, current: "Two" }));
    expect(planned).toMatchObject({ background_tasks: 1, plan: { done: 1, total: 2, current: "Two" } });
    expect(paneAfterStatus(planned, frame())).toMatchObject({ plan: { done: 1, total: 2 } });
    expect("plan" in paneAfterStatus(planned, frame(null))).toBe(false);
  });

  it("keeps a remote PC's context as its frames say", () => {
    const frame = (context?: PaneContext | null) => ({ type: "pane-status" as const, pane_id: "p1", agent_status: "idle" as const, ...(context === undefined ? {} : { context }) });
    const filled = paneAfterStatus(pane("p1", "claude"), frame({ used: 50_000, window: 200_000 }));
    expect(filled).toMatchObject({ context: { used: 50_000, window: 200_000 } });
    expect(paneAfterStatus(filled, frame())).toMatchObject({ context: { used: 50_000 } });
    expect("context" in paneAfterStatus(filled, frame(null))).toBe(false);
  });

  it("tells a Claude pane's context as its requests fill it, the main session's only, and clears it with the pane", async () => {
    // Given a Claude transcript whose last request went past the 200k window.
    const s = claude();
    const changes: [string, PaneContext | null][] = [];
    const plans = new SessionPlans({ claudePath: (id) => id === "p1" ? s.path : null, codexPath: async () => null, onChange: () => {}, onContext: (id, context) => changes.push([id, context]) });
    const request = (input: number, extra: Record<string, unknown> = {}) => s.add({ type: "assistant", timestamp: at(1), ...extra, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: input, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 } } });
    request(240_000);
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    // Then it is told with the 1M window, as the chat's ring reads it.
    expect(changes).toEqual([["p1", { used: 242_000, window: 1_000_000 }]]);
    expect(plans.contextOf("p1")).toEqual({ used: 242_000, window: 1_000_000 });
    // A subagent's request fills its own context; an unchanged context is not told again.
    request(5_000, { isSidechain: true });
    plans.poll();
    expect(changes).toHaveLength(1);
    request(98_000);
    plans.poll();
    expect(changes.at(-1)).toEqual(["p1", { used: 100_000, window: 1_000_000 }]);
    // When the pane runs something else, its context goes.
    await plans.refresh([pane("p1", "shell")]);
    expect(changes.at(-1)).toEqual(["p1", null]);
    expect(plans.contextOf("p1")).toBeNull();
  });

  it("takes a Claude pane's window from its status line capture, also when the capture comes after the request", async () => {
    // Given a Claude request under 200k, whose window the transcript does not say.
    const s = claude();
    s.add({ type: "assistant", timestamp: at(1), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 30_000 } } });
    let captured: number | null = null;
    const asked: [string, string | null][] = [];
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {}, claudeWindow: (path, model) => { asked.push([path, model]); return captured; } });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    // Then no window is known: the ring would draw nothing.
    expect(plans.contextOf("p1")).toEqual({ used: 30_000, window: null });
    // When the status line names the window without a transcript append, the next poll tells it.
    captured = 200_000;
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 30_000, window: 200_000 });
    expect(asked.at(-1)).toEqual([s.path, "claude-opus-5-5"]);
    // When /model switches the session, the window is asked for the model it set, as the chat asks.
    s.add({ type: "user", message: { role: "user", content: "<local-command-stdout>Set model to `Sonnet 5.5` for this session only</local-command-stdout>" } });
    plans.poll();
    expect(asked.at(-1)).toEqual([s.path, "claude-sonnet-5-5"]);
  });

  it("clears a pane's context as soon as it runs another session, before its transcript is read", async () => {
    // Given a Claude pane whose context was told.
    const s = claude();
    s.add({ type: "assistant", timestamp: at(1), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 30_000 } } });
    const changes: [string, PaneContext | null][] = [];
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {}, onContext: (id, context) => changes.push([id, context]), claudeWindow: () => 200_000 });
    await plans.refresh([pane("p1", "claude", "A")]);
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 30_000, window: 200_000 });
    // When herdr says the pane runs another session, the old figure goes at once, before any poll.
    await plans.refresh([pane("p1", "claude", "B")]);
    expect(plans.contextOf("p1")).toBeNull();
    expect(changes.at(-1)).toEqual(["p1", null]);
  });

  it("reads a Codex pane's context with the window Codex states", async () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258_400, last_token_usage: { total_tokens: 64_600 } } } });
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => f.path, onChange: () => {} });
    await plans.refresh([pane("p2", "codex")]);
    plans.poll();
    expect(plans.contextOf("p2")).toEqual({ used: 64_600, window: 258_400 });
  });

  it("tells a pane's summary as its plan moves, reads nothing while its transcript is as it was, and clears it when the pane runs something else", async () => {
    const s = claude();
    const changes: [string, PlanSummary | null][] = [];
    let codexLookups = 0;
    const plans = new SessionPlans({ claudePath: (id) => id === "p1" ? s.path : null, codexPath: async () => { codexLookups++; return null; }, onChange: (id, summary) => changes.push([id, summary]) });
    const a = s.create("One", 1, { activeForm: "Doing one" });
    s.create("Two");
    await plans.refresh([pane("p1", "claude"), pane("p2", "codex"), pane("p3", "shell")]);
    // a snapshot reads nothing: the poll does
    expect(changes).toEqual([]);
    plans.poll();
    expect(changes).toEqual([["p1", { done: 0, total: 2, current: null }]]);
    expect(codexLookups).toBe(1);
    s.update({ taskId: a, status: "in_progress" }, 2);
    plans.poll();
    plans.poll();
    expect(changes.at(-1)).toEqual(["p1", { done: 0, total: 2, current: "Doing one" }]);
    expect(changes).toHaveLength(2);
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.status)).toEqual(["in_progress", "pending"]);
    // a Codex pane whose rollout was not found is not asked again at once
    await plans.refresh([pane("p1", "claude"), pane("p2", "codex")]);
    expect(codexLookups).toBe(1);
    await plans.refresh([pane("p1", "shell"), pane("p2", "codex")]);
    expect(changes.at(-1)).toEqual(["p1", null]);
    expect(plans.summaryOf("p1")).toBeNull();
  });

  it("looks a Codex pane's rollout up again when its session changes", async () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c1", arguments: JSON.stringify({ plan: [{ step: "Go", status: "completed" }] }) } });
    const looked: string[] = [];
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async (p) => { looked.push(p.agent_session?.value ?? ""); return f.path; }, onChange: (_id, summary) => changes.push(summary) });
    await plans.refresh([pane("p2", "codex", "t1")]);
    plans.poll();
    await plans.refresh([pane("p2", "codex", "t1")]);
    await plans.refresh([pane("p2", "codex", "t2")]);
    plans.poll();
    expect(looked).toEqual(["t1", "t2"]);
    expect(changes).toEqual([{ done: 1, total: 1, current: null }]);
  });

  it("drops a Codex lookup that ends after its pane left", async () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c1", arguments: JSON.stringify({ plan: [{ step: "Go", status: "pending" }] }) } });
    let answer: (path: string) => void = () => {};
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => null, codexPath: () => new Promise((resolve) => { answer = resolve; }), onChange: (_id, summary) => changes.push(summary) });
    const looking = plans.refresh([pane("p2", "codex")]);
    await plans.refresh([pane("p2", "shell")]);
    answer(f.path);
    await looking;
    plans.poll();
    expect(plans.known(pane("p2", "codex"))).toBe(false);
    expect(changes).toEqual([]);
  });

  it("keeps a lookup a request asked for, for a pane the last snapshot had not seen yet", async () => {
    const f = file("rollout.jsonl");
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => f.path, onChange: () => {} });
    await plans.refresh([]);
    await plans.ensure(pane("p3", "codex"), true);
    expect(plans.known(pane("p3", "codex"))).toBe(true);
  });

  it("tells a request the plan as the poll last read it, and reads nothing for it", async () => {
    const s = claude();
    s.create("One");
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {} });
    await plans.refresh([pane("p1", "claude")]);
    // no poll has read the transcript yet: a request does not read it
    expect(plans.planOf(pane("p1", "claude"))).toBeNull();
    plans.poll();
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One"]);
    // what was written since, however much, is the next poll's to read
    s.create("Two", 2);
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One"]);
    plans.poll();
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One", "Two"]);
  });

  it("tells a plan only for the pane as herdr has it now, in the session its transcript was found for", async () => {
    const s = claude();
    s.create("One");
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {} });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One"]);
    // herdr did not say in time, or no longer has the pane: what was read for it is not told
    expect(plans.planOf(undefined)).toBeNull();
    // the pane runs another session now, not looked up yet
    expect(plans.planOf(pane("p1", "claude", "s2"))).toBeNull();
  });

  it("knows a pane's transcript only for the session it was found for", async () => {
    const f = file("rollout.jsonl");
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => f.path, onChange: () => {} });
    await plans.refresh([pane("p2", "codex", "t1")]);
    expect(plans.known(pane("p2", "codex", "t1"))).toBe(true);
    // the pane runs another session, not looked up yet: the rollout of the one before is not its plan
    expect(plans.known(pane("p2", "codex", "t2"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("reads a transcript it could not open again at the next poll, though its size is the same", () => {
    const s = claude();
    s.create("One");
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: (_id, summary) => changes.push(summary) });
    void plans.refresh([pane("p1", "claude")]);
    chmodSync(s.path, 0o000);
    try { plans.poll(); } finally { chmodSync(s.path, 0o644); }
    expect(changes).toEqual([]);
    plans.poll();
    expect(changes).toEqual([{ done: 0, total: 1, current: null }]);
  });

  it("reads at most its budget in one poll, and the rest at the next; a request in between reads none of it", () => {
    const big = claude();
    big.create("Far");
    // past the poll's budget: the plan is told only once the read reaches the end
    big.add({ type: "user", timestamp: at(2), message: { role: "user", content: "x".repeat(33 * 1024 * 1024) } });
    big.create("Near", 3);
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => big.path, codexPath: async () => null, onChange: (_id, summary) => changes.push(summary) });
    void plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(changes).toEqual([]);
    // the first read is the poll's, in its shared budget: a request does not read on with a budget of its own
    expect(plans.planOf(pane("p1", "claude"))).toBeNull();
    plans.poll();
    expect(changes).toEqual([{ done: 0, total: 2, current: null }]);
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["Far", "Near"]);
  });
});

describe("readPlan edges", () => {
  it("is caught up on a transcript that ends inside a line, and takes the line once it is whole", () => {
    const s = claude();
    s.create("One");
    appendFileSync(s.path, '{"type":"assistant","timestamp":"2026-10-07T00:09:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_z","name":"TaskCreate","input":{"subject":"Two"}}]}}');
    expect(steps(s.path)).toEqual(["1:pending:"]);
    appendFileSync(s.path, `\n${JSON.stringify({ type: "user", timestamp: at(9), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_z", content: "Task #2 created successfully: Two" }] }, toolUseResult: { task: { id: "2", subject: "Two" } } })}\n`);
    expect(steps(s.path)).toEqual(["1:pending:", "2:pending:"]);
  });

  it("ignores code-mode output and patches that mention update_plan", () => {
    const f = file("rollout.jsonl");
    const call = (name: string, input: string) => ({ timestamp: at(1), type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "c", name, input } });
    f.add(call("apply_patch", "+ tools.update_plan({plan:[{step:'fixture',status:'completed'}]})"));
    f.add(call("exec", "await tools.update_plan({plan:[{step:'real',status:'pending'}]});"));
    f.add({ timestamp: at(2), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "tools.update_plan({plan:[{step:'output',status:'pending'}]})" }] } });
    expect(readPlan("codex-transcript", f.path)).toBeNull();
  });
});
