import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createShellTestPage } from "./shell.test.tsx";
import { dashboardHash, keepSheetContext, sheetContext } from "./shellState.ts";

describe("dashboard return context", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  beforeEach(() => { browser = createShellTestPage(); });
  afterEach(() => { browser.dispose(); });

  it("preserves filter, relay and selected PC across a scoped Join", () => {
    const returnHash = "#pcs?filter=needs&relay=relay-ap.ovis.sh&pc=abc123";
    keepSheetContext({ mode: "join", server_id: "joining-pc", returnHash });
    expect(sheetContext("joining-pc")).toEqual({ mode: "join", server_id: "joining-pc", returnHash });
    expect(sheetContext("joining-pc")).toBeNull();
  });

  it("canonicalizes legacy dashboard routes while discarding unrelated fields", () => {
    expect(dashboardHash("#relay-dash-pcs?pc=abc123&relay=relay-ap.ovis.sh&filter=needs&code=private"))
      .toBe("#pcs?filter=needs&relay=relay-ap.ovis.sh&pc=abc123");
    for (const hash of ["#offer=private", "#code=private&state=oauth", "#pane=p1", ""]) expect(dashboardHash(hash)).toBe("");
  });
});
