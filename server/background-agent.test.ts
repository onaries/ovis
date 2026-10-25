import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, PaneBackgroundAgentDetail } from "../shared/protocol.ts";
import { handleBackgroundAgentRequest, type BackgroundAgentDeps } from "./background-agent.ts";
import { ClaudeSubagentStatus, backgroundAgentDetail, forgetSubagents } from "./claude-subagents.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  forgetSubagents();
});

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";
const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

/** a store with one session per id, each with the subagent `agent` */
function store(): { root: string; transcript: (session: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "herdr-background-agent-"));
  roots.push(root);
  for (const session of [FIRST, SECOND]) {
    const dir = join(root, "projects", "p", session, "subagents");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, "projects", "p", `${session}.jsonl`), json({ type: "user", timestamp: "2026-10-06T11:00:00.000Z", message: { role: "user", content: "go" } }));
    writeFileSync(join(dir, "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: `agent of ${session}`, toolUseId: "toolu_a1" }));
    writeFileSync(join(dir, "agent-a1.jsonl"), json({ isSidechain: true, sessionId: session, agentId: "a1", type: "user", timestamp: "2026-10-06T11:01:00.000Z", message: { role: "user", content: `prompt of ${session}` } }));
  }
  return { root, transcript: (session) => join(root, "projects", "p", `${session}.jsonl`) };
}

/** a `Bash` call of the session `session` sent to the background as the task `id` */
function command(transcript: string, id: string): void {
  appendFileSync(transcript, json({ type: "assistant", timestamp: "2026-10-06T11:02:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: { command: "bun test", run_in_background: true } }] } }));
  appendFileSync(transcript, json({ type: "user", timestamp: "2026-10-06T11:02:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${id}`, content: `Command running in background with ID: ${id}.` }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: id } }));
}

const pane = (session: string, agent = "claude"): HerdrPane => ({ pane_id: "w0:p0", workspace_id: "w0", agent, agent_status: "working", agent_session: { kind: "id", value: session } } as unknown as HerdrPane);

function harness(sessions: string[], agent = "claude", read?: BackgroundAgentDeps["read"]) {
  const files = store();
  const claudeAgents = new ClaudeSubagentStatus({ resolve: async (seen) => ({ path: files.transcript(seen.agent_session?.value ?? ""), startedAt: null, pid: null }), onChange: () => {} });
  const asked: string[] = [];
  const request = (query: string) => handleBackgroundAgentRequest(new Request(`http://local/api/pane/background-agent?${query}`), new URL(`http://local/api/pane/background-agent?${query}`), {
    // herdr answers the pane as it is at each ask: the sessions in turn, the last one from then on
    paneGet: async () => { asked.push("pane"); return pane(sessions[Math.min(asked.length, sessions.length) - 1]!, agent); },
    omoPane: () => false,
    claudeAgents,
    read,
    now: () => Date.parse("2026-10-06T12:00:00.000Z"),
  });
  return { request, asked, files };
}

describe("handleBackgroundAgentRequest", () => {
  it("answers the selected pane's session, looked up before the read and after it", async () => {
    const { request, asked } = harness([FIRST]);
    const response = await request("pane_id=w0:p0&agent_id=a1");
    expect(response.status).toBe(200);
    const body: PaneBackgroundAgentDetail = await response.json();
    expect(body).toMatchObject({ agent_id: "a1", session_id: FIRST, title: `agent of ${FIRST}`, agent: "reviewer", prompt: `prompt of ${FIRST}`, events: [], truncated: false, incomplete: false, server_time: "2026-10-06T12:00:00.000Z" });
    expect(asked).toEqual(["pane", "pane"]);
  });

  it("tells a pane that moved to another session during the read, rather than answering either session's agent", async () => {
    const { request } = harness([FIRST, SECOND]);
    const response = await request("pane_id=w0:p0&agent_id=a1");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "background_target_changed" } });
    // settled on the second session: its own agent is answered from then on
    const settled = await request("pane_id=w0:p0&agent_id=a1");
    expect(settled.status).toBe(200);
    expect(((await settled.json()) as PaneBackgroundAgentDetail).session_id).toBe(SECOND);
  });

  it("refuses an id that is not a plain word before anything is looked up", async () => {
    const { request, asked } = harness([FIRST]);
    for (const id of ["..", "a/b", "%2Fetc%2Fpasswd", "a%00b", "x".repeat(129)]) {
      const response = await request(`pane_id=w0:p0&agent_id=${id}`);
      expect([id.slice(0, 12), response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([id.slice(0, 12), 400, "invalid_agent_id"]);
    }
    expect((await request("pane_id=w0:p0")).status).toBe(400);
    expect((await request("agent_id=a1")).status).toBe(400);
    expect((await request("pane_id=w0:p0&agent_id=a1", )).status).toBe(200);
    expect(asked).toEqual(["pane", "pane"]);
  });

  it("has no detail for another agent's pane, an OmO pane, or an agent the session does not have", async () => {
    const codex = harness([FIRST], "codex");
    const other = await codex.request("pane_id=w0:p0&agent_id=a1");
    expect([other.status, ((await other.json()) as { error: { code: string } }).error.code]).toEqual([501, "background_detail_unsupported"]);
    const omo = await handleBackgroundAgentRequest(new Request("http://local/api/pane/background-agent?pane_id=w0:p0&agent_id=a1"), new URL("http://local/api/pane/background-agent?pane_id=w0:p0&agent_id=a1"), {
      paneGet: async () => { throw new Error("not asked"); }, omoPane: () => true, claudeAgents: { ensure: async () => {}, sessionOf: () => null },
    });
    expect(omo.status).toBe(501);
    const { request } = harness([FIRST]);
    const missing = await request("pane_id=w0:p0&agent_id=nobody");
    expect([missing.status, ((await missing.json()) as { error: { code: string } }).error.code]).toEqual([404, "background_agent_not_found"]);
  });

  it("has no detail for a background command, though files bear its id", async () => {
    const { request, files } = harness([FIRST]);
    command(files.transcript(FIRST), "a1");
    const response = await request("pane_id=w0:p0&agent_id=a1");
    const text = await response.text();
    expect([response.status, (JSON.parse(text) as { error: { code: string } }).error.code]).toEqual([501, "background_detail_unsupported"]);
    expect(text).not.toContain("prompt of");
  });

  it("tells a pane whose session changed while the read was out, and answers nothing of the read", async () => {
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sessions = [FIRST];
    const { request } = harness(sessions, "claude", async (path, id) => { const read = backgroundAgentDetail(path, id); entered(); await gate; return read; });
    const answer = request("pane_id=w0:p0&agent_id=a1");
    await held;
    // the pane's Claude is now on the second session, which has an agent of the same id
    sessions.push(SECOND);
    release();
    const response = await answer;
    const text = await response.text();
    expect([response.status, (JSON.parse(text) as { error: { code: string } }).error.code]).toEqual([409, "background_target_changed"]);
    expect(text).not.toContain("prompt of");
  });
});
