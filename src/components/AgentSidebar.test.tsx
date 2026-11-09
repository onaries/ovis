import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { currentAgentRowTokens, setAgentRowTokens } from "../lib/agentRowTokens.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SidebarActivityProvider } from "../lib/sidebarActivity.tsx";
import type { SidebarFilter } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../lib/sidebarFilterContext.ts";
import { setSidebarPins } from "../lib/sidebarPins.ts";
import { AgentSidebar } from "./AgentSidebar.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const paneId = "w1C:p1";

function roster(tokens: Record<string, string> = { quota: "95%" }): Machine[] {
  return structuredClone(fixture).map((machine) => ({
    ...machine,
    snapshot: machine.snapshot === null ? null : {
      ...machine.snapshot,
      panes: machine.snapshot.panes.map((pane) => ({ ...pane, tokens: pane.pane_id === paneId ? tokens : {} })),
    },
  }));
}

describe("AgentSidebar phone sheet live row", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let historyState: unknown;
  let steppedBack: Promise<void>;
  let originalTokens: ReturnType<typeof currentAgentRowTokens>;
  // RowMenu asks the anchor whether it sits inside a dialog; this row is not in one.
  const anchor = { isConnected: true, focus() {}, querySelector: () => null, closest: () => null };

  beforeEach(() => {
    originalTokens = currentAgentRowTokens();
    setAgentRowTokens(null);
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    historyState = null;
    let onBack = () => {};
    steppedBack = new Promise<void>((resolve) => { onBack = resolve; });
    const events = new EventTarget();
    const media = { matches: true, addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => media,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      location: { href: "http://localhost/" },
      history: {
        get state() { return historyState; },
        pushState(state: unknown) { historyState = state; },
        replaceState(state: unknown) { historyState = state; },
        back() { historyState = null; onBack(); },
      },
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      // Portals use the test renderer's host container, not a DOM renderer.
      body: { nodeType: 1, children: [], createNodeMock: () => null },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    // leaveSheet schedules history cleanup; await that signal before restoring window.
    if (historyState !== null) await steppedBack;
    setAgentRowTokens(originalTokens);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const view = (machines: Machine[]) => <SettingsProvider>
    <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
  </SettingsProvider>;

  it("says how long an agent has waited only for a wait this page saw begin, never a reload's guess", async () => {
    const at = (status: AgentStatus) => roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    // already waiting when the page opened: herdr says nothing of when it began, so the row says no time
    await act(async () => { renderer = create(view(at("blocked"))); });
    expect(since()).toEqual([]);
    // a wait this page sees begin says how long it has lasted
    await act(async () => { renderer!.update(view(at("working"))); });
    expect(since()).toEqual([]);
    await act(async () => { renderer!.update(view(at("blocked"))); });
    expect(since()).toEqual(["<1m"]);
  });

  it("makes no wait time from a PC's return: a wait it finds there began out of sight", async () => {
    const at = (status: AgentStatus, state: Machine["state"] = "connected") => roster().map((machine) => ({ ...machine, ...(machine.id === "local" ? { state } : {}), snapshot: machine.snapshot && {
      ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: status } : pane),
    } }));
    const since = () => renderer!.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findAll((node) => node.props.className === "agent-since").map((node) => node.children.join(""));
    await act(async () => { renderer = create(view(at("working"))); });
    await act(async () => { renderer!.update(view(at("working", "disconnected"))); });
    await act(async () => { renderer!.update(view(at("blocked"))); });
    expect(since()).toEqual([]);
  });

  async function open() {
    await act(async () => {
      renderer = create(view(roster()), { createNodeMock: () => anchor });
    });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const row = () => mounted.root.findByProps({ "data-machine": "local", "data-pane": paneId });
    await act(async () => { row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props.onClick({ currentTarget: anchor }); });
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findByProps({ className: "row-menu-target-name" }).children).toEqual(["Idempotent payments"]);
    expect(mounted.root.findByProps({ className: "row-menu-target-place" }).children).toEqual(["checkout-api"]);
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["95%"]);
    return {
      mounted,
      row,
      update: async (machines: Machine[]) => { await act(async () => { mounted.update(view(machines)); }); },
    };
  }

  // Settings -> Lock pinned agents (experimental), as this device's stored settings carry it
  const lockSetting = (agentLocks: boolean, lockedAgents: string[] = []) => {
    (globalThis.window as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
      getItem: (key) => key === "ovis:settings" ? JSON.stringify({ agentLocks, lockedAgents }) : null, setItem() {}, removeItem() {},
    };
  };

  it("offers no lock, and holds none, until Lock pinned agents is turned on (#2432)", async () => {
    lockSetting(false, [`local:${paneId}`]);
    setSidebarPins([`local:${paneId}`]);
    try {
      const { mounted } = await open();
      expect((mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).map((item) => item.id)).toEqual(["unpin"]);
      expect(mounted.root.findAllByProps({ "data-testid": "agent-locked" })).toHaveLength(0);
    } finally {
      setSidebarPins([]);
    }
  });

  it("locks only a pinned row, which keeps its pin and shows a lock until it is unlocked (#2432)", async () => {
    lockSetting(true);
    setSidebarPins([]);
    try {
      const { mounted } = await open();
      const items = () => mounted.root.findByType(RowMenu).props.items as RowMenuItem[];
      const ids = () => items().map((item) => item.id);
      const run = async (id: string) => { await act(async () => { items().find((item) => item.id === id)!.run(); }); };
      const lockIcons = () => mounted.root.findAllByProps({ "data-testid": "agent-locked" });
      expect(ids()).toEqual(["pin"]);
      await act(async () => { setSidebarPins([`local:${paneId}`]); });
      expect(ids()).toEqual(["unpin", "lock"]);
      await run("lock");
      expect(ids()).toEqual(["unlock"]);
      expect(lockIcons()).toHaveLength(1);
      await run("unlock");
      expect(ids()).toEqual(["unpin", "lock"]);
      expect(lockIcons()).toHaveLength(0);
    } finally {
      setSidebarPins([]);
    }
  });

  // Settings -> Named agent groups, as this device's stored settings carry it
  const groupSetting = (agentNamedGroups: boolean, agentGroupOf: Record<string, string> = {}, folded: string[] = []) => {
    (globalThis.window as unknown as { localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> }).localStorage = {
      getItem: (key) => key === "ovis:settings" ? JSON.stringify({ agentNamedGroups, agentGroupNames: ["Agents", "Tasks"], agentGroupOf })
        : key === "ovis:agent-group-folds" ? JSON.stringify(folded) : null,
      setItem() {}, removeItem() {},
    };
  };
  const groupHeadings = (mounted: ReactTestRenderer) => mounted.root.findAllByProps({ className: "agent-named-group-name" }).map((node) => node.children.join(""));

  it("draws no named group and offers no move until Named agent groups is turned on (#2431)", async () => {
    groupSetting(false, { [`local:${paneId}`]: "Tasks" });
    const { mounted } = await open();
    expect(groupHeadings(mounted)).toEqual([]);
    expect((mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).map((item) => item.id)).toEqual(["pin"]);
  });

  it("draws a row under its named group and moves it from the row's menu (#2431)", async () => {
    groupSetting(true, { [`local:${paneId}`]: "Tasks" });
    const { mounted } = await open();
    const items = () => mounted.root.findByType(RowMenu).props.items as RowMenuItem[];
    const run = async (id: string) => { await act(async () => { items().find((item) => item.id === id)!.run(); }); };
    expect(groupHeadings(mounted)).toContain("Tasks");
    expect(items().map((item) => item.id)).toEqual(["pin", "group:Agents", "ungroup"]);
    await run("group:Agents");
    expect(groupHeadings(mounted)).toContain("Agents");
    expect(groupHeadings(mounted)).not.toContain("Tasks");
    // the open menu follows the row into its new group
    expect(items().map((item) => item.id)).toEqual(["pin", "group:Tasks", "ungroup"]);
    await run("ungroup");
    expect(groupHeadings(mounted)).toEqual([]);
  });

  it("folds a named group, keeping its count and its rows out of sight (#2431)", async () => {
    groupSetting(true, { [`local:${paneId}`]: "Tasks" });
    const { mounted, row } = await open();
    const toggle = mounted.root.findByProps({ "data-named-group": "Tasks" }).findByType("button");
    expect(toggle.props["aria-expanded"]).toBe(true);
    await act(async () => { toggle.props.onClick(); });
    expect(mounted.root.findByProps({ "data-named-group": "Tasks" }).findByType("button").props["aria-expanded"]).toBe(false);
    expect(row().props.hidden).toBe(true);
  });

  it("offers no group move for a background agent, which stays under Background agents (#2431)", async () => {
    groupSetting(true);
    await act(async () => { renderer = create(view(roster({ role: "background" })), { createNodeMock: () => anchor }); });
    const mounted = renderer!;
    await act(async () => { mounted.root.findByProps({ "data-machine": "local", "data-pane": paneId }).findByProps({ className: "sidebar-row-action row-menu-toggle" }).props.onClick({ currentTarget: anchor }); });
    expect((mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).map((item) => item.id)).toEqual(["pin"]);
  });

  it("opens a folded group a row is moved into, so the row stays in sight (#2431)", async () => {
    groupSetting(true, { [`local:${paneId}`]: "Tasks" }, ["Agents"]);
    const { mounted, row } = await open();
    await act(async () => { (mounted.root.findByType(RowMenu).props.items as RowMenuItem[]).find((item) => item.id === "group:Agents")!.run(); });
    expect(mounted.root.findByProps({ "data-named-group": "Agents" }).findByType("button").props["aria-expanded"]).toBe(true);
    expect(row().props.hidden).toBeUndefined();
  });

  it("updates the open sheet when a plugin value changes", async () => {
    // Given an open sheet with the original quota.
    const { mounted, update } = await open();
    // When a new roster reports a different quota.
    await update(roster({ quota: "40%" }));
    // Then the sheet shows the new value without reopening.
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["40%"]);
  });

  it("says a blocked agent's whole reason in the open sheet, which has no tooltip", async () => {
    const { mounted, update } = await open();
    // When herdr-core reports the agent blocked on a permission, with its message.
    await update(roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : {
        ...machine.snapshot,
        panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: "blocked" as const, agent_kind: "permission", agent_message: "Allow bash?" } : pane),
      },
    })));
    // Then the sheet gives the reason in full before the plugin values.
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["Needs permission: Allow bash? \u00b7 95%"]);
  });

  it("removes the sheet detail when a token is deleted", async () => {
    const { mounted, update } = await open();
    // When the pane no longer reports any tokens.
    await update(roster({}));
    // Then the open sheet has no stale detail.
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findAllByProps({ className: "row-sheet-detail" })).toHaveLength(0);
  });

  it("removes the sheet detail when a new hide rule matches", async () => {
    const { mounted } = await open();
    // When the live sidebar configuration hides the current quota.
    await act(async () => { setAgentRowTokens({ rows: [{ name: "quota", rules: [{ equals: "95%", hide: true }] }], by_agent: {} }); });
    // Then the open sheet follows the same visibility rule as its row.
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findAllByProps({ className: "row-sheet-detail" })).toHaveLength(0);
  });

  for (const state of ["connecting", "reconnecting"] as const) {
    it(`keeps the sheet open when its PC briefly enters ${state} then recovers`, async () => {
      // Given an open sheet whose row and anchor will remain present.
      const { mounted, row, update } = await open();
      // When a transient connection state is followed by a recovered roster.
      await update(roster().map((machine) => ({ ...machine, state })));
      expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
      expect(row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props["aria-expanded"]).toBe(true);
      expect(row().findAllByProps({ className: "agent-tokens" })).toHaveLength(0);
      expect(mounted.root.findAllByProps({ className: "row-sheet-detail" })).toHaveLength(0);
      await update(roster({ quota: "40%" }));
      // Then the same open sheet resumes showing the row's current values.
      expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
      expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["40%"]);
    });
  }

  for (const state of ["disconnected", "error"] as const) {
    it(`closes the sheet when its PC enters ${state} with a cached roster`, async () => {
      // Given an open sheet and a cached row.
      const { mounted, row, update } = await open();
      // When the PC reaches a terminal connection state but retains its snapshot.
      await update(roster().map((machine) => ({ ...machine, state })));
      // Then the row remains available but its sheet is closed.
      expect(row().findByProps({ className: "agent-select agent-row" }).props.disabled).toBe(true);
      expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
      expect(row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props["aria-expanded"]).toBe(false);
    });
  }

  it("keeps the sheet closed when a disconnected PC reconnects", async () => {
    const { mounted, update } = await open();
    await update(roster().map((machine) => ({ ...machine, state: "disconnected" })));
    // When the PC reconnects, a retired sheet must not reopen.
    await update(roster({ quota: "40%" }));
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });

  it("keeps the sheet closed when a removed row returns", async () => {
    const { mounted, update } = await open();
    await update([]);
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    // When a row with the same identity later returns.
    await update(roster());
    // Then removal has retired the menu state, not merely hidden the sheet.
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
  });
});

describe("AgentSidebar fold memory", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const FOLD_KEY = "ovis:agents-collapsed";
  let renderer: ReactTestRenderer | undefined;
  let stored: Map<string, string>;
  let writes: string[];
  let phone: boolean;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    stored = new Map();
    writes = [];
    phone = false;
    const events = new EventTarget();
    const localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { writes.push(key); stored.set(key, value); },
      removeItem: (key: string) => { writes.push(key); stored.delete(key); },
    };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage,
      matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      location: { href: "http://localhost/" },
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      body: { nodeType: 1, children: [] },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const inactive: SidebarFilter = { query: "", active: false, machines: new Map(), matches: 0 };
  const view = (filter: SidebarFilter) => <SettingsProvider>
    <SidebarFilterProvider value={{ filter, reportBranches: () => {} }}>
      <AgentSidebar machines={roster()} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
    </SidebarFilterProvider>
  </SettingsProvider>;

  async function mount(filter = inactive) {
    await act(async () => { renderer = create(view(filter)); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const toggle = () => mounted.root.findByProps({ className: "agent-section-toggle sidebar-section-label" });
    return {
      expanded: (): boolean => toggle().props["aria-expanded"],
      click: async () => { await act(async () => { toggle().props.onClick(); }); },
      remount: async (next = filter) => {
        await act(async () => { mounted.unmount(); });
        return mount(next);
      },
    };
  }

  it("keeps the defaults with nothing stored: open on a desktop, folded in the phone drawer", async () => {
    expect((await mount()).expanded()).toBe(true);
    await act(async () => { renderer?.unmount(); });
    phone = true;
    expect((await mount()).expanded()).toBe(false);
    expect(writes).toEqual([]);
  });

  it("remembers the reader's fold across a reload", async () => {
    // Given a desktop list the reader folds.
    const sidebar = await mount();
    await sidebar.click();
    expect(sidebar.expanded()).toBe(false);
    // When the page loads again, the fold is still there.
    const reloaded = await sidebar.remount();
    expect(reloaded.expanded()).toBe(false);
    // And opening it again is remembered too.
    await reloaded.click();
    expect((await reloaded.remount()).expanded()).toBe(true);
  });

  it("lets a stored choice win over the screen's default", async () => {
    phone = true;
    stored.set(FOLD_KEY, "0");
    expect((await mount()).expanded()).toBe(true);
    await act(async () => { renderer?.unmount(); });
    phone = false;
    stored.set(FOLD_KEY, "1");
    expect((await mount()).expanded()).toBe(false);
  });

  it("opening an agent's helpers keeps another tab's choices and a loading PC's, and drops a gone pane's (#772)", async () => {
    // Given Fold helpers under their agent, a helper under each of two agents, and a second PC still loading.
    stored.set("ovis:fold-helpers", "true");
    stored.set("ovis:agents-helpers-open", JSON.stringify(["pc2:w1:p1", "local:gone:p1"]));
    const parents: Record<string, string> = { "w1E:p1": "w1C:p1", "w1F:p1": "w1D:p1" };
    const machines = roster().map((machine) => machine.snapshot === null ? machine : { ...machine, snapshot: { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => parents[pane.pane_id] ? { ...pane, parent_pane_id: parents[pane.pane_id] } : pane) } });
    machines.push({ id: "pc2", name: "laptop", kind: "ssh", enabled: true, state: "connecting", error: null, snapshot: null } as Machine);
    await act(async () => {
      renderer = create(<SettingsProvider><SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider></SettingsProvider>);
    });
    const line = (agent: string) => renderer!.root.find((node) => node.props["data-helpers-of"] === `local:${agent}`).findByType("button");
    expect(line("w1C:p1").props["aria-expanded"]).toBe(false);
    // When another tab opens the second agent's helpers, then this tab opens the first's.
    stored.set("ovis:agents-helpers-open", JSON.stringify(["pc2:w1:p1", "local:gone:p1", "local:w1D:p1"]));
    await act(async () => { line("w1C:p1").props.onClick(); });
    // Then both are kept with the loading PC's, and the pane gone from a loaded PC leaves.
    expect(JSON.parse(stored.get("ovis:agents-helpers-open")!)).toEqual(["pc2:w1:p1", "local:w1D:p1", "local:w1C:p1"]);
    expect(line("w1C:p1").props["aria-expanded"]).toBe(true);
  });

  it("never writes the filter's temporary fold", async () => {
    // Given a filter that keeps no agent rows.
    const sidebar = await mount({ query: "nothing", active: true, machines: new Map(), matches: 0 });
    const before = sidebar.expanded();
    // When the reader folds and opens the list during the filter.
    await sidebar.click();
    expect(sidebar.expanded()).toBe(!before);
    await sidebar.click();
    // Then nothing is stored, and the list comes back with the screen's default.
    expect(writes).toEqual([]);
    expect((await sidebar.remount(inactive)).expanded()).toBe(true);
  });

  it("draws the composer's context ring on agent rows only while Context left on agent rows is on", async () => {
    // Given three agents: one with 40% left, one with 15% left, one whose window is not known.
    const contexts: Record<string, { used: number; window: number | null }> = {
      [paneId]: { used: 120_000, window: 200_000 },
      "w1E:p1": { used: 170_000, window: 200_000 },
      "w1F:p1": { used: 30_000, window: null },
    };
    const filled = roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => contexts[pane.pane_id] ? { ...pane, context: contexts[pane.pane_id] } : pane) },
    }));
    const rings = async () => {
      await act(async () => { renderer?.unmount(); });
      await act(async () => { renderer = create(<SettingsProvider><SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={filled} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider></SettingsProvider>); });
      return renderer!.root.findAll((node) => node.type === "span" && node.props["data-testid"] === "context-left")
        .map((node) => [node.props["aria-label"], node.props.className]);
    };
    // When the setting was never chosen, no row draws a ring.
    expect(await rings()).toEqual([]);
    // When it is on, the rows with a known window draw the ring with the composer's words, red at 20% left or less.
    stored.set("ovis:sidebar-context", "true");
    expect(await rings()).toEqual([
      ["Context 40% left · 120k of 200k tokens", "context-count"],
      ["Context 15% left · 170k of 200k tokens", "context-count is-low"],
    ]);
  });

  it("draws the groups in one list, so a row whose state changes moves to its new group instead of being drawn anew", async () => {
    // Given grouping on for this device.
    stored.set("ovis:agent-groups", "true");
    const blockedRoster = (blocked: boolean) => roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === paneId ? { ...pane, agent_status: blocked ? "blocked" as const : "working" as const } : pane) },
    }));
    const grouped = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await act(async () => { renderer = create(grouped(blockedRoster(false))); });
    const mounted = renderer!;
    const list = () => mounted.root.findByProps({ className: "agent-list agent-list-grouped" });
    // the group a row stands under: the last heading before it in the one list
    const groupOf = (pane: string): string | undefined => {
      let group: string | undefined;
      for (const child of list().children) {
        if (typeof child === "string") continue;
        if (child.props.className === "agent-group-label") group = child.props["data-group"];
        if (child.props["data-pane"] === pane) return group;
      }
      return undefined;
    };
    expect(groupOf(paneId)).toBe("working");
    // When the agent becomes blocked, its row is still a child of the same list, now under Needs you.
    await act(async () => { mounted.update(grouped(blockedRoster(true))); });
    expect(groupOf(paneId)).toBe("blocked");
    expect(mounted.root.findAllByProps({ className: "agent-list" })).toHaveLength(0);
  });

  it("keeps a background row's element when it becomes blocked and moves up, so its focus and open menu stay", async () => {
    // Given an opened background part holding the agent, which works, and another background agent.
    stored.set("ovis:agents-background-collapsed", "0");
    const tagged = (blocked: boolean) => roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) =>
        pane.pane_id === paneId ? { ...pane, tokens: { role: "background" }, agent_status: blocked ? "blocked" as const : "working" as const }
        : pane.pane_id === "w1E:p1" ? { ...pane, tokens: { role: "background" } } : pane) },
    }));
    const view = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await act(async () => { renderer = create(view(tagged(false))); });
    const mounted = renderer!;
    const row = () => mounted.root.find((node) => node.type === "li" && node.props["data-pane"] === paneId);
    const order = () => mounted.root.findAll((node) => node.type === "li" && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label")).map((node) => node.props["data-pane"] ?? "BG");
    expect(order().indexOf(paneId)).toBeGreaterThan(order().indexOf("BG"));
    const before = row();
    // When it becomes blocked, it stands above the background heading as the same element.
    await act(async () => { mounted.update(view(tagged(true))); });
    expect(order().indexOf(paneId)).toBeLessThan(order().indexOf("BG"));
    expect(row()).toBe(before);
  });

  it("orders the groups the same whichever Agents order is chosen: ties keep herdr's order, not Activity's", async () => {
    // Given grouping on, ordered by name, and two idle agents with the same name (w1F changed after w1E).
    stored.set("ovis:agent-groups", "true");
    stored.set("ovis:agent-group-sort", JSON.stringify("name"));
    const sameNames = roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === "w1E:p1" || pane.pane_id === "w1F:p1" ? { ...pane, label: "Same" } : pane) },
    }));
    const seqs = new Map([["w1E:p1", 43], ["w1F:p1", 44]]);
    const activity = { seqs: () => seqs, status: (_machineId: string, pane: { agent_status?: AgentStatus }) => pane.agent_status };
    const order = async (agentOrder: string): Promise<string[]> => {
      stored.set("ovis:settings", JSON.stringify({ agentOrder }));
      await act(async () => { renderer?.unmount(); });
      await act(async () => { renderer = create(<SettingsProvider><SidebarActivityProvider value={activity}>
        <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
          <AgentSidebar machines={sameNames} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
        </SidebarFilterProvider>
      </SidebarActivityProvider></SettingsProvider>); });
      return renderer!.root.findAll((node) => typeof node.type === "string" && node.props["data-pane"] !== undefined).map((node) => node.props["data-pane"]);
    };
    // Then Activity, which puts w1F first by its later change, does not leak into the grouped order.
    expect(await order("activity")).toEqual(await order("workspace"));
  });

  it("a resting row turning blocked while the pointer or focus is in the list does not enter until it leaves", async () => {
    // Waiting first: the order that moves a row by its state, and its resting fold
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    const withStatuses = (overrides: Record<string, AgentStatus>) => roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : {
        ...machine.snapshot,
        panes: machine.snapshot.panes.map((pane) => overrides[pane.pane_id] ? { ...pane, agent_status: overrides[pane.pane_id] } : pane),
      },
    }));
    const renderList = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await act(async () => { renderer = create(renderList(roster())); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const section = () => mounted.root.findByType("section");
    const drawnEntries = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label agent-resting-label"))
      .map((node) => node.props["data-pane"] ?? "RESTING");
    const restingLabel = () => mounted.root.findByProps({ className: "agent-background-label agent-resting-label" }).findByType("span").children.join("");
    // Initially w1D:p1 (blocked) and w1C:p1 (working) are drawn above the resting line; w1E:p1 and w1F:p1 are resting (+2 resting).
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+2 resting");

    // When the pointer enters the list and a resting row (w1E:p1) turns blocked:
    await act(async () => { section().props.onPointerEnter(); });
    await act(async () => { mounted.update(renderList(withStatuses({ "w1E:p1": "blocked" }))); });
    // Then the drawn rows do not change, the resting count updates, and the row joins only after the pointer leaves.
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+1 resting");
    await act(async () => { section().props.onPointerLeave(); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1E:p1", "w1C:p1", "RESTING"]);

    // Continuing from that state, while keyboard focus is inside the list, another resting row (w1F:p1) turning blocked also waits until focus leaves:
    await act(async () => { section().props.onFocus(); });
    await act(async () => { mounted.update(renderList(withStatuses({ "w1E:p1": "blocked", "w1F:p1": "blocked" }))); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1E:p1", "w1C:p1", "RESTING"]);
    await act(async () => { section().props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1E:p1", "w1F:p1", "w1C:p1"]);
  });

  it("an active row turning idle while the pointer or focus is in the list keeps its place above the resting line until both leave", async () => {
    // Waiting first: the order that moves a row by its state, and its resting fold
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    const withStatuses = (overrides: Record<string, AgentStatus>) => roster().map((machine) => ({
      ...machine,
      snapshot: machine.snapshot === null ? null : {
        ...machine.snapshot,
        panes: machine.snapshot.panes.map((pane) => overrides[pane.pane_id] ? { ...pane, agent_status: overrides[pane.pane_id] } : pane),
      },
    }));
    const renderList = (machines: Machine[]) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
        <AgentSidebar machines={machines} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    await act(async () => { renderer = create(renderList(roster())); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const section = () => mounted.root.findByType("section");
    const drawnEntries = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label agent-resting-label"))
      .map((node) => node.props["data-pane"] ?? "RESTING");
    const restingLabel = () => mounted.root.findByProps({ className: "agent-background-label agent-resting-label" }).findByType("span").children.join("");
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+2 resting");

    // When both pointer and focus are in the list, and the selected working row (w1C:p1) and the nonselected blocked row (w1D:p1) turn idle:
    await act(async () => { section().props.onPointerEnter(); section().props.onFocus(); });
    await act(async () => { mounted.update(renderList(withStatuses({ [paneId]: "idle", "w1D:p1": "idle" }))); });
    // Then both stay in place above the resting heading (neither jumps below RESTING nor disappears), while the resting count updates at once:
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);
    expect(restingLabel()).toBe("+4 resting");

    // Leaving pointer alone keeps the hold while focus remains:
    await act(async () => { section().props.onPointerLeave(); });
    expect(drawnEntries()).toEqual(["w1D:p1", "w1C:p1", "RESTING"]);

    // Once focus leaves too, the idle rows move into the resting fold (the selected w1C:p1 stays visible below the heading):
    await act(async () => { section().props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });
    expect(drawnEntries()).toEqual(["RESTING", "w1C:p1"]);
  });

  it("keeps rows still for one second after a touch ends, then applies the new order without changing selection", async () => {
    // Waiting first: the order that moves a row by its state, and its resting fold
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    jest.useFakeTimers();
    try {
      const renderList = (blocked: boolean) => <SettingsProvider>
        <SidebarFilterProvider value={{ filter: inactive, reportBranches: () => {} }}>
          <AgentSidebar machines={roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && {
            ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === "w1E:p1" && blocked ? { ...pane, agent_status: "blocked" } : pane),
          } }))} selectedMachineId="local" selectedPaneId={paneId} stateWord={(machine) => machine.state} onSelect={() => {}} />
        </SidebarFilterProvider>
      </SettingsProvider>;
      await act(async () => { renderer = create(renderList(false)); });
      if (!renderer) throw new Error("sidebar did not mount");
      const mounted = renderer;
      const section = () => mounted.root.findByType("section");
      const order = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && node.props["data-pane"] !== undefined).map((node) => node.props["data-pane"]);
      await act(async () => { section().props.onPointerEnter(); });
      await act(async () => { section().props.onTouchEnd?.(); section().props.onPointerLeave(); });
      await act(async () => { mounted.update(renderList(true)); jest.advanceTimersByTime(999); });
      expect(order()).toEqual(["w1D:p1", paneId]);
      await act(async () => { jest.advanceTimersByTime(1); });
      expect(order()).toEqual(["w1D:p1", "w1E:p1", paneId]);
      expect(mounted.root.findAll((node) => node.type === "li" && node.props.className.includes("is-selected")).map((node) => node.props["data-pane"])).toEqual([paneId]);
    } finally {
      await act(async () => { renderer?.unmount(); });
      renderer = undefined;
      jest.useRealTimers();
    }
  });

  it("clearing the filter while the pointer is in the list shows the rows in their normal order", async () => {
    // Waiting first: the order that moves a row by its state, and its resting fold
    stored.set("ovis:settings", JSON.stringify({ agentOrder: "waiting" }));
    const keepsWorking: SidebarFilter = { query: "pay", active: true, matches: 1, machines: new Map([["local", {
      shown: true, matched: false, workspaces: new Set(), matchedWorkspaces: new Set(), revealedWorkspaces: new Set(), panes: new Set([paneId]), matchedPanes: new Set([paneId]),
    }]]) };
    const renderList = (filter: SidebarFilter) => <SettingsProvider>
      <SidebarFilterProvider value={{ filter, reportBranches: () => {} }}>
        <AgentSidebar machines={roster()} selectedMachineId="local" selectedPaneId={null} stateWord={(machine) => machine.state} onSelect={() => {}} />
      </SidebarFilterProvider>
    </SettingsProvider>;
    // Given a filter that keeps only the working row (w1C:p1), and the pointer moving into the list.
    await act(async () => { renderer = create(renderList(keepsWorking)); });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const drawnEntries = () => mounted.root.findAll((node) => node.type === "li" && !node.props.hidden && (node.props["data-pane"] !== undefined || node.props.className === "agent-background-label agent-resting-label"))
      .map((node) => node.props["data-pane"] ?? "RESTING");
    expect(drawnEntries()).toEqual([paneId]);
    await act(async () => { mounted.root.findByType("section").props.onPointerEnter(); });
    // When the reader clears the filter with the pointer still there:
    await act(async () => { mounted.update(renderList(inactive)); });
    // Then every row is back where it stands without a filter: the blocked one first, the resting ones folded.
    expect(drawnEntries()).toEqual(["w1D:p1", paneId, "RESTING"]);
  });
});
