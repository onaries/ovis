import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, useLayoutEffect, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useKeptPaneBoxes } from "./coveredPane.ts";

interface Box { left: number; top: number; width: number; height: number }

/** a pane slot as the hook reads and writes it: its box, its kept-box attribute and its own style's properties */
class FakeSlot {
  box: Box;
  /** how often its box was read */
  reads = 0;
  readonly attributes = new Map<string, string>();
  readonly properties = new Map<string, string>();
  /** the custom properties the page gives it from its ancestors, as the slot's computed style reads them */
  readonly computed = new Map<string, string>();
  readonly style = {
    getPropertyValue: (name: string): string => this.properties.get(name) ?? "",
    setProperty: (name: string, value: string): void => { this.properties.set(name, value); },
    removeProperty: (name: string): void => { this.properties.delete(name); },
  };
  /** `own`: the properties the slot's own style already holds, as a split's slot holds its rectangle */
  constructor(box: Box, own: Record<string, string> = {}) {
    this.box = box;
    for (const [name, value] of Object.entries(own)) this.properties.set(name, value);
  }
  getBoundingClientRect(): Box { this.reads += 1; return { ...this.box }; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  kept(): Record<string, string> | null {
    return this.attributes.has("data-kept-box") ? Object.fromEntries(this.properties) : null;
  }
}

describe("useKeptPaneBoxes", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let slots: FakeSlot[];
  let areaBox: Box;
  /** how often the pane area was asked for its panes or its own box, and how many observers of any kind were made */
  let asked: { panes: number; box: number; observers: number };
  const area = { current: null } as unknown as RefObject<HTMLElement | null>;

  beforeEach(() => {
    for (const key of ["ResizeObserver", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT", "getComputedStyle"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (slot: FakeSlot) => ({ getPropertyValue: (name: string) => slot.computed.get(name) ?? "" }) });
    asked = { panes: 0, box: 0, observers: 0 };
    const Observer = class {
      constructor() { asked.observers += 1; }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    for (const key of ["ResizeObserver", "MutationObserver"]) Object.defineProperty(globalThis, key, { configurable: true, value: Observer });
    slots = [];
    areaBox = { left: 0, top: 52, width: 390, height: 792 };
    (area as { current: unknown }).current = {
      querySelectorAll: () => { asked.panes += 1; return slots; },
      getBoundingClientRect: () => { asked.box += 1; return { ...areaBox }; },
    };
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

  function Probe({ covered }: { covered: boolean }) {
    useKeptPaneBoxes(area, covered);
    return null;
  }
  const draw = async (covered: boolean): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, { covered }));
      else renderer = create(createElement(Probe, { covered }));
    });
  };

  it("holds a covered pane in the box it was shown in, whatever the shell around it has become, and lets it go when it is shown again", async () => {
    // Given a pane shown under a phone's header.
    const slot = new FakeSlot({ left: 0, top: 52, width: 390, height: 792 });
    slots = [slot];
    await draw(false);
    expect(slot.kept()).toBeNull();

    // When the list covers it and the header is gone: the pane area starts at the screen's top.
    areaBox = { left: 0, top: 0, width: 390, height: 844 };
    await draw(true);

    // Then the pane keeps its box, placed inside the area as it now lies.
    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "52px", width: "390px", height: "792px" });

    // When it is shown again.
    await draw(false);

    // Then nothing holds it.
    expect(slot.kept()).toBeNull();
    expect(slot.properties.size).toBe(0);
  });

  it("reads a pane's box as the list is about to cover it and not while it is covered: the box it keeps is the last it was shown in", async () => {
    const slot = new FakeSlot({ left: 0, top: 42, width: 1440, height: 830 });
    slots = [slot];
    await draw(false);
    // a wide window whose classic sidebar is collapsed: the mode draws its column, and the area moves and narrows
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);
    expect(slot.kept()).toEqual({ position: "absolute", left: "-320px", top: "42px", width: "1440px", height: "830px" });

    // the window is resized under the list: what the pane's element measures now is not a box it was shown in
    slot.box = { left: 0, top: 42, width: 1000, height: 600 };
    await draw(true);
    expect(slot.kept()).toEqual({ position: "absolute", left: "-320px", top: "42px", width: "1440px", height: "830px" });

    // a row opens it as a thread beside the column, and Back covers it again: the thread's box is the one it keeps now
    await draw(false);
    slot.box = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);
    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "0px", width: "1120px", height: "900px" });
  });

  it("leaves alone a pane that came to the page under the list, until it has been shown", async () => {
    // Given a page that opened on the mode's list: its pane is drawn under the list and was never shown.
    areaBox = { left: 0, top: 0, width: 390, height: 844 };
    await draw(true);
    const slot = new FakeSlot({ left: 0, top: 0, width: 390, height: 844 });
    slots = [slot];
    await draw(true);
    expect(slot.kept()).toBeNull();

    // When a row shows it as a thread, and Back covers it.
    await draw(false);
    await draw(true);

    // Then it keeps the thread's box.
    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "0px", width: "390px", height: "844px" });
  });

  it("holds each half of a classic split in its own box over the rectangle its style carries, and gives that style back", async () => {
    // Given a split's two halves, side by side: each slot's own style places it by percentages of the pane area.
    const rectangle = (left: string) => ({ left, top: "0%", width: "50%", height: "100%" });
    const first = new FakeSlot({ left: 320, top: 42, width: 560, height: 830 }, rectangle("0%"));
    const second = new FakeSlot({ left: 880, top: 42, width: 560, height: 830 }, rectangle("50%"));
    slots = [first, second];
    areaBox = { left: 320, top: 42, width: 1120, height: 830 };
    await draw(false);

    // When the list covers them, and the bars over the area are gone.
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);

    // Then each half is held in the box it was shown in, over its rectangle.
    expect(first.kept()).toEqual({ position: "absolute", left: "0px", top: "42px", width: "560px", height: "830px" });
    expect(second.kept()).toEqual({ position: "absolute", left: "560px", top: "42px", width: "560px", height: "830px" });

    // When they are shown again as the classic split, React leaves their style alone: each has its own rectangle back.
    await draw(false);
    expect([first.kept(), Object.fromEntries(first.properties)]).toEqual([null, rectangle("0%")]);
    expect([second.kept(), Object.fromEntries(second.properties)]).toEqual([null, rectangle("50%")]);
  });

  it("leaves what React wrote on a slot's style in the commit that shows it again: a thread's slot has no rectangle", async () => {
    // Given a split's first half, held under the list over the rectangle its style carries.
    const rectangle = { left: "0%", top: "0%", width: "50%", height: "100%" };
    const slot = new FakeSlot({ left: 320, top: 42, width: 560, height: 830 }, rectangle);
    slots = [slot];
    areaBox = { left: 320, top: 42, width: 1120, height: 830 };
    await draw(false);
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);

    // When a row's thread is drawn: in that commit React clears the slot's rectangle before the hold lets go.
    for (const side of Object.keys(rectangle)) slot.style.removeProperty(side);
    await draw(false);

    // Then the slot has no rectangle and nothing of the hold: the thread fills the pane area.
    expect([slot.kept(), Object.fromEntries(slot.properties)]).toEqual([null, {}]);
  });

  it("holds a split's half that Back mounts again under the list at the box the list found it in", async () => {
    // Given a split's two halves under the list, each read in its classic box.
    const half = (id: string, left: number) => { const slot = new FakeSlot({ left, top: 42, width: 560, height: 830 }); slot.setAttribute("data-slot", id); return slot; };
    const first = half("a", 320);
    slots = [first, half("b", 880)];
    areaBox = { left: 320, top: 42, width: 1120, height: 830 };
    await draw(false);
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(true);

    // When a row's thread takes the second half off the page, and Back mounts it again as another element under the list.
    slots = [first];
    await draw(false);
    const again = half("b", 880);
    again.box = { left: 880, top: 0, width: 560, height: 900 };
    // it mounts in the commit of that render: the render that reads the boxes finds the first half alone
    let queries = 0;
    (area as unknown as { current: { querySelectorAll(): FakeSlot[] } }).current.querySelectorAll = () => (queries++ === 0 ? [first] : [first, again]);
    await draw(true);

    // Then it is held at the box the list found it in, not at the one the area gives it now.
    expect(again.kept()).toEqual({ position: "absolute", left: "560px", top: "42px", width: "560px", height: "830px" });
  });

  it("holds a covered pane at its size before anything in the commit that covers it reads the page", async () => {
    // Given a pane shown under a phone's header, and a part of the page that opens with the list and reads the page as
    // it opens (the list puts its scroll back and takes the focus): its layout effect runs before the hold's own.
    const slot = new FakeSlot({ left: 0, top: 52, width: 390, height: 792 });
    slots = [slot];
    const seen: string[] = [];
    function Opening({ covered }: { covered: boolean }) {
      useLayoutEffect(() => { if (covered) seen.push(slot.style.getPropertyValue("height") || "not held"); }, [covered]);
      return null;
    }
    function Page({ covered }: { covered: boolean }) {
      useKeptPaneBoxes(area, covered);
      return createElement(Opening, { covered });
    }
    const show = async (covered: boolean): Promise<void> => {
      await act(async () => {
        if (renderer) renderer.update(createElement(Page, { covered }));
        else renderer = create(createElement(Page, { covered }));
      });
    };
    await show(false);

    // When the list covers it, the header gone: the area the page would lay it out in is taller.
    areaBox = { left: 0, top: 0, width: 390, height: 844 };
    await show(true);

    // Then that part finds the pane already held at the height it was shown at, and the hold ends where it was on the
    // screen: the page is never laid out with the pane at the area's height, not even for a moment.
    expect(seen).toEqual(["792px"]);
    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "52px", width: "390px", height: "792px" });
  });

  it("holds the room a header over the pane took of it as it was shown (--header-over), and gives it back", async () => {
    // Given a thread on a wide window: its zone floats over the chat, and the page gives the pane the zone's room above
    // its transcript (under the list it gives none).
    const slot = new FakeSlot({ left: 320, top: 0, width: 1120, height: 900 });
    slot.computed.set("--header-over", "calc(34px + 12px * 2)");
    slots = [slot];
    areaBox = { left: 320, top: 0, width: 1120, height: 900 };
    await draw(false);

    // When Back puts the list over it.
    await draw(true);

    // Then the pane keeps that room with its box: its transcript has the top it was shown with under the list.
    expect(slot.kept()).toEqual({ position: "absolute", left: "0px", top: "0px", width: "1120px", height: "900px", "--header-over": "calc(34px + 12px * 2)" });

    // When the row shows it again, nothing of the hold is left: the thread's own room stands.
    await draw(false);
    expect([slot.kept(), slot.properties.size]).toEqual([null, 0]);
  });

  it("reads nothing of the page and watches nothing while no list covers a pane, as in the classic app", async () => {
    const slot = new FakeSlot({ left: 0, top: 52, width: 390, height: 792 });
    slots = [slot];

    // When the classic app draws, and draws again.
    await draw(false);
    await draw(false);
    await draw(false);

    // Then no pane was looked for, no box was read and no observer was made.
    expect(asked).toEqual({ panes: 0, box: 0, observers: 0 });
    expect(slot.reads).toBe(0);
  });
});
