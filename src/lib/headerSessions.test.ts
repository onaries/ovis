import { expect, it } from "bun:test";
import { act, createElement } from "react";
import { create } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot, TabInfo } from "../../shared/protocol.ts";
import { drawerReturnButton, nextWaitingTarget, sessionCounts, sessionCountsAcross, tabPosition, useWaitingRosters, type MachineRoster } from "./headerSessions.ts";

const pane = (pane_id: string, agent_status: AgentStatus, tab_id = "t1", workspace_id = "w1", extra: Partial<HerdrPane> = {}): HerdrPane =>
  ({ pane_id, agent_status, tab_id, workspace_id, focused: false, agent: "claude", ...extra }) as HerdrPane;
const tab = (tab_id: string, workspace_id = "w1"): TabInfo => ({ tab_id, workspace_id }) as TabInfo;
const raw = (p: HerdrPane): AgentStatus | undefined => p.agent_status;
/** the next waiting pane on one PC, as the header's jump picks it */
const nextOnOnePc = (panes: HerdrPane[], selected: string | null, layouts?: MachineRoster<HerdrPane>["layouts"]) =>
  nextWaitingTarget([{ machineId: "local", panes, status: raw, layouts }], { machineId: "local", paneId: selected })?.paneId ?? null;

it("places the selected pane's tab among its workspace's tabs", () => {
  const roster = { tabs: [tab("t1"), tab("t2"), tab("t3"), tab("x", "w2")], panes: [pane("a", "idle", "t1"), pane("b", "idle", "t2"), pane("c", "idle", "t3"), pane("d", "idle", "x", "w2")] };
  expect(tabPosition(roster, "b")).toEqual({ index: 2, count: 3 });
  expect(tabPosition(roster, "d")).toBeNull();
  expect(tabPosition(roster, "missing")).toBeNull();
});

it("counts the sessions waiting for the person; background work is not waiting", () => {
  const panes = [pane("a", "working"), pane("b", "blocked"), pane("c", "blocked"), pane("d", "done"), pane("e", "idle"), pane("f", "blocked", "t1", "w1", { background_wait: true })];
  expect(sessionCounts(panes, (p) => (p.background_wait ? "waiting" : p.agent_status))).toEqual({ waiting: 2 });
});

it("opens the next waiting pane after the selected one, wrapping, never the selected one", () => {
  const panes = [pane("a", "blocked"), pane("b", "idle"), pane("c", "blocked"), pane("d", "working")];
  expect(nextOnOnePc(panes, "b")).toBe("c");
  expect(nextOnOnePc(panes, "c")).toBe("a");
  expect(nextOnOnePc(panes, null)).toBe("a");
  expect(nextOnOnePc([pane("a", "blocked"), pane("b", "idle")], "a")).toBeNull();
  expect(nextOnOnePc([pane("a", "idle")], "a")).toBeNull();
});

it("counts and walks the waiting panes of every connected PC, the selected PC first", () => {
  const rosters = [
    { machineId: "local", panes: [pane("a", "idle"), pane("b", "blocked")], status: raw },
    { machineId: "work", panes: [pane("c", "blocked"), pane("d", "working")], status: raw },
    { machineId: "lab", panes: [pane("e", "blocked")], status: raw },
  ];
  expect(sessionCountsAcross(rosters)).toEqual({ waiting: 3 });
  // from the selected PC's own next, then the PCs after it, wrapping round to the ones before
  expect(nextWaitingTarget(rosters, { machineId: "local", paneId: "a" })).toEqual({ machineId: "local", paneId: "b" });
  expect(nextWaitingTarget(rosters, { machineId: "local", paneId: "b" })).toEqual({ machineId: "work", paneId: "c" });
  expect(nextWaitingTarget(rosters, { machineId: "work", paneId: "c" })).toEqual({ machineId: "lab", paneId: "e" });
  expect(nextWaitingTarget(rosters, { machineId: "lab", paneId: "e" })).toEqual({ machineId: "local", paneId: "b" });
  // the one waiting pane is the selected one: nothing else to open
  expect(nextWaitingTarget([rosters[2]!], { machineId: "lab", paneId: "e" })).toBeNull();
  expect(nextWaitingTarget([], { machineId: "local", paneId: null })).toBeNull();

  // two waiting panes on one PC and one on another: walks the selected PC's later waiting panes,
  // then the other PCs in order, before wrapping back to earlier panes on the selected PC (G-002)
  const twoPlusOne = [
    { machineId: "workstation", panes: [pane("w1", "blocked"), pane("w2", "blocked")], status: raw },
    { machineId: "laptop", panes: [pane("l1", "blocked")], status: raw },
  ];
  expect(sessionCountsAcross(twoPlusOne).waiting).toBe(3);
  expect(nextWaitingTarget(twoPlusOne, { machineId: "workstation", paneId: "w1" })).toEqual({ machineId: "workstation", paneId: "w2" });
  expect(nextWaitingTarget(twoPlusOne, { machineId: "workstation", paneId: "w2" })).toEqual({ machineId: "laptop", paneId: "l1" });
  expect(nextWaitingTarget(twoPlusOne, { machineId: "laptop", paneId: "l1" })).toEqual({ machineId: "workstation", paneId: "w1" });
});

it("skips a waiting pane its tab's zoom hides, which a pick would never reach", () => {
  const panes = [pane("a", "working", "t1"), pane("b", "blocked", "t1"), pane("c", "blocked", "t2")];
  const zoomed = [{ tab_id: "t1", zoomed: true, focused_pane_id: "a" }] as unknown as MachineRoster<HerdrPane>["layouts"];
  expect(nextOnOnePc(panes, "a", zoomed)).toBe("c");
  expect(nextOnOnePc(panes, "c", zoomed)).toBeNull();
  expect(nextOnOnePc(panes, "a")).toBe("b");
});

it("counts the selected PC's waiting panes, and jumps to them, while the sidebar hides that PC", async () => {
  const pc = (id: string, panes: HerdrPane[]): Machine => ({ id, state: "connected", snapshot: { tabs: [], panes, layouts: [] } as unknown as SessionSnapshot }) as unknown as Machine;
  const shown = [pc("local", [pane("a", "idle")])];
  const hidden = pc("work", [pane("w1", "blocked"), pane("w2", "blocked")]);
  const status = (_machineId: string, p: HerdrPane) => p.agent_status;
  let rosters: MachineRoster<HerdrPane>[] = [];
  const before = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  try {
    const Header = ({ selected }: { selected: Machine | undefined }) => { rosters = useWaitingRosters(shown, selected, status); return null; };
    const renderer = await act(async () => create(createElement(Header, { selected: hidden })));
    expect(sessionCountsAcross(rosters).waiting).toBe(2);
    expect(nextWaitingTarget(rosters, { machineId: "work", paneId: "w1" })).toEqual({ machineId: "work", paneId: "w2" });
    // a shown PC selected adds nothing: the hidden one is not counted then
    await act(async () => renderer.update(createElement(Header, { selected: shown[0] })));
    expect(rosters.map((roster) => roster.machineId)).toEqual(["local"]);
    await act(async () => renderer.unmount());
  } finally {
    if (before) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", before);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  }
});

it.each([
  ["only Back to agents is in the header (a thread opened from the list)", [".app-header .inbox-back"], ".app-header .inbox-back"],
  ["the drawer toggle and Back to agents are both in the header", [".app-header .inbox-back", ".app-header .drawer-toggle"], ".app-header .drawer-toggle"],
  ["only the drawer toggle is in the header", [".app-header .drawer-toggle"], ".app-header .drawer-toggle"],
] as const)("gives a closed drawer's focus back to the header's first button when %s", (_case, present, expected) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const buttons = new Map<string, object>(present.map((selector) => [selector, { selector }]));
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: (selector: string) => buttons.get(selector) ?? null } });
  try {
    expect(drawerReturnButton()).toBe(buttons.get(expected) as HTMLElement);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
