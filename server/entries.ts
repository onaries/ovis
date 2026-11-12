/**
 * The server's entry points by name. From source each is its own file that Bun runs; in the compiled
 * binary (scripts/build-server.ts) all of them are one file, `ovis-server <name>` (server/main.ts).
 * Every child process this server starts from its own code is started through entryCommand.
 */
import { dirname, join } from "node:path";

// Each entry's file only: what runs it is in server/main.ts, so a module that starts an entry (the supervisor, which an
// update copies and runs by what it imports) does not import every entry's code with this table
export const ENTRIES = {
  serve: "server/index.ts",
  managed: "server/managed.ts",
  supervisor: "server/supervisor.ts",
  remote: "server/remote-entry.ts",
  machine: "server/herdr-core/machine-entry.ts",
  plugin: "scripts/plugin.ts",
  askpass: "server/ssh-askpass.ts",
  "windows-launch": "server/windows-launch.ts",
} as const;

export type EntryName = keyof typeof ENTRIES;

/** Whether this process is the compiled binary: its modules then live in Bun's embedded file system. */
export const COMPILED = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(import.meta.path);

/** The checkout when run from source; the binary's own folder when compiled. */
export function serverRoot(compiled = COMPILED): string {
  return compiled ? dirname(process.execPath) : join(import.meta.dir, "..");
}
export const ROOT = serverRoot();

/** Where `dist/` is read from: OVIS_ASSETS when set, else the server's root. */
export function assetsRoot(env: Record<string, string | undefined> = process.env, root = ROOT): string {
  return env["OVIS_ASSETS"] || root;
}
export const ASSETS = assetsRoot();

/**
 * The environment that makes process.execPath run as Bun itself (`-e`, a script file): the compiled
 * binary is Bun only with BUN_BE_BUN set; from source process.execPath already is Bun.
 */
export const BUN_ENV: Record<string, string> = COMPILED ? { BUN_BE_BUN: "1" } : {};

/** The command that starts entry `name`: its file under `root` from source, the binary with the entry's name when compiled. */
export function entryCommand(name: EntryName, root = ROOT, compiled = COMPILED): [string, string] {
  return [process.execPath, compiled ? name : join(root, ENTRIES[name])];
}
