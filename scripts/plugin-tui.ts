/**
 * `tui`: runs the terminal client (crates/ovis-tui) in this terminal: herdr-core's terminals as herdr shows them.
 *
 * It neither starts nor asks the server anything, and the program never talks to it. It takes no turn in the
 * plugin's lifecycle lock either.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const TUI_NAME = "ovis-tui";
/** the setting that names the program, ahead of the install's own */
export const TUI_BIN_VARIABLE = "OVIS_TUI_BIN";

type Env = Readonly<Record<string, string | undefined>>;

export type TuiLookup =
  | { readonly kind: "found"; readonly path: string }
  /** OVIS_TUI_BIN is set and names no file: the install's own program is not tried instead */
  | { readonly kind: "configured-missing"; readonly path: string }
  | { readonly kind: "missing"; readonly looked: readonly string[] };

/**
 * Where an install keeps the program: in its bin/ (a checkout's, beside its PTY host), beside the
 * server itself (a compiled install's root is its bin/ already), else a local build of the crate.
 */
export function tuiPaths(root: string): readonly string[] {
  return [join(root, "bin", TUI_NAME), join(root, TUI_NAME), join(root, "crates", "ovis-tui", "target", "release", TUI_NAME)];
}

export const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

/** The program to run: OVIS_TUI_BIN from the merged settings, else the first of tuiPaths that is a file. */
export function findTui(settings: Env, where: { readonly root: string; readonly home: string; readonly onPath?: (name: string) => string | null }, fileAt: (path: string) => boolean = isFile): TuiLookup {
  const configured = settings[TUI_BIN_VARIABLE] ?? "";
  if (configured !== "") {
    // a bare name is what spawning it would run: the PATH's, so the file checked is the file run
    const bare = !configured.includes("/");
    const path = configured.startsWith("~/") ? join(where.home, configured.slice(2)) : bare ? ((where.onPath ?? Bun.which)(configured) ?? configured) : configured;
    return fileAt(path) ? { kind: "found", path } : { kind: "configured-missing", path };
  }
  const paths = tuiPaths(where.root);
  const path = paths.find(fileAt);
  return path === undefined ? { kind: "missing", looked: paths } : { kind: "found", path };
}

/** What the program never gets: it talks to herdr-core alone, and whatever it starts inherits its environment. */
export const WITHHELD = ["OVIS_TOKEN", "OVIS_URL", "HERDR_WEB_TOKEN"] as const;

/** The program's environment: the caller's, without the Ovis server's token or address. */
export function tuiEnv(caller: Env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(caller)) if (value !== undefined && !(WITHHELD as readonly string[]).includes(key)) env[key] = value;
  return env;
}

export const WINDOWS_MESSAGE = "ovis tui: the terminal client runs on Linux and macOS only.\n";

/** What a lookup that found nothing to run says, for the person who typed `ovis tui`. */
export function lookupMessage(lookup: Exclude<TuiLookup, { kind: "found" }>): string {
  switch (lookup.kind) {
    case "configured-missing":
      return `ovis tui: ${TUI_BIN_VARIABLE} is ${lookup.path}, which is not a file. Point it at the ${TUI_NAME} program, or remove it to use the one this install has.\n`;
    case "missing":
      return [
        `ovis tui: this install has no ${TUI_NAME} program yet. It was looked for at:`,
        ...lookup.looked.map((path) => `  ${path}`),
        "To build it, run these two commands in a checkout of Ovis:",
        "  crates/ovis-tui/prepare.sh",
        "  cargo build --release --manifest-path crates/ovis-tui/Cargo.toml",
        `or set ${TUI_BIN_VARIABLE} to the path of a ${TUI_NAME} you have.`,
        "",
      ].join("\n");
    default: {
      const unreachable: never = lookup;
      return unreachable;
    }
  }
}

export interface TuiOptions {
  readonly platform: NodeJS.Platform;
  /** the install's root (plugin.ts ROOT) and the home a leading `~/` stands for */
  readonly where: { readonly root: string; readonly home: string };
  /** the caller's own environment, which the program inherits */
  readonly caller: Env;
  /** the plugin's merged settings: the process environment and its config files */
  readonly settings: Env;
  readonly err: (text: string) => void;
  /** where the launcher's signal handlers go: process.on for the command; what it returns takes the handler off again */
  readonly on: (signal: "SIGINT" | "SIGTERM" | "SIGHUP", handler: () => void) => () => void;
}

/** Runs the program with the terminal handed over; its exit code, or 128 + the signal that ended it. */
export async function runTui(args: readonly string[], options: TuiOptions): Promise<number> {
  if (options.platform === "win32") {
    options.err(WINDOWS_MESSAGE);
    return 1;
  }
  const lookup = findTui(options.settings, options.where);
  if (lookup.kind !== "found") {
    options.err(lookupMessage(lookup));
    return 1;
  }
  // the program holds the terminal in raw mode and owns Ctrl+C; a SIGINT sent to the whole group must not end this
  // process under it, from the program's first instant: ignored before it starts, not once it already runs
  const offs = [options.on("SIGINT", () => undefined)];
  let child: Bun.Subprocess<"inherit", "inherit", "inherit"> | undefined;
  // a SIGTERM or SIGHUP sent to this process alone is passed on, so both end; listened for before the program starts,
  // so one that comes while it starts cannot end this process under it: Bun runs the listener after `child` is set.
  // A program that could not be started has nothing to pass one on to, and the listeners go on every way out.
  for (const signal of ["SIGTERM", "SIGHUP"] as const) offs.push(options.on(signal, () => child?.kill(signal)));
  try {
    try {
      child = Bun.spawn([lookup.path, ...args], { env: tuiEnv(options.caller), stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    } catch (error) {
      options.err(`ovis tui: could not run ${lookup.path}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
    // Bun resolves a death by signal as 128 + its number
    return await child.exited;
  } finally {
    for (const off of offs) off();
  }
}
