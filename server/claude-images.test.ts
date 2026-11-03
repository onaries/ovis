import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdtempSync, renameSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, transcriptImage, transcriptImageAsync, transcriptPage } from "./conversation.ts";

const roots: string[] = [];
afterEach(() => {
  forgetTranscriptState();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
const line = (entry: unknown) => JSON.stringify(entry) + "\n";
function fixture(tiny = false) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-claude-image-"));
  roots.push(dir);
  const path = join(dir, "session.jsonl");
  const call = line({ type: "assistant", uuid: id(2), parentUuid: id(1), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } });
  const result = line({ type: "user", uuid: id(3), parentUuid: id(2), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture, picture] }] } });
  const padding = tiny
    ? line({ type: "progress", data: "read", uuid: id(3) }).repeat(6000)
    : line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(20);
  writeFileSync(path, line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "read" } }) + call + padding + result);
  return { path, ref: `${id(3)}:0:0` };
}
function exact(image: Awaited<ReturnType<typeof transcriptImageAsync>>) {
  expect(image?.mediaType).toBe("image/png");
  expect(Buffer.from(image!.bytes).equals(png)).toBe(true);
  expect(image!.bytes.byteLength).toBe(png.length);
}

describe("cooperative Claude images", () => {
  for (const tiny of [false, true]) it(`runs timers and file IO before cold and warm lookups finish (${tiny ? "tiny records" : "large history"})`, async () => {
    const { path, ref } = fixture(tiny);
    for (let pass = 0; pass < 2; pass += 1) {
      let finished = false;
      const progress = new Promise<void>((resolve, reject) => setTimeout(() => {
        if (finished) { reject(new Error("image lookup blocked the timer")); return; }
        Bun.file(path).slice(0, 16).arrayBuffer().then(() => {
          try { expect(finished).toBe(false); resolve(); } catch (error) { reject(error); }
        }, reject);
      }, 0));
      const reading = Promise.all([transcriptImageAsync(path, ref), transcriptImageAsync(path, `${id(3)}:0:1`)]).then((images) => { finished = true; return images; });
      const [images] = await Promise.all([reading, progress]);
      images.forEach(exact);
    }
  });

  it("serves exactly 8 MiB and rejects an image one byte larger", async () => {
    const { path } = fixture(true);
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    png.copy(bytes);
    const image = (data: Buffer) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: data.toString("base64") } });
    writeFileSync(path, line({ type: "user", uuid: id(3), message: { content: [image(bytes), image(Buffer.concat([bytes, Buffer.from([0])]))] } }));
    const accepted = await transcriptImageAsync(path, `${id(3)}:0`);
    expect(accepted?.mediaType).toBe("image/png");
    expect(Buffer.from(accepted!.bytes).equals(bytes)).toBe(true);
    expect(await transcriptImageAsync(path, `${id(3)}:1`)).toBeNull();
  });

  it("bounds record judgments between event-loop turns even with a warm boundary", async () => {
    const { path, ref } = fixture(true);
    exact(await transcriptImageAsync(path, ref));
    let since = 0, most = 0, total = 0;
    const alloc = Buffer.alloc.bind(Buffer);
    const counting = spyOn(Buffer, "alloc").mockImplementation(((...args: Parameters<typeof Buffer.alloc>) => {
      since += 1; total += 1;
      return alloc(...args);
    }) as typeof Buffer.alloc);
    let looking = true;
    const turn = () => { most = Math.max(most, since); since = 0; if (looking) setImmediate(turn); };
    try {
      setImmediate(turn);
      exact(await transcriptImageAsync(path, ref));
    } finally { looking = false; most = Math.max(most, since); counting.mockRestore(); }
    expect(total).toBeGreaterThan(6000);
    expect(most).toBeLessThanOrEqual(100);
  });

  it("bounds record judgments between event-loop turns on a cold boundary scan", async () => {
    const { path, ref } = fixture(true);
    let since = 0, most = 0, total = 0;
    const parse = JSON.parse;
    const counting = spyOn(JSON, "parse").mockImplementation(((...args: Parameters<typeof JSON.parse>) => {
      since += 1; total += 1;
      return parse(...args);
    }) as typeof JSON.parse);
    let looking = true;
    const turn = () => { most = Math.max(most, since); since = 0; if (looking) setImmediate(turn); };
    try {
      setImmediate(turn);
      exact(await transcriptImageAsync(path, ref));
    } finally { looking = false; most = Math.max(most, since); counting.mockRestore(); }
    // every record is followed by the boundary scan and judged by the search
    expect(total).toBeGreaterThan(12000);
    expect(most).toBeLessThanOrEqual(100);
  });

  it("yields while constructing a search for a long decoded tool call id", async () => {
    const { path, ref } = fixture(true);
    const call = "c".repeat(100_000);
    writeFileSync(path, line({ type: "assistant", message: { content: [{ type: "tool_use", id: call, name: "Read" }] } }) + line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: call, content: [picture] }] } }));
    let finished = false;
    const progress = new Promise<void>((resolve, reject) => setTimeout(() => {
      try { expect(finished).toBe(false); resolve(); } catch (error) { reject(error); }
    }, 0));
    // Some engines refuse a regexp this large; either outcome must let other work run first.
    const reading = transcriptImageAsync(path, ref).then(() => { finished = true; });
    await Promise.all([reading, progress]);
  });

  it("rejects a second mutation after validation has already hashed the changed prefix", async () => {
    const { path, ref } = fixture();
    const original = await Bun.file(path).bytes();
    let starts = 0;
    let changed = false;
    const read = fs.readSync;
    const watching = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const result = read(...args);
      const request = args as unknown as [number, Uint8Array, number, number, number];
      // the uuid and call searches, then the same two of the read made again after the first append
      if (request[4] === 0 && request[3] === 1024 * 1024 && ++starts === 4) setImmediate(() => {
        const bytes = Buffer.from(original);
        bytes.write("gone", bytes.indexOf('"id":"read"') + 6);
        writeFileSync(path, bytes);
        appendFileSync(path, line({ type: "progress", data: "second append" }));
        changed = true;
      });
      return result;
    }) as typeof fs.readSync);
    try {
      const reading = transcriptImageAsync(path, ref);
      await new Promise<void>((resolve) => setImmediate(resolve));
      appendFileSync(path, line({ type: "progress", data: "first append" }));
      expect(await reading).toBeNull();
      expect(changed).toBe(true);
    } finally { watching.mockRestore(); }
  });

  for (const change of ["replace", "truncate", "rewrite", "rewrite and grow", "clear", "rewind"] as const) it(`rejects an image after an in-flight ${change}`, async () => {
    const { path, ref } = fixture();
    const reading = transcriptImageAsync(path, ref);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (change === "replace") { writeFileSync(`${path}.new`, line({ type: "user", uuid: id(3), message: { content: [picture] } })); renameSync(`${path}.new`, path); }
    if (change === "truncate") truncateSync(path, 0);
    if (change === "rewrite" || change === "rewrite and grow") {
      const bytes = await Bun.file(path).bytes();
      // Keep the tail and inode: a prefix rewrite must not pass an append-only check.
      bytes[Buffer.from(bytes).indexOf('"read"') + 1] = 120;
      writeFileSync(path, bytes);
      if (change === "rewrite and grow") appendFileSync(path, line({ type: "progress", data: "appended" }));
    }
    if (change === "clear") appendFileSync(path, line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }));
    if (change === "rewind") appendFileSync(path, line({ type: "user", uuid: id(4), parentUuid: null, message: { content: "new branch" } }));
    expect(await reading).toBeNull();
    // A failed old read cannot leave a half-built or obsolete shared boundary behind.
    if (change === "rewrite" || change === "rewrite and grow") {
      exact(await transcriptImageAsync(path, ref));
      exact(transcriptImage(path, ref));
    } else {
      expect(await transcriptImageAsync(path, ref)).toBeNull();
      expect(transcriptImage(path, ref)).toBeNull();
    }
  });

  it("allows a harmless append and concurrent page/image reads without downgrading the boundary cache", async () => {
    const { path, ref } = fixture();
    const reading = transcriptImageAsync(path, ref);
    await new Promise<void>((resolve) => setImmediate(resolve));
    appendFileSync(path, line({ type: "assistant", uuid: id(4), parentUuid: id(3), message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } }));
    transcriptPage("claude-transcript", path);
    exact(await transcriptImageAsync(path, ref));
    exact(await reading);
    exact(await transcriptImageAsync(path, ref));
    appendFileSync(path, line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }));
    expect(await transcriptImageAsync(path, ref)).toBeNull();
  });
});

it("a lookup rejected after an in-place rewrite and growth leaves no stale boundary behind for the next lookup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-stale-boundary-"));
  roots.push(dir);
  const path = join(dir, "log.jsonl");
  const uuid = "00000000-0000-4000-8000-000000000001";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const picture = JSON.stringify({ type: "user", uuid, message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] } }) + "\n";
  const clear = JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }) + "\n";
  const same = JSON.stringify({ type: "progress", data: "x".repeat(clear.length - 30) }) + "\n";
  expect(same.length).toBe(clear.length);
  const padding = JSON.stringify({ type: "progress", data: "x".repeat(1024 * 1024) }) + "\n";
  writeFileSync(path, picture + same + padding.repeat(3));
  let scanned = false;
  let changed = false;
  const read = fs.readSync;
  // the boundary scan reads the whole file at once; the first search window after it is the picture's search:
  // there, once the boundary is published, rewrite the record after the picture into a /clear (same length,
  // same inode) and append, while the lookup is paused
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const result = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (at[4] === 0 && at[3] > 1024 * 1024) scanned = true;
    if (at[4] === 0 && at[3] === 1024 * 1024 && scanned && !changed) setImmediate(() => {
      writeFileSync(path, picture + clear + padding.repeat(3));
      appendFileSync(path, JSON.stringify({ type: "progress", data: "append" }) + "\n");
      changed = true;
    });
    return result;
  }) as typeof fs.readSync);
  try {
    expect(await transcriptImageAsync(path, `${uuid}:0`)).toBeNull();
    expect(changed).toBe(true);
  } finally { watch.mockRestore(); }
  // the picture is now before a /clear: the next lookup must not reuse the rejected scan's boundary
  expect(await transcriptImageAsync(path, `${uuid}:0`)).toBeNull();
});

it("never serves a picture read from a rewrite the file undid before an append (ABA)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-aba-"));
  roots.push(dir);
  const path = join(dir, "session.jsonl");
  const other = Buffer.from(png);
  other[40] = other[40]! ^ 1;
  const result = (bytes: Buffer) => line({ type: "user", uuid: id(3), parentUuid: id(2), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [{ ...picture, source: { ...picture.source, data: bytes.toString("base64") } }] }] } });
  // a /clear after the first record puts the searches' first window off every other read's offsets
  const before = line({ type: "progress", data: "before" });
  const head = before + line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } })
    + line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "read" } })
    + line({ type: "assistant", uuid: id(2), parentUuid: id(1), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } })
    + line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(20);
  const original = head + result(png);
  const rewritten = head + result(other);
  expect(rewritten.length).toBe(original.length);
  writeFileSync(path, original);
  const floor = Buffer.byteLength(before);
  const record = Buffer.byteLength(head);
  let step = 0;
  const read = fs.readSync;
  // once the picture search starts, rewrite the file to another picture; once that picture's record is read,
  // put the original bytes back and append, all on the same inode, before the lookup checks the file
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const value = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (step === 0 && at[4] === floor && at[3] === 1024 * 1024) { step = 1; setImmediate(() => { writeFileSync(path, rewritten); step = 2; }); }
    if (step === 2 && at[4] === record) { step = 3; setImmediate(() => { writeFileSync(path, original); appendFileSync(path, line({ type: "progress", data: "append" })); step = 4; }); }
    return value;
  }) as typeof fs.readSync);
  let image: Awaited<ReturnType<typeof transcriptImageAsync>>;
  try { image = await transcriptImageAsync(path, `${id(3)}:0:0`); } finally { watch.mockRestore(); }
  expect(step).toBe(4);
  // the file holds the first picture: the other one must not be served, whether this read serves or not
  expect(image === null || Buffer.from(image.bytes).equals(png)).toBe(true);
  exact(await transcriptImageAsync(path, `${id(3)}:0:0`));
});

it("a lookup with a warm boundary rebuilds it when the file is rewritten before that boundary and appended to", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-warm-boundary-"));
  roots.push(dir);
  const path = join(dir, "log.jsonl");
  const drawn = line({ type: "user", uuid: id(1), message: { content: [picture] } });
  const clear = line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } });
  const same = line({ type: "progress", data: "x".repeat(clear.length - 30) });
  expect(same.length).toBe(clear.length);
  const padding = line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(3);
  writeFileSync(path, drawn + same + padding);
  // the first lookup keeps the boundary: the second reads nothing of the file before its search
  exact(await transcriptImageAsync(path, `${id(1)}:0`));
  let changed = false;
  const read = fs.readSync;
  // during the second lookup's search, turn the record after the picture into a /clear (same length, same
  // inode, far from the tail the kept boundary is checked by) and append
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const value = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (!changed && at[4] === 0 && at[3] === 1024 * 1024) {
      changed = true;
      setImmediate(() => { writeFileSync(path, drawn + clear + padding); appendFileSync(path, line({ type: "progress", data: "append" })); });
    }
    return value;
  }) as typeof fs.readSync);
  try { expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull(); } finally { watch.mockRestore(); }
  expect(changed).toBe(true);
  expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull();
});

it("a lookup that sees the file rewritten drops the boundary it kept, even when it serves nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-dropped-boundary-"));
  roots.push(dir);
  const path = join(dir, "log.jsonl");
  const drawn = line({ type: "user", uuid: id(1), message: { content: [picture] } });
  const broken = drawn.replace(id(1), id(9));
  const clear = line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } });
  const same = line({ type: "progress", data: "x".repeat(clear.length - 30) });
  const padding = line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(3);
  writeFileSync(path, drawn + same + padding);
  exact(await transcriptImageAsync(path, `${id(1)}:0`));
  let changed = false;
  const read = fs.readSync;
  // during the next lookup's search, the picture's record stops naming it (same length, same inode)
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const value = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (!changed && at[4] === 0 && at[3] === 1024 * 1024) {
      changed = true;
      setImmediate(() => writeFileSync(path, broken + same + padding));
    }
    return value;
  }) as typeof fs.readSync);
  try { expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull(); } finally { watch.mockRestore(); }
  expect(changed).toBe(true);
  // then it names the picture again, a /clear after it hides it, and the file grows: the boundary kept
  // before the change still matches the tail, and must not be reused
  writeFileSync(path, drawn + clear + padding);
  appendFileSync(path, line({ type: "progress", data: "append" }));
  expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull();
});

it("a filesystem exception revokes a rejected lookup's boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-exception-"));
  roots.push(dir, `${dir}.away`);
  const path = join(dir, "session.jsonl");
  const drawn = line({ type: "user", uuid: id(1), message: { content: [picture] } });
  const clear = line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } });
  const same = line({ type: "progress", data: "x".repeat(clear.length - 30) });
  expect(same.length).toBe(clear.length);
  const padding = line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(3);
  writeFileSync(path, drawn + same + padding);
  exact(await transcriptImageAsync(path, `${id(1)}:0`));
  let moved = false;
  const read = fs.readSync;
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const value = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (!moved && at[4] === 0 && at[3] === 1024 * 1024) {
      moved = true;
      setImmediate(() => renameSync(dir, `${dir}.away`));
    }
    return value;
  }) as typeof fs.readSync);
  try { expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull(); } finally { watch.mockRestore(); }
  expect(moved).toBe(true);
  renameSync(`${dir}.away`, dir);
  writeFileSync(path, drawn + clear + padding);
  appendFileSync(path, line({ type: "progress", data: "append" }));
  // The failed lookup must not leave a cached boundary that predates this clear.
  expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull();
});
