/**
 * Which two states of a repository are compared: the working tree against the index, the index
 * against HEAD, two commits, or (`branch`) the working tree against the merge base of a chosen
 * base and HEAD.
 */
export type RepoDiffScope = "workspace" | "staged" | "commit" | "branch";

export interface RepoDiffRepositories {
  roots: string[];
  /** The bounded search stopped early or could not read a folder. */
  truncated: boolean;
}

/**
 * The identity of a `branch` comparison, pinned when the list answered: the repository, HEAD,
 * the chosen base as the commit it named then, and their merge base, which the patches are read
 * from. Carried back whole on each patch read; the server recomputes the merge base from the
 * immutable ids and refuses (409 comparison_changed) once the repository or HEAD is another.
 */
export interface RepoBranchComparison {
  repository_root: string;
  head_oid: string;
  base_oid: string;
  merge_base_oid: string;
}

/** GET /api/workspace/diff/refs */
export interface RepoDiffRefs {
  repository: RepoDiffRepository;
  /** full refnames (`refs/heads/main`, `refs/remotes/origin/main`) with their commits, sorted by name */
  refs: { name: string; oid: string }[];
  /** `refs` is not the whole list: a base not in it can still be typed */
  truncated: boolean;
  limits: { max_refs: number; max_list_bytes: number };
}

/** How one file changed. `untracked` exists only in the `workspace` and `branch` scopes. */
export type RepoDiffStatus = "added" | "deleted" | "modified" | "renamed" | "copied" | "type_changed" | "unmerged" | "untracked";

/** The repository a comparison was read from, on the PC that owns it. */
export interface RepoDiffRepository {
  /** the working tree's top folder, absolute */
  root: string;
  /** the checked-out branch; null on a detached HEAD */
  branch: string | null;
  /** HEAD's commit hash; null before the first commit */
  head: string | null;
  detached: boolean;
  /** no commit yet: `staged` then lists everything added so far */
  unborn: boolean;
}

export interface RepoDiffFile {
  /** relative to the repository root, forward slashes, as git names it (never quoted) */
  path: string;
  /** where a renamed or copied file came from; null otherwise */
  old_path: string | null;
  status: RepoDiffStatus;
  /** lines added and removed; null for a binary file, an untracked one, and past the list's byte cap */
  additions: number | null;
  deletions: number | null;
  /** null when not determined: an untracked file in a list is not opened to find out */
  binary: boolean | null;
}

/** GET /api/workspace/diff/files */
export interface RepoDiffFileList {
  repository: RepoDiffRepository;
  scope: RepoDiffScope;
  /**
   * the commits compared, as full hashes, in the `commit` scope; in the `branch` scope the chosen
   * base and HEAD (the merge base they were compared from is in `comparison`); null in the others
   */
  base: string | null;
  head: string | null;
  /** the `branch` scope's pinned identity, to carry into each patch read; null in the others */
  comparison: RepoBranchComparison | null;
  /** sorted by path, at most `limits.max_files` */
  files: RepoDiffFile[];
  /** how many files changed in all; null when git printed more than `limits.max_list_bytes` */
  total: number | null;
  /** `files` is not the whole list */
  truncated: boolean;
  limits: { max_files: number; max_list_bytes: number };
}

/**
 * GET /api/workspace/diff/file. `patch` is git's own output for that one file, from its
 * `diff --git` line on, and is either complete or null.
 */
export interface RepoDiffFilePatch {
  repository: RepoDiffRepository;
  scope: RepoDiffScope;
  base: string | null;
  head: string | null;
  /** the `branch` scope's identity this patch was read from, as the list gave it; null in the others */
  comparison: RepoBranchComparison | null;
  file: RepoDiffFile;
  patch: string | null;
  /**
   * Why there is no patch: `binary` (no text to show), `too_large` (past `limits.max_patch_bytes`),
   * `unmerged` (a conflict: git prints a combined diff, which is not a unified patch) or
   * `unsupported` (an untracked path that is not a regular file). Null when `patch` is set.
   */
  unavailable: "binary" | "too_large" | "unmerged" | "unsupported" | null;
  /** the patch exists and was left out for its size */
  truncated: boolean;
  limits: { max_patch_bytes: number; context_lines: number };
}
