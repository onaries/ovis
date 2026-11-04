import { describe, expect, it } from "bun:test";
import { updatePlan } from "./updates.ts";

const packaged = { packaged: true, platform: "darwin", builtWithFeed: true, env: {} };

describe("updatePlan", () => {
  it("updates a packaged build from the feed it was built with", () => {
    expect(updatePlan(packaged)).toEqual({ enabled: true, feed: null });
  });

  it("never updates a development run, or with OVIS_UPDATES=0", () => {
    expect(updatePlan({ ...packaged, packaged: false }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATES: "0" } }).enabled).toBe(false);
  });

  it("has nothing to update from without a feed", () => {
    expect(updatePlan({ ...packaged, builtWithFeed: false })).toEqual({ enabled: false, reason: "this build has no update feed" });
  });

  it("takes OVIS_UPDATE_URL over the built feed, https only", () => {
    expect(updatePlan({ ...packaged, builtWithFeed: false, env: { OVIS_UPDATE_URL: "https://updates.example/desktop" } })).toEqual({ enabled: true, feed: "https://updates.example/desktop" });
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATE_URL: "http://updates.example/desktop" } }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, env: { OVIS_UPDATE_URL: "not an address" } }).enabled).toBe(false);
  });

  it("updates on Linux only as an AppImage", () => {
    expect(updatePlan({ ...packaged, platform: "linux" }).enabled).toBe(false);
    expect(updatePlan({ ...packaged, platform: "linux", env: { APPIMAGE: "/home/u/Ovis.AppImage" } }).enabled).toBe(true);
  });
});
