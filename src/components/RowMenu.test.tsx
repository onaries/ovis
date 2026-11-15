import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { Pencil } from "lucide-react";

import { SettingsProvider } from "../lib/settings.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { RowMenu } from "./RowMenu.tsx";

// the test renderer draws no DOM: a node stands in for every element, outside every other one, and the portal the
// menu draws into is a body that makes them
const node = (): HTMLElement => ({
  isConnected: true, offsetWidth: 200, offsetHeight: 100, dataset: {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, closest: () => null,
  focus() {}, addEventListener() {}, removeEventListener() {},
}) as unknown as HTMLElement;

describe("how the row menu closes from outside it", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let events: EventTarget;
  let closes: number;

  async function draw(phone: boolean): Promise<void> {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    events = new EventTarget();
    closes = 0;
    const storage = { getItem: () => null, setItem() {}, removeItem() {} };
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("localStorage", storage);
    define("navigator", { languages: ["en-US"], platform: "Linux" });
    const on = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
    define("window", { ...on, localStorage: storage, matchMedia: (query: string) => ({ matches: phone && query === SHEET_QUERY, addEventListener() {}, removeEventListener() {} }), innerWidth: phone ? 390 : 1280, innerHeight: 800, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { ...on, visibilityState: "visible", activeElement: null, body: { nodeType: 1, children: [], createNodeMock: node }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null });
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    const menu = createElement(RowMenu, { anchor: node(), title: "w1", items: [{ id: "rename", label: "Rename", icon: Pencil, run() {} }], onClose: () => { closes++; } });
    await act(async () => { renderer = create(createElement(SettingsProvider, null, menu), { createNodeMock: node }); });
  }

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  beforeEach(() => descriptors.clear());

  const scrim = () => renderer!.root.findByProps({ className: "modal-scrim" });
  /** a press on `target` inside the scrim, then the click a browser sends for it */
  const press = async (on: "scrim" | "sheet", then: "click" | "none"): Promise<void> => {
    const self = scrim();
    const target = on === "scrim" ? self : {};
    await act(async () => self.props.onPointerDown({ target, currentTarget: self }));
    if (then === "click") await act(async () => self.props.onClick({ target, currentTarget: self }));
  };

  it("keeps a phone's sheet through the press of a tap outside it, and closes it on the tap's click on the dimmed page", async () => {
    await draw(true);
    await act(async () => { events.dispatchEvent(new Event("pointerdown")); });
    expect(closes).toBe(0);
    await press("scrim", "none");
    expect(closes).toBe(0);
    await press("scrim", "click");
    expect(closes).toBe(1);
  });

  it("keeps the sheet when a press begun in it is let go over the dimmed page", async () => {
    await draw(true);
    // the press as a listener on the window sees it: outside the sheet's surface
    await act(async () => { events.dispatchEvent(new Event("pointerdown")); });
    expect(closes).toBe(0);
    await press("sheet", "click");
    const self = scrim();
    await act(async () => self.props.onClick({ target: self, currentTarget: self }));
    expect(closes).toBe(0);
    await press("scrim", "click");
    expect(closes).toBe(1);
  });

  it("closes a desktop's popover on a press outside it", async () => {
    await draw(false);
    expect(renderer!.root.findAllByProps({ className: "modal-scrim" })).toHaveLength(0);
    await act(async () => { events.dispatchEvent(new Event("pointerdown")); });
    expect(closes).toBe(1);
  });
});
