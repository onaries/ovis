import { chmodSync, closeSync, constants, copyFileSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { syncDirectory } from "./private-state.ts";
import { basename, dirname } from "node:path";

/**
 * A shared state document as it is on disk (preferences.json, seen.json): absent, JSON for its
 * store to check, or bytes that are not JSON. A read that fails otherwise (permissions, a
 * directory in its place) throws: an unreadable file is not an absent one.
 */
export type StateDocument = { kind: "missing" } | { kind: "json"; value: unknown } | { kind: "malformed" };

export function readStateDocument(path: string): StateDocument {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  try { return { kind: "json", value: JSON.parse(text) }; } catch { return { kind: "malformed" }; }
}

/** The name a damaged document is kept under until the next damaged one replaces it. */
export const damagedCopy = (path: string): string => `${path}.bad`;

/**
 * Moves a document that is not JSON out of the way at once, bytes untouched, to
 * `<path>.corrupt-<time>` (0600, as damagedCopy's), so its store can start empty instead of
 * refusing to start. Each one keeps a name of its own: these documents (machines.json,
 * herdr-profile-state.json) hold what cannot be recomputed, so an earlier damaged copy is never
 * replaced. Returns the new path; throws, leaving `path` as it was, when the file cannot be moved,
 * saying why so a start that stops on it can be understood from its log.
 */
export function setAsideDamaged(path: string, now = new Date()): string {
  // no ':' in a Windows file name
  const name = `${path}.corrupt-${now.toISOString().replace(/[:.]/g, "-")}`;
  let aside = name;
  try {
    chmodSync(path, 0o600);
    // a rename would replace a copy of the same name; a link or exclusive copy refuses to
    for (let attempt = 1; !keepAs(path, aside); attempt += 1) {
      if (attempt > 99) throw Object.assign(new Error("too many copies"), { code: "EEXIST" });
      aside = `${name}-${attempt}`;
    }
    // the kept copy is on disk under its name before the original goes, so a second crash keeps one
    try { flushFile(aside); } catch (error) { dropCopy(aside); throw error; }
    syncDirectory(dirname(path), process.platform);
    try { unlinkSync(path); } catch (error) { dropCopy(aside); throw error; }
    syncDirectory(dirname(path), process.platform);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    throw new Error(`${basename(path)} is not JSON and cannot be set aside as ${basename(aside)} (${reason})`);
  }
  return aside;
}

/** Gives `path`'s bytes the name `aside` without replacing a file there: false when one is there. */
function keepAs(path: string, aside: string): boolean {
  try { linkSync(path, aside); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
  }
  // a file system without hard links
  try { copyFileSync(path, aside, constants.COPYFILE_EXCL); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try { chmodSync(aside, 0o600); }
  catch (error) { dropCopy(aside); throw error; }
  return true;
}

function flushFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Removes a copy that is not kept; the error that made it unneeded is the one to report. */
function dropCopy(aside: string): void {
  try { rmSync(aside, { force: true }); } catch { /* the caller's error says why */ }
}

/**
 * Whether the JSON file at `path` holds `text` (compact JSON.stringify): a store that skips writing
 * an unchanged document checks the file still holds it, so a file deleted or replaced on disk since
 * is written again. A file that is absent or not JSON holds nothing.
 */
export function holdsDocument(path: string, text: string): boolean {
  try { return JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) === text; } catch { return false; }
}

/**
 * Replaces the document at `path` with `text` through a private temporary file. With
 * `keepDamaged`, the file now at `path` is first moved, bytes untouched, to `<path>.bad` (0600),
 * replacing an older one; when it cannot be kept the write is refused and `path` is left as it
 * was. Synchronous, so nothing else in this process writes the file in between.
 */
export function writeStateDocument(path: string, text: string, keepDamaged: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  if (keepDamaged) {
    try {
      chmodSync(path, 0o600);
      renameSync(path, damagedCopy(path));
    } catch (error) {
      rmSync(temporary, { force: true });
      const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
      throw new Error(`Cannot keep the damaged ${basename(path)} as ${basename(damagedCopy(path))} (${reason}), so it was not replaced`);
    }
  }
  renameSync(temporary, path);
}
