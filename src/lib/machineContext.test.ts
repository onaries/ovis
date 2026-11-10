import { describe, expect, it } from "bun:test";
import type { HerdrIdentity } from "../../shared/machines.ts";
import { appLayoutOf } from "./machineContext.tsx";

const tui = { version: "0.9.5" } as HerdrIdentity;
const none = { rename: false, split: false, move: false, arrange: false, worktrees: false };

describe("appLayoutOf", () => {
  it("offers pane resizing without enabling the Herdr app's arrangement commands", () => {
    const identity: HerdrIdentity = { ...tui, runtime: "herdr-core", layout: { ...none, resize: true } };
    expect(appLayoutOf(identity)).toEqual({ ...none, resize: true });
    expect(appLayoutOf({ ...identity })).toBe(appLayoutOf(identity));
    expect(appLayoutOf(identity)).not.toBe(appLayoutOf({ ...identity, layout: none }));
  });
  it("offers every layout call once a PC's herdr says it is herdr's TUI server", () => {
    expect(appLayoutOf(tui)).toEqual({ rename: true, split: true, move: true, arrange: true, worktrees: true });
    // health still loading: nothing to offer that a core PC would refuse
    expect(appLayoutOf(undefined)).toEqual(none);
  });

  it("offers a herdr-core PC only the calls its layout names", () => {
    expect(appLayoutOf({ ...tui, runtime: "herdr-core" })).toEqual(none);
    expect(appLayoutOf({ ...tui, runtime: "herdr-core", layout: { rename: false, split: false, move: false, arrange: false, worktrees: false } })).toEqual(none);
    const named = { ...tui, runtime: "herdr-core" as const, layout: { rename: true, split: false, move: true, arrange: false, worktrees: false } };
    expect(appLayoutOf(named)).toEqual({ rename: true, split: false, move: true, arrange: false, worktrees: false });
    const own = { ...tui, runtime: "herdr-core" as const, layout: { rename: true, split: true, move: true, arrange: true, worktrees: true } };
    expect(appLayoutOf(own)).toEqual({ rename: true, split: true, move: true, arrange: true, worktrees: true });
    // the same offer object each time, so a context value or a hook's dependency stays put between renders
    expect(appLayoutOf({ ...own })).toBe(appLayoutOf(own));
  });
});
