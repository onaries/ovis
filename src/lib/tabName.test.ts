import { describe, expect, it } from "bun:test";

import { autoTabLabel, customTabLabel, tabLabel } from "./tabName.ts";

const t = (key: string, vars?: Record<string, string | number>): string => key.replace("{n}", String(vars?.["n"]));

describe("tab names", () => {
  it("reads a tab herdr names by its number as Tab n", () => {
    expect(tabLabel({ label: "2", number: 2 }, t)).toBe("Tab 2");
    expect(tabLabel({ label: "", number: 3 }, t)).toBe("Tab 3");
    expect(customTabLabel({ label: " 2 ", number: 2 })).toBeNull();
  });

  it("keeps a given name, trimmed", () => {
    expect(tabLabel({ label: " build ", number: 2 }, t)).toBe("build");
    expect(customTabLabel({ label: "build", number: 2 })).toBe("build");
  });

  it("follows the tab's place once a tab before it closed: herdr relabels it and keeps its number", () => {
    // tab 1 of two closed: herdr reports { number: 2, label: "1" } for the one left
    expect(customTabLabel({ label: "1", number: 2 }, 1)).toBeNull();
    expect(tabLabel({ label: "1", number: 2 }, t, 1)).toBe("Tab 1");
    // a name that only looks like another place is a name
    expect(tabLabel({ label: "7", number: 2 }, t, 1)).toBe("7");
  });

  it("keeps a numeric custom name when its stable number differs from its place", () => {
    expect(customTabLabel({ label: "3", number: 3 }, 2)).toBe("3");
    expect(tabLabel({ label: "3", number: 3 }, t, 2)).toBe("3");
  });

  it("treats an empty label as herdr's automatic name", () => {
    expect(customTabLabel({ label: "", number: 3 }, 2)).toBeNull();
    expect(tabLabel({ label: "", number: 3 }, t, 2)).toBe("Tab 2");
  });

  describe("a label from the first message (#2019)", () => {
    const panes = [{ pane_id: "w1:p2", terminal_id: "term_b" }];
    const labels = { "w1:p2|term_b": "Fix the login redirect…" };

    it("names a tab herdr names by its number", () => {
      for (const label of ["2", ""]) expect(autoTabLabel({ label, number: 2 }, panes, "local", labels)).toBe("Fix the login redirect…");
    });

    it("never covers a name someone gave the tab, an agent's name included", () => {
      for (const label of ["build", "claude", "claude-2", "3"]) expect(autoTabLabel({ label, number: 2 }, panes, "local", labels)).toBeNull();
    });

    it("reads the label of this PC's pane on its terminal only", () => {
      expect(autoTabLabel({ label: "2", number: 2 }, panes, "pc-2", labels)).toBeNull();
      expect(autoTabLabel({ label: "2", number: 2 }, [{ pane_id: "w1:p2", terminal_id: "term_new" }], "local", labels)).toBeNull();
      expect(autoTabLabel({ label: "2", number: 2 }, panes, "pc-2", { "remote:pc-2:w1%3Ap2|term_b": "Ship it" })).toBe("Ship it");
    });
  });
});
