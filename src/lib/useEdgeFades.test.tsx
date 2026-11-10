import { afterEach, beforeEach, expect, it } from "bun:test";
import { useRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { useEdgeFades } from "./useEdgeFades.ts";

const globals = ["document", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "MutationObserver", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let page: EventTarget & { hidden: boolean };
let frames: Map<number, FrameRequestCallback>;
let mutated: () => void;
let renderer: ReactTestRenderer | undefined;

function List() {
  const ref = useRef<HTMLDivElement>(null);
  useEdgeFades(ref);
  return <div ref={ref} />;
}

beforeEach(() => {
  page = Object.assign(new EventTarget(), { hidden: false });
  frames = new Map();
  let next = 0;
  mutated = () => { throw new Error("no MutationObserver made"); };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    document: page,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    ResizeObserver: class { observe() {} disconnect() {} },
    MutationObserver: class { constructor(callback: () => void) { mutated = callback; } observe() {} disconnect() {} },
  };
  for (const key of globals) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  }
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  for (const key of globals) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it("reads a hidden list's edges in no frame until the page is shown again (IS-092)", () => {
  const attributes = new Set<string>();
  const list = {
    scrollTop: 0, clientHeight: 100, scrollHeight: 300, children: [],
    toggleAttribute(name: string, force: boolean) { if (force) attributes.add(name); else attributes.delete(name); },
    addEventListener() {}, removeEventListener() {},
  };
  act(() => { renderer = create(<List />, { createNodeMock: () => list }); });
  page.hidden = true;
  page.dispatchEvent(new Event("visibilitychange"));
  list.scrollTop = 200;
  mutated();
  mutated();
  expect(frames.size).toBe(0);
  expect([...attributes]).toEqual(["data-fade-bottom"]);
  page.hidden = false;
  page.dispatchEvent(new Event("visibilitychange"));
  expect(frames.size).toBe(1);
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(0);
  expect([...attributes]).toEqual(["data-fade-top"]);
});
