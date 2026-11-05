import { describe, expect, it } from "bun:test";

import { HC_OTHER_WORKSPACE_ID } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import { moveDestinations, renamesWorkspace } from "./layoutTargets.ts";

const workspace = (id: string) => ({ workspace_id: id, label: id }) as HerdrWorkspace;
const pane = (extra: Partial<HerdrPane> = {}) => ({ pane_id: "t3", workspace_id: "s1", tab_id: "s1:t3", ...extra }) as HerdrPane;
const spaces = [workspace("s1"), workspace("s2"), workspace(HC_OTHER_WORKSPACE_ID)];

describe("moveDestinations", () => {
  it("lists every other workspace, Other terminals too, for a terminal nothing started", () => {
    expect(moveDestinations(spaces, pane(), "s1").map((w) => w.workspace_id)).toEqual(["s2", HC_OTHER_WORKSPACE_ID]);
  });

  it("leaves Other terminals out for a helper whose parent is shown, which herdr-core refuses to move there (#2806)", () => {
    expect(moveDestinations(spaces, pane({ parent_pane_id: "t1" }), "s1").map((w) => w.workspace_id)).toEqual(["s2"]);
  });
});

describe("renamesWorkspace", () => {
  it("renames any workspace but herdr-core's Other terminals (#2806)", () => {
    expect(renamesWorkspace("s1")).toBe(true);
    expect(renamesWorkspace(HC_OTHER_WORKSPACE_ID)).toBe(false);
  });
});
