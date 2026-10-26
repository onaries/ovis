import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** A canonical regular JSONL file inside the canonical session store, never a link out or FIFO. */
export function transcriptInStore(path: string, sessionDir: string): string | null {
  let canonical: string;
  let root: string;
  try {
    canonical = realpathSync(path);
    root = realpathSync(sessionDir);
  } catch { return null; }
  const inside = relative(root, canonical);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  if (!canonical.endsWith(".jsonl")) return null;
  let fd: number | undefined;
  try {
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK);
    return fstatSync(fd).isFile() ? canonical : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

const absent = (error: unknown): boolean => error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

/**
 * A reported session not written yet. pi and omp write the session file only after the first
 * answer (pi's SessionManager waits for an assistant message). Only an absent JSONL file whose
 * nearest existing ancestor is a directory inside the resolved store counts; dangling links never do.
 */
export function unwrittenSession(path: string, sessionDir: string): { id: string; path: string } | null {
  if (!isAbsolute(path) || !path.endsWith(".jsonl")) return null;
  let root: string;
  try { root = realpathSync(sessionDir); } catch { return null; }
  try {
    lstatSync(path);
    return null;
  } catch (error) { if (!absent(error)) return null; }
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      const real = realpathSync(dir);
      if (!statSync(real).isDirectory()) return null;
      const inside = relative(root, real);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
      return { id: basename(path, ".jsonl"), path: join(real, relative(dir, path)) };
    } catch (error) {
      if (!absent(error) || dirname(dir) === dir) return null;
      // A dangling link is not a directory still to come: the agent cannot write through it.
      try { lstatSync(dir); return null; } catch (missing) { if (!absent(missing)) return null; }
    }
  }
}
