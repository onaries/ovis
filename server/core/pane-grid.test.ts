import { expect, it } from "bun:test";
import { paneGrid } from "./terminal-process.ts";

const layouts = [{ workspace_id: "w", tab_id: "t", focused_pane_id: "p", zoomed: false, area: { x: 0, y: 0, width: 1000, height: 1000 },
  panes: [{ pane_id: "p", focused: true, rect: { x: 0, y: 0, width: 500, height: 1000 } }], splits: [] }];

it("starts an attach that must not resize at herdr-core's own grid, not its layout share, and at herdr's layout rect otherwise", () => {
  expect(paneGrid({ layouts }, { pane_id: "p", grid: { cols: 80, rows: 24 } })).toEqual({ width: 80, height: 24 });
  expect(paneGrid({ layouts }, { pane_id: "p" })).toEqual({ width: 500, height: 1000 });
  expect(paneGrid({ layouts }, { pane_id: "q" })).toBeNull();
});
