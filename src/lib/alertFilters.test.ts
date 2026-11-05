import { describe, expect, it } from "bun:test";

import { keyedAlertPcs, parseAlertFilters, withAlertFilters } from "./alertFilters.ts";

describe("this device's finer alert choices", () => {
  it("reads only known fields, and anything else as the defaults", () => {
    expect(parseAlertFilters(null)).toEqual({ pcsOff: [] });
    expect(parseAlertFilters("not json")).toEqual({ pcsOff: [] });
    expect(parseAlertFilters("[1]")).toEqual({ pcsOff: [] });
    expect(parseAlertFilters(JSON.stringify({ permission: false, error: true, pcsOff: ["Desk", "Desk", 3] })))
      .toEqual({ permission: false, error: true, pcsOff: ["Desk"] });
  });

  it("adds the relay ID of a PC turned off by name once the roster names it, and nothing else (#2876)", () => {
    const office = { name: "Office", server_id: "cd".repeat(16) }, relay = { name: "Home PC", relay: { server_id: "ef".repeat(16), relay: "wss://relay.example" } };
    const pcsOff = ["Office", "Home PC"];
    expect(keyedAlertPcs(pcsOff, [office, relay, { name: "Desk" }])).toEqual(["Office", "Home PC", office.server_id, relay.relay.server_id]);
    const keyed = ["Office", office.server_id];
    expect(keyedAlertPcs(keyed, [office, { name: "Desk" }])).toBe(keyed);
    expect(keyedAlertPcs([], [office])).toEqual([]);
  });

  it("sends only the choices made, so a device that made none subscribes as before", () => {
    expect(withAlertFilters({ input: true, done: "long" }, { pcsOff: [] })).toEqual({ input: true, done: "long" });
    expect(withAlertFilters({ input: false, done: "off" }, { permission: true, error: false, pcsOff: ["Home PC"] }))
      .toEqual({ input: false, done: "off", permission: true, error: false, pcs_off: ["Home PC"] });
  });
});
