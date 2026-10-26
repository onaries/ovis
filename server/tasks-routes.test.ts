import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as herdr from "./herdr/client.ts";
import { HerdrError } from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { handleTasksRequest } from "./tasks-routes.ts";

describe("GET /api/pane/omo-tasks", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const error = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

  beforeAll(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ovis-tasks-route-"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  });
  afterAll(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("wants GET and a pane", async () => {
    expect(await error(await fetch(url("/api/pane/omo-tasks?pane_id=w1:p1"), { method: "POST", headers: { origin: url("") } }))).toEqual([400, "method_not_allowed"]);
    expect(await error(await fetch(url("/api/pane/omo-tasks")))).toEqual([400, "missing_pane_id"]);
  });

  it("answers no tasks and no runs, on this PC's clock, for a pane that runs neither OmO nor Claude Code", async () => {
    const get = spyOn(herdr, "paneGet").mockImplementation(async (paneId) => { throw new HerdrError("pane_not_found", `pane ${paneId} not found`); });
    try {
      const response = await fetch(url("/api/pane/omo-tasks?pane_id=w9:p9"));
      expect(response.status).toBe(200);
      const body = await response.json() as { tasks: unknown[]; runs: unknown[]; server_time: string };
      expect(body.tasks).toEqual([]);
      expect(body.runs).toEqual([]);
      expect(Number.isFinite(Date.parse(body.server_time))).toBe(true);
      expect(get).toHaveBeenCalledWith("w9:p9");
    } finally {
      get.mockRestore();
    }
  });

  it("answers what is known when herdr does not answer the pane lookup", async () => {
    let answer: () => void = () => undefined;
    const get = spyOn(herdr, "paneGet").mockImplementation(() => new Promise((_resolve, reject) => { answer = () => reject(new HerdrError("timeout", "herdr did not answer")); }));
    try {
      const response = await fetch(url("/api/pane/omo-tasks?pane_id=w9:p8"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ tasks: [], runs: [] });
    } finally {
      answer();
      get.mockRestore();
    }
  });
});

describe("handleTasksRequest with an OmO session", () => {
  it("answers the session's tasks and workflows from its records on this PC's clock, and asks the subagent trackers nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "ovis-tasks-omo-"));
    try {
      const dir = join(cwd, ".omo", "senpi-task", "tasks");
      mkdirSync(dir, { recursive: true });
      const started = new Date(Date.now() - 60_000).toISOString();
      writeFileSync(join(dir, "st_1.json"), JSON.stringify({ task_id: "st_1", parent_session_id: "session-1", host_pid: process.pid, status: "running", task_summary: "index the repo", started_at: started }));
      const runs = join(cwd, ".omo", "senpi-task", "dag", "runs");
      mkdirSync(runs, { recursive: true });
      writeFileSync(join(runs, "dag_1.json"), JSON.stringify({ runId: "dag_1", parentSessionId: "session-1", name: "Bug-fix round", status: "running", nodes: [] }));
      const claudeAgents = { sessionOf: () => { throw new Error("not asked"); }, ensure: async () => { throw new Error("not asked"); } };
      const opencodeAgents = { sessionOf: () => { throw new Error("not asked"); }, ensure: () => { throw new Error("not asked"); }, tasksOf: () => { throw new Error("not asked"); }, beginRead: () => { throw new Error("not asked"); } };
      const response = await handleTasksRequest(new Request("http://localhost/api/pane/omo-tasks?pane_id=w1:p1"), new URL("http://localhost/api/pane/omo-tasks?pane_id=w1:p1"), "/api/pane/omo-tasks", { omo: { sessionOf: (paneId) => paneId === "w1:p1" ? { cwd, sessionId: "session-1" } : null }, claudeAgents, opencodeAgents });
      expect(response?.status).toBe(200);
      const body = await response!.json() as { tasks: { id: string; title: string; status: string }[]; runs: { id: string; name: string; status: string }[]; server_time: string };
      expect(body.tasks.map((task) => [task.id, task.title, task.status])).toEqual([["st_1", "index the repo", "running"]]);
      expect(body.runs.map((run) => [run.id, run.name, run.status])).toEqual([["dag_1", "Bug-fix round", "running"]]);
      expect(Number.isFinite(Date.parse(body.server_time))).toBe(true);
      expect(await handleTasksRequest(new Request("http://localhost/api/pane/plan"), new URL("http://localhost/api/pane/plan"), "/api/pane/plan", { omo: { sessionOf: () => null }, claudeAgents, opencodeAgents })).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
