import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { assignAgentGroup, folderAgentGroup, liveGroupKeys, loadFoldedAgentGroups, MAX_GROUPED_AGENTS, movedAgentGroup, rememberFolderAgentGroup, renameDeviceAgentGroup, saveFoldedAgentGroups, removeAgentGroup, renameAgentGroup, sanitizeGroupNames, sanitizeGroupOf, splitNamedGroups } from "./namedAgentGroups.ts";

const row = (paneId: string, parent?: string, machineId = "local") => ({ machine: { id: machineId }, entry: { pane: { pane_id: paneId, ...(parent === undefined ? {} : { parent_pane_id: parent }) } } });

describe("named agent groups (#2431)", () => {
  it("splits the rows by group in the names' order, the ungrouped last, a helper with its agent", () => {
    const rows = [row("a"), row("b"), row("c"), row("a-helper", "a"), row("d")];
    const groups = splitNamedGroups(rows, { "local:a": "Tasks", "local:c": "Agents", "local:d": "Gone" }, ["Agents", "Replies", "Tasks"]);
    expect(groups.map(({ name, rows: grouped }) => [name, grouped.map(({ entry }) => entry.pane.pane_id)])).toEqual([
      ["Agents", ["c"]],
      ["Tasks", ["a", "a-helper"]],
      [null, ["b", "d"]],
    ]);
  });

  it("keeps a helper's own group over its agent's", () => {
    const rows = [row("a"), row("h", "a")];
    expect(splitNamedGroups(rows, { "local:a": "Tasks", "local:h": "Agents" }, ["Agents", "Tasks"]).map(({ name }) => name)).toEqual(["Agents", "Tasks"]);
  });

  it("sets, moves and clears a row's group, dropping the keys no longer kept", () => {
    const held = { "local:a": "Tasks", "local:gone": "Tasks" };
    expect(assignAgentGroup(held, "local:b", "Agents", (key) => key !== "local:gone")).toEqual({ "local:a": "Tasks", "local:b": "Agents" });
    expect(assignAgentGroup(held, "local:a", null)).toEqual({ "local:gone": "Tasks" });
    expect(movedAgentGroup(held, "local", "a", "w2:a")).toEqual({ "local:gone": "Tasks", "local:w2:a": "Tasks" });
    expect(movedAgentGroup(held, "local", "x", "y")).toBe(held);
  });

  it("refuses a new row once the map is full, never dropping another row's group", () => {
    const full = Object.fromEntries(Array.from({ length: MAX_GROUPED_AGENTS }, (_, index) => [`pc:p${index}`, "Tasks"]));
    expect(assignAgentGroup(full, "local:new", "Tasks")).toBeNull();
    expect(assignAgentGroup(full, "pc:p0", "Agents")?.["pc:p0"]).toBe("Agents");
    expect(Object.keys(assignAgentGroup(full, "local:new", "Tasks", (key) => key !== "pc:p0")!)).toHaveLength(MAX_GROUPED_AGENTS);
  });

  it("renames a group with its rows, refuses a taken name, and removes a group's rows with it", () => {
    const names = ["Agents", "Tasks"], groupOf = { "local:a": "Tasks", "local:b": "Agents" };
    expect(renameAgentGroup(names, groupOf, "Tasks", " Jobs ")).toEqual({ names: ["Agents", "Jobs"], groupOf: { "local:a": "Jobs", "local:b": "Agents" } });
    expect(renameAgentGroup(names, groupOf, "Tasks", "Agents")).toBeNull();
    expect(renameAgentGroup(names, groupOf, "Tasks", "  ")).toBeNull();
    expect(removeAgentGroup(names, groupOf, "Tasks")).toEqual({ names: ["Agents"], groupOf: { "local:b": "Agents" } });
  });

  it("keeps only usable names and assignments from a stored value", () => {
    expect(sanitizeGroupNames([" Agents ", "", "Agents", 3, "Tasks"])).toEqual(["Agents", "Tasks"]);
    expect(sanitizeGroupNames("Agents")).toEqual([]);
    expect(sanitizeGroupOf({ "local:a": "Tasks", "local:b": 2, "local:c": " " })).toEqual({ "local:a": "Tasks" });
    expect(sanitizeGroupOf(["Tasks"])).toEqual({});
  });

  describe("the folder's last group", () => {
    let stored: Map<string, string>;
    const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
    beforeEach(() => {
      stored = new Map();
      Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
      } } });
    });
    afterEach(() => {
      if (previous) Object.defineProperty(globalThis, "window", previous);
      else Reflect.deleteProperty(globalThis, "window");
    });

    it("offers the group last picked for the PC's folder while it still exists", () => {
      rememberFolderAgentGroup("local", "~/app/", "Tasks");
      expect(folderAgentGroup("local", "~/app", ["Agents", "Tasks"])).toBe("Tasks");
      expect(folderAgentGroup("other", "~/app", ["Agents", "Tasks"])).toBeNull();
      expect(folderAgentGroup("local", "~/app", ["Agents"])).toBeNull();
      rememberFolderAgentGroup("local", "~/app", null);
      expect(folderAgentGroup("local", "~/app", ["Agents", "Tasks"])).toBeNull();
    });

    it("moves the folder's group and the fold with a renamed group, and drops them with a removed one", () => {
      rememberFolderAgentGroup("local", "~/app", "Tasks");
      saveFoldedAgentGroups(["Tasks", "Agents"]);
      renameDeviceAgentGroup("Tasks", "Jobs");
      expect(folderAgentGroup("local", "~/app", ["Jobs"])).toBe("Jobs");
      expect(loadFoldedAgentGroups()).toEqual(["Jobs", "Agents"]);
      renameDeviceAgentGroup("Jobs", null);
      expect(folderAgentGroup("local", "~/app", ["Jobs"])).toBeNull();
      expect(loadFoldedAgentGroups()).toEqual(["Agents"]);
    });
  });

  it("keeps the groups of every pane a loaded PC has, and of PCs still loading or hidden", () => {
    const groupOf = { "a:p1": "T", "a:gone": "T", "b:p9": "T", "c:p1": "T" };
    const machines = [{ id: "a", snapshot: { panes: [{ pane_id: "p1" }] } }, { id: "b", snapshot: null }];
    expect([...liveGroupKeys(groupOf, machines, ["c"])].sort()).toEqual(["a:p1", "b:p9", "c:p1"]);
  });
});
