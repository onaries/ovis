/**
 * Paths in the file browser read from the folder it was opened on (the pane's directory), as
 * "root/sub/dir", instead of from home. Adapted from t3code's formatWorkspaceRelativePath. A chat's
 * tool-file labels read the same way from the pane's folder.
 */

/** The absolute folder the browser was opened on: `start` typed as `~`, `~/…` or an absolute path. */
export function resolveWorkspaceRoot(start: string, home: string): string | null {
  let root: string;
  if (start === "~") root = home;
  else if (start.startsWith("~/")) root = `${home.replace(/\/+$/, "")}/${start.slice(2)}`;
  else if (start.startsWith("/")) root = start;
  else return null;
  root = root.replace(/\/+$/, "");
  return root === "" ? null : root;
}

/**
 * The folder a chat's tool paths read from: the pane's `cwd` when it is an absolute POSIX path
 * (trailing slashes trimmed, never `/` itself), else null and the paths stay as written. A Windows
 * drive or UNC folder is not guessed at, a UNC one written with forward slashes (`//server/share`)
 * included.
 */
export function toolPathRoot(cwd: string | null | undefined): string | null {
  if (cwd == null || !cwd.startsWith("/") || cwd.startsWith("//")) return null;
  const root = cwd.replace(/\/+$/, "");
  return root === "" ? null : root;
}

/**
 * A chat tool-file label: `path` read from `root` (toolPathRoot) when it is inside it, else as
 * written. A path with a `.` or `..` segment stays as written: agent output can name
 * `/work/app/../etc/passwd`, which is not inside `/work/app` however it starts.
 */
export function toolPathLabel(path: string, root: string | null): string {
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return path;
  return workspaceRelativePath(path, root, path);
}

/**
 * `path` as "<root name>/<rest>" when it is the root or inside it, else `fallback` (the
 * home-relative form). Nothing is shown relative to a root that is not an ancestor.
 */
export function workspaceRelativePath(path: string, root: string | null, fallback: string): string {
  if (root === null) return fallback;
  const label = root.slice(root.lastIndexOf("/") + 1);
  if (path === root) return label;
  return path.startsWith(`${root}/`) ? `${label}/${path.slice(root.length + 1)}` : fallback;
}
