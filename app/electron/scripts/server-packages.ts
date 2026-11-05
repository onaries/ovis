/**
 * The staged server's node_modules cut down to what the server runs: the packages its own code imports
 * and everything they depend on. `bun install --production` also installs the client's packages
 * (React, mermaid, shiki, icons: about 18,000 of the stage's 20,000 files), which dist/ already
 * carries bundled. Every installed file costs time on Windows, where Defender scans each one as the
 * installer writes it.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;

/** the package a bare import names (`@noble/hashes/sha2.js` is `@noble/hashes`); null for a path or a builtin */
export function packageOf(specifier: string): string | null {
  if (/^(\.|\/|node:|bun:|[a-zA-Z]:)/.test(specifier) || specifier === "bun") return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? (parts.length > 1 ? `${parts[0]}/${parts[1]}` : null) : parts[0]!;
}

/** every package the source files under `dirs` import, require or resolve by name */
export function importedPackages(dirs: string[]): Set<string> {
  const found = new Set<string>();
  const scanners = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }), js: new Bun.Transpiler({ loader: "js" }) };
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") visit(path);
        continue;
      }
      if (!SOURCE.test(entry.name)) continue;
      // the scanner refuses a script's #! line
      const text = readFileSync(path, "utf8").replace(/^#!.*/, "");
      const scanner = entry.name.endsWith(".tsx") ? scanners.tsx : entry.name.endsWith(".ts") ? scanners.ts : scanners.js;
      const specifiers = scanner.scanImports(text).map((item) => item.path);
      // Bun.resolveSync("name", …) and require.resolve("name") load a package the scanner does not see
      for (const match of text.matchAll(/(?:resolveSync|require\.resolve)\(\s*["']([^"']+)["']/g)) specifiers.push(match[1]!);
      for (const specifier of specifiers) {
        const name = packageOf(specifier);
        if (name) found.add(name);
      }
    }
  };
  for (const dir of dirs) if (existsSync(dir)) visit(dir);
  return found;
}

/**
 * Removes from `root`/node_modules every top-level package that none of `roots` needs, as Node and Bun
 * resolve a dependency: the nearest node_modules above the package that asks. Optional and peer
 * dependencies count when they are installed. Returns the names it removed.
 */
export function pruneUnused(root: string, roots: Iterable<string>): string[] {
  const top = join(root, "node_modules");
  const kept = new Set<string>();
  const seen = new Set<string>();
  const resolve = (from: string, name: string): string | null => {
    for (let dir = from; dir.startsWith(root); dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) return candidate;
      if (dir === root) break;
    }
    return null;
  };
  const visit = (dir: string): void => {
    if (seen.has(dir)) return;
    seen.add(dir);
    if (dirname(dir) === top || dirname(dirname(dir)) === top) kept.add(dir.slice(top.length + 1).replaceAll("\\", "/"));
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const found = resolve(dir, name);
        if (found) visit(found);
        else if (field === "dependencies") throw new Error(`${dir} needs ${name}, which is not installed`);
      }
    }
  };
  for (const name of roots) {
    const found = resolve(root, name);
    if (!found) throw new Error(`The server imports ${name}, which is not installed`);
    visit(found);
  }
  const removed: string[] = [];
  for (const entry of readdirSync(top)) {
    const names = entry.startsWith("@") && statSync(join(top, entry)).isDirectory() ? readdirSync(join(top, entry)).map((name) => `${entry}/${name}`) : [entry];
    for (const name of names) {
      // .bin and the package manager's own files are not packages
      if (name.startsWith(".") || kept.has(name)) continue;
      rmSync(join(top, name), { recursive: true, force: true });
      removed.push(name);
    }
    if (entry.startsWith("@") && existsSync(join(top, entry)) && readdirSync(join(top, entry)).length === 0) rmSync(join(top, entry), { recursive: true });
  }
  return removed;
}
