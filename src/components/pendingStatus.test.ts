import { describe, expect, it } from "bun:test";
import { pendingStatus as status } from "./PendingMessages.tsx";

const pendingStatus = (message: Parameters<typeof status>[0], busy: boolean) => status(message, busy, String);

describe("pending row status", () => {
  it("says a held message waits for Send now only while this connection holds it on the bridge", () => {
    expect(pendingStatus({ state: "held", serverOwned: true }, false)).toBe("Waits for Send now");
    // a copy restored from storage: another tab's live hold, or one from before a reload
    expect(pendingStatus({ state: "held", serverOwned: false }, false)).toBe("Held message — review and send");
    // a hold the bridge refused is reviewed too
    expect(pendingStatus({ state: "held", serverOwned: true, error: { code: "pending_lease_lost", message: "lost" } }, false)).toBe("Held message — review and send");
  });

  it("keeps the other states' words", () => {
    expect(pendingStatus({ state: "queued", serverOwned: true }, false)).toBe("Next turn");
    expect(pendingStatus({ state: "queued", serverOwned: true }, true)).toBe("Sending…");
    expect(pendingStatus({ state: "uncertain", serverOwned: false }, false)).toBe("Not confirmed. Check the terminal before sending again.");
    expect(pendingStatus({ state: "uncertain", serverOwned: true, error: { code: "pi_transcript_pending", message: "waiting" } }, false)).toBe("Sent to Pi · waiting for transcript");
    expect(pendingStatus({ state: "uncertain", serverOwned: true, error: { code: "pi_transcript_target_changed", message: "changed" } }, false)).toBe("Sent to Pi · transcript confirmation unavailable");
    expect(pendingStatus({ state: "held", serverOwned: true, error: { code: "pending_target_changed", message: "changed" } }, false)).toBe("Held message — review and send");
  });
});
