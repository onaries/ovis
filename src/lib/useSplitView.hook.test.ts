import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SplitState } from "./split.ts";
import { useSplitLayout } from "./useSplitView.ts";

describe("useSplitLayout", () => {
  let renderer: ReactTestRenderer | undefined;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  /** every split the hook set */
  let written: (SplitState | null)[];
  let layout: ReturnType<typeof useSplitLayout>;
  const splitShownRef = { current: false };
  /** a split of two halves side by side: slot a, the active one, shows the selection, slot b another pane */
  const split: SplitState = {
    root: { dir: "row", ratio: 0.5, first: { slot: "a" }, second: { slot: "b" } },
    panes: { b: { machineId: "local", paneId: "w1:p2" } },
    active: "a",
  };

  beforeEach(() => {
    for (const key of ["IS_REACT_ACT_ENVIRONMENT", "window"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
    written = [];
    splitShownRef.current = false;
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });

  const nothing = (): void => {};
  function Probe({ wideScreen, threadDrawn }: { wideScreen: boolean; threadDrawn: boolean }) {
    layout = useSplitLayout({
      machines: [], split, wideScreen, selectedPaneId: "w1:p1", selectedPane: null, selectedMachineId: "local", splitShownRef,
      health: null, machineRosterLoaded: false, endSplit: nothing, otherRecheck: { current: false }, otherRosterTick: 0,
      setSplit: (next) => { written.push(next); }, soloSlot: "a", setConnected: nothing, setConnectedBefore: nothing,
      setSelectedMachineId: nothing, setSelectedPaneId: nothing, setAutoSelected: nothing, setOutputStopped: nothing,
      splitRef: { current: split }, selectPane: nothing, paneAreaRef: { current: null }, gridDrop: null, gridDropRef: { current: null },
      clearDropPreview: nothing, tabDrag: null, showGridDrop: nothing, hideDropTarget: nothing, setPaneDragging: nothing,
      movingPanes: { current: new Set() }, draggedPaneRef: { current: null }, markSwap: nothing, markMove: nothing,
      swapPanes: nothing, movePanes: nothing, arrangeRefused: () => false, followPaneMove: nothing, threadDrawn,
    });
    return null;
  }
  const draw = async (props: { wideScreen: boolean; threadDrawn: boolean }): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, props));
      else renderer = create(createElement(Probe, props));
    });
  };

  it("tells the alerts the split is on the screen only while both halves are drawn, not under a thread drawn alone", async () => {
    await draw({ wideScreen: true, threadDrawn: false });
    expect(layout.splitOn).toBe(true);
    expect(splitShownRef.current).toBe(true);
    // the inbox mode's thread draws the selected pane alone: the other half's alerts are no longer muted
    await draw({ wideScreen: true, threadDrawn: true });
    expect(splitShownRef.current).toBe(false);
    // back in the classic app, the split is on the screen again
    await draw({ wideScreen: true, threadDrawn: false });
    expect(splitShownRef.current).toBe(true);
  });

  it("makes the slot that holds a picked pane the active one on a narrow window that keeps the split, as on a wide one", async () => {
    for (const wideScreen of [true, false]) {
      written = [];
      await draw({ wideScreen, threadDrawn: false });
      await act(async () => { layout.activateSlotOf({ machineId: "local", paneId: "w1:p2" }); });
      // slot b is active and the pane slot a showed stays in slot a: neither half is drawn twice once the window widens
      expect(written).toEqual([{ ...split, panes: { a: { machineId: "local", paneId: "w1:p1" } }, active: "b" }]);
    }
  });
});
