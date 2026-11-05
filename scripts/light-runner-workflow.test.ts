import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow, root, type Job } from "./shell-workflow-rules.ts";

// Light jobs (Detect changes, the PR title check, ...) take the self-hosted pool so they do not wait
// in GitHub's hosted queue, but a fork pull request's job must never reach that pool: the guard comes
// first, so a fork gets ubuntu-24.04 whatever the repository variables say.
const FORK_GUARD = "github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-24.04'";
const LIGHT = `\${{ ${FORK_GUARD} || fromJSON(github.ref == 'refs/heads/main' && vars.CI_MAIN_SELF_HOSTED_LABELS || vars.CI_LIGHT_LABELS || vars.CI_SELF_HOSTED_LABELS || '["self-hosted","self-hosted-ovis"]') }}`;
// ci.yml's heavy Linux jobs: scripts/ci-runner-route.sh keeps forks hosted (scripts/ci-runner-route.test.ts)
const ROUTED = "${{ fromJSON(needs.changes.outputs.linux) }}";
const HOSTED = /^(ubuntu|windows|macos)-[\w.-]+$/;

const dir = join(root, ".github/workflows");
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, workflow: parseWorkflow(join(dir, name)) }));

const triggers = (on: unknown): string[] => (typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on as object));

// workflows a pull request runs: its own triggers, then every reusable workflow they call
const pullRequestWorkflows = new Set(
  workflows.filter(({ workflow }) => triggers(workflow.on).some((event) => event === "pull_request" || event === "pull_request_target")).map(({ name }) => name),
);
for (let grew = true; grew; ) {
  grew = false;
  for (const { workflow } of workflows.filter(({ name }) => pullRequestWorkflows.has(name))) {
    for (const job of Object.values(workflow.jobs)) {
      const called = /^\.\/\.github\/workflows\/(.+\.yml)$/.exec(job.uses ?? "")?.[1];
      if (called && !pullRequestWorkflows.has(called)) {
        pullRequestWorkflows.add(called);
        grew = true;
      }
    }
  }
}

/** Why `job` can never send a fork pull request's code to a self-hosted runner, or null. */
function forkSafe(job: Job & { strategy?: { matrix?: { include?: { os?: unknown }[] } } }): string | null {
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string") return null;
  if (HOSTED.test(runsOn)) return "hosted";
  if (runsOn === LIGHT) return "light";
  if (runsOn === ROUTED) return "routed";
  if (runsOn === "${{ matrix.os }}") {
    const include = job.strategy?.matrix?.include ?? [];
    return include.length > 0 && include.every((entry) => typeof entry.os === "string" && HOSTED.test(entry.os)) ? "hosted matrix" : null;
  }
  // a job that never runs for a pull request may take any runner: its condition must require that
  const condition = job.if ?? "";
  return /^(.+ && )?github\.event_name != 'pull_request'( && .+)?$/.test(condition) && !condition.includes("||") ? "not on pull requests" : null;
}

describe("self-hosted runners and fork pull requests", () => {
  test("the light runner expression sends fork pull requests to ubuntu-24.04 before reading any variable", () => {
    expect(LIGHT.indexOf(FORK_GUARD)).toBe(4);
    expect(LIGHT.indexOf("vars.")).toBeGreaterThan(LIGHT.indexOf(FORK_GUARD));
  });

  test("ci.yml's routed Linux label comes from scripts/ci-runner-route.sh", () => {
    const ci = workflows.find(({ name }) => name === "ci.yml")!.workflow;
    const changes = ci.jobs.changes!;
    expect(changes.outputs?.linux).toBe("${{ steps.route.outputs.linux }}");
    expect(changes.steps?.find((step) => step.id === "route")?.run).toBe('bash scripts/ci-runner-route.sh >> "$GITHUB_OUTPUT"');
  });

  test("ci-runner-route.sh leaves out of its busy count exactly the light jobs a pull request runs", () => {
    const names = workflows
      .filter(({ name }) => pullRequestWorkflows.has(name))
      .flatMap(({ workflow }) => Object.entries(workflow.jobs).filter(([, job]) => job["runs-on"] === LIGHT).map(([id, job]) => (job as Job & { name?: string }).name ?? id));
    const route = readFileSync(join(root, "scripts/ci-runner-route.sh"), "utf8");
    const listed = JSON.parse(/^light_job_names='(.+)'$/m.exec(route)![1]!) as string[];
    expect(listed.toSorted()).toEqual(names.toSorted());
  });

  test("some job uses the light runner expression", () => {
    const light = workflows.flatMap(({ workflow }) => Object.values(workflow.jobs).filter((job) => job["runs-on"] === LIGHT));
    expect(light.length).toBeGreaterThan(0);
  });

  test("pull requests run ci.yml", () => {
    expect(pullRequestWorkflows.has("ci.yml")).toBe(true);
  });

  for (const { name, workflow } of workflows.filter(({ name }) => pullRequestWorkflows.has(name))) {
    test(`${name}: no pull request job can reach a self-hosted runner without the fork guard`, () => {
      const unsafe = Object.entries(workflow.jobs)
        .filter(([, job]) => job["runs-on"] !== undefined && forkSafe(job) === null)
        .map(([id, job]) => `${id}: ${String(job["runs-on"])}`);
      expect(unsafe).toEqual([]);
    });
  }
});
