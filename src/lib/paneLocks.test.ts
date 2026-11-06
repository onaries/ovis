import { describe, expect, it } from "bun:test";
import { lockedPinKeys, locksAfterPinToggle, toggleAgentLock } from "./paneLocks.ts";

describe("locked agent rows", () => {
  it("holds a lock only while its row is pinned", () => {
    expect([...lockedPinKeys(["pc:p1", "pc:p2"], ["pc:p2", "pc:p3"])]).toEqual(["pc:p2"]);
    expect(lockedPinKeys([], ["pc:p1"]).size).toBe(0);
    expect(lockedPinKeys(["pc:p1"], ["pc:p1"], false).size).toBe(0);
  });

  it("locks and unlocks a pinned row, dropping the locks of rows no longer pinned", () => {
    expect(toggleAgentLock([], ["pc:p1"], "pc:p1")).toEqual(["pc:p1"]);
    expect(toggleAgentLock(["pc:p1"], ["pc:p1"], "pc:p1")).toEqual([]);
    expect(toggleAgentLock(["gone:p9"], ["pc:p1"], "pc:p1")).toEqual(["pc:p1"]);
  });

  it("starts a fresh pin unlocked: a lock left behind by an unpin that had not heard of it does not come back (#2977)", () => {
    // another browser unpinned pc:p1 before this one's lock of it arrived, so the lock stayed in the list
    expect(locksAfterPinToggle(["pc:p1", "pc:p2"], ["pc:p2", "pc:p1"], "pc:p1")).toEqual(["pc:p2"]);
    // an unpin takes its lock, and the locks of rows no longer pinned, with it
    expect(locksAfterPinToggle(["pc:p1", "pc:p2", "gone:p9"], ["pc:p2"], "pc:p1")).toEqual(["pc:p2"]);
  });

  it("never locks a row that is not pinned", () => {
    expect(toggleAgentLock([], ["pc:p2"], "pc:p1")).toEqual([]);
  });
});
