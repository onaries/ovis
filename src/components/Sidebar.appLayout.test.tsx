import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import type { AppActions } from "../lib/actions.ts";
import { AppLayoutContext, ReorderContext } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { inactiveSidebarFilter } from "../lib/sidebarFilter.ts";
import { SidebarFilterProvider } from "../lib/sidebarFilterContext.ts";
import { currentSidebarPins, setSidebarPins } from "../lib/sidebarPins.ts";
import { ReorderCoordinator } from "../lib/workspaceOrder.ts";
import { RowMenu } from "./RowMenu.tsx";
import { Sidebar } from "./Sidebar.tsx";

const worktree = (linked: boolean) => ({ is_linked_worktree: linked, repo_key: "r", repo_name: "r", checkout_path: "/test-project" }) as WorkspaceInfo["worktree"];
const workspace = (id: string, tree: WorkspaceInfo["worktree"] = null): WorkspaceInfo =>
  ({ workspace_id: id, label: id, active_tab_id: `${id}:t`, number: 1, tab_count: 1, pane_count: 1, focused: false, agent_status: "idle", worktree: tree });
const roster = (workspaces: WorkspaceInfo[]): SessionSnapshot => ({
  protocol: 22, version: "test", workspaces, layouts: [], agents: [],
  tabs: workspaces.map((w) => ({ tab_id: w.active_tab_id, workspace_id: w.workspace_id, label: w.label, number: 1, pane_count: 1, focused: false, agent_status: "idle" })),
  panes: workspaces.map((w) => ({ pane_id: `${w.workspace_id}:p`, workspace_id: w.workspace_id, tab_id: w.active_tab_id, terminal_id: `${w.workspace_id}:term`, revision: 1, focused: false, agent_status: "idle" })),
});
const actions = new Proxy({}, { get: () => () => {} }) as AppActions;
// the test renderer draws no DOM: a node stands in for every element, connected and measurable, so a row's ⋯ menu can open
const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, dataset: {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;
const keyPress = (key: string, altKey: boolean) => ({ key, altKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

describe("the sidebar on a PC the Herdr app lays out", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  let renderer: ReactTestRenderer | undefined;
  let pinsBefore: string[];
  let requested: string[];

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    stored.clear();
    requested = [];
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } };
    const events = new EventTarget();
    const media = { matches: false, addEventListener() {}, removeEventListener() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("HTMLElement", class HTMLElement {});
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    define("window", { localStorage: storage, matchMedia: () => media, innerWidth: 1280, innerHeight: 800, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    // the portal RowMenu draws into needs an element (nodeType 1) the test renderer can append to, with the node mock its refs read
    define("document", { visibilityState: "visible", activeElement: null, body: { nodeType: 1, children: [], createNodeMock: node }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    pinsBefore = currentSidebarPins();
    setSidebarPins([]);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    setSidebarPins(pinsBefore);
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  async function draw(snapshot: SessionSnapshot, appLayout: boolean, online = false): Promise<ReorderCoordinator> {
    const coordinator = new ReorderCoordinator();
    await act(async () => {
      renderer = create(createElement(SettingsProvider, null, createElement(SidebarFilterProvider, { value: { filter: inactiveSidebarFilter(), reportBranches: () => {} } },
        createElement(AppLayoutContext.Provider, { value: appLayout }, createElement(ReorderContext.Provider, { value: coordinator },
          createElement(Sidebar, { snapshot, online, selectedPaneId: `${snapshot.workspaces[0]!.workspace_id}:p`, actions }))))), { createNodeMock: node });
    });
    return coordinator;
  }
  const menuOf = async (label: string): Promise<string[]> => {
    await act(async () => renderer!.root.findByProps({ "aria-label": `More for ${label}` }).props.onClick({ currentTarget: node() }));
    return (renderer!.root.findByType(RowMenu).props.items as { id: string }[]).map((item) => item.id);
  };
  const row = (id: string) => renderer!.root.findByProps({ "data-pane": `${id}:p` });

  it("offers a TUI PC's rows their rename, worktree and delete items", async () => {
    await draw(roster([workspace("root", worktree(false)), workspace("child", worktree(true))]), false);
    expect(await menuOf("root")).toEqual(["pin-workspace", "rename-workspace", "session-history", "close", "new-worktree", "open-worktree", "fold"]);
    expect(await menuOf("child")).toEqual(["pin-workspace", "rename-workspace", "session-history", "close", "delete-worktree"]);
  });

  it("leaves rename, the worktree actions and the checkout's delete out on a core PC, and keeps pin, earlier sessions, close and the fold", async () => {
    await draw(roster([workspace("root", worktree(false)), workspace("child", worktree(true))]), true);
    expect(await menuOf("root")).toEqual(["pin-workspace", "session-history", "close", "fold"]);
    expect(await menuOf("child")).toEqual(["pin-workspace", "session-history", "close"]);
  });

  it("lets a TUI PC's rows be dragged and moved with Alt+arrows", async () => {
    const coordinator = await draw(roster([workspace("a"), workspace("b")]), false);
    const reorder = spyOn(coordinator, "reorder").mockImplementation(async () => undefined);
    expect(row("a").props.draggable).toBe(true);
    expect(row("a").props["aria-keyshortcuts"]).toBe("Alt+ArrowUp Alt+ArrowDown");
    await act(async () => row("a").props.onKeyDown(keyPress("ArrowDown", true)));
    expect(reorder).toHaveBeenCalledTimes(1);
    expect(reorder.mock.calls[0]![2]).toEqual(["b", "a"]);
  });

  it("keeps a core PC's rows where the Herdr app put them, still draggable into half of the pane area", async () => {
    const coordinator = await draw(roster([workspace("a"), workspace("b")]), true);
    const reorder = spyOn(coordinator, "reorder").mockImplementation(async () => undefined);
    expect(row("a").props.draggable).toBe(true);
    expect(row("a").props["aria-keyshortcuts"]).toBeUndefined();
    await act(async () => row("a").props.onKeyDown(keyPress("ArrowDown", true)));
    expect(reorder).not.toHaveBeenCalled();
  });

  it("asks a TUI PC which unmarked rows are repositories, and a core PC not at all", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      requested.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Response.json({ error: "not_found" }, { status: 404 });
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      await draw(roster([workspace("a"), workspace("b")]), false, true);
      expect(requested.filter((url) => url.includes("/api/worktree/list?")).sort()).toEqual(["/api/worktree/list?workspace_id=a", "/api/worktree/list?workspace_id=b"]);
      await act(async () => renderer!.unmount());
      renderer = undefined;
      requested = [];
      await draw(roster([workspace("a"), workspace("b")]), true, true);
      expect(requested.filter((url) => url.includes("/api/worktree/list?"))).toEqual([]);
    } finally {
      fetch.mockRestore();
    }
  });
});
