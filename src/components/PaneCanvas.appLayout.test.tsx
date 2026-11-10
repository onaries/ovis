import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { AppLayoutContext, appLayoutOf, type LayoutOffer } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { setSidebarPins } from "../lib/sidebarPins.ts";
import type { RowMenuItem } from "./RowMenu.tsx";
import { PaneCanvas } from "./PaneCanvas.tsx";

/** herdr's TUI server, a herdr-core PC the Herdr app lays out, and one whose layout Ovis keeps (lib/machineContext.tsx) */
const TUI = appLayoutOf({ version: "0.9.5", protocol: 22 });
const APP_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core" });
const OVIS_CORE = appLayoutOf({ version: "0.1.17", protocol: 22, runtime: "herdr-core", layout: { rename: true, split: true, move: true, arrange: true, worktrees: true } });

const pane = (id: string, label?: string): HerdrPane =>
  ({ pane_id: id, workspace_id: "w1", tab_id: "t1", terminal_id: `${id}:term`, revision: 1, focused: id === "p1", agent_status: "idle", label }) as HerdrPane;
// one tab, split in two side by side: a divider stands between p1 and p2
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", agents: [{ agent: "claude", name: "reviewer", pane_id: "p1", terminal_id: "p1:term", workspace_id: "w1", tab_id: "t1", revision: 1, focused: true, agent_status: "idle" }],
  workspaces: [{ workspace_id: "w1", label: "w1", active_tab_id: "t1", number: 1, tab_count: 1, pane_count: 2, focused: true, agent_status: "idle", worktree: null }],
  tabs: [{ tab_id: "t1", workspace_id: "w1", label: "", number: 1, pane_count: 2, focused: true, agent_status: "idle" }],
  panes: [pane("p1", "named"), pane("p2")],
  layouts: [{
    tab_id: "t1", workspace_id: "w1", focused_pane_id: "p1", zoomed: false, area: { x: 0, y: 0, width: 100, height: 40 },
    panes: [{ pane_id: "p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 40 } }, { pane_id: "p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 40 } }],
    splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 100, height: 40 } }],
  }],
};

describe("the pane canvas on a PC the Herdr app lays out", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  // every media query answers alike: true is a cramped phone (SOLO_PANE_QUERY and CRAMPED_QUERY both hold)
  let phone = false;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    phone = false;
    const media = { get matches() { return phone; }, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { visibilityState: "visible", activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  let actions: (target: HerdrPane) => RowMenuItem[] = () => [];
  async function draw(offer: LayoutOffer, drawn: SessionSnapshot = snapshot, watching = false): Promise<(target: HerdrPane) => string[]> {
    const actionsRef: { current: ((target: HerdrPane) => RowMenuItem[]) | null } = { current: null };
    actions = (target) => actionsRef.current!(target);
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: offer },
        createElement(PaneCanvas, { snapshot: drawn, pane: drawn.panes[0] as HerdrPane, selectedPaneId: "p1", onSelect: () => {}, onChanged: () => {}, renderPane: () => null, actionsRef,
          onNewTab: () => {}, onNewTerminal: async () => {}, onMoveToWorkspace: async () => {}, watching }))));
    });
    return (target) => actionsRef.current!(target).map((item) => item.id);
  }
  const dividers = () => renderer!.root.findAllByProps({ role: "separator" }).length;

  it("offers a TUI PC's panes their name, swap, split and zoom items, and a divider to drag", async () => {
    const itemsOf = await draw(TUI);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["rename", "clear-name", "rename-agent", "split-right", "split-down", "zoom", "close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["rename", "swap-focused", "split-right", "split-down", "zoom", "close"]);
    expect(dividers()).toBe(1);
  });

  it("offers no split on a core whose layout Ovis keeps for a pane in a tab of its own terminal (#2806)", async () => {
    const own: SessionSnapshot = { ...snapshot, panes: [{ ...pane("p1", "named"), own_tab: true }, pane("p2")] };
    const itemsOf = await draw(OVIS_CORE, own);
    expect(itemsOf(own.panes[0] as HerdrPane)).toEqual(["rename", "clear-name", "rename-agent", "zoom", "close"]);
    expect(itemsOf(own.panes[1] as HerdrPane)).toEqual(["rename", "swap-focused", "split-right", "split-down", "zoom", "close"]);
  });

  it("gives a lone tab with no row (a cramped phone) the row's menu, for the header's More menu, and no pane ellipsis", async () => {
    phone = true;
    const itemsOf = await draw(TUI);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["pane:p1", "pane:p2", "rename", "clear-name", "rename-agent", "close", "new-terminal", "new-agent-tab", "rename-tab", "close-tab"]);
    const heads = renderer!.root.findAll((node) => node.props.className === "pane-frame-head");
    expect(heads.map((head) => head.parent?.props["data-layout-pane"])).toEqual(["p2"]);
  });

  // a one-pane lone tab beside another workspace: herdr moves it there, as the row's menu offers
  const movable: SessionSnapshot = {
    ...snapshot,
    workspaces: [{ ...snapshot.workspaces[0]!, pane_count: 1 }, { ...snapshot.workspaces[0]!, workspace_id: "w2", label: "w2", active_tab_id: "t2", number: 2, focused: false }],
    tabs: [{ ...snapshot.tabs[0]!, pane_count: 1 }, { ...snapshot.tabs[0]!, tab_id: "t2", workspace_id: "w2", focused: false }],
    panes: [pane("p1"), { ...pane("p3"), workspace_id: "w2", tab_id: "t2" } as HerdrPane],
    layouts: [],
  };

  it("gives a lone one-pane tab with no row Move to workspace and Close tab, as the row's menu does", async () => {
    phone = true;
    const itemsOf = await draw(TUI, movable);
    expect(itemsOf(movable.panes[0] as HerdrPane)).toEqual(["rename", "rename-agent", "close", "new-terminal", "move-workspace", "new-agent-tab", "rename-tab", "close-tab"]);
  });

  it("keeps agent naming in a lone app-owned tab without pane arrangement actions", async () => {
    phone = true;
    const itemsOf = await draw(APP_CORE, movable);
    expect(itemsOf(movable.panes[0] as HerdrPane)).toEqual(["rename-agent", "close", "new-terminal", "new-agent-tab", "close-tab"]);
  });

  it("gives a lone tab with no row on a core whose layout Ovis keeps the same menu as herdr's TUI", async () => {
    phone = true;
    const itemsOf = await draw(OVIS_CORE, movable);
    expect(itemsOf(movable.panes[0] as HerdrPane)).toEqual(["rename", "rename-agent", "close", "new-terminal", "move-workspace", "new-agent-tab", "rename-tab", "close-tab"]);
  });

  it("leaves no actions behind for the header's menu once the canvas is gone", async () => {
    const actionsRef: { current: ((target: HerdrPane) => RowMenuItem[]) | null } = { current: null };
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(PaneCanvas, { snapshot, pane: snapshot.panes[0] as HerdrPane, selectedPaneId: "p1", onSelect: () => {}, onChanged: () => {}, renderPane: () => null, actionsRef })));
    });
    expect(actionsRef.current).not.toBeNull();
    await act(async () => renderer?.unmount());
    renderer = undefined;
    expect(actionsRef.current).toBeNull();
  });

  it("keeps the row's own menu where a lone tab's row is drawn", async () => {
    const itemsOf = await draw(TUI);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).not.toContain("new-terminal");
    expect(renderer!.root.findAll((node) => node.props.className === "pane-frame-head")).toHaveLength(2);
  });

  const zoomButtons = () => renderer!.root.findAll((node) => node.type === "button" && node.props.className === "icon-button pane-frame-zoom");
  const frameOf = (id: string) => renderer!.root.find((node) => node.type === "section" && node.props["data-layout-pane"] === id);
  const zoomed: SessionSnapshot = { ...snapshot, layouts: [{ ...snapshot.layouts[0]!, zoomed: true }] };

  it("draws a Zoom pane button on each split pane's title, which zooms that pane (#2037)", async () => {
    await draw(TUI);
    expect(zoomButtons().map((button) => button.props["aria-label"])).toEqual(["Zoom pane", "Zoom pane"]);
    const bodies: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
      return Response.json({ zoomed: true });
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      await act(async () => { zoomButtons()[1]!.props.onClick({ detail: 0, currentTarget: { closest: () => null } }); });
    } finally {
      fetch.mockRestore();
    }
    expect(bodies).toEqual([{ pane_id: "p2", mode: "on" }]);
  });

  it("moves the typing into the pane whose zoom a mouse clicked, never leaving it in another pane (#2037)", async () => {
    await draw(TUI);
    const focused: string[] = [];
    const frame = { querySelector: (selector: string) => selector === ".xterm-helper-textarea" ? { focus: () => focused.push("p2 terminal") } : null };
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => Response.json({ zoomed: true }), { preconnect: globalThis.fetch.preconnect }));
    try {
      await act(async () => { zoomButtons()[1]!.props.onClick({ detail: 1, currentTarget: { closest: () => frame } }); });
      // a key that pressed the button leaves the focus on it
      await act(async () => { zoomButtons()[1]!.props.onClick({ detail: 0, currentTarget: { closest: () => frame } }); });
    } finally {
      fetch.mockRestore();
    }
    expect(focused).toEqual(["p2 terminal"]);
  });

  it("keeps a zoomed pane's title row, with Unzoom pane, so the hidden panes are one click away (#2037)", async () => {
    await draw(TUI, zoomed);
    expect(frameOf("p1").props.className).not.toContain("is-single");
    expect(zoomButtons().filter((button) => button.props["aria-label"] === "Unzoom pane")).toHaveLength(1);
  });

  it("draws no zoom button where panes are shown one at a time, or the Herdr app lays them out", async () => {
    phone = true;
    await draw(TUI);
    expect(zoomButtons()).toHaveLength(0);
    phone = false;
    await act(async () => renderer?.unmount());
    await draw(APP_CORE);
    expect(zoomButtons()).toHaveLength(0);
  });

  it("offers no Close for a locked pinned agent, nor Close tab for the tab it is in (#2432)", async () => {
    phone = true;
    stored.set("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:p1"] }));
    setSidebarPins(["local:p1"]);
    try {
      const itemsOf = await draw(TUI);
      expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["pane:p1", "pane:p2", "rename", "clear-name", "rename-agent", "unlock", "new-terminal", "new-agent-tab", "rename-tab"]);
      // the other pane of the tab still closes on its own; the tab, with the locked agent in it, does not
      expect(itemsOf(snapshot.panes[1] as HerdrPane)).toContain("close");
      expect(itemsOf(snapshot.panes[1] as HerdrPane)).not.toContain("close-tab");
    } finally {
      setSidebarPins([]);
    }
  });

  it("unlocks a locked pane from its own menu, which stays when its agent left the Agents list (#2977)", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:p1", "local:p9"] }));
    setSidebarPins(["local:p1", "local:p9"]);
    try {
      const itemsOf = await draw(TUI);
      const unlock = actions(snapshot.panes[0] as HerdrPane).find((item) => item.id === "unlock");
      expect(unlock?.disabled).toBeFalsy();
      await act(async () => unlock!.run());
      // the pane closes again; the other lock stays
      expect(itemsOf(snapshot.panes[0] as HerdrPane)).toContain("close");
      expect(JSON.parse(stored.get("ovis:settings") ?? "{}").lockedAgents).toEqual(["local:p9"]);
    } finally {
      setSidebarPins([]);
    }
  });

  it("shows a watching device the pane's Unlock, which it cannot use", async () => {
    stored.set("ovis:settings", JSON.stringify({ agentLocks: true, lockedAgents: ["local:p1"] }));
    setSidebarPins(["local:p1"]);
    try {
      await draw(TUI, snapshot, true);
      expect(actions(snapshot.panes[0] as HerdrPane).find((item) => item.id === "unlock")?.disabled).toBe(true);
    } finally {
      setSidebarPins([]);
    }
  });

  it("keeps agent naming independent of the Herdr app's pane arrangement", async () => {
    const itemsOf = await draw(APP_CORE);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["rename-agent", "close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["close"]);
    expect(dividers()).toBe(0);
  });

  it("offers pane title changes independently while retaining agent call names", async () => {
    const itemsOf = await draw({ ...APP_CORE, paneRename: true });
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["rename", "clear-name", "rename-agent", "close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["rename", "close"]);
    expect(dividers()).toBe(0);
  });

  it("draws a resize divider without offering arrangement actions when only resizing is supported", async () => {
    const itemsOf = await draw({ ...APP_CORE, resize: true });
    expect(dividers()).toBe(1);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["rename-agent", "close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["close"]);
  });

  it("keeps both split actions on an app-owned core that supports splitting", async () => {
    const itemsOf = await draw({ ...APP_CORE, resize: true, split: true });
    expect(dividers()).toBe(1);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["rename-agent", "split-right", "split-down", "close"]);
  });

  it.each([TUI, APP_CORE])("does not offer call-name changes to a watching device (%j)", async (offer) => {
    const itemsOf = await draw(offer, snapshot, true);
    expect(itemsOf(pane("p1", "named"))).not.toContain("rename-agent");
  });

  it.each([TUI, APP_CORE])("does not offer the previous terminal's agent name on a replacement pane (%j)", async (offer) => {
    const itemsOf = await draw(offer);
    expect(itemsOf({ ...pane("p1"), terminal_id: "replacement" })).not.toContain("rename-agent");
  });
});
