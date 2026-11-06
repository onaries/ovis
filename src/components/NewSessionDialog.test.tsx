import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider, useSettings, type Settings } from "../lib/settings.ts";
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

  it("fills the model and effort Settings > Agents sets for the agent picked, and starts it with them", async () => {
    const bodies: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("workspace/create")) { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ workspace_id: "w9", pane_id: "w9:p1", agent_started: true }), { headers: { "content-type": "application/json" } }); }
      return new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }, { kind: "codex", label: "Codex" }, { kind: "omp", label: "OMP" }] }), { headers: { "content-type": "application/json" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    localStorage.setItem("ovis:settings", JSON.stringify({ claudeLaunchModel: "opus", claudeLaunchEffort: "high", codexLaunchEffort: "xhigh" }));
    const view = createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined }) });
    try {
      await act(async () => { renderer = create(view); });
      const value = (id: string) => renderer!.root.findByProps({ id }).props.value;
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["opus", "high"]);
      const pick = async (kind: string) => { await act(async () => { renderer!.root.findByProps({ labelledBy: "new-session-agent" }).props.onChange(kind); }); };
      // Codex has an effort and no model set: its own model, the level set for it
      await pick("codex");
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["", "xhigh"]);
      // every field stays the user's to change before Start
      await act(async () => { renderer!.root.findByProps({ id: "new-session-model" }).props.onChange({ target: { value: "gpt-5-codex" } }); });
      await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
      expect(bodies).toHaveLength(1);
      expect((bodies[0] as { agent: unknown }).agent).toEqual({ kind: "codex", args: ["--model", "gpt-5-codex", "-c", "model_reasoning_effort=xhigh"] });
    } finally {
      fetch.mockRestore();
    }
  });

  it("starts each agent on its own model and effort while Settings > Agents sets none", async () => {
    const bodies: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("workspace/create")) { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ workspace_id: "w9", pane_id: "w9:p1", agent_started: true }), { headers: { "content-type": "application/json" } }); }
      return new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }] }), { headers: { "content-type": "application/json" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    const view = createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined }) });
    try {
      await act(async () => { renderer = create(view); });
      expect(renderer!.root.findByProps({ id: "new-session-model" }).props.value).toBe("");
      expect(renderer!.root.findByProps({ id: "new-session-effort" }).props.value).toBe("");
      await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
      expect((bodies[0] as { agent: unknown }).agent).toEqual({ kind: "claude" });
    } finally {
      fetch.mockRestore();
    }
  });

  it("carries a level the reader picked to the next agent, even one equal to the last agent's setting, and never the setting itself", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }, { kind: "codex", label: "Codex" }] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    localStorage.setItem("ovis:settings", JSON.stringify({ claudeLaunchEffort: "high" }));
    const view = createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined }) });
    try {
      await act(async () => { renderer = create(view); });
      const effort = () => renderer!.root.findByProps({ id: "new-session-effort" });
      const pick = async (kind: string) => { await act(async () => { renderer!.root.findByProps({ labelledBy: "new-session-agent" }).props.onChange(kind); }); };
      // Claude Code's setting is not Codex's
      await pick("codex");
      expect(effort().props.value).toBe("");
      await pick("claude");
      expect(effort().props.value).toBe("high");
      // picked by the reader, though it is the level Claude Code's setting names: it goes with them
      await act(async () => { effort().props.onChange({ target: { value: "max" } }); });
      await act(async () => { effort().props.onChange({ target: { value: "high" } }); });
      await pick("codex");
      expect(effort().props.value).toBe("high");
    } finally {
      fetch.mockRestore();
    }
  });

  it("fills a model and effort Settings > Agents sets after it opened, and leaves what the reader changed", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    let update: (patch: Partial<Settings>) => void = () => undefined;
    const Grab = () => { update = useSettings().update; return null; };
    const view = createElement(SettingsProvider, { children: [createElement(Grab, { key: "grab" }), createElement(NewSessionDialog, { key: "dialog", open: true, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined })] });
    try {
      await act(async () => { renderer = create(view); });
      const value = (id: string) => renderer!.root.findByProps({ id }).props.value;
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["", ""]);
      // the shared settings come in (or Settings, opened over the dialog, sets them)
      await act(async () => { update({ claudeLaunchModel: "opus", claudeLaunchEffort: "high" }); });
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["opus", "high"]);
      // the reader's own model stays; the effort they left follows the setting
      await act(async () => { renderer!.root.findByProps({ id: "new-session-model" }).props.onChange({ target: { value: "sonnet" } }); });
      await act(async () => { update({ claudeLaunchModel: "haiku", claudeLaunchEffort: "max" }); });
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["sonnet", "max"]);
    } finally {
      fetch.mockRestore();
    }
  });
});
