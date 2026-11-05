/**
 * The pull request of a workspace's branch, as the PC that runs the workspace reads it through its
 * own `gh` sign-in (GET /api/workspace/pr, /api/workspace/pr/log; POST /api/workspace/pr/merge).
 */

/** How a check stands: `fail` covers failed, timed out, cancelled and action required. */
export type PullRequestCheckState = "pass" | "fail" | "pending" | "skipped" | "neutral";

export interface PullRequestCheck {
  name: string;
  /** the Actions workflow a check run belongs to; null for a commit status or another app's check */
  workflow: string | null;
  state: PullRequestCheckState;
  /** the check's page on GitHub, when it has one */
  url: string | null;
  /** an Actions job's id, whose log GET /api/workspace/pr/log reads; null for any other check */
  job_id: string | null;
}

/** An unresolved review thread: where it is and its first comment. */
export interface PullRequestThread {
  path: string;
  /** the line in the pull request's current diff; null when the thread is outdated or on the file */
  line: number | null;
  outdated: boolean;
  author: string | null;
  /** the first comment's text, cut at PULL_REQUEST_MAX_COMMENT_CHARS */
  body: string;
  /** how many comments the thread holds, the first included */
  comments: number;
  url: string | null;
}

/** GitHub's merge methods; a merge uses the repository's default for the signed-in user. */
export type PullRequestMergeMethod = "merge" | "squash" | "rebase";

/** GET /api/workspace/pr */
export interface PullRequestView {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  head_ref: string;
  base_ref: string;
  /** the head commit the view was read at: a merge names it, so a push after the read is not merged */
  head_oid: string;
  /** GitHub's mergeStateStatus, lower case: clean, unstable, has_hooks, blocked, behind, dirty, draft, unknown */
  merge_state: string;
  /** the base branch merges through a merge queue: Merge is left to GitHub, where the queue is seen */
  merge_queue: boolean;
  /** an open, ready pull request GitHub would merge now: required checks and reviews passed, no conflict */
  mergeable: boolean;
  merge_method: PullRequestMergeMethod;
  /** failing first, then pending, then the rest, each in GitHub's order */
  checks: PullRequestCheck[];
  threads: PullRequestThread[];
  /** more unresolved threads than the view lists */
  threads_truncated: boolean;
}

/** GET /api/workspace/pr/log: the tail of an Actions job's log, timestamps and colour codes removed. */
export interface PullRequestCheckLog {
  job_id: string;
  text: string;
  /** earlier lines were left out */
  truncated: boolean;
}

/** POST /api/workspace/pr/merge */
export interface PullRequestMergeRequest {
  pane_id?: string;
  directory?: string;
  number: number;
  head_oid: string;
  /** the base the view showed: a pull request moved to another base since is refused, not merged there */
  base_ref: string;
  method: PullRequestMergeMethod;
}

export const PULL_REQUEST_MAX_THREADS = 100;
export const PULL_REQUEST_MAX_COMMENT_CHARS = 2_000;
export const PULL_REQUEST_LOG_LINES = 80;
export const PULL_REQUEST_LOG_CHARS = 8_000;
