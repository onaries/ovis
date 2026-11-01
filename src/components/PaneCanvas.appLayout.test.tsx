import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { AppLayoutContext } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import type { RowMenuItem } from "./RowMenu.tsx";
import { PaneCanvas } from "./PaneCanvas.tsx";

const pane = (id: string, label?: string): HerdrPane =>
  ({ pane_id: id, workspace_id: "w1", tab_id: "t1", terminal_id: `${id}:term`, revision: 1, focused: id === "p1", agent_status: "idle", label }) as HerdrPane;
// one tab, split in two side by side: a divider stands between p1 and p2
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", agents: [],
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

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
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

  async function draw(appLayout: boolean): Promise<(target: HerdrPane) => string[]> {
    const actionsRef: { current: ((target: HerdrPane) => RowMenuItem[]) | null } = { current: null };
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: appLayout },
        createElement(PaneCanvas, { snapshot, pane: snapshot.panes[0] as HerdrPane, selectedPaneId: "p1", onSelect: () => {}, onChanged: () => {}, renderPane: () => null, actionsRef }))));
    });
    return (target) => actionsRef.current!(target).map((item) => item.id);
  }
  const dividers = () => renderer!.root.findAllByProps({ role: "separator" }).length;

  it("offers a TUI PC's panes their name, swap, split and zoom items, and a divider to drag", async () => {
    const itemsOf = await draw(false);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["rename", "clear-name", "split-right", "split-down", "zoom", "close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["rename", "swap-focused", "split-right", "split-down", "zoom", "close"]);
    expect(dividers()).toBe(1);
  });

  it("leaves a core PC's panes to the Herdr app: Close pane stays, no divider is drawn", async () => {
    const itemsOf = await draw(true);
    expect(itemsOf(snapshot.panes[0] as HerdrPane)).toEqual(["close"]);
    expect(itemsOf(snapshot.panes[1] as HerdrPane)).toEqual(["close"]);
    expect(dividers()).toBe(0);
  });
});
