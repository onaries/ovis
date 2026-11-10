import { afterEach, beforeEach, expect, it } from "bun:test";

import { requestShownFrame } from "./shownFrame.ts";

const globals = ["document", "requestAnimationFrame", "cancelAnimationFrame"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let page: EventTarget & { hidden: boolean };
let frames: Map<number, FrameRequestCallback>;
let next: number;

const setHidden = (hidden: boolean): void => {
  page.hidden = hidden;
  page.dispatchEvent(new Event("visibilitychange"));
};
const runFrames = (): void => {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(0);
};

beforeEach(() => {
  page = Object.assign(new EventTarget(), { hidden: false });
  frames = new Map();
  next = 0;
  const values: Record<string, unknown> = {
    document: page,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
  };
  for (const key of globals) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  }
});

afterEach(() => {
  for (const key of globals) {
    const descriptor = saved.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it("asks a hidden page for no frame and runs the work in the first frame once it is shown", () => {
  setHidden(true);
  let ran = 0;
  requestShownFrame(() => { ran++; });
  expect(frames.size).toBe(0);
  setHidden(false);
  expect(frames.size).toBe(1);
  runFrames();
  expect(ran).toBe(1);
});

it("holds a frame asked for before the page was hidden until the page is shown", () => {
  let ran = 0;
  requestShownFrame(() => { ran++; });
  setHidden(true);
  expect(frames.size).toBe(0);
  runFrames();
  expect(ran).toBe(0);
  expect(frames.size).toBe(0);
  setHidden(false);
  runFrames();
  expect(ran).toBe(1);
});

it("coalesces repeated visibility events and releases its listener after running", () => {
  setHidden(true);
  let ran = 0;
  requestShownFrame(() => { ran++; });
  setHidden(false);
  setHidden(false);
  expect(frames.size).toBe(1);
  runFrames();
  setHidden(true);
  setHidden(false);
  expect(frames.size).toBe(0);
  expect(ran).toBe(1);
});

it("asks for nothing once cancelled, hidden or not", () => {
  setHidden(true);
  const cancel = requestShownFrame(() => { throw new Error("cancelled work ran"); });
  cancel();
  setHidden(false);
  expect(frames.size).toBe(0);
  requestShownFrame(() => { throw new Error("cancelled work ran"); })();
  expect(frames.size).toBe(0);
});
