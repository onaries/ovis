import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, chmodSync, closeSync, mkdtempSync, openSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandHistory, commandHistorySize, historyVersion, holdCommandHistory, resetCommandHistory, waitCommandHistory, watchCommandHistory } from "./claude-command-history.ts";

const roots: string[] = [];
const release: (() => void)[] = [];
afterEach(() => {
  for (const done of release.splice(0)) done();
  resetCommandHistory();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(name = "parent") {
  const root = mkdtempSync(join(tmpdir(), "ovis-command-history-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, "");
  return { path, root, limit: () => statSync(path).size };
}
const json = (entry: unknown): string => `${JSON.stringify(entry)}\n`;
const notice = (id: string, status = "completed"): string => json({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-01T12:00:00.000Z", content: `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>Background command finished</summary></task-notification>` });
const filler = json({ type: "progress", value: "x".repeat(1024) }).repeat(1024);
/** Resolves on the first change of `path`'s history for which `test` holds. */
function heard(path: string, test: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stop = watchCommandHistory(path, () => { if (test()) { stop!(); resolve(); } });
    expect(stop).not.toBeNull();
    release.push(stop!);
  });
}

it("reuses complete all-ID coverage for newly discovered IDs and scans only appends", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("first") + notice("discovered_later", "failed") + filler);
  const first = await waitCommandHistory(s.path, s.limit());
  expect(first).toMatchObject({ complete: true, through: s.limit() });
  expect(first!.ends.map((end) => end.id)).toEqual(["first", "discovered_later"]);
  const again = commandHistory(s.path, s.limit());
  expect(again).toEqual(first);
  expect(commandHistorySize().waiting).toBe(0);
  appendFileSync(s.path, notice("next"));
  const next = await waitCommandHistory(s.path, s.limit());
  expect(next!.ends.map((end) => end.id)).toEqual(["first", "discovered_later", "next"]);
});

it("invalidates completion authority on replacement, truncation and same-size rewrites", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("old"));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends).toHaveLength(1);
  const replacement = join(s.root, "replacement");
  writeFileSync(replacement, notice("new"));
  renameSync(replacement, s.path);
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["new"]);
  writeFileSync(s.path, notice("alt"));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["alt"]);
  writeFileSync(s.path, "{}\n");
  expect((await waitCommandHistory(s.path, s.limit()))!.ends).toEqual([]);
});

it("invalidates completion authority on a same-size rewrite within the timestamp tick of the check", async () => {
  const s = fixture();
  // one timestamp for both writes, as two writes a millisecond apart keep on Windows; a minute ahead,
  // so every check of this test begins within its tick however slowly it runs
  const tick = Math.ceil(Date.now() / 1000) + 60;
  writeFileSync(s.path, notice("new"));
  utimesSync(s.path, tick, tick);
  const before = historyVersion(s.path);
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["new"]);
  writeFileSync(s.path, notice("alt"));
  utimesSync(s.path, tick, tick);
  expect(historyVersion(s.path)).toEqual(before);
  expect(commandHistory(s.path, s.limit(), false)!.ends).toEqual([]);
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["alt"]);
});

it("times the recheck within a version's tick for a watch taken again after the last one let go", async () => {
  const s = fixture();
  const tick = Math.ceil(Date.now() / 1000) + 60;
  writeFileSync(s.path, notice("same"));
  utimesSync(s.path, tick, tick);
  await waitCommandHistory(s.path, s.limit());
  // asked while nobody watches: the recheck is held back untimed
  commandHistory(s.path, s.limit());
  expect(commandHistorySize().timers).toBe(0);
  release.push(watchCommandHistory(s.path, () => {})!);
  expect(commandHistorySize().timers).toBe(1);
});

/** `body` written with a timestamp a minute ahead, so every check of the test begins within its tick, and read through. */
async function racy(body: string) {
  const s = fixture();
  const tick = Math.ceil(Date.now() / 1000) + 60;
  writeFileSync(s.path, body);
  utimesSync(s.path, tick, tick);
  await waitCommandHistory(s.path, s.limit());
  return s;
}
/** The bytes `run` asks fs.readSync for, and how many reads. */
function reads(run: () => unknown): Promise<{ bytes: number; calls: number }> {
  const spy = spyOn(fs, "readSync");
  return Promise.resolve(run()).then(() => ({ bytes: spy.mock.calls.reduce((sum, call) => sum + ((call as unknown[])[3] as number), 0), calls: spy.mock.calls.length })).finally(() => spy.mockRestore());
}

it("tells the ends whose lines it reads again within a tick, past the most it reads at once, and all to a request it checked for", async () => {
  // five ends of 900 KB lines: more than one call reads again
  const big = (id: string) => json({ ...JSON.parse(notice(id)), pad: "x".repeat(900 * 1024) });
  const ids = ["a", "b", "c", "d", "e"];
  const s = await racy(ids.map(big).join(""));
  const now = commandHistory(s.path, s.limit(), false)!;
  expect(now.ends.map((end) => end.id)).toEqual(["b", "c", "d", "e"]);
  expect(now.complete).toBe(false);
  appendFileSync(s.path, json({ type: "progress" }));
  utimesSync(s.path, Math.ceil(Date.now() / 1000) + 60, Math.ceil(Date.now() / 1000) + 60);
  expect(await waitCommandHistory(s.path, s.limit())).toMatchObject({ complete: true, ends: ids.map((id) => ({ id })) });
});

it("shares one recheck within a version's tick among the requests that wait, reading only the lines of its ends", async () => {
  const s = await racy(filler.repeat(2) + notice("same"));
  const read = await reads(async () => { for (let request = 0; request < 5; request++) expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["same"]); });
  expect(read.bytes).toBeLessThan(s.limit());
});

it("reads the lines of ends close together at once", async () => {
  const s = await racy(Array.from({ length: 50 }, (_, index) => notice(`id${index}`)).join(""));
  const read = await reads(() => expect(commandHistory(s.path, s.limit(), false)!.ends).toHaveLength(50));
  expect(read.calls).toBe(1);
});

it("rechecks a version whose mtime is far ahead of the clock within the check interval", async () => {
  const s = fixture();
  // 60 days ahead: past setTimeout's limit, a delay that long would fire at once, again and again
  const tick = Math.ceil(Date.now() / 1000) + 60 * 86_400;
  writeFileSync(s.path, notice("same"));
  utimesSync(s.path, tick, tick);
  await waitCommandHistory(s.path, s.limit());
  const timers = spyOn(globalThis, "setTimeout");
  try {
    release.push(watchCommandHistory(s.path, () => {})!);
    const delays = timers.mock.calls.map((call) => call[1] as number);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeLessThanOrEqual(5000);
  } finally { timers.mockRestore(); }
  // and once that interval is past, the check is due, not put off again
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
  try {
    commandHistory(s.path, s.limit());
    expect(commandHistorySize().waiting).toBe(1);
  } finally { clock.mockRestore(); }
});

it("reads again no more than its budget of bytes, the gaps between lines read at once too", async () => {
  const gap = json({ type: "progress", value: "x".repeat(1024) }).repeat(60);
  const s = await racy(Array.from({ length: 100 }, (_, index) => gap + notice(`id${index}`)).join(""));
  const read = await reads(() => commandHistory(s.path, s.limit(), false));
  expect(read.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});

it("forgets every end once any byte it read is rewritten, though the transcript only grew", async () => {
  const s = fixture();
  // the rewritten notice sits mid-file, far from the first and last bytes read
  const head = filler.repeat(2);
  writeFileSync(s.path, head + notice("same") + filler.repeat(2));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["same"]);
  const fd = openSync(s.path, "r+");
  writeSync(fd, Buffer.from(notice("else")), 0, Buffer.byteLength(notice("else")), Buffer.byteLength(head));
  closeSync(fd);
  appendFileSync(s.path, notice("next"));
  const after = await waitCommandHistory(s.path, s.limit());
  expect(after).toMatchObject({ complete: true, through: s.limit() });
  expect(after!.ends.map((end) => end.id)).toEqual(["else", "next"]);
});

it("tells no end it read before a rewrite that also grew the transcript until those bytes are checked again", async () => {
  const s = fixture();
  const head = filler.repeat(2);
  writeFileSync(s.path, head + notice("same") + filler);
  const limit = s.limit();
  expect((await waitCommandHistory(s.path, limit))!.ends.map((end) => end.id)).toEqual(["same"]);
  const fd = openSync(s.path, "r+");
  writeSync(fd, Buffer.from(notice("else")), 0, Buffer.byteLength(notice("else")), Buffer.byteLength(head));
  closeSync(fd);
  appendFileSync(s.path, notice("next"));
  // asked before any check of the grown transcript: what it read is unknown, not ended
  expect(commandHistory(s.path, limit)).toMatchObject({ complete: false, ends: [] });
  const checked = await waitCommandHistory(s.path, limit);
  expect(checked).toMatchObject({ complete: true });
  expect(checked!.ends.map((end) => end.id)).toEqual(["else", "next"]);
});

it.each([["the newline after it", 0], ["the newline before it (joining it to the record before)", -1]])("tells no end of a line once %s is rewritten", async (_, shift) => {
  const s = fixture();
  const head = json({ type: "progress" });
  writeFileSync(s.path, head + notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  const fd = openSync(s.path, "r+");
  const at = shift === 0 ? Buffer.byteLength(head + notice("same")) - 1 : Buffer.byteLength(head) - 1;
  writeSync(fd, Buffer.from(" "), 0, 1, at);
  closeSync(fd);
  appendFileSync(s.path, "\n");
  expect(commandHistory(s.path, limit, false)).toMatchObject({ complete: false, ends: [] });
});

it("tells an end at once while the transcript grows, when its line begins exactly where a read chunk began", async () => {
  const s = fixture();
  const pad = json({ type: "progress", value: "" });
  // the first record fills the first 1 MiB chunk exactly: the notice begins the next one
  const first = json({ type: "progress", value: "x".repeat(1024 * 1024 - Buffer.byteLength(pad)) });
  expect(Buffer.byteLength(first)).toBe(1024 * 1024);
  writeFileSync(s.path, first + notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  appendFileSync(s.path, notice("next"));
  expect(commandHistory(s.path, limit, false)).toMatchObject({ complete: true, ends: [{ id: "same" }] });
});

it("tells the ends it read at once while the transcript only grows, before any check of it", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  appendFileSync(s.path, notice("next"));
  expect(commandHistory(s.path, limit, false)).toMatchObject({ complete: true, ends: [{ id: "same" }] });
  // only the ids asked for
  expect(commandHistory(s.path, limit, false, new Set(["other"]))!.ends).toEqual([]);
});

it("shares accepted notice and successful TaskStop semantics without accepting quoted output", async () => {
  const s = fixture();
  const timestamp = "2026-10-01T12:00:00.000Z";
  writeFileSync(s.path, notice("accepted")
    + json({ type: "queue-operation", operation: "remove", timestamp, content: JSON.parse(notice("removed")).content })
    + json({ type: "user", timestamp, message: { content: [{ type: "tool_result", content: JSON.parse(notice("quoted")).content }] } })
    + json({ type: "user", timestamp, message: { content: [{ type: "tool_result" }] }, toolUseResult: { task_type: "shell", task_id: "stopped" } })
    + json({ type: "user", timestamp, message: { content: [{ type: "tool_result", is_error: true }] }, toolUseResult: { task_type: "shell", task_id: "failed_stop" } }));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => [end.id, end.status])).toEqual([["accepted", "completed"], ["stopped", "cancelled"]]);
});

it("takes no end from a row of another session", async () => {
  const s = fixture("this-session.jsonl");
  const foreign = { ...JSON.parse(notice("foreign")), sessionId: "other-session" };
  const own = { ...JSON.parse(notice("own")), sessionId: "this-session" };
  writeFileSync(s.path, json(foreign) + json(own) + notice("unnamed"));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["own", "unnamed"]);
});

it("reads through oversized and malformed records, which prove nothing", async () => {
  const s = fixture();
  writeFileSync(s.path, "x".repeat(2 * 1024 * 1024) + "\nnot json\n" + notice("accepted"));
  const evidence = await waitCommandHistory(s.path, s.limit());
  expect(evidence).toMatchObject({ complete: true, through: s.limit() });
  expect(evidence!.ends.map((end) => end.id)).toEqual(["accepted"]);
});

it("answers a request at once while a record waits to be written whole, and reads it once it is", async () => {
  const s = fixture();
  const record = notice("finished");
  writeFileSync(s.path, record.slice(0, -4));
  const boundary = s.limit();
  // the test's own timeout fails it if the request waits for its deadline
  const partial = await waitCommandHistory(s.path, boundary, 60_000);
  expect(partial).toMatchObject({ complete: false, through: 0, ends: [] });
  expect(commandHistorySize().waiting).toBe(0);
  appendFileSync(s.path, record.slice(-4));
  const completed = await waitCommandHistory(s.path, boundary);
  expect(completed).toMatchObject({ complete: true, through: s.limit() });
  expect(completed!.ends.map((end) => end.id)).toEqual(["finished"]);
}, 5000);

it("follows a transcript replaced while a request waits, within the same deadline", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("old") + filler.repeat(4));
  const waiting = waitCommandHistory(s.path, s.limit(), 60_000);
  const replacement = join(s.root, "replacement");
  writeFileSync(replacement, notice("new"));
  renameSync(replacement, s.path);
  commandHistory(s.path, s.limit());
  expect((await waiting)!.ends.map((end) => end.id)).toEqual(["new"]);
}, 5000);

it("answers a waiting request when a read fails, and tries again after a backoff while watched", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return; // an unreadable file needs POSIX modes and no root
  const s = fixture();
  writeFileSync(s.path, notice("late"));
  chmodSync(s.path, 0o000);
  commandHistory(s.path, s.limit(), false);
  const recovered = heard(s.path, () => commandHistory(s.path, s.limit(), false)?.complete === true);
  const failed = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(failed).toMatchObject({ complete: false, through: 0 });
  expect(commandHistorySize().timers).toBe(1);
  chmodSync(s.path, 0o644);
  await recovered;
  expect(commandHistory(s.path, s.limit(), false)!.ends.map((end) => end.id)).toEqual(["late"]);
}, 5000);

it("evicts the least recently used read, never a watched one", () => {
  const paths = Array.from({ length: 16 }, (_, index) => { const s = fixture(`s${index}`); writeFileSync(s.path, notice(`c${index}`)); return s.path; });
  for (const path of paths) expect(commandHistory(path, 0, false)).not.toBeNull();
  const owner = watchCommandHistory(paths[0]!, () => {});
  release.push(owner!);
  commandHistory(paths[1]!, 0, false);
  const extra = fixture("extra");
  writeFileSync(extra.path, notice("x"));
  expect(commandHistory(extra.path, 0, false)).not.toBeNull();
  expect(commandHistorySize().sessions).toBe(16);
  expect(watchCommandHistory(paths[2]!, () => {})).toBeNull();
  for (const path of [paths[0]!, paths[1]!]) { const watch = watchCommandHistory(path, () => {}); expect(watch).not.toBeNull(); release.push(watch!); }
  for (const path of paths.slice(3)) { const watch = watchCommandHistory(path, () => {}); release.push(watch!); }
  const watched = watchCommandHistory(extra.path, () => {});
  release.push(watched!);
  // every read is watched: a new one is refused, and nothing watched goes
  expect(commandHistory(paths[2]!, 0, false)).toBeNull();
  expect(commandHistorySize().sessions).toBe(16);
});

it("lets a small session finish before a large one, a slice each in turn", async () => {
  const large = fixture();
  // every line a notice: the large read takes many slices
  writeFileSync(large.path, Array.from({ length: 40_000 }, (_, index) => notice(`l${index}`)).join(""));
  commandHistory(large.path, large.limit());
  let largeDone = false;
  void heard(large.path, () => commandHistory(large.path, large.limit(), false)?.through === large.limit()).then(() => { largeDone = true; });
  const small = fixture("small");
  writeFileSync(small.path, notice("small"));
  expect((await waitCommandHistory(small.path, small.limit()))!.complete).toBe(true);
  expect(largeDone).toBe(false);
});

it("drops every read and timer once the last server lets go", async () => {
  const hold = holdCommandHistory();
  const s = fixture();
  writeFileSync(s.path, filler.repeat(8));
  commandHistory(s.path, s.limit());
  release.push(watchCommandHistory(s.path, () => {})!);
  expect(commandHistorySize()).toMatchObject({ sessions: 1, waiting: 1 });
  hold();
  expect(commandHistorySize()).toMatchObject({ sessions: 0, waiting: 0, timers: 0 });
});
