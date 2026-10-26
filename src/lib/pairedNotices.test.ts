import { describe, expect, it } from "bun:test";
import type { DevicePairedEvent } from "../../shared/protocol.ts";
import { PAIRED_NOTICE_LIMIT, withPairedNotice } from "./pairedNotices.ts";

const event = (id: string, label = `Device ${id}`): DevicePairedEvent => ({ type: "device-paired", event_id: id, device_id: `d${id}`, label, enrolled_at: "2026-10-21T12:00:00.000Z" });

describe("withPairedNotice", () => {
  it("adds each enrollment once, by its event id, and keeps the list as it was for a repeat", () => {
    const one = withPairedNotice([], event("a"));
    expect(one.map((item) => item.event_id)).toEqual(["a"]);
    const repeated = withPairedNotice(one, event("a", "same event, told again"));
    expect(repeated).toBe(one);
    expect(withPairedNotice(one, event("b")).map((item) => item.event_id)).toEqual(["a", "b"]);
  });

  it("keeps only the newest past the limit, oldest first to go", () => {
    let list: readonly DevicePairedEvent[] = [];
    for (const id of ["a", "b", "c", "d", "e"]) list = withPairedNotice(list, event(id));
    expect(list).toHaveLength(PAIRED_NOTICE_LIMIT);
    expect(list.map((item) => item.event_id)).toEqual(["c", "d", "e"]);
  });
});
