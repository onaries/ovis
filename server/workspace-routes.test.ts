import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { PendingMessage, ServerMessage } from "../shared/protocol.ts";
import * as agentLaunchModule from "./agent-launch.ts";
import * as herdr from "./herdr/client.ts";
import { handleWorkspaceRequest } from "./workspace-routes.ts";

/** each herdr create, launch, queued message and broadcast a create makes, in the order made */
const calls: string[] = [];
const made = (workspace: string) => ({ workspace: { workspace_id: workspace }, tab: { workspace_id: workspace, tab_id: `${workspace}:t1` }, root_pane: { pane_id: `${workspace}:p1` } });
// no herdr answers here: the create calls stand in for it, and the launch starts nothing
beforeEach(() => {
  calls.length = 0;
  spyOn(herdr, "tabCreate").mockImplementation(async () => { calls.push("tab.create"); return made("w1") as never; });
  spyOn(herdr, "workspaceCreate").mockImplementation(async () => { calls.push("workspace.create"); return made("w2") as never; });
  spyOn(herdr, "worktreeCreate").mockImplementation(async () => { calls.push("worktree.create"); return { ...made("w3"), worktree: { path: "/repo-feature", branch: "feature" } } as never; });
  spyOn(agentLaunchModule, "agentLaunch").mockImplementation(async () => { await Promise.resolve(); calls.push("launch"); return { agent_started: true }; });
});
afterEach(() => mock.restore());

async function post(path: string, body: unknown): Promise<Response> {
  const request = new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const queue = async (): Promise<PendingMessage> => { await Promise.resolve(); calls.push("queue"); return { id: "m1" } as PendingMessage; };
  const response = await handleWorkspaceRequest(request, new URL(request.url), path, { timeout: () => {} },
    (message: ServerMessage) => { calls.push(message.type); }, queue, () => ({ order_epoch: "e", moved_seq: 1 }));
  calls.push("answer");
  return response!;
}

describe("a create answers after the roster is told", () => {
  // the page draws a new pane only once the roster lists it: without this push, the roster is read
  // only after the collector's debounced pane.created, about 500 ms after herdr made the pane
  it.each([
    ["/api/tab/create", { workspace_id: "w1" }, ["tab.create", "session-changed", "answer"]],
    ["/api/tab/create", { workspace_id: "w1", agent: { kind: "claude" } }, ["tab.create", "launch", "session-changed", "answer"]],
    ["/api/tab/create", { workspace_id: "w1", agent: { kind: "claude" }, first_message: "hello" }, ["tab.create", "launch", "queue", "session-changed", "answer"]],
    ["/api/workspace/create", {}, ["workspace.create", "session-changed", "answer"]],
    ["/api/workspace/create", { agent: { kind: "claude" } }, ["workspace.create", "launch", "session-changed", "answer"]],
    ["/api/worktree/create", { workspace_id: "w1", branch: "feature" }, ["worktree.create", "session-changed", "answer"]],
    ["/api/worktree/create", { workspace_id: "w1", branch: "feature", agent: { kind: "claude" } }, ["worktree.create", "launch", "session-changed", "answer"]],
  ] as const)("%s %j", async (path, body, order) => {
    const response = await post(path, body);
    expect(response.status).toBe(200);
    // once, and after the launch: a roster read beside the launch's own herdr calls slows both
    expect(calls).toEqual([...order]);
  });
});
