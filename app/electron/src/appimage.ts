import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The folder this AppImage unpacked itself into to run without FUSE (`--appimage-extract-and-run`
 * or APPIMAGE_EXTRACT_AND_RUN=1, the fallback where user FUSE mounts are not allowed), when this
 * program runs from it; null otherwise, and with NO_CLEANUP (the runtime's own way to keep it). The
 * runtime names it `appimage_extracted_<hash>` in the temporary folder and is meant to remove it
 * after the app exits, but it was seen left behind (about 400 MB), so the app removes it as it quits.
 */
export function extractedAppDir(env: Record<string, string | undefined>, execPath: string): string | null {
  const dir = env["APPDIR"]?.replace(/\/+$/, "");
  if (!env["APPIMAGE"] || env["NO_CLEANUP"] !== undefined || !dir || !/^appimage_extracted_[0-9a-f]+$/.test(basename(dir))) return null;
  return execPath.startsWith(`${dir}/`) ? dir : null;
}

/**
 * Whether a process outside this app's own tree runs a program from `dir`: the same AppImage
 * started again (with another user data folder, so it got a lock of its own) unpacks into the same
 * folder, which must then stay. Processes this one cannot read are not counted.
 */
export function othersRunFrom(dir: string, selfPid: number, procRoot = "/proc"): boolean {
  const parents = new Map<number, number>();
  const users: number[] = [];
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(join(procRoot, name, "stat"), "utf8");
      parents.set(pid, Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
      if (readlinkSync(join(procRoot, name, "exe")).startsWith(`${dir}/`)) users.push(pid);
    } catch { /* gone, or another user's */ }
  }
  return users.some((pid) => {
    const seen = new Set<number>();
    for (let at: number | undefined = pid; at !== undefined && at > 1 && !seen.has(at); at = parents.get(at)) {
      if (at === selfPid) return false;
      seen.add(at);
    }
    return true;
  });
}
