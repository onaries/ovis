/** Exact Grok session binding on the machine that owns the pane. */
import { opendirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";

const SESSION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_GROUPS = 4096;
/** Linux appends this to `/proc/<pid>/exe` after the inode is unlinked. */
const DELETED_SUFFIX = " (deleted)";
/** Packaging only. A version such as `grok-1.0.52` keeps its dots. */
const EXECUTABLE_SUFFIXES = [".cjs", ".mjs", ".exe", ".js"];

export interface GrokProcessInfo { foreground_processes?: { pid: number; argv?: string[] | null }[] }
/** Discover native or bun/node-launched Grok using the same names as the exe gate. */
export function grokPaneProcesses(info: GrokProcessInfo): { pid: number }[] {
  return (info.foreground_processes ?? []).filter((p) => {
    const argv = p.argv ?? [];
    return isGrokExecutable(argv[0] ?? "") ||
      (/(^|[\\/])(?:bun|node)(?:\.exe)?$/i.test(argv[0] ?? "") && isGrokExecutable(argv[1] ?? ""));
  });
}

/** True when this path's file name is Grok: `grok`, or `grok-` plus anything else
 * (`grok-1.0.52-linux-x86_64`, `grok.exe`). The session is the one Herdr reported, when that
 * events.jsonl is open. */
export function isGrokExecutable(exePath: string): boolean {
  const slash = Math.max(exePath.lastIndexOf("/"), exePath.lastIndexOf("\\"));
  let name = slash >= 0 ? exePath.slice(slash + 1) : exePath;
  if (name.endsWith(DELETED_SUFFIX)) name = name.slice(0, -DELETED_SUFFIX.length);
  name = name.toLowerCase();
  for (;;) {
    const suffix = EXECUTABLE_SUFFIXES.find((candidate) => name.endsWith(candidate));
    if (!suffix) break;
    name = name.slice(0, -suffix.length);
  }
  return name === "grok" || name.startsWith("grok-");
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** The resolved store and its cwd groups (URI-encoded or native hashed names), or null when
 * the store is missing, not absolute or holds too many entries to trust. */
export function grokSessionGroups(home: string): { store: string; groups: string[] } | null {
  if (!isAbsolute(home)) return null;
  try {
    const store = realpathSync(join(home, "sessions"));
    const entries = opendirSync(store);
    const groups: string[] = [];
    let count = 0;
    try {
      for (let group = entries.readSync(); group; group = entries.readSync()) {
        if (++count > MAX_GROUPS) return null;
        if (group.isDirectory()) groups.push(group.name);
      }
    } finally { entries.closeSync(); }
    return { store, groups };
  } catch { return null; }
}

/** Search by exact ID, including native hashed cwd groups. Neither cwd nor mtime selects
 * a conversation. Duplicate custom IDs across groups are ambiguous and fail closed. */
export function grokTranscriptPath(home: string, session: string): string | null {
  if (!SESSION.test(session)) return null;
  const listed = grokSessionGroups(home);
  if (listed === null) return null;
  const { store, groups } = listed;
  let found: string | null = null;
  for (const group of groups) {
    const candidate = join(store, group, session, "updates.jsonl");
    try {
      const path = realpathSync(candidate);
      // Reject a link into another session as well as links outside the store.
      if (path !== candidate || !inside(store, path) || !statSync(path).isFile()) continue;
      if (found !== null) return null;
      found = path;
    } catch { /* no matching file in this group */ }
  }
  return found;
}

/** Do not substitute the bridge's home when the pane's environment is unreadable. */
export function grokHomeFromEnvironment(environment: string): string | null {
  const fields = environment.split("\0");
  const explicit = fields.find((field) => field.startsWith("GROK_HOME="))?.slice(10);
  const userHome = fields.find((field) => field.startsWith("HOME="))?.slice(5)
    || fields.find((field) => field.startsWith("USERPROFILE="))?.slice(12);
  const home = explicit || (userHome ? join(userHome, ".grok") : null);
  return home && isAbsolute(home) ? home : null;
}

/**
 * Held events.jsonl directories and descriptor write times. Null on an unreadable or oversized
 * table, or on a held file that may be a session's events file under another name, since that
 * session could be the newest one written:
 * - a file whose name starts with `events.jsonl` that is not a resolved real
 *   `<group>/<session>/events.jsonl` with an accepted session ID: deleted, renamed with a suffix
 *   (`events.jsonl.old`), moved into a folder the ID filter skips (`.archived-resumed`) or
 *   deeper into the store, or replaced at its path;
 * - any other file held in a folder of a cwd group (a session's, or one renamed past the ID
 *   filter) that has no `events.jsonl` of its own on disk: its events file moved away, perhaps to
 *   that held name (`old-events.jsonl`).
 * Other held files are ignored: which ones Grok keeps open is not known from native captures.
 */
export function grokHeldSessions(pid: number, home: string): Map<string, number> | null {
  try {
    const store = realpathSync(join(home, "sessions"));
    const fds = opendirSync(`/proc/${pid}/fd`);
    const sessions = new Map<string, number>();
    /** folders of a cwd group the process holds some other file in */
    const others = new Set<string>();
    let count = 0;
    try {
      for (let fd = fds.readSync(); fd; fd = fds.readSync()) {
        if (++count > 4096) return null;
        const descriptor = `/proc/${pid}/fd/${fd.name}`;
        let target: string;
        // a descriptor closed since the listing is not a held file
        try { target = readlinkSync(descriptor); } catch { continue; }
        if (!inside(store, target)) continue;
        const parts = relative(store, target).split(sep);
        if (!basename(target).startsWith("events.jsonl")) {
          if (parts.length >= 3) others.add(join(store, parts[0]!, parts[1]!));
          continue;
        }
        // Do not silently drop events.jsonl (deleted), events.jsonl.old or one moved out of
        // the session's shape: that could make an older held session look newest after an
        // unreported /resume.
        if (parts.length !== 3 || !SESSION.test(parts[1]!) || basename(target) !== "events.jsonl" || realpathSync(target) !== target) return null;
        const held = statSync(descriptor);
        const named = statSync(target);
        if (!held.isFile() || !named.isFile() || held.dev !== named.dev || held.ino !== named.ino) return null;
        sessions.set(dirname(target), held.mtimeMs);
      }
    } finally { fds.closeSync(); }
    for (const folder of others) {
      if (sessions.has(folder)) continue;
      // a folder whose events file is gone may hold it under the other name
      if (!statSync(join(folder, "events.jsonl"), { throwIfNoEntry: false })?.isFile()) return null;
    }
    return sessions;
  } catch { return null; }
}

/** Bind Herdr's exact ID only when its unique held directory has the newest events.jsonl.
 * Write times confirm that ID; they never select a different conversation. */
export async function resolveGrokStore(pane: HerdrPane, configuredHome?: string): Promise<string | null> {
  const session = pane.agent_session;
  if (pane.agent !== "grok" || session?.agent !== "grok" || session.kind !== "id" || session.source !== "herdr:grok" || !SESSION.test(session.value)) return null;
  // The held file is read from /proc, so this shortcut is Linux-only. The executable may be
  // any Grok build. Herdr's id chooses the session; an events.jsonl it did not name does not.
  if (process.platform !== "linux") return null;
  try {
    const processes = grokPaneProcesses((await paneProcessInfo(pane.pane_id)) ?? {});
    if (processes.length !== 1) return null;
    const owner = processes[0]!;
    if (!isGrokExecutable(readlinkSync(`/proc/${owner.pid}/exe`))) return null;
    const home = configuredHome ?? grokHomeFromEnvironment(readFileSync(`/proc/${owner.pid}/environ`, "utf8"));
    if (!home) return null;
    const path = grokTranscriptPath(home, session.value);
    if (path === null) return null;
    const held = grokHeldSessions(owner.pid, home);
    const sessionDir = dirname(path);
    const written = held?.get(sessionDir);
    if (!held || written === undefined) return null;
    // A duplicate held ID is ambiguous even if only one directory has updates.jsonl.
    if ([...held.keys()].filter((dir) => basename(dir) === session.value).length !== 1) return null;
    for (const [dir, mtime] of held) {
      // Equal timestamps cannot prove which session was written most recently.
      if (dir !== sessionDir && mtime >= written) return null;
    }
    return path;
  } catch { return null; }
}
