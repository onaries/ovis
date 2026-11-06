import type { RepoDiffRepository } from "./repo-diff.ts";

/** Who wrote or committed a commit, as git recorded it. */
export interface RepoPerson {
  name: string;
  email: string;
  /** ISO 8601 with the offset it was recorded in */
  time: string;
}

export interface RepoCommit {
  oid: string;
  /** full hashes, the first parent first; empty for a root commit, and for a shallow clone's boundary commit */
  parents: string[];
  author: RepoPerson;
  committer: RepoPerson;
  /** the message's first paragraph on one line, as `git log --oneline` shows it */
  subject: string;
  /**
   * the branches, remote branches and tags at this commit as full refnames (`refs/heads/feat/a,b`,
   * `refs/tags/v1.0`), sorted; an annotated tag counts at the commit it names
   */
  refs: string[];
}

/** GET /api/workspace/git/log */
export interface RepoLog {
  repository: RepoDiffRepository;
  /** the revision the history was read from, as asked: `HEAD` when none was */
  ref: string;
  /** the commit that revision named when this page was read; null before the first commit. Later pages pass it back as `oid` */
  oid: string | null;
  skip: number;
  /** newest first, at most the asked `limit` */
  commits: RepoCommit[];
  /** the `skip` of the next page; null on the last one */
  next_skip: number | null;
  /** some commits' `refs` may be missing: the refs on this page passed `limits.max_list_bytes` */
  refs_truncated: boolean;
  limits: { max_limit: number; max_list_bytes: number };
}

export interface RepoBranch {
  /** the full refname, `refs/heads/…`, which `ref` of the log route takes as it is */
  name: string;
  oid: string;
  /** the branch checked out in this working tree */
  current: boolean;
  /** the configured upstream as a full refname (`refs/remotes/origin/main`); null when none is set */
  upstream: string | null;
  /** commits on this branch and not on its upstream, and the reverse; null without an upstream or with a gone one */
  ahead: number | null;
  behind: number | null;
  /** an upstream is configured and no longer exists here (deleted on the remote and pruned) */
  upstream_gone: boolean;
  /** the tip's committer date, ISO 8601 */
  committed_at: string;
  subject: string;
}

/** GET /api/workspace/git/branches */
export interface RepoBranches {
  repository: RepoDiffRepository;
  /** the current branch first, then by last commit, newest first; at most `limits.max_branches` */
  branches: RepoBranch[];
  truncated: boolean;
  limits: { max_branches: number; max_list_bytes: number };
}

/** GET /api/workspace/git/show */
export interface RepoCommitDetail {
  repository: RepoDiffRepository;
  commit: RepoCommit;
  /** `commit.refs` may be missing some: the refs at it passed the list's byte cap */
  refs_truncated: boolean;
  /** the whole message, its trailing newlines left out; cut at `limits.max_message_bytes` when `message_truncated` */
  message: string;
  message_truncated: boolean;
  /**
   * what this commit's changes are read against with the diff routes (`scope=commit&base=<base>&head=<oid>`):
   * its first parent, or for a root commit the empty tree's hash, which those routes take as a base;
   * null for a shallow clone's boundary commit, whose parent this clone does not have
   */
  base: string | null;
  limits: { max_message_bytes: number };
}
