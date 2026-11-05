import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importedPackages, packageOf, pruneUnused } from "./server-packages.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ovis-server-packages-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const pkg = (name: string, deps: Record<string, Record<string, string>> = {}) => JSON.stringify({ name, version: "1.0.0", ...deps });

describe("packageOf", () => {
  it("names the package of a bare import and nothing for paths and builtins", () => {
    expect(packageOf("@noble/hashes/sha2.js")).toBe("@noble/hashes");
    expect(packageOf("web-push")).toBe("web-push");
    expect(packageOf("lodash/fp")).toBe("lodash");
    expect(packageOf("bunyan")).toBe("bunyan");
    for (const specifier of ["./x.ts", "../y", "/abs", "node:fs", "bun", "bun:test", "C:/x"]) expect(packageOf(specifier)).toBeNull();
  });
});

describe("importedPackages", () => {
  it("finds imports, requires and resolveSync names in sources, not in node_modules", () => {
    const root = fixture({
      "server/a.ts": `import { x } from "@noble/hashes/sha2.js"; import type { T } from "type-only"; const y = await import("web-push"); import "./local.ts";`,
      "server/pty/host.mjs": `#!/usr/bin/env node\nconst pty = require("@lydell/node-pty");`,
      "server/sidecar.ts": `Bun.resolveSync("resolved-by-name", import.meta.dir);`,
      "shared/b.ts": `export * from "jsonc-parser";`,
      "server/node_modules/hidden/index.js": `require("never-seen");`,
    });
    const found = importedPackages([join(root, "server"), join(root, "shared"), join(root, "missing")]);
    expect([...found].sort()).toEqual(["@lydell/node-pty", "@noble/hashes", "jsonc-parser", "resolved-by-name", "web-push"]);
  });
});

describe("pruneUnused", () => {
  it("keeps the imported packages and what they depend on, and removes the rest", () => {
    const root = fixture({
      "node_modules/web-push/package.json": pkg("web-push", { dependencies: { "http-ece": "1", "jws": "1" } }),
      "node_modules/http-ece/package.json": pkg("http-ece"),
      // a nested copy wins for its parent, but its own dependencies resolve upward to the top
      "node_modules/jws/package.json": pkg("jws", { dependencies: { "jwa": "2" } }),
      "node_modules/jws/node_modules/jwa/package.json": pkg("jwa", { dependencies: { "ecdsa-sig": "1" } }),
      "node_modules/jwa/package.json": pkg("jwa"),
      "node_modules/ecdsa-sig/package.json": pkg("ecdsa-sig"),
      "node_modules/@lydell/node-pty/package.json": pkg("@lydell/node-pty", { optionalDependencies: { "@lydell/node-pty-win32-x64": "1", "@lydell/node-pty-darwin-arm64": "1" } }),
      "node_modules/@lydell/node-pty-win32-x64/package.json": pkg("@lydell/node-pty-win32-x64"),
      "node_modules/mermaid/package.json": pkg("mermaid", { dependencies: { "d3": "7" } }),
      "node_modules/d3/package.json": pkg("d3"),
      "node_modules/@shikijs/langs/package.json": pkg("@shikijs/langs"),
      "node_modules/.bin/tool": "",
    });
    const removed = pruneUnused(root, ["web-push", "@lydell/node-pty"]);
    expect(removed.sort()).toEqual(["@shikijs/langs", "d3", "jwa", "mermaid"]);
    expect(readdirSync(join(root, "node_modules")).sort()).toEqual([".bin", "@lydell", "ecdsa-sig", "http-ece", "jws", "web-push"]);
    expect(existsSync(join(root, "node_modules", "jws", "node_modules", "jwa", "package.json"))).toBe(true);
    expect(existsSync(join(root, "node_modules", "@shikijs"))).toBe(false);
  });

  it("stops the build when an import or a required dependency is not installed", () => {
    const root = fixture({ "node_modules/web-push/package.json": pkg("web-push", { dependencies: { "http-ece": "1" } }) });
    expect(() => pruneUnused(root, ["missing"])).toThrow(/imports missing, which is not installed/);
    expect(() => pruneUnused(root, ["web-push"])).toThrow(/needs http-ece, which is not installed/);
  });
});
