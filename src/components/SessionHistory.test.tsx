import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ReactNode } from "react";
import * as ReactDom from "react-dom";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { HerdrPane, WorkspaceInfo } from "../../shared/protocol.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { SettingsProvider } from "../lib/settings.ts";

await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { SessionHistory } = await import("./SessionHistory.tsx");

describe("SessionHistory", () => {
  let renderer: ReactTestRenderer | undefined;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class HTMLElement {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "http://ovis.test/" }, matchMedia, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; }, cancelAnimationFrame() {}, setTimeout, clearTimeout } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), body: {} } });
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => String(input).includes("/agents") ? Response.json({ agents: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }] }) : Response.json({ workspace_id: "w1", agent: "pi", cwd: "/repo", sessions: [] }), { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  it("renders the next action when the selected agent has no saved sessions", async () => {
    const workspace: WorkspaceInfo = { workspace_id: "w1", label: "release", active_tab_id: "w1:t1", number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false };
    await act(async () => {
      renderer = create(<SettingsProvider><MachineContext.Provider value="local"><SessionHistory workspace={workspace} panes={[] as HerdrPane[]} agent="pi" onClose={() => undefined} onSelectPane={() => undefined} onResumed={() => undefined} /></MachineContext.Provider></SettingsProvider>);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(JSON.stringify(renderer?.toJSON())).toContain("No earlier Pi sessions in this folder. Choose another agent.");
  });
});
