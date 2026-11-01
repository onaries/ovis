import { describe, expect, it } from "bun:test";
import type { HerdrIdentity } from "../../shared/machines.ts";
import { appLayoutOf } from "./machineContext.tsx";

const tui = { version: "0.9.5" } as HerdrIdentity;

describe("appLayoutOf", () => {
  it("offers the layout calls only once a PC's herdr says it is herdr's TUI server", () => {
    expect(appLayoutOf(tui)).toBe(false);
    expect(appLayoutOf({ ...tui, runtime: "herdr-core" })).toBe(true);
    // health still loading: nothing to offer that a core PC would refuse
    expect(appLayoutOf(undefined)).toBe(true);
  });
});
