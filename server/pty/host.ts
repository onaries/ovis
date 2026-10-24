import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { legacyName } from "../legacy-env.ts";

/** Where `cargo build --release` in crates/pty-sidecar puts the Rust PTY host. */
export const RUST_SIDECAR_BUILD = join(import.meta.dir, "..", "..", "crates", "pty-sidecar", "target", "release", "ovis-pty-sidecar");
/** Where a release's host is installed beside the server (scripts/pty-sidecar.ts install, a remote PC bundle's bin/). */
export const RUST_SIDECAR_INSTALLED = join(import.meta.dir, "..", "..", "bin", "ovis-pty-sidecar");

/** each installed binary's SHA-256, one entry per path, kept while its file state stays the same */
const digests = new Map<string, { state: string; sha256: string }>();

/** the binary's SHA-256, hashed again only when its mtime, size or inode moved (the installers replace it by rename, never in place) */
function binaryDigest(installed: string): string {
  const stat = statSync(installed);
  const state = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  const known = digests.get(installed);
  if (known?.state === state) return known.sha256;
  const sha256 = createHash("sha256").update(readFileSync(installed)).digest("hex");
  digests.set(installed, { state, sha256 });
  return sha256;
}

/**
 * Whether the installed host is the one its record (`<binary>.json`, written by scripts/pty-sidecar.ts
 * install or the remote bundle's builder) vouches for: the same SHA-256, for the version in the
 * package.json beside the server. The record and the version are read on every call (both are small),
 * so a rewrite of either within one tick of the file clock still counts; only the binary's hash is
 * cached, so attaches do not hash it again.
 */
export function installedHostVouched(installed: string, packageJson = join(dirname(installed), "..", "package.json")): boolean {
  try {
    const record = JSON.parse(readFileSync(`${installed}.json`, "utf8")) as { sha256?: unknown; version?: unknown };
    const version = (JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown }).version;
    return typeof record.sha256 === "string" && record.version === version && binaryDigest(installed) === record.sha256;
  } catch {
    return false;
  }
}

/** The host to run without OVIS_PTY_SIDECAR_BIN: the installed release's when its record vouches for it, else a local build. */
export function defaultRustSidecar(installed = RUST_SIDECAR_INSTALLED): string {
  return existsSync(installed) && installedHostVouched(installed) ? installed : RUST_SIDECAR_BUILD;
}

export type RustHostVerdict = { ok: true } | { ok: false; reason: string };

const verdicts = new Map<string, RustHostVerdict>();
const said = new Set<string>();
let disabled = false;

/** Says `message` once per process: a warning (or log line) about the host, never one per attach. */
function once(message: string, print: (message: string) => void = console.error): void {
  if (said.has(message)) return;
  said.add(message);
  print(message);
}

/** Why a spawn threw: its errno code (ENOENT, EACCES, ENOEXEC) when it has one. */
export function spawnErrorReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return "code" in error && error.code != null ? String(error.code) : error.message;
}

/** The configured binary, expanding only a leading home-directory shorthand. */
export function rustSidecarPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const binary = env["OVIS_PTY_SIDECAR_BIN"] || defaultRustSidecar();
  if (binary === "~") return home;
  return binary.startsWith("~/") ? join(home, binary.slice(2)) : binary;
}

/**
 * Checks the host's identity and its PTY path before it is allowed to serve attachments, in at most
 * 2 x timeoutMs: a run past its time is killed with SIGKILL, since the host (or a binary posing as it)
 * may outlive SIGTERM, and the server's start waits on this check.
 */
export function probeRustHost(binary: string, env: Record<string, string | undefined> = process.env, timeoutMs = 3000): RustHostVerdict {
  const clean = { ...env };
  delete clean["OVIS_TOKEN"];
  const legacyToken = legacyName("OVIS_TOKEN");
  if (legacyToken !== null) delete clean[legacyToken];
  try {
    for (const identity of [true, false]) {
      const result = Bun.spawnSync(identity ? [binary] : [binary, "1", "1", "true"], {
        env: clean, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL",
      });
      if (result.exitedDueToTimeout) return { ok: false, reason: `no answer in ${timeoutMs} ms` };
      if (result.signalCode != null) return { ok: false, reason: result.signalCode };
      const first = result.stderr.toString().split("\n")[0] ?? "";
      const exit = `exit ${result.exitCode}${first ? `: ${first}` : ""}`;
      if (identity && (result.exitCode !== 2 || !first.startsWith("pty-sidecar: usage:"))) return { ok: false, reason: `not the Rust PTY host (${exit})` };
      if (!identity && result.exitCode !== 0) return { ok: false, reason: exit };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: spawnErrorReason(error) };
  }
}

/**
 * The Rust PTY host to run (OVIS_PTY_SIDECAR_BIN, else the installed release's, else a local build): it
 * takes pty-host.mjs's arguments and frames. It is the default on Linux and macOS once it passes its
 * check; OVIS_PTY_SIDECAR=node asks for the Node sidecar, which is also the fallback.
 */
export function rustSidecar(env: Record<string, string | undefined> = process.env): string | null {
  if (process.platform === "win32") return null;
  const choice = env["OVIS_PTY_SIDECAR"];
  if (choice === "node") return null;
  if (choice && choice !== "rust") {
    once(`OVIS_PTY_SIDECAR=${choice}: expected "node" or "rust"; using the Node PTY sidecar`);
    return null;
  }
  if (disabled) return null;
  const binary = rustSidecarPath(env);
  let verdict = verdicts.get(binary);
  if (!verdict) {
    verdict = probeRustHost(binary, env);
    verdicts.set(binary, verdict);
  }
  if (!verdict.ok) {
    // a checkout nobody installed a release's host into (a fork, a branch, an offline install) says it once, quietly
    if (!choice) {
      once(`Rust PTY host unavailable (${binary}: ${verdict.reason})`, console.log);
      return null;
    }
    once(`OVIS_PTY_SIDECAR=rust: ${binary}: ${verdict.reason}; using the Node PTY sidecar (run bun scripts/pty-sidecar.ts install for the release's host in bin/, build it with cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml, or set OVIS_PTY_SIDECAR_BIN to a built binary's absolute path)`);
    return null;
  }
  once(`PTY host: Rust (${binary})`, console.log);
  return binary;
}

/** Stops starting Rust hosts until this server restarts. */
export function disableRustHost(reason: string): void {
  if (disabled) return;
  disabled = true;
  once(`Rust PTY host: ${reason}; using the Node PTY sidecar until this server restarts`);
}

/** Forgets cached verdicts, the disable and what was said. Tests only. */
export function resetPtyHostForTests(): void {
  verdicts.clear();
  said.clear();
  disabled = false;
}
