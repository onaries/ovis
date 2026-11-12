import { afterEach, beforeEach, describe, expect, it, jest, setSystemTime, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { UsageReport } from "../../shared/protocol.ts";
import { useUsage } from "./usage.ts";

// The real hook over a fetch the test answers, on fake clocks: advancing the timers moves both of the device's clocks
// and brings the hook's next ask; setting the system time moves the wall clock alone, as a correction does.
const START = Date.parse("2026-09-29T12:00:00Z");
const MINUTE = 60_000;
/** The PC's clock when the page opens: 40 minutes ahead of this device's. */
const PC = START + 40 * MINUTE;

describe("the report the usage hook hands on", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | null;
  let hook: ReturnType<typeof useUsage> | null;
  /** what the PC does with an ask: answer, fail, or nothing at all */
  let pc: () => Promise<Response>;
  let asks: number;
  let answered: Set<() => void>;
  let openedAt: number;

  beforeEach(() => {
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const page = new EventTarget();
    const listening = { addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page) };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: listening });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", ...listening } });
    renderer = null;
    hook = null;
    asks = 0;
    answered = new Set();
    const ask = async (): Promise<Response> => {
      asks++;
      try { return await pc(); }
      finally { for (const listener of [...answered]) listener(); }
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(ask, { preconnect: globalThis.fetch.preconnect }));
    jest.useFakeTimers();
    setSystemTime(new Date(START));
    openedAt = performance.now();
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    jest.useRealTimers();
    setSystemTime();
    jest.restoreAllMocks();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  /** The PC's own clock, which no correction of the device's touches. */
  const pcNow = (): number => PC + Math.round(performance.now() - openedAt);
  /** The PC answering with its time and one account another tool recorded, last read at `readAt` on the PC's clock. */
  const says = (readAt: number) => async (): Promise<Response> => Response.json({
    server_time: new Date(pcNow()).toISOString(),
    providers: [{ id: "claude", key: "claude:recorded", account: "me@example.com", plan: null, windows: [], problem: null, checked_at: new Date(readAt).toISOString(), recorded: { by: "omp", stale: false, signed_in: false } }],
  } satisfies UsageReport);
  const silent = (): Promise<Response> => new Promise(() => {});
  const stale = (): boolean | undefined => hook?.report?.providers[0]?.recorded?.stale;

  /** the PC's next answer or failure to an ask; a test that waits for one never given ends at the runner's own limit */
  function heard(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { answered.delete(done); resolve(); };
      answered.add(done);
    });
  }
  async function open(): Promise<void> {
    function Probe() { hook = useUsage(true); return null; }
    const first = heard();
    // the hook asks from an effect, which runs as this step ends: the answer is waited for in the next
    await act(async () => { renderer = create(createElement(Probe)); });
    await act(async () => { await first; });
  }
  /** a minute on both of the device's clocks, which brings the hook's next ask */
  async function minute(wait: "heard" | "unheard"): Promise<void> {
    const next = wait === "heard" ? heard() : null;
    await act(async () => { jest.advanceTimersByTime(MINUTE); await next; });
  }

  it("ages the report in hand as it asks again, before any answer: a PC that never answers leaves no record current", async () => {
    // a record the PC sees read again and again: 13 minutes old at each of its answers
    pc = () => says(pcNow() - 13 * MINUTE)();
    await open();
    await minute("heard");
    await minute("heard");
    expect([asks, stale()]).toEqual([3, false]);
    // from its last answer on, the PC is silent: the count starts there, and not where the page opened
    pc = silent;
    await minute("unheard");
    await minute("unheard");
    expect([asks, stale()]).toEqual([5, false]);
    await minute("unheard");
    expect([asks, stale()]).toEqual([6, true]);
  });

  it("ages it as an ask fails, and counts again from the PC's next answer", async () => {
    pc = says(PC - 14 * MINUTE);
    await open();
    pc = async () => { throw new TypeError("Failed to fetch"); };
    await minute("heard");
    expect(stale()).toBe(false);
    await minute("heard");
    expect(stale()).toBe(true);
    // the PC is back, and saw the record read again a minute ago
    pc = says(PC + 2 * MINUTE);
    await minute("heard");
    expect(stale()).toBe(false);
  });

  it("takes nothing off a record's age when the device's clock is set back while the PC is silent", async () => {
    pc = says(PC - 13 * MINUTE);
    await open();
    pc = silent;
    setSystemTime(new Date(Date.now() - 15 * MINUTE));
    await minute("unheard");
    await minute("unheard");
    await minute("unheard");
    expect([asks, stale()]).toEqual([4, true]);
  });

  it("hands on the same report while the PC says the same, though its time moves on", async () => {
    pc = says(PC - 2 * MINUTE);
    await open();
    const first = hook?.report;
    expect(first?.providers[0]?.account).toBe("me@example.com");
    await minute("heard");
    await minute("heard");
    expect(asks).toBe(3);
    expect(hook?.report).toBe(first);
  });
});
