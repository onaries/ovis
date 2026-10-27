import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readStateDocument, setAsideDamaged } from "./state-document.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "herdr-state-document-")); dirs.push(dir); return dir; };

describe("setAsideDamaged", () => {
  it("moves a file of NULs aside, bytes untouched, under a name a Windows file may have", () => {
    const dir = directory(), path = join(dir, "machines.json");
    const zeros = Buffer.alloc(353);
    writeFileSync(path, zeros);
    expect(readStateDocument(path)).toEqual({ kind: "malformed" });
    const aside = setAsideDamaged(path, new Date("2026-10-26T07:06:23.123Z"));
    expect(basename(aside)).toBe("machines.json.corrupt-2026-10-26T07-06-23-123Z");
    expect(readFileSync(aside)).toEqual(zeros);
    expect(readStateDocument(path)).toEqual({ kind: "missing" });
  });

  it("keeps every damaged copy: a later one never replaces an earlier one", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "first");
    setAsideDamaged(path, new Date("2026-10-24T01:00:00.000Z"));
    writeFileSync(path, "second");
    setAsideDamaged(path, new Date("2026-10-26T01:00:00.000Z"));
    const kept = readdirSync(dir).sort();
    expect(kept).toHaveLength(2);
    expect(kept.map((name) => readFileSync(join(dir, name), "utf8"))).toEqual(["first", "second"]);
  });

  it("never replaces an earlier copy set aside at the same moment", () => {
    const dir = directory(), path = join(dir, "machines.json");
    const now = new Date("2026-10-26T07:06:23.123Z");
    writeFileSync(path, "first");
    const first = setAsideDamaged(path, now);
    writeFileSync(path, "second");
    const second = setAsideDamaged(path, now);
    expect(second).not.toBe(first);
    expect(readFileSync(first, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("second");
    expect(readStateDocument(path)).toEqual({ kind: "missing" });
  });

  // a file system without hard links: the copy is made with copyFileSync instead
  const withoutLinks = () => spyOn(fs, "linkSync").mockImplementation(() => { throw Object.assign(new Error("no links"), { code: "EPERM" }); });

  it("flushes a copy to disk before the damaged original goes", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "damaged");
    const steps: string[] = [];
    const links = withoutLinks();
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(() => { steps.push("fsync"); });
    const unlink = spyOn(fs, "unlinkSync");
    unlink.mockImplementation(((target: fs.PathLike) => { steps.push(`unlink ${basename(String(target))}`); unlink.mockRestore(); fs.unlinkSync(target); }) as typeof fs.unlinkSync);
    try {
      const aside = setAsideDamaged(path, new Date("2026-10-26T07:06:23.123Z"));
      expect(readFileSync(aside, "utf8")).toBe("damaged");
      expect(steps.indexOf("fsync")).toBeGreaterThanOrEqual(0);
      expect(steps.indexOf("fsync")).toBeLessThan(steps.indexOf("unlink machines.json"));
    } finally { links.mockRestore(); fsync.mockRestore(); unlink.mockRestore(); }
  });

  it("removes a copy that cannot be made private, leaving the original where it was", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "damaged");
    const links = withoutLinks();
    const chmod = spyOn(fs, "chmodSync");
    chmod.mockImplementation(((target: fs.PathLike, mode: fs.Mode) => {
      if (String(target).includes(".corrupt-")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    }) as typeof fs.chmodSync);
    try {
      expect(() => setAsideDamaged(path)).toThrow(/\(EACCES\)$/);
      expect(readdirSync(dir)).toEqual(["machines.json"]);
      expect(readFileSync(path, "utf8")).toBe("damaged");
    } finally { links.mockRestore(); chmod.mockRestore(); }
  });

  it("reports why the original could not be removed, even when the spare copy cannot be either", () => {
    const dir = directory(), path = join(dir, "machines.json");
    writeFileSync(path, "damaged");
    const unlink = spyOn(fs, "unlinkSync").mockImplementation(() => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); });
    const rm = spyOn(fs, "rmSync").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    try {
      expect(() => setAsideDamaged(path)).toThrow(/\(EBUSY\)$/);
      expect(readFileSync(path, "utf8")).toBe("damaged");
    } finally { unlink.mockRestore(); rm.mockRestore(); }
  });

  it("throws, naming the file and why, when it cannot be moved", () => {
    const dir = directory();
    expect(() => setAsideDamaged(join(dir, "machines.json"))).toThrow(/^machines\.json is not JSON and cannot be set aside as machines\.json\.corrupt-\S+ \(ENOENT\)$/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
