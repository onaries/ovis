import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { currentAgentRowTokens, setAgentRowTokens } from "../lib/agentRowTokens.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentSidebar } from "./AgentSidebar.tsx";

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

  async function open() {
    await act(async () => {
      renderer = create(view(roster()), { createNodeMock: () => anchor });
    });
    if (!renderer) throw new Error("sidebar did not mount");
    const mounted = renderer;
    const row = () => mounted.root.findByProps({ "data-machine": "local", "data-pane": paneId });
    await act(async () => { row().findByProps({ className: "sidebar-row-action row-menu-toggle" }).props.onClick({ currentTarget: anchor }); });
    expect(mounted.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["95%"]);
    return {
      mounted,
      row,
      update: async (machines: Machine[]) => { await act(async () => { mounted.update(view(machines)); }); },
    };
  }

  it("updates the open sheet when a plugin value changes", async () => {
    // Given an open sheet with the original quota.
    const { mounted, update } = await open();
    // When a new roster reports a different quota.
    await update(roster({ quota: "40%" }));
    // Then the sheet shows the new value without reopening.
    expect(mounted.root.findByProps({ className: "row-sheet-detail" }).children).toEqual(["40%"]);
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
