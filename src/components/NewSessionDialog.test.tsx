import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentPicker } from "./AgentPicker.tsx";
import { NewSessionDialog, type NewSessionDialogProps } from "./NewSessionDialog.tsx";

// App keeps the dialog mounted and flips `open`: every hook runs whether it is open or not, or React
// refuses the render where it opens ("Rendered more hooks than during the previous render").
describe("NewSessionDialog", () => {
  let renderer: ReactTestRenderer | undefined;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "ResizeObserver", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    // the test renderer draws no DOM: nothing is an element, so the focus trap finds nothing to hold
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class HTMLElement {} });
    // the recent folders' row measures itself; nothing here is laid out
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class ResizeObserver { observe() {} disconnect() {} } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://ovis.example/", search: "" },
      history: { state: null, replaceState() {} },
      localStorage: storage,
      matchMedia,
      innerWidth: 1280,
      setTimeout, clearTimeout,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      activeElement: null,
      querySelector: () => null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
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

  it("opens and closes while it stays mounted", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    const props = (open: boolean): NewSessionDialogProps => ({ open, defaultCwd: "/home/u", onClose: () => undefined, onCreated: () => undefined });
    const view = (open: boolean) => createElement(SettingsProvider, { children: createElement(NewSessionDialog, props(open)) });
    try {
      await act(async () => { renderer = create(view(false)); });
      await act(async () => { renderer!.update(view(true)); });
      expect(renderer!.toJSON()).not.toBeNull();
      await act(async () => { renderer!.update(view(false)); });
      expect(renderer!.toJSON()).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  it("offers the named groups, starts on the folder's last one, and puts the new pane in the group picked (#2431)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("workspace/create") ? { workspace_id: "w9", pane_id: "w9:p1" } : { agents: [] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    localStorage.setItem("ovis:settings", JSON.stringify({ agentNamedGroups: true, agentGroupNames: ["Agents", "Tasks"] }));
    localStorage.setItem("ovis:agent-group-by-folder", JSON.stringify({ "local\n/home/u": "Tasks" }));
    const created: string[] = [];
    const view = (open: boolean) => createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open, defaultCwd: "/home/u", onClose: () => undefined, onCreated: (paneId) => { created.push(paneId); } }) });
    try {
      await act(async () => { renderer = create(view(true)); });
      const field = () => renderer!.root.findByProps({ id: "new-session-group" });
      expect(field().props.value).toBe("Tasks");
      expect(field().findAllByType("option").map((option) => option.props.value)).toEqual(["", "Agents", "Tasks"]);
      await act(async () => { field().props.onChange({ target: { value: "Agents" } }); });
      await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
      expect(created).toEqual(["w9:p1"]);
      expect(JSON.parse(localStorage.getItem("ovis:settings")!).agentGroupOf).toEqual({ "local:w9:p1": "Agents" });
      expect(JSON.parse(localStorage.getItem("ovis:agent-group-by-folder")!)).toEqual({ "local\n/home/u": "Agents" });
    } finally {
      fetch.mockRestore();
    }
  });

  it("clears a gone pane's group from a reused id on No group, and prunes the groups of gone panes (#2431)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("workspace/create") ? { workspace_id: "w9", pane_id: "w9:p1" } : { agents: [] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    localStorage.setItem("ovis:settings", JSON.stringify({ agentNamedGroups: true, agentGroupNames: ["Tasks"], agentGroupOf: { "local:w9:p1": "Tasks", "local:gone": "Tasks", "local:live": "Tasks" } }));
    const groupKept = () => new Set(["local:live"]);
    try {
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", onClose: () => undefined, onCreated: () => undefined, groupKept }) })); });
      expect(renderer!.root.findByProps({ id: "new-session-group" }).props.value).toBe("");
      await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
      expect(JSON.parse(localStorage.getItem("ovis:settings")!).agentGroupOf).toEqual({ "local:live": "Tasks" });
    } finally {
      fetch.mockRestore();
    }
  });

  it("starts a New tab from a chat on that chat's agent, model and effort, and the tab menu's on the last agent picked (#774)", async () => {
    const agents = [{ kind: "claude", label: "Claude Code", installed: true }, { kind: "codex", label: "Codex", installed: true }];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    localStorage.setItem("ovis:new-session-agent", "codex");
    const target = { workspaceId: "w1", workspaceLabel: "repo", cwd: "/home/u/repo", number: 2 };
    const view = (open: boolean, tab: NewSessionDialogProps["tab"]) => createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open, defaultCwd: "/home/u", tab, onClose: () => undefined, onCreated: () => undefined }) });
    const field = (id: string) => renderer!.root.findByProps({ id }).props.value as string;
    try {
      await act(async () => { renderer = create(view(true, { ...target, chat: { agent: "claude", model: "claude-opus-5-5", effort: "xhigh" } })); });
      expect(renderer!.root.findByType(AgentPicker).props.value).toBe("claude");
      expect(field("new-session-model")).toBe("claude-opus-5-5");
      expect(field("new-session-effort")).toBe("xhigh");
      await act(async () => { renderer!.update(view(false, null)); });
      await act(async () => { renderer!.update(view(true, target)); });
      expect(renderer!.root.findByType(AgentPicker).props.value).toBe("codex");
      expect(field("new-session-model")).toBe("");
      expect(field("new-session-effort")).toBe("");
    } finally {
      fetch.mockRestore();
    }
  });

  it("drops a chat's effort with its agent when the PC does not offer that agent (#774)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [{ kind: "codex", label: "Codex", installed: true }] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    localStorage.setItem("ovis:new-session-agent", "codex");
    const tab = { workspaceId: "w1", workspaceLabel: "repo", cwd: "/home/u/repo", number: 2, chat: { agent: "claude", model: "claude-opus-5-5", effort: "high" } };
    try {
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", tab, onClose: () => undefined, onCreated: () => undefined }) })); });
      // Claude Code is not on this PC: the dialog gives way to the last agent picked, with none of Claude Code's choices
      expect(renderer!.root.findByType(AgentPicker).props.value).toBe("codex");
      expect(renderer!.root.findByProps({ id: "new-session-model" }).props.value).toBe("");
      expect(renderer!.root.findByProps({ id: "new-session-effort" }).props.value).toBe("");
    } finally {
      fetch.mockRestore();
    }
  });

  it("puts the chat the button was pressed in before a link's fields left from an earlier opening (#774)", async () => {
    const agents = [{ kind: "claude", label: "Claude Code", installed: true }, { kind: "omp", label: "Oh My Pi", installed: true }];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    const tab = { workspaceId: "w1", workspaceLabel: "repo", cwd: "/home/u/repo", number: 2, chat: { agent: "claude", model: "claude-opus-5-5", effort: "high" } };
    try {
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", tab, prefill: { cwd: null, name: null, agent: "omp" }, onClose: () => undefined, onCreated: () => undefined }) })); });
      expect(renderer!.root.findByType(AgentPicker).props.value).toBe("claude");
      expect(renderer!.root.findByProps({ id: "new-session-model" }).props.value).toBe("claude-opus-5-5");
    } finally {
      fetch.mockRestore();
    }
  });

  it("offers no group while Named agent groups is off (#2431)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    localStorage.setItem("ovis:settings", JSON.stringify({ agentNamedGroups: false, agentGroupNames: ["Agents"] }));
    try {
      await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", onClose: () => undefined, onCreated: () => undefined }) })); });
      expect(renderer!.root.findAllByProps({ id: "new-session-group" })).toHaveLength(0);
    } finally {
      fetch.mockRestore();
    }
  });
});
