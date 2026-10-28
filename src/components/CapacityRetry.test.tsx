import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import { CapacityRetry } from "./CapacityRetry.tsx";

let root: ReactTestRenderer | undefined;
const previous = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
  jest.useFakeTimers();
  for (const key of ["window", "navigator", "document", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const events = new EventTarget();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null,
  } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterEach(async () => {
  await act(() => root?.unmount()); root = undefined;
  jest.useRealTimers();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
async function mount(send: () => Promise<boolean>, allowed = true) {
  await act(() => { root = create(createElement(SettingsProvider, { children: createElement(CapacityRetry, { allowed, failed: true, onRetry: send }) })); });
  return () => root?.root.findByType("button").props.onClick();
}
const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); await Promise.resolve(); }); };

it("waits for opt-in and sends at most once per 30 seconds, until stopped", async () => {
  let sent = 0;
  const click = await mount(async () => { sent++; return true; });
  await advance(60_000); expect(sent).toBe(0);
  await act(click); await advance(29_999); expect(sent).toBe(0);
  await advance(1); expect(sent).toBe(1);
  await advance(30_000); expect(sent).toBe(2);
  await act(click); await advance(60_000); expect(sent).toBe(2);
});
it("stops on an uncertain or refused send", async () => {
  let sent = 0;
  const click = await mount(async () => { sent++; return false; });
  await act(click); await advance(30_000); await advance(60_000);
  expect(sent).toBe(1);
  expect(root?.root.findByType("button").props["aria-pressed"]).toBe(false);
  await act(() => root?.update(createElement(SettingsProvider, { children: createElement(CapacityRetry, { allowed: true, failed: false, onRetry: async () => true }) })));
  expect(root?.root.findByProps({ role: "status" }).children.join("")).toBe("Retry stopped. Check the terminal.");
});
it("does not overlap a send still waiting for its receipt", async () => {
  let sent = 0;
  const receipt = Promise.withResolvers<boolean>();
  const click = await mount(() => { sent++; return receipt.promise; });
  await act(click); await advance(90_000); expect(sent).toBe(1);
  await act(async () => { receipt.resolve(true); await receipt.promise; });
});
it("cancels the timer when the capacity notice disappears", async () => {
  let sent = 0;
  const click = await mount(async () => { sent++; return true; });
  await act(click); await act(() => root?.unmount()); root = undefined;
  await advance(60_000); expect(sent).toBe(0);
});
it("disables retries while the pane is hidden, disconnected or observing", async () => {
  let sent = 0;
  const send = async () => { sent++; return true; };
  const click = await mount(send);
  await act(click);
  await act(() => root?.update(createElement(SettingsProvider, { children: createElement(CapacityRetry, { allowed: false, failed: true, onRetry: send }) })));
  await advance(60_000); expect(sent).toBe(0);
});
it("waits through a transient retry and stops when the error stays cleared", async () => {
  let sent = 0;
  const send = async () => { sent++; return true; };
  const click = await mount(send);
  const update = async (failed: boolean) => act(() => root?.update(createElement(SettingsProvider, { children: createElement(CapacityRetry, { allowed: true, failed, onRetry: send }) })));
  await act(click); await advance(30_000); expect(sent).toBe(1);
  await update(false); await advance(10_000); await update(true);
  await advance(20_000); expect(sent).toBe(2);
  await update(false); await advance(30_000); await advance(60_000);
  expect(sent).toBe(2); expect(root?.toJSON()).toBeNull();
});
