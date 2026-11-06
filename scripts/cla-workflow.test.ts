import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Step { name?: string; run?: string }
interface Workflow { jobs: { cla: { steps: Step[] } } }

const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/cla.yml", import.meta.url), "utf8")) as Workflow;
const guard = workflow.jobs.cla.steps.find((step) => step.run !== undefined)!;

interface Pr { opener: string; head: { repo: string; owner: string; type: string } | null; authors: string[] }

/** Runs the guard step for PR 7 of devswha/ovis with `gh api` answered from `pr` through jq, like `gh --jq`. */
function runGuard(pr: Pr): { code: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "cla-guard-"));
  try {
    const head = pr.head && { full_name: pr.head.repo, owner: { login: pr.head.owner, type: pr.head.type } };
    writeFileSync(join(dir, "pull.json"), JSON.stringify({ user: { login: pr.opener }, commits: pr.authors.length, head: { repo: head } }));
    writeFileSync(join(dir, "commits.json"), JSON.stringify(pr.authors.map((login, i) => ({ sha: `${i}`.padStart(40, "a"), author: { login } }))));
    const stub = `gh() {
      local path="$2" filter; while [ $# -gt 0 ]; do [ "$1" = --jq ] && filter="$2"; shift; done
      case "$path" in repos/devswha/ovis/pulls/7) jq -r "$filter" "${dir}/pull.json" ;; repos/devswha/ovis/pulls/7/commits) jq -r "$filter" "${dir}/commits.json" ;; *) return 1 ;; esac
    }`;
    const run = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", `${stub}\n${guard.run}`], {
      env: { PATH: process.env.PATH ?? "", REPO: "devswha/ovis", PR: "7" },
    });
    return { code: run.exitCode, output: run.stdout.toString() + run.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fork = (owner: string, type = "User") => ({ repo: `${owner}/ovis`, owner, type });
const own = { repo: "devswha/ovis", owner: "devswha", type: "User" };

test.each<[string, Pr, boolean]>([
  ["the maintainer's own branch", { opener: "devswha", head: own, authors: ["devswha"] }, true],
  ["an outsider's fork with an outsider's commit", { opener: "alice", head: fork("alice"), authors: ["alice", "devswha"] }, true],
  ["the maintainer opening an outsider's fork the outsider committed to", { opener: "devswha", head: fork("alice"), authors: ["alice", "devswha"] }, true],
  ["an outsider opening a PR with no commit of their own", { opener: "alice", head: fork("alice"), authors: ["devswha"] }, false],
  ["the maintainer opening an outsider's fork whose commits all name the maintainer", { opener: "devswha", head: fork("alice"), authors: ["devswha"] }, false],
  ["the maintainer opening an organization's fork", { opener: "devswha", head: fork("acme", "Organization"), authors: ["devswha"] }, false],
  ["the maintainer opening a PR whose fork was deleted", { opener: "devswha", head: null, authors: ["devswha"] }, false],
  ["an outsider opening an organization's fork with their own commit", { opener: "alice", head: fork("acme", "Organization"), authors: ["alice"] }, true],
  ["an outsider opening another person's fork with their own commit", { opener: "bob", head: fork("alice"), authors: ["bob"] }, true],
])("the CLA guard on %s", (_, pr, passes) => {
  const result = runGuard(pr);
  expect({ passed: result.code === 0, output: result.output }).toMatchObject({ passed: passes });
  if (!passes) expect(result.output).toContain("::error title=CLA::");
});
