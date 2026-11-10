import { describe, expect, it } from "bun:test";

import { formatDashboardHash, isDashboardHash, parseDashboardHash } from "./dashboardRoute.ts";

describe("dashboardRoute", () => {
  it("parses the five canonical routes and defaults unknown or empty hashes to overview", () => {
    expect(parseDashboardHash("")).toEqual({ view: "overview", filter: "all", relay: null, pc: null });
    expect(parseDashboardHash("#")).toEqual({ view: "overview", filter: "all", relay: null, pc: null });
    expect(parseDashboardHash("#overview")).toEqual({ view: "overview", filter: "all", relay: null, pc: null });
    expect(parseDashboardHash("#pcs")).toEqual({ view: "pcs", filter: "all", relay: null, pc: null });
    expect(parseDashboardHash("#devices")).toEqual({ view: "devices", filter: "all", relay: null, pc: null });
    expect(parseDashboardHash("#relay")).toEqual({ view: "relay", filter: "all", relay: null, pc: null });
    expect(parseDashboardHash("#settings")).toEqual({ view: "settings", filter: "all", relay: null, pc: null });
    expect(parseDashboardHash("#unknown")).toEqual({ view: "overview", filter: "all", relay: null, pc: null });
    // names an object inherits are no legacy anchors
    for (const inherited of ["#constructor", "#toString", "#__proto__", "#hasOwnProperty"]) {
      expect(parseDashboardHash(inherited)).toEqual({ view: "overview", filter: "all", relay: null, pc: null });
      expect(isDashboardHash(inherited)).toBe(false);
    }
  });

  it("maps legacy scroll-anchor hashes onto their real views", () => {
    expect(parseDashboardHash("#relay-dash-overview").view).toBe("overview");
    expect(parseDashboardHash("#relay-dash-pcs").view).toBe("pcs");
    expect(parseDashboardHash("#relay-dash-device").view).toBe("devices");
    expect(parseDashboardHash("#relay-dash-devices").view).toBe("devices");
    expect(parseDashboardHash("#relay-dash-relays").view).toBe("relay");
    expect(parseDashboardHash("#relay-dash-relay").view).toBe("relay");
    expect(parseDashboardHash("#relay-dash-settings").view).toBe("settings");
  });

  it("parses filter, relay and pc parameters on the PCs view and ignores invalid values", () => {
    expect(parseDashboardHash("#pcs?filter=needs")).toEqual({ view: "pcs", filter: "needs", relay: null, pc: null });
    expect(parseDashboardHash("#pcs?filter=ready&relay=wss%3A%2F%2Frelay-ap.ovis.sh&pc=srv_1")).toEqual({
      view: "pcs",
      filter: "ready",
      relay: "wss://relay-ap.ovis.sh",
      pc: "srv_1",
    });
    expect(parseDashboardHash("#pcs?filter=offline")).toEqual({ view: "pcs", filter: "offline", relay: null, pc: null });
    expect(parseDashboardHash("#pcs?filter=bogus&relay=&pc=")).toEqual({ view: "pcs", filter: "all", relay: null, pc: null });
    expect(parseDashboardHash("#devices?filter=needs&pc=srv_1")).toEqual({ view: "devices", filter: "all", relay: null, pc: null });
  });

  it("formats canonical hashes and omits default PCs parameters", () => {
    expect(formatDashboardHash({ view: "overview" })).toBe("#overview");
    expect(formatDashboardHash({ view: "pcs", filter: "all", relay: null, pc: null })).toBe("#pcs");
    expect(formatDashboardHash({ view: "pcs", filter: "needs" })).toBe("#pcs?filter=needs");
    expect(formatDashboardHash({ view: "pcs", filter: "offline", relay: "wss://relay.ovis.sh", pc: "id_1" })).toBe(
      "#pcs?filter=offline&relay=wss%3A%2F%2Frelay.ovis.sh&pc=id_1",
    );
    expect(formatDashboardHash({ view: "settings", filter: "needs", pc: "id_1" })).toBe("#settings");
  });

  it("recognizes dashboard hashes while rejecting OAuth return, pairing offer and PC-app fragments", () => {
    expect(isDashboardHash("#overview")).toBe(true);
    expect(isDashboardHash("#pcs?filter=needs&pc=abc")).toBe(true);
    expect(isDashboardHash("#relay-dash-pcs")).toBe(true);
    expect(isDashboardHash("#offer=eyJ2IjoxfQ")).toBe(false);
    expect(isDashboardHash("#code=abc&state=xyz")).toBe(false);
    expect(isDashboardHash("#pane=1")).toBe(false);
    expect(isDashboardHash("")).toBe(false);
  });
});
