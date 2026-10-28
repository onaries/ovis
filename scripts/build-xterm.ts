/** xterm's source uses const enums in .d.ts files; TypeScript must inline them before Vite. */
import ts from "typescript-api";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Emits xterm's source into a directory of node_modules/.cache/herdr-xterm named after what it is
 * built from (the patched source, TypeScript's version and the options), and returns it. A finished
 * directory is never written again: builds running at once in one checkout (the browser lane's
 * workers) read it while another may be emitting, and a module rewritten in place reads as missing
 * its exports (#2021). A new one is emitted into a private directory renamed into place whole; a
 * build that loses that rename to another uses the other's.
 */
export function buildXtermSource(root: string): string {
  const source = join(root, "node_modules/@xterm/xterm/src");
  const cache = join(root, "node_modules/.cache/herdr-xterm");
  const version = JSON.parse(readFileSync(join(source, "../package.json"), "utf8")).version;
  if (version !== "5.5.0") throw new Error("Revalidate the xterm composition backport before changing xterm versions");
  const files = ts.sys.readDirectory(source, [".ts"], undefined, ["**/*"]).sort();
  // the patch also edits xterm's public typings, which the emit type-checks against
  const typings = ts.sys.readDirectory(join(source, "../typings"), [".ts"], undefined, ["**/*"]).sort();
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: source,
    paths: { "browser/*": [join(source, "browser/*")], "common/*": [join(source, "common/*")] },
    experimentalDecorators: true, useDefineForClassFields: false,
    skipLibCheck: true, types: [], noEmitOnError: true,
  };
  const key = createHash("sha256").update(`${ts.version}\0${JSON.stringify(options)}\0`);
  for (const file of [...files, ...typings]) {
    const content = readFileSync(file);
    key.update(`${relative(source, file)}\0${content.length}\0`).update(content);
  }
  const output = join(cache, key.digest("hex").slice(0, 16));
  if (existsSync(output)) return output;
  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(`${output}.tmp-`);
  try {
    const program = ts.createProgram(files, { ...options, outDir: staging });
    const emitted = program.emit();
    // a file TypeScript could not write is only a diagnostic: never publish a build missing it
    if (emitted.emitSkipped || emitted.diagnostics.some(({ category }) => category === ts.DiagnosticCategory.Error)) {
      const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitted.diagnostics);
      throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => "\n",
      }));
    }
    moveIntoPlace(staging, output);
  } finally {
    rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
  }
  return output;
}

/**
 * Renames a finished build into place; losing to another build that got there first is fine. On
 * Windows a scanner (Defender, the indexer) can hold a fresh file for a moment and refuse the rename,
 * so it is tried again until a deadline.
 */
function moveIntoPlace(staging: string, output: string): void {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      renameSync(staging, output);
      return;
    } catch (error) {
      if (existsSync(output)) return;
      const held = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
      if (!held || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
