import { afterEach, beforeAll, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SlashCommand } from "../../shared/protocol.ts";
import { invalidatePaneCommands } from "./paneCommandCache.ts";
import { usePaneCommands } from "./usePaneCommands.ts";

const config: SlashCommand = { name: "config", description: "Open config", source: "builtin", visibility: "terminal" };

// Keep React, the hook, its cache and the API function real; only the network is a stand-in.
describe("usePaneCommands after a failed read", () => {
  let renderer: ReactTestRenderer | null = null;
  let down = false;
  /** while set, each read waits for the test to answer it, in the order the test chooses */
  let held: ((rows: SlashCommand[]) => void)[] | null = null;
  let seen: readonly SlashCommand[] = [];
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  function Probe({ pane }: { pane: string }) { seen = usePaneCommands(pane, "claude"); return null; }
  /** Lets the read's promise chain finish: a bounded number of turns, each inside act. */
  const settle = async (done: () => boolean) => { for (let turn = 0; turn < 50 && !done(); turn++) await act(async () => { await Promise.resolve(); }); };

  beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
  beforeEach(() => {
    jest.useFakeTimers();
    down = false; seen = []; held = null;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
      if (down) throw new TypeError("network down");
      if (held !== null) { const queue = held; return Response.json({ commands: await new Promise<SlashCommand[]>((resolve) => { queue.push(resolve); }) }); }
      return Response.json({ commands: [config] });
    }, { preconnect: globalThis.fetch.preconnect }));
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });

  it("asks again instead of keeping an empty list for good", async () => {
    down = true;
    await act(async () => { renderer = create(createElement(Probe, { pane: "w-retry:p1" })); });
    await settle(() => fetchSpy.mock.calls.length >= 1);
    expect(seen).toEqual([]);
    down = false;
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle(() => seen.length > 0);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
  });

  it("keeps the newer list when a retry and a refresh answer out of order", async () => {
    const oldList: SlashCommand[] = [{ ...config, name: "old-list" }];
    const newList: SlashCommand[] = [{ ...config, name: "new-list" }];
    down = true;
    await act(async () => { renderer = create(createElement(Probe, { pane: "w-retry:p3" })); });
    await settle(() => fetchSpy.mock.calls.length >= 1);
    // the failed read's retry is pending; a catalog change starts a read, then the retry starts another
    down = false; held = [];
    const answers = held;
    await act(async () => { invalidatePaneCommands("w-retry:p3", "local"); });
    await settle(() => answers.length >= 1);
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle(() => answers.length >= 2);
    expect(answers).toHaveLength(2);
    // the later read answers first with the newer list, the earlier one after it with the older list
    answers[1]!(newList);
    await settle(() => seen[0]?.name === "new-list");
    answers[0]!(oldList);
    await settle(() => false);
    held = null;
    await act(async () => { renderer?.unmount(); });
    const calls = fetchSpy.mock.calls.length;
    await act(async () => { renderer = create(createElement(Probe, { pane: "w-retry:p3" })); });
    await settle(() => seen.length > 0);
    expect(seen.map((command) => command.name)).toEqual(["new-list"]);
    expect(fetchSpy.mock.calls.length).toBe(calls);
  });

  it("draws the list another hook read on its first render, before its own read answers", async () => {
    await act(async () => { renderer = create(createElement(Probe, { pane: "w-first:p1" })); });
    await settle(() => seen.length > 0);
    const firsts: string[][] = [];
    function Later() { const rows = usePaneCommands("w-first:p1", "claude"); if (firsts.length === 0) firsts.push(rows.map((command) => command.name)); return null; }
    let later: ReactTestRenderer | null = null;
    await act(async () => { later = create(createElement(Later)); });
    expect(firsts).toEqual([["config"]]);
    await act(async () => { later?.unmount(); });
  });

  it("keeps the list it had while a fresh read fails", async () => {
    await act(async () => { renderer = create(createElement(Probe, { pane: "w-retry:p2" })); });
    await settle(() => seen.length > 0);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
    down = true;
    const calls = fetchSpy.mock.calls.length;
    await act(async () => { invalidatePaneCommands("w-retry:p2", "local"); });
    await settle(() => fetchSpy.mock.calls.length > calls);
    await settle(() => false);
    expect(seen.map((command) => command.name)).toEqual(["config"]);
    // and still asks again once the failed read's wait is over
    const failed = fetchSpy.mock.calls.length;
    await act(async () => { jest.advanceTimersByTime(2_000); });
    await settle(() => fetchSpy.mock.calls.length > failed);
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(failed);
  });
});
