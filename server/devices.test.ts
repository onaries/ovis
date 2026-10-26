import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevicePairedEvent } from "../shared/protocol.ts";
import { DeviceStore, newStreamKey, normalizeLabel, sameBrowser, streamCookie, streamKeys } from "./devices.ts";
import { privateStateFs } from "./private-state.ts";
import { isTaggedNode, parseTailscaleOwner } from "./tailscale.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-devices-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("DeviceStore", () => {
  it("keeps an unreadable or invalid registry gated and intact for recovery", () => {
    for (const contents of ["{broken", "null", "{}", '{"devices":[]}', '{"gate_closed_at":null,"devices":[{}]}']) {
      const root = mkdtempSync(join(dir, "invalid-"));
      const path = join(root, "devices.json");
      writeFileSync(path, contents);
      const store = new DeviceStore(root);
      expect(store.gated).toBe(true);
      expect(store.error).toContain("Restore a valid devices.json");
      expect(() => store.startPairing()).toThrow();
      expect(() => store.revoke("any")).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
    const unreadable = mkdtempSync(join(dir, "unreadable-"));
    mkdirSync(join(unreadable, "devices.json"));
    expect(new DeviceStore(unreadable).gated).toBe(true);
    const fresh = new DeviceStore(mkdtempSync(join(dir, "fresh-")));
    expect(fresh.error).toBeNull();
    expect(fresh.gated).toBe(false);

    const legacy = mkdtempSync(join(dir, "legacy-gate-"));
    writeFileSync(join(legacy, "devices.json"), JSON.stringify({
      gate_closed_at: null,
      devices: [{ id: "0123456789abcdef", label: "Legacy", role: "drive", token_hash: "hash", created_at: new Date().toISOString(), last_seen_at: null }],
    }));
    const legacyStore = new DeviceStore(legacy);
    expect(legacyStore.gated).toBe(true);
    expect(legacyStore.list(null)[0]?.last_seen_at).toBeNull();
    expect(legacyStore.revoke("0123456789abcdef")).toBe(true);
    expect(legacyStore.gated).toBe(true);
    expect(new DeviceStore(legacy).gated).toBe(true);
  });

  it("closes only the revoked device's listeners, including late registrations", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "listeners-")));
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    expect(store.match(a.token)).not.toBeNull();
    const b = store.pair(store.startPairing().code, "B", "drive")!;
    expect(store.match(b.token)).not.toBeNull();
    const closed: string[] = [];
    store.onRevoke(a.device.id, () => closed.push("a"));
    store.onRevoke(b.device.id, () => closed.push("b"));
    const unsubscribe = store.onRevoke(a.device.id, () => closed.push("finished"));
    unsubscribe();
    store.revoke(a.device.id);
    store.onRevoke(a.device.id, () => closed.push("late upgrade"));
    expect(closed).toEqual(["a", "late upgrade"]);
    expect(store.match(b.token)).not.toBeNull();
  });

  it("pairs with the code once, keeps only a hash, and finds the device by its token", () => {
    const store = new DeviceStore(dir);
    expect(store.gated).toBe(false);
    const { code } = store.startPairing();
    expect(code).toMatch(/^\d{6}$/);
    expect(store.pair("000000".replace(/./g, (c) => c === code[0] ? "1" : c), "x", "drive")).toBeNull(); // a wrong code
    const paired = store.pair(code.slice(0, 3) + " " + code.slice(3), "My phone", "drive");
    expect(paired).not.toBeNull();
    expect(store.pair(code, "again", "drive")).toBeNull(); // spent
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(() => statSync(join(dir, "devices.json"))).toThrow();
    expect(new DeviceStore(dir).gated).toBe(false); // an unreturned cookie is not durable across restart
    expect(new DeviceStore(dir).match(paired!.token)).toBeNull();
    expect(store.match(paired!.token)).toEqual({ id: paired!.device.id, label: "My phone", role: "drive" });
    expect(store.gated).toBe(true);
    const file = readFileSync(join(dir, "devices.json"), "utf8");
    expect(file).not.toContain(paired!.token);
    expect((statSync(join(dir, "devices.json")).mode & 0o777)).toBe(0o600);
    expect(new DeviceStore(dir).gated).toBe(true);
    expect(store.match("not-a-token")).toBeNull();
    // and a second store reading the same file knows the device
    expect(new DeviceStore(dir).match(paired!.token)?.label).toBe("My phone");
  });

  it("expires a code after ten minutes and after five wrong tries", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "s-")));
    const started = Date.now();
    const { code } = store.startPairing(started);
    expect(store.pair(code, "late", "drive", started + 10 * 60_000 + 1)).toBeNull();
    const second = store.startPairing().code;
    for (let i = 0; i < 5; i++) expect(store.pair("999999" === second ? "000000" : "999999", "x", "drive")).toBeNull();
    expect(store.pair(second, "x", "drive")).toBeNull();
  });

  it("keeps a first-pair retry open, preserves issued candidates across replaced codes, and bounds them", () => {
    const root = mkdtempSync(join(dir, "retry-"));
    const store = new DeviceStore(root);
    const now = Date.now();
    const replaced = store.startPairing(now).code;
    const firstCode = store.startPairing(now + 1).code;
    expect(store.pair(replaced, "obsolete", "drive", now + 1)).toBeNull();
    const lost = store.pair(firstCode, "Lost cookie", "drive", now + 1)!;
    const retry = store.pair(store.startPairing(now + 2).code, "Retry", "drive", now + 2)!;
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(store.match(retry.token, now + 3)).toEqual(retry.device);
    expect(store.gated).toBe(true);
    expect(store.match(lost.token, now + 4)).toBeNull();
    expect(store.list(null)).toHaveLength(1);
    expect(store.revoke(retry.device.id)).toBe(true);
    expect(store.gated).toBe(true);
    expect(store.match(lost.token, now + 5)).toBeNull();
    expect(store.list(null)).toEqual([]);
    expect(new DeviceStore(root).gated).toBe(true);

    const bounded = new DeviceStore(mkdtempSync(join(dir, "bounded-")));
    const issued: { token: string; device: { id: string; label: string; role: "drive" | "watch" } }[] = [];
    for (let i = 0; i < 9; i += 1) {
      const at = now + i * 2;
      issued.push(bounded.pair(bounded.startPairing(at).code, `Device ${i}`, "drive", at)!);
    }
    expect(bounded.match(issued[0]!.token, now + 20)).toBeNull();
    expect(bounded.gated).toBe(false);
    expect(bounded.list(null)).toEqual([]);
    expect(bounded.match(issued[8]!.token, now + 20)).not.toBeNull();
    expect(bounded.gated).toBe(true);
  });

  it("expires unconfirmed first-pair cookies and loses them on restart without closing the gate", () => {
    const root = mkdtempSync(join(dir, "candidate-expiry-"));
    const store = new DeviceStore(root);
    const started = Date.now();
    const paired = store.pair(store.startPairing(started).code, "Expired", "drive", started)!;
    expect(store.match(paired.token, started + 10 * 60_000 + 1)).toBeNull();
    expect(store.gated).toBe(false);
    expect(store.list(null)).toEqual([]);
    expect(new DeviceStore(root).gated).toBe(false);
  });

  it("renames, revokes, and marks the caller's device", () => {
    const root = mkdtempSync(join(dir, "r-"));
    const store = new DeviceStore(root);
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    store.match(a.token);
    const b = store.pair(store.startPairing().code, "B", "drive")!;
    const reloaded = new DeviceStore(root);
    expect(reloaded.gated).toBe(true);
    expect(reloaded.list(null).find((device) => device.id === b.device.id)?.last_seen_at).toBeNull();
    store.match(b.token);
    expect(store.list(a.device.id).map((d) => [d.label, d.current])).toEqual([["A", true], ["B", false]]);
    expect(store.update(b.device.id, { label: "Bee" })?.label).toBe("Bee");
    expect(store.revoke(a.device.id)).toBe(true);
    expect(store.revoke(a.device.id)).toBe(false);
    expect(store.match(a.token)).toBeNull();
    expect(store.match(b.token)?.label).toBe("Bee");
    // revoking the last device does not reopen the gate, not even after a restart
    expect(store.revoke(b.device.id)).toBe(true);
    expect(store.gated).toBe(true);
    expect(new DeviceStore(root).gated).toBe(true);
  });
});

describe("revoke all", () => {
  it("revoke all is atomic and stays gated after restart", () => {
    const root = mkdtempSync(join(dir, "revoke-all-"));
    const store = new DeviceStore(root);
    const a = store.pair(store.startPairing().code, "A", "drive")!;
    store.match(a.token);
    const b = store.pair(store.startPairing().code, "B", "watch")!;
    store.match(b.token);
    const closed: string[] = [];
    store.onRevoke(a.device.id, () => closed.push("a"));
    store.onRevoke(a.device.id, () => closed.push("a2"));
    store.onRevoke(b.device.id, () => closed.push("b"));
    expect(store.revokeAll().sort()).toEqual([a.device.id, b.device.id].sort());
    expect(closed.sort()).toEqual(["a", "a2", "b"]);
    expect(store.list(null)).toEqual([]);
    expect(store.has(a.device.id)).toBe(false);
    expect(store.match(a.token)).toBeNull();
    expect(store.match(b.token)).toBeNull();
    expect(store.gated).toBe(true);
    const registry = JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { gate_closed_at: string | null; devices: unknown[] };
    expect(registry).toEqual({ gate_closed_at: expect.any(String), devices: [] });
    const reloaded = new DeviceStore(root);
    expect(reloaded.gated).toBe(true);
    expect(reloaded.match(a.token)).toBeNull();
    // a listener registered after the fact is closed at once, as after a single revocation
    store.onRevoke(a.device.id, () => closed.push("late"));
    expect(closed).toContain("late");
    // nothing more to revoke: still one durable write of an empty, gated registry
    expect(store.revokeAll()).toEqual([]);
    expect(new DeviceStore(root).gated).toBe(true);
  });

  it("save failure preserves pending and live devices", () => {
    const root = mkdtempSync(join(dir, "revoke-all-failure-"));
    const store = new DeviceStore(root);
    const live = store.pair(store.startPairing().code, "Live", "drive")!;
    store.match(live.token);
    const pendingCode = store.startPairing().code;
    let closed = false;
    store.onRevoke(live.device.id, () => { closed = true; });
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try {
      expect(() => store.revokeAll()).toThrow("EIO");
      expect(closed).toBe(false);
      expect(store.list(null).map((d) => d.label)).toEqual(["Live"]);
      expect(store.match(live.token)?.label).toBe("Live");
    } finally { fsync.mockRestore(); }
    expect(new DeviceStore(root).match(live.token)?.label).toBe("Live");
    // the pending code is still good after the failed attempt: nothing was voided
    expect(store.pair(pendingCode, "Second", "drive")).not.toBeNull();
    expect(store.revokeAll()).toHaveLength(2);
    expect(closed).toBe(true);
  });

  it("unconfirmed credentials and pending codes are void", () => {
    const root = mkdtempSync(join(dir, "revoke-all-void-"));
    const store = new DeviceStore(root);
    // only a first-pair candidate exists: the gate is still open and no registry is on disk
    const candidate = store.pair(store.startPairing().code, "Candidate", "drive")!;
    const code = store.startPairing().code;
    expect(store.gated).toBe(false);
    expect(store.revokeAll()).toEqual([]);
    // revoking closes the gate durably even though no device was ever confirmed
    expect(store.gated).toBe(true);
    expect(new DeviceStore(root).gated).toBe(true);
    expect(store.match(candidate.token)).toBeNull();
    expect(store.pair(code, "Stale code", "drive")).toBeNull();
    expect(store.list(null)).toEqual([]);
    // a code issued after the revocation pairs through the gated flow and is announced
    const notices: string[] = [];
    store.onPaired((event) => notices.push(event.label));
    const fresh = store.pair(store.startPairing().code, "Fresh", "drive")!;
    expect(store.match(fresh.token)?.label).toBe("Fresh");
    expect(notices).toEqual(["Fresh"]);
  });

  it("notice occurs once after durable enrollment", () => {
    const root = mkdtempSync(join(dir, "paired-notice-"));
    const store = new DeviceStore(root);
    const events: DevicePairedEvent[] = [];
    const stop = store.onPaired((event) => events.push(event));
    // issuing an unconfirmed first-pair credential announces nothing
    const first = store.pair(store.startPairing().code, "  First   phone ", "drive")!;
    expect(events).toEqual([]);
    // its confirmation (the first cookie that returns) is the durable enrollment: once
    expect(store.match(first.token)).not.toBeNull();
    expect(store.match(first.token)).not.toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "device-paired", event_id: expect.stringMatching(/^[0-9a-f]{16}$/), device_id: first.device.id, label: "  First   phone ", enrolled_at: expect.any(String) });
    expect(Date.parse(events[0]!.enrolled_at)).not.toBeNaN();
    // a gated pairing is durable at once: one notice, and none for its later requests
    const second = store.pair(store.startPairing().code, "Second", "drive")!;
    expect(events).toHaveLength(2);
    expect(events[1]!.device_id).toBe(second.device.id);
    expect(events[1]!.event_id).not.toBe(events[0]!.event_id);
    store.match(second.token, Date.now() + 120_000); // a last-seen write
    store.update(second.device.id, { label: "Renamed" });
    expect(events).toHaveLength(2);
    // a pairing whose write fails announces nothing
    const code = store.startPairing().code;
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try { expect(() => store.pair(code, "Failed", "drive")).toThrow("EIO"); } finally { fsync.mockRestore(); }
    expect(events).toHaveLength(2);
    stop();
    expect(store.pair(code, "Unheard", "drive")).not.toBeNull();
    expect(events).toHaveLength(2);
  });

  it("tells the moment of enrollment, not of issue, and the browser that asked for it", () => {
    const store = new DeviceStore(mkdtempSync(join(dir, "enrolled-at-")));
    const heard: { event: DevicePairedEvent; origin: readonly string[] }[] = [];
    store.onPaired((event, origin) => heard.push({ event, origin }));
    // a first-pair credential issued at 12:00 and returned at 12:05 was enrolled at 12:05
    const issuedAt = Date.parse("2026-10-21T12:00:00.000Z");
    const confirmedAt = Date.parse("2026-10-21T12:05:00.000Z");
    const self = ["a".repeat(32), "b".repeat(32)];
    const first = store.pair(store.startPairing(issuedAt).code, "Phone", "drive", issuedAt, self)!;
    expect(heard).toEqual([]);
    expect(store.match(first.token, confirmedAt)).not.toBeNull();
    expect(heard).toEqual([{ event: expect.objectContaining({ device_id: first.device.id, enrolled_at: "2026-10-21T12:05:00.000Z" }), origin: self }]);
    // a gated pairing is enrolled when its write succeeds; one that names no browser is told with none
    const gatedAt = Date.parse("2026-10-21T12:07:30.000Z");
    const second = store.pair(store.startPairing(gatedAt).code, "Tablet", "drive", gatedAt)!;
    expect(heard[1]).toEqual({ event: expect.objectContaining({ device_id: second.device.id, enrolled_at: "2026-10-21T12:07:30.000Z" }), origin: [] });
  });

  it("reads every stream key a browser holds and ignores malformed ones", () => {
    const a = "a".repeat(32);
    const b = "b".repeat(32);
    const keys = (cookie: string) => streamKeys(new Request("http://host/", { headers: { cookie } }));
    expect(keys(`ovis_stream_${a}=1; other=x; ovis_stream_${b}=1`)).toEqual([a, b]);
    // a wrong value, a short or upper-case key, the bare name, a junk pair: none is a key, and none refuses the rest
    expect(keys(`ovis_stream_${a}=0; ovis_stream_${"A".repeat(32)}=1; ovis_stream_abc=1; ovis_stream=${a}; =1; %zz; ovis_stream_${b}=1`)).toEqual([b]);
    expect(keys("")).toEqual([]);
    // at most eight are read from one request
    const many = Array.from({ length: 12 }, (_, index) => index.toString(16).repeat(32));
    expect(keys(many.map((key) => `ovis_stream_${key}=1`).join("; "))).toEqual(many.slice(0, 8));
    expect(sameBrowser([a, b], [b])).toBe(true);
    expect(sameBrowser([a], [b])).toBe(false);
    expect(sameBrowser([], [a])).toBe(false);
    // the cookie that issues one: its own name, no authority, a year like the device cookie
    expect(streamCookie(a, true)).toBe(`ovis_stream_${a}=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure`);
    expect(streamCookie(a, false)).not.toContain("Secure");
    expect(newStreamKey()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("labels and owner", () => {
  it("trims labels and falls back", () => {
    expect(normalizeLabel("  my   phone ", "Device")).toBe("my phone");
    expect(normalizeLabel("", "Device")).toBe("Device");
    expect(normalizeLabel(42, "Device")).toBe("Device");
    expect(normalizeLabel("x".repeat(80), "Device")).toHaveLength(48);
  });

  it("reads the PC's login out of tailscale status", () => {
    const status = JSON.stringify({ Self: { UserID: 42 }, User: { "42": { LoginName: "me@example.com" }, "43": { LoginName: "them@example.com" } } });
    expect(parseTailscaleOwner(status)).toBe("me@example.com");
    expect(parseTailscaleOwner(JSON.stringify({ Self: { UserID: 99 }, User: {} }))).toBeNull();
    // a real id is past 2^53: as a double it becomes ...136 and names nobody (#526)
    expect(parseTailscaleOwner('{"Self":{"UserID":15633668397603135},"User":{"15633668397603135":{"LoginName":"me@example.com"}}}')).toBe("me@example.com");
    expect(parseTailscaleOwner(null)).toBeNull();
    expect(parseTailscaleOwner("nope")).toBeNull();
    expect(isTaggedNode(status)).toBeFalse();
    // a tagged node's user entry is the node itself: no person's login
    const tagged = JSON.stringify({ Self: { UserID: 7, Tags: ["tag:server"] }, User: { "7": { LoginName: "pc.tailnet.ts.net" } } });
    expect(parseTailscaleOwner(tagged)).toBeNull();
    expect(isTaggedNode(tagged)).toBeTrue();
    expect(isTaggedNode(null)).toBeFalse();
  });
});

it("reports failed registry writes without committing a pair, rename or revocation in memory", () => {
  const root = mkdtempSync(join(dir, "write-failure-"));
  const store = new DeviceStore(root);
  const first = store.pair(store.startPairing().code, "Original", "drive")!;
  store.match(first.token);
  let closed = false;
  store.onRevoke(first.device.id, () => { closed = true; });
  const code = store.startPairing().code;
  const rename = spyOn(privateStateFs, "renameSync").mockImplementation(() => { throw new Error("EXDEV: rename refused"); });
  try {
    expect(() => store.pair(code, "Failed pair", "drive")).toThrow("EXDEV");
    expect(() => store.update(first.device.id, { label: "Failed rename" })).toThrow("EXDEV");
    expect(() => store.revoke(first.device.id)).toThrow("EXDEV");
  } finally { rename.mockRestore(); }
  expect(closed).toBe(false);
  expect(readdirSync(root)).toEqual(["devices.json"]);
  expect(store.list(null).map((d) => d.label)).toEqual(["Original"]);
  expect(store.match(first.token)?.label).toBe("Original");
  expect(new DeviceStore(root).match(first.token)?.label).toBe("Original");
  expect(store.pair(code, "Retry", "drive")).not.toBeNull();
  expect(store.revoke(first.device.id)).toBe(true);
  expect(closed).toBe(true);
  expect(new DeviceStore(root).match(first.token)).toBeNull();
});

it("does not authorize a first-pair cookie when promotion cannot be persisted", () => {
  const root = mkdtempSync(join(dir, "promotion-failure-"));
  const store = new DeviceStore(root);
  const candidate = store.pair(store.startPairing().code, "Pending", "drive")!;
  const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
  try {
    expect(() => store.match(candidate.token)).toThrow("EIO");
  } finally { fsync.mockRestore(); }
  expect(readdirSync(root)).toEqual([]);
  expect(store.gated).toBe(false);
  expect(store.list(null)).toEqual([]);
  expect(new DeviceStore(root).gated).toBe(false);
  expect(store.match(candidate.token)).toEqual(candidate.device);
  expect(store.gated).toBe(true);
  expect(new DeviceStore(root).match(candidate.token)).toEqual(candidate.device);
});

it("does not commit a failed revocation", () => {
  const root = mkdtempSync(join(dir, "revoke-failure-"));
  const store = new DeviceStore(root);
  const only = store.pair(store.startPairing().code, "Phone", "drive")!;
  store.match(only.token);
  const before = readFileSync(join(root, "devices.json"), "utf8");
  const receipts: string[] = [];
  store.onRevoke(only.device.id, () => { receipts.push(only.device.id); });
  // a short write first, so the failure lands after part of the document reached the temporary file
  const realWrite = privateStateFs.writeSync;
  let writes = 0;
  const write = spyOn(privateStateFs, "writeSync").mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number) =>
    realWrite(fd, buffer, offset, ++writes === 1 ? 7 : length)) as typeof realWrite);
  const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
  try {
    expect(() => store.revoke(only.device.id)).toThrow("EIO");
  } finally { write.mockRestore(); fsync.mockRestore(); }
  expect(writes).toBe(2);
  expect(receipts).toEqual([]);
  expect(store.has(only.device.id)).toBe(true);
  expect(store.match(only.token)?.id).toBe(only.device.id);
  expect(readdirSync(root)).toEqual(["devices.json"]);
  expect(readFileSync(join(root, "devices.json"), "utf8")).toBe(before);

  expect(store.revoke(only.device.id)).toBe(true);
  expect(receipts).toEqual([only.device.id]);
  // the final revocation keeps the gate closed, also for the next start
  const reopened = new DeviceStore(root);
  expect(reopened.gated).toBe(true);
  expect(reopened.match(only.token)).toBeNull();
  expect(reopened.list(null)).toEqual([]);
});

it("flushes the last-seen update before it replaces the registry", () => {
  const root = mkdtempSync(join(dir, "last-seen-"));
  const store = new DeviceStore(root);
  const paired = store.pair(store.startPairing().code, "Phone", "drive")!;
  const confirmedAt = Date.now();
  const fsync = spyOn(privateStateFs, "fsyncSync");
  try {
    store.match(paired.token, confirmedAt);
    const authorizationSyncs = fsync.mock.calls.length;
    expect(authorizationSyncs).toBeGreaterThanOrEqual(1);
    store.match(paired.token, confirmedAt + 61_000);
    expect(fsync.mock.calls.length).toBeGreaterThan(authorizationSyncs);
  } finally { fsync.mockRestore(); }
  expect(new DeviceStore(root).list(null)[0]?.last_seen_at).toBe(new Date(confirmedAt + 61_000).toISOString());
});

it("keeps the previous registry intact and the credential valid when a last-seen write fails before rename", () => {
  const root = mkdtempSync(join(dir, "last-seen-failure-"));
  const store = new DeviceStore(root);
  const paired = store.pair(store.startPairing().code, "Phone", "drive")!;
  const confirmedAt = Date.now();
  store.match(paired.token, confirmedAt);
  const before = readFileSync(join(root, "devices.json"), "utf8");
  const rename = spyOn(privateStateFs, "renameSync").mockImplementation(() => { throw new Error("EXDEV: rename refused"); });
  try {
    expect(store.match(paired.token, confirmedAt + 61_000)).toEqual(paired.device);
    expect(rename).toHaveBeenCalledTimes(1);
  } finally { rename.mockRestore(); }
  expect(readdirSync(root)).toEqual(["devices.json"]);
  expect(readFileSync(join(root, "devices.json"), "utf8")).toBe(before);
  const reopened = new DeviceStore(root);
  expect(reopened.error).toBeNull();
  expect(reopened.list(null)[0]?.last_seen_at).toBe(new Date(confirmedAt).toISOString());
  expect(reopened.match(paired.token, confirmedAt + 62_000)).toEqual(paired.device);
});
