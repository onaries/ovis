import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BRIDGE_PROTOCOL } from "./machines.ts";

const app = join(import.meta.dir, "..", "app");

describe("the phone app's bridge protocols", () => {
  // the app adopts a PC address's redirect only to a server whose /api/health names a bridge
  // protocol it knows (PCStore on both platforms): a server that moves BRIDGE_PROTOCOL moves the
  // app's range with it, or every installed app refuses that server's redirects
  it("reach this server's bridge protocol on Android and iOS", () => {
    const java = readFileSync(join(app, "android/app/src/main/java/sh/ovis/app/PCStore.java"), "utf8");
    const swift = readFileSync(join(app, "ios/App/App/HerdrBridgeViewController.swift"), "utf8");
    expect(Number(java.match(/MIN_BRIDGE_PROTOCOL = (\d+);/)?.[1])).toBeLessThanOrEqual(BRIDGE_PROTOCOL);
    expect(Number(java.match(/MAX_BRIDGE_PROTOCOL = (\d+);/)?.[1])).toBe(BRIDGE_PROTOCOL);
    const swiftRange = swift.match(/bridgeProtocols: ClosedRange<Int64> = (\d+)\.\.\.(\d+)/);
    expect(Number(swiftRange?.[1])).toBeLessThanOrEqual(BRIDGE_PROTOCOL);
    expect(Number(swiftRange?.[2])).toBe(BRIDGE_PROTOCOL);
  });
});
