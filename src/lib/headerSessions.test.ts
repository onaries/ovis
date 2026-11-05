import { expect, it } from "bun:test";
import type { AgentStatus, HerdrPane, TabInfo } from "../../shared/protocol.ts";
import { nextWaitingPane, sessionCounts, tabPosition } from "./headerSessions.ts";

const pane = (pane_id: string, agent_status: AgentStatus, tab_id = "t1", workspace_id = "w1", extra: Partial<HerdrPane> = {}): HerdrPane =>
  ({ pane_id, agent_status, tab_id, workspace_id, focused: false, agent: "claude", ...extra }) as HerdrPane;
const tab = (tab_id: string, workspace_id = "w1"): TabInfo => ({ tab_id, workspace_id }) as TabInfo;
const raw = (p: HerdrPane): AgentStatus | undefined => p.agent_status;

it("places the selected pane's tab among its workspace's tabs", () => {
  const roster = { tabs: [tab("t1"), tab("t2"), tab("t3"), tab("x", "w2")], panes: [pane("a", "idle", "t1"), pane("b", "idle", "t2"), pane("c", "idle", "t3"), pane("d", "idle", "x", "w2")] };
  expect(tabPosition(roster, "b")).toEqual({ index: 2, count: 3 });
  expect(tabPosition(roster, "d")).toBeNull();
  expect(tabPosition(roster, "missing")).toBeNull();
});

it("counts working, waiting and unseen done; background work counts as working", () => {
  const panes = [pane("a", "working"), pane("b", "blocked"), pane("c", "blocked"), pane("d", "done"), pane("e", "idle"), pane("f", "done", "t1", "w1", { background_wait: true })];
  expect(sessionCounts(panes, (p) => (p.background_wait ? "waiting" : p.agent_status))).toEqual({ working: 2, waiting: 2, done: 1 });
  expect(sessionCounts(panes, (p) => (p.pane_id === "d" ? "idle" : raw(p))).done).toBe(1);
  expect(sessionCounts(panes, (p) => (p.pane_id === "d" || p.pane_id === "f" ? "idle" : raw(p))).done).toBe(0);
});

it("opens the next waiting pane after the selected one, wrapping, never the selected one", () => {
  const panes = [pane("a", "blocked"), pane("b", "idle"), pane("c", "blocked"), pane("d", "working")];
  expect(nextWaitingPane(panes, raw, "b")).toBe("c");
  expect(nextWaitingPane(panes, raw, "c")).toBe("a");
  expect(nextWaitingPane(panes, raw, null)).toBe("a");
  expect(nextWaitingPane([pane("a", "blocked"), pane("b", "idle")], raw, "a")).toBeNull();
  expect(nextWaitingPane([pane("a", "idle")], raw, "a")).toBeNull();
});

it("skips a waiting pane its tab's zoom hides, which a pick would never reach", () => {
  const panes = [pane("a", "working", "t1"), pane("b", "blocked", "t1"), pane("c", "blocked", "t2")];
  const zoomed = [{ tab_id: "t1", zoomed: true, focused_pane_id: "a" }] as unknown as Parameters<typeof nextWaitingPane>[3];
  expect(nextWaitingPane(panes, raw, "a", zoomed)).toBe("c");
  expect(nextWaitingPane(panes, raw, "c", zoomed)).toBeNull();
  expect(nextWaitingPane(panes, raw, "a")).toBe("b");
});
