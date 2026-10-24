import { describe, expect, it } from "bun:test";
import { ConnectionDiagnostics, transportFailureCode } from "./connection-diagnostics.ts";

function fixture() {
  let now = Date.parse("2026-10-19T00:00:00Z");
  const lines: string[] = [];
  const diagnostics = new ConnectionDiagnostics("herdr.rpc", (line) => lines.push(line), () => now);
  return { diagnostics, lines, records: () => lines.map((line) => JSON.parse(line)), advance: (ms: number) => { now += ms; } };
}

describe("connection diagnostics", () => {
  it("records the first failure with a timestamp and bounded timing fields", () => {
    const { diagnostics, records } = fixture();
    diagnostics.failed("private socket path", "timeout", { operation: "session.snapshot", request_id: "br-abc-1", elapsed_ms: 10_120.4, timeout_ms: 10_000, connect_ms: 2.8, phase: "response", pending: 2 });
    expect(records()).toEqual([{
      time: "2026-10-19T00:00:00.000Z", event: "herdr.rpc.failed", episode_id: expect.any(String),
      operation: "session.snapshot", code: "timeout", failures: 1, suppressed: 0, since_first_failure_ms: 0,
      request_id: "br-abc-1", elapsed_ms: 10_120, timeout_ms: 10_000, connect_ms: 3, phase: "response", pending: 2,
    }]);
  });

  it("coalesces repeated failures, then reports how many were suppressed", () => {
    const { diagnostics, records, advance } = fixture();
    const fields = { operation: "session.snapshot" };
    diagnostics.failed("peer", "timeout", fields);
    advance(1000);
    diagnostics.failed("peer", "timeout", fields);
    diagnostics.failed("peer", "timeout", fields);
    expect(records()).toHaveLength(1);
    advance(29_000);
    diagnostics.failed("peer", "timeout", fields);
    expect(records()[1]).toMatchObject({ failures: 4, suppressed: 2, since_first_failure_ms: 30_000 });
  });

  it("also rate-limits a peer alternating between different failure codes", () => {
    const { diagnostics, records } = fixture();
    for (let i = 0; i < 20; i++) diagnostics.failed("peer", i % 2 ? "closed" : "timeout", { operation: "session.snapshot" });
    expect(records()).toHaveLength(1);
    diagnostics.recovered("peer", { operation: "session.snapshot" });
    expect(records()[1]).toMatchObject({ failures: 20, suppressed: 19, code: "closed" });
  });

  it("reports one recovery with the same episode and suppressed failures", () => {
    const { diagnostics, records, advance } = fixture();
    diagnostics.recovered("peer", { operation: "session.snapshot" });
    expect(records()).toHaveLength(0);
    diagnostics.failed("peer", "timeout", { operation: "session.snapshot" });
    diagnostics.failed("peer", "timeout", { operation: "session.snapshot" });
    advance(5000);
    diagnostics.recovered("peer", { operation: "session.snapshot", elapsed_ms: 1 });
    diagnostics.recovered("peer", { operation: "session.snapshot" });
    expect(records()).toHaveLength(2);
    expect(records()[1]).toMatchObject({ event: "herdr.rpc.recovered", episode_id: records()[0].episode_id, failures: 2, suppressed: 1, since_first_failure_ms: 5000 });
    advance(30_000);
    diagnostics.failed("peer", "closed", { operation: "session.snapshot" });
    expect(records()[2].episode_id).not.toBe(records()[0].episode_id);
  });

  it("throttles rapid failure/recovery cycles and summarizes silent failures on the next visible episode", () => {
    const { diagnostics, records, advance } = fixture();
    for (let i = 0; i < 100; i++) {
      diagnostics.failed("peer", "closed", { operation: "session.snapshot" });
      diagnostics.recovered("peer", { operation: "session.snapshot" });
    }
    expect(records()).toHaveLength(2);
    advance(30_000);
    diagnostics.failed("peer", "timeout", { operation: "session.snapshot" });
    expect(records()[2]).toMatchObject({ event: "herdr.rpc.failed", failures: 100, suppressed: 99 });
    diagnostics.recovered("peer", { operation: "session.snapshot" });
    expect(records()).toHaveLength(4);
    expect(records()[3]).toMatchObject({ event: "herdr.rpc.recovered", episode_id: records()[2].episode_id });
    expect(records()[2].episode_id).not.toBe(records()[0].episode_id);
  });

  it("keeps failures and recoveries separate for different peers", () => {
    const { diagnostics, records } = fixture();
    diagnostics.failed("peer one", "timeout", { operation: "session.snapshot" });
    diagnostics.recovered("peer two", { operation: "session.snapshot" });
    diagnostics.failed("peer two", "closed", { operation: "session.snapshot" });
    expect(records()).toHaveLength(2);
    expect(records()[0].episode_id).not.toBe(records()[1].episode_id);
  });

  it("never logs private keys or unrecognized fields and drops unsafe labels", () => {
    const { diagnostics, lines, records } = fixture();
    const privateText = "private-secret/with\nnewline";
    diagnostics.failed(privateText, "bad_frame", {
      operation: privateText, request_id: privateText, elapsed_ms: NaN, connect_ms: -1, timeout_ms: Infinity,
      ...{ url: privateText, token: privateText, error: privateText, params: { text: privateText } },
    });
    expect(lines.join("\n")).not.toContain("private-secret");
    expect(records()[0]).toEqual({ time: expect.any(String), event: "herdr.rpc.failed", episode_id: expect.any(String), operation: "unknown", code: "bad_frame", failures: 1, suppressed: 0, since_first_failure_ms: 0 });
  });

  it("identifies a remote machine only by an opaque UUID, never a name or address", () => {
    const { diagnostics, records } = fixture();
    diagnostics.failed("one", "connection_lost", { operation: "bridge", machine_id: "00000000-0000-4000-8000-000000000001" });
    diagnostics.failed("two", "connection_lost", { operation: "bridge", machine_id: "private-host.example" });
    expect(records()[0].machine_id).toBe("00000000-0000-4000-8000-000000000001");
    expect(records()[1].machine_id).toBeUndefined();
  });

  it("bounds retained failures for peers that never recover", () => {
    const { diagnostics, records } = fixture();
    for (let i = 0; i < 129; i++) diagnostics.failed(`peer-${i}`, "timeout", { operation: "session.snapshot" });
    diagnostics.recovered("peer-0", { operation: "session.snapshot" });
    expect(records()).toHaveLength(129);
    diagnostics.recovered("peer-1", { operation: "session.snapshot" });
    expect(records()).toHaveLength(130);
  });

  it("evicts the least recently used key, not the oldest inserted", () => {
    const { diagnostics, records } = fixture();
    for (let i = 0; i < 128; i++) diagnostics.failed(`peer-${i}`, "timeout", { operation: "session.snapshot" });
    diagnostics.failed("peer-0", "timeout", { operation: "session.snapshot" });
    diagnostics.failed("peer-128", "timeout", { operation: "session.snapshot" });
    const before = records().length;
    diagnostics.recovered("peer-0", { operation: "session.snapshot" });
    expect(records()).toHaveLength(before + 1);
    diagnostics.recovered("peer-1", { operation: "session.snapshot" });
    expect(records()).toHaveLength(before + 1);
  });

  it("does not change connection handling when the log writer throws", () => {
    const diagnostics = new ConnectionDiagnostics("machine.local", () => { throw new Error("log unavailable"); });
    expect(() => diagnostics.failed("peer", "refresh_failed", { operation: "snapshot" })).not.toThrow();
    expect(() => diagnostics.recovered("peer", { operation: "snapshot" })).not.toThrow();
  });

  it("recognizes only transport errors, never a daemon's arbitrary error code", () => {
    expect(transportFailureCode("timeout")).toBe("timeout");
    expect(transportFailureCode("server_unavailable")).toBe("server_unavailable");
    expect(transportFailureCode("pane_not_found")).toBeNull();
    expect(transportFailureCode("private-secret")).toBeNull();
  });
});
