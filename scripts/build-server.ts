/**
 * `bun scripts/build-server.ts <platform> <dir>`: the server as one compiled binary, `<dir>/ovis-server`
 * (`ovis-server.exe` on Windows), whose first argument names the entry it runs (server/entries.ts).
 * It serves dist/ from OVIS_ASSETS, else from its own folder; the Node PTY host script is copied
 * beside it, and the Rust PTY host stays a file of its own in `bin/` there.
 *
 * The binary holds minified JavaScript and Bun bytecode, built without source maps: the source is not
 * published with it, but anyone who unpacks the file can read that code. `--format=esm` because the
 * entries await at top level, which bytecode allows only in an ES module.
 */
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64"];
const [platform, dir] = process.argv.slice(2);
if (platform === undefined || !PLATFORMS.includes(platform) || dir === undefined) {
  console.error(`usage: bun scripts/build-server.ts <${PLATFORMS.join("|")}> <dir>`);
  process.exit(2);
}
const root = join(import.meta.dir, "..");
const out = resolve(dir);
mkdirSync(out, { recursive: true });
// server/statusline-install.ts writes these files out for Claude Code; the binary has no copy of them on disk
const statusline = Object.fromEntries(["statusline-context.ts", "statusline-capture.ts"].map((name) => [name, readFileSync(join(root, "server", name), "utf8")]));
const build = Bun.spawn([
  process.execPath, "build", "--compile", "--minify", "--bytecode", "--format=esm", `--target=bun-${platform}`,
  "--define", `OVIS_STATUSLINE_SOURCES=${JSON.stringify(statusline)}`,
  // the file pool's thread (server/file-pool.ts) is an entry of its own in the binary
  "server/main.ts", "server/file-worker.ts", "--outfile", join(out, "ovis-server"),
], { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
const code = await build.exited;
if (code !== 0) process.exit(code);
copyFileSync(join(root, "server", "pty", "pty-host.mjs"), join(out, "pty-host.mjs"));
