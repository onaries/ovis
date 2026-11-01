import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { PaneInfo, SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { AppLayoutContext } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { CommandPalette } from "./CommandPalette.tsx";

const workspace = (id: string, tabs: number): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, tab_count: tabs, pane_count: tabs, focused: false, agent_status: "idle", worktree: null });
const pane = (id: string, workspaceId: string, tabId: string): PaneInfo =>
  ({ pane_id: id, workspace_id: workspaceId, tab_id: tabId, terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle" });
// w1's tab holds two panes (a zoom means something there); w2's tab holds one (it can move to w1)
const snapshot: SessionSnapshot = {
  protocol: 22, version: "test", agents: [], workspaces: [workspace("w1", 1), workspace("w2", 1)],
  tabs: [
    { tab_id: "w1:t1", workspace_id: "w1", label: "", number: 1, pane_count: 2, focused: true, agent_status: "idle" },
    { tab_id: "w2:t1", workspace_id: "w2", label: "", number: 1, pane_count: 1, focused: false, agent_status: "idle" },
  ],
  panes: [pane("p1", "w1", "w1:t1"), pane("p2", "w1", "w1:t1"), pane("p3", "w2", "w2:t1")],
  layouts: [{
    tab_id: "w1:t1", workspace_id: "w1", focused_pane_id: "p1", zoomed: false, area: { x: 0, y: 0, width: 100, height: 40 },
    panes: [{ pane_id: "p1", focused: true, rect: { x: 0, y: 0, width: 50, height: 40 } }, { pane_id: "p2", focused: false, rect: { x: 50, y: 0, width: 50, height: 40 } }],
    splits: [{ id: "split_0_root", direction: "right", ratio: 0.5, rect: { x: 0, y: 0, width: 100, height: 40 } }],
  }],
};
const machines: Machine[] = [{ id: "local", name: "Host", kind: "local", enabled: true, state: "connected", error: null, snapshot }];
// App's actions on each PC: split and zoom on a TUI PC, none on a core PC (lib/layoutActions.ts, tested there)
const actionsOf = (core: boolean) => new Proxy({ splitPane: core ? null : () => {}, zoomPane: core ? null : () => {}, enableNotifications: null, openFiles: null, lock: null }, { get: (own, key) => key in own ? own[key as keyof typeof own] : () => {} }) as unknown as AppActions;
const LAYOUT_ROWS = ["Rename tab", "Split pane right", "Split pane down", "Split pane right and open it", "Split pane down and open it", "Zoom pane"];

describe("the command palette on a PC the Herdr app lays out", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    // the test renderer draws no DOM: nothing is an element, so the focus trap finds nothing to hold
    define("HTMLElement", class HTMLElement {});
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, innerWidth: 1280, innerHeight: 800, history: { state: null, pushState() {}, replaceState() {}, back() {} }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { visibilityState: "visible", activeElement: null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
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

  async function rows(appLayout: boolean, selectedPaneId: string, initialQuery: string): Promise<string[]> {
    await act(async () => { renderer?.unmount(); });
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(AppLayoutContext.Provider, { value: appLayout },
        createElement(CommandPalette, { open: true, initialQuery, onClose: () => {}, machines, onSelect: () => {}, snapshot, online: false, selectedPaneId, view: "chat", actions: actionsOf(appLayout) }))));
    });
    return renderer!.root.findAll((node) => node.props.className === "menu-item-main" && typeof node.props.children === "string").map((node) => node.props.children as string);
  }

  it("lists a TUI PC's rename, split, zoom and move rows", async () => {
    const listed = await rows(false, "p1", ">");
    for (const row of LAYOUT_ROWS) expect(listed).toContain(row);
    expect(await rows(false, "p3", ">move tab")).toEqual(["Move tab to w1"]);
  });

  it("lists none of them on a core PC, and keeps New workspace and New tab", async () => {
    const listed = await rows(true, "p1", ">");
    for (const row of LAYOUT_ROWS) expect(listed).not.toContain(row);
    expect(listed).toContain("New workspace");
    expect(listed).toContain("New tab");
    expect(await rows(true, "p3", ">move tab")).toEqual([]);
  });
});
