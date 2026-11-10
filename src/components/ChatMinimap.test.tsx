import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { createRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import * as i18n from "../lib/i18n.ts";
import { ChatMinimap } from "./ChatMinimap.tsx";

const globals = ["document", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let page: EventTarget & { hidden: boolean };
let frames: Map<number, FrameRequestCallback>;
let renderer: ReactTestRenderer | undefined;
let restoreTranslation = () => {};

beforeEach(() => {
  page = Object.assign(new EventTarget(), { hidden: false });
  frames = new Map();
  let next = 0;
  const translated = spyOn(i18n, "useT").mockReturnValue((text) => text);
  restoreTranslation = () => translated.mockRestore();
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: page,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    getComputedStyle: () => ({ fontSize: "16px" }),
    ResizeObserver: class { observe() {} disconnect() {} },
  };
  for (const key of globals) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  }
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  restoreTranslation();
  for (const key of globals) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it("measures a hidden chat in no frame until the page is shown again (IS-092)", () => {
  let measured = 0;
  const scroller = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => { measured++; return { top: 0, bottom: 800, width: 1000, height: 800 }; },
    querySelectorAll: () => [],
    querySelector: () => null,
  });
  const ref = createRef<HTMLDivElement>();
  page.hidden = true;
  act(() => {
    renderer = create(<><div ref={ref} /><ChatMinimap turns={[]} rowKeys={["a", "b"]} scroller={ref} onJump={() => {}} /></>, { createNodeMock: () => scroller });
  });
  scroller.dispatchEvent(new Event("scroll"));
  expect(frames.size).toBe(0);
  expect(measured).toBe(0);
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  expect(frames.size).toBe(1);
  act(() => {
    const due = [...frames.values()];
    frames.clear();
    for (const callback of due) callback(0);
  });
  expect(measured).toBe(1);
});
