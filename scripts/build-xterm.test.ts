import { afterEach, describe, expect, it } from "bun:test";
import ts from "typescript-api";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildXtermSource } from "./build-xterm.ts";

const repo = join(import.meta.dir, "..");
const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });

/** A checkout of its own holding only xterm's patched source, so the test never touches the repo's cache. */
function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-build-xterm-test-"));
  made.push(root);
  cpSync(join(repo, "node_modules/@xterm/xterm"), join(root, "node_modules/@xterm/xterm"), { recursive: true, dereference: true });
  return root;
}

const module = "common/services/UnicodeService";
const written = (dir: string): { content: string; ino: bigint; mtimeNs: bigint } => {
  const file = join(dir, `${module}.js`);
  const { ino, mtimeNs } = statSync(file, { bigint: true });
  return { content: readFileSync(file, "utf8"), ino, mtimeNs };
};

describe("buildXtermSource", () => {
  // a build reading the directory another build returned must never see a module half rewritten (#2021)
  it("hands a later build the finished directory without writing into it again", () => {
    const root = checkout();
    const first = buildXtermSource(root);
    const before = written(first);
    expect(before.content).toContain("export class UnicodeService");
    expect(buildXtermSource(root)).toBe(first);
    expect(written(first)).toEqual(before);
  }, 60_000);

  it("emits changed source into a new directory and leaves the old one as it was", () => {
    const root = checkout();
    const first = buildXtermSource(root);
    const before = written(first);
    appendFileSync(join(root, "node_modules/@xterm/xterm/src", `${module}.ts`), "\nexport const changedForTest = 1;\n");
    const second = buildXtermSource(root);
    expect(second).not.toBe(first);
    expect(written(second).content).toContain("changedForTest");
    expect(written(first)).toEqual(before);
  }, 60_000);

  it("publishes nothing when a module could not be written, so the next build emits it again", () => {
    const root = checkout();
    const cache = join(root, "node_modules/.cache/herdr-xterm");
    const writeFile = ts.sys.writeFile;
    ts.sys.writeFile = (path, ...rest) => {
      if (path.endsWith(`${module}.js`)) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      writeFile(path, ...rest);
    };
    try {
      expect(() => buildXtermSource(root)).toThrow("no space left on device");
    } finally {
      ts.sys.writeFile = writeFile;
    }
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
    expect(written(buildXtermSource(root)).content).toContain("export class UnicodeService");
  }, 60_000);
});
