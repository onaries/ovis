import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { capturePiDeliveryAnchor, capturePiDeliveryAnchorRetrying, matchPiDeliveries, PiReceiptCapacity, type PiDeliveryAnchor, type PiDeliveryCandidate } from "./pi-delivery.ts";

const dir = () => mkdtempSync(join(tmpdir(), "ovis-pi-delivery-"));
const entry = (id: string, parentId: string | null, role: string, text: string) => JSON.stringify({
  type: "message", id, parentId, timestamp: "2026-10-24T00:00:00.000Z",
  message: { role, content: [{ type: "text", text }], timestamp: Date.now() },
}) + "\n";
const header = (id = crypto.randomUUID()) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-24T00:00:00.000Z", cwd: "/tmp" }) + "\n";
const candidate = (id: string, text: string, anchor: NonNullable<ReturnType<typeof capturePiDeliveryAnchor>>): PiDeliveryCandidate => ({ id, text, anchor });

describe("Pi receipt capacity", () => {
  it("reserves synchronously across panes for one owner", () => {
    const owner = {}, capacity = new PiReceiptCapacity<object>(1);
    const firstPane = capacity.reserve(owner);
    expect(firstPane).not.toBeNull();
    expect(capacity.reserve(owner)).toBeNull();
    capacity.release(firstPane);
  });

  it("releases a failed send's reservation", () => {
    const owner = {}, capacity = new PiReceiptCapacity<object>(1);
    const failed = capacity.reserve(owner);
    capacity.release(failed);
    expect(capacity.reserve(owner)).not.toBeNull();
  });

  it("guards record-time retention even without a reservation", () => {
    const owner = {}, capacity = new PiReceiptCapacity<object>(1);
    expect(capacity.retain(owner)).toBe(true);
    expect(capacity.retain(owner)).toBe(false);
    capacity.remove(owner);
    const reserved = capacity.reserve(owner);
    expect(capacity.retain(owner, reserved)).toBe(true);
  });
});

describe("Pi delivery transcript matching", () => {
  it("retries a capture invalidated by a concurrent append, then uses the stable anchor", async () => {
    const anchor: PiDeliveryAnchor = { path: "session.jsonl", file: "1:2", session: "s1", leaf: "a0", size: 12, prefix: "abc" };
    let captures = 0, waits = 0;
    const result = await capturePiDeliveryAnchorRetrying(anchor.path, false, undefined,
      () => ++captures < 3 ? { anchor: null, retry: true } : { anchor, retry: false },
      async () => { waits++; });
    expect(result).toEqual(anchor);
    expect({ captures, waits }).toEqual({ captures: 3, waits: 2 });
  });

  it("does not retry a genuinely unreadable transcript capture", async () => {
    let captures = 0, waits = 0;
    const result = await capturePiDeliveryAnchorRetrying("missing.jsonl", false, undefined,
      () => { captures++; return { anchor: null, retry: false }; },
      async () => { waits++; });
    expect(result).toBeNull();
    expect({ captures, waits }).toEqual({ captures: 1, waits: 0 });
  });

  it("waits through assistant work and consumes only the durable matching user append", () => {
    const path = join(dir(), "session.jsonl");
    writeFileSync(path, header() + entry("u0", null, "user", "before") + entry("a0", "u0", "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path);
    expect(anchor?.leaf).toBe("a0");
    expect(matchPiDeliveries(path, [candidate("r1", "later", anchor!)])).toEqual({ consumed: [], changed: [], retry: false });
    appendFileSync(path, entry("u1", "a0", "user", "later"));
    expect(matchPiDeliveries(path, [candidate("r1", "later", anchor!)])).toEqual({ consumed: ["r1"], changed: [], retry: false });
  });

  it("matches duplicate Ovis text by FIFO occurrence and consumes one receipt per entry", () => {
    const path = join(dir(), "session.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    const receipts = [candidate("r1", "same", anchor), candidate("r2", "same", anchor)];
    appendFileSync(path, entry("u1", "a0", "user", "same"));
    expect(matchPiDeliveries(path, receipts)).toEqual({ consumed: ["r1"], changed: [], retry: false });
    appendFileSync(path, entry("u2", "u1", "user", "same"));
    expect(matchPiDeliveries(path, receipts)).toEqual({ consumed: ["r1", "r2"], changed: [], retry: false });
  });

  it("ignores unrelated external user entries without advancing an Ovis receipt", () => {
    const path = join(dir(), "session.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("external", "a0", "user", "from the terminal") + entry("ours", "external", "user", "from Ovis"));
    expect(matchPiDeliveries(path, [candidate("r1", "from Ovis", anchor)])).toEqual({ consumed: ["r1"], changed: [], retry: false });
  });

  it("does not reuse a consumed transcript entry across reconciliation calls", () => {
    const path = join(dir(), "reconcile.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    const consumed = new Set<string>();
    appendFileSync(path, entry("u1", "a0", "user", "same"));
    expect(matchPiDeliveries(path, [candidate("r1", "same", anchor), candidate("r2", "same", anchor)], consumed))
      .toEqual({ consumed: ["r1"], changed: [], retry: false });
    expect(matchPiDeliveries(path, [candidate("r2", "same", anchor)], consumed))
      .toEqual({ consumed: [], changed: [], retry: false });
    appendFileSync(path, entry("u2", "u1", "user", "same"));
    expect(matchPiDeliveries(path, [candidate("r2", "same", anchor)], consumed))
      .toEqual({ consumed: ["r2"], changed: [], retry: false });
  });

  it("does not cross ordered Ovis receipts when a later text appears first", () => {
    const path = join(dir(), "session.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("u1", "a0", "user", "second"));
    expect(matchPiDeliveries(path, [candidate("r1", "first", anchor), candidate("r2", "second", anchor)])).toEqual({ consumed: [], changed: [], retry: false });
    appendFileSync(path, entry("u2", "u1", "user", "first") + entry("u3", "u2", "user", "second"));
    expect(matchPiDeliveries(path, [candidate("r1", "first", anchor), candidate("r2", "second", anchor)])).toEqual({ consumed: ["r1", "r2"], changed: [], retry: false });
  });

  it("accepts an unwritten session only when that exact path becomes its first file", () => {
    const path = join(dir(), "session.jsonl");
    const session = crypto.randomUUID();
    const anchor = capturePiDeliveryAnchor(path, true, session)!;
    expect(anchor).toMatchObject({ leaf: null, file: null, session });
    writeFileSync(path, header(session) + entry("u1", null, "user", "first"));
    expect(matchPiDeliveries(path, [candidate("r1", "first", anchor)])).toEqual({ consumed: ["r1"], changed: [], retry: false });
  });

  it("does not consume a pre-anchor identical turn that a later branch switch makes active", () => {
    const path = join(dir(), "branches.jsonl");
    writeFileSync(path, header() + entry("root", null, "assistant", "root")
      + entry("captured", "root", "assistant", "captured")
      + entry("old-same", "root", "user", "ours")
      + entry("current", "captured", "assistant", "current"));
    const anchor = capturePiDeliveryAnchor(path)!;
    appendFileSync(path, entry("switch", "old-same", "assistant", "switch"));
    expect(matchPiDeliveries(path, [candidate("r1", "ours", anchor)]))
      .toEqual({ consumed: [], changed: ["r1"], retry: false });
  });

  it("fails closed when the same inode is rewritten before the captured append boundary", () => {
    const path = join(dir(), "rewrite.jsonl"), session = crypto.randomUUID();
    const original = header(session) + entry("a0", null, "assistant", "old");
    writeFileSync(path, original);
    const anchor = capturePiDeliveryAnchor(path)!;
    const rewritten = header(session) + entry("b0", null, "assistant", "new");
    expect(rewritten.length).toBe(original.length);
    writeFileSync(path, rewritten);
    appendFileSync(path, entry("u1", "b0", "user", "ours"));
    expect(matchPiDeliveries(path, [candidate("r1", "ours", anchor)]))
      .toEqual({ consumed: [], changed: ["r1"], retry: false });
  });

  it("fails closed when the file or active branch no longer contains the captured leaf", () => {
    const root = dir(), path = join(root, "session.jsonl");
    writeFileSync(path, header() + entry("a0", null, "assistant", "working"));
    const replaced = capturePiDeliveryAnchor(path)!;
    writeFileSync(path, header() + entry("u1", null, "user", "ours"));
    expect(matchPiDeliveries(path, [candidate("replace", "ours", replaced)])).toEqual({ consumed: [], changed: ["replace"], retry: false });

    const branchPath = join(root, "branch.jsonl");
    writeFileSync(branchPath, header() + entry("root", null, "assistant", "root") + entry("old", "root", "assistant", "old"));
    const branched = capturePiDeliveryAnchor(branchPath)!;
    appendFileSync(branchPath, entry("new", "root", "user", "ours"));
    expect(matchPiDeliveries(branchPath, [candidate("branch", "ours", branched)])).toEqual({ consumed: [], changed: ["branch"], retry: false });
  });
});
