/**
 * Which browser scripts failed, and which passed only on a second run, across recent CI runs:
 *   bun scripts/ci-flakes.ts [--hours 24] [--repo owner/name] [--json]
 * Reads through `gh`, changes nothing. A job that failed has its log read. A job that passed is
 * read only when it carries the lane's "Flaky browser script" warning, so a quiet day costs one
 * small request per job instead of its whole log.
 */
import { parseArgs } from "node:util";
import { failureSite } from "./ci-browser-parallel.ts";

export interface LaneFailure {
  readonly script: string;
  readonly outcome: "failed" | "flaky";
  readonly site: string | null;
  readonly message: string | null;
}

export function parseLaneLog(log: string): LaneFailure[] {
  const clean = Bun.stripANSI(log).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, "");
  const headers = [...clean.matchAll(/^(FAILED|FLAKY) (scripts\/[\w.-]+\.ts)(?=[:\s]).*$/gm)];
  return headers.map((header, index) => {
    const body = clean.slice((header.index ?? 0) + header[0].length, headers[index + 1]?.index ?? clean.length);
    return {
      script: header[2] ?? "",
      outcome: header[1] === "FLAKY" ? "flaky" : "failed",
      ...failureSite(body),
    };
  });
}

export interface FailureObservation extends LaneFailure {
  readonly runId: number;
  readonly branch: string;
  readonly createdAt: string;
}

export interface RankedFailure {
  readonly script: string;
  readonly site: string | null;
  readonly message: string | null;
  failed: number;
  flaky: number;
  runId: number;
  branch: string;
  createdAt: string;
}

export function aggregateFailures(observations: readonly FailureObservation[]): RankedFailure[] {
  const rows = new Map<string, RankedFailure>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.script, observation.site, observation.message]);
    let row = rows.get(key);
    if (!row) {
      row = { script: observation.script, site: observation.site, message: observation.message, failed: 0, flaky: 0, runId: observation.runId, branch: observation.branch, createdAt: observation.createdAt };
      rows.set(key, row);
    }
    row[observation.outcome]++;
    if (observation.createdAt > row.createdAt || (observation.createdAt === row.createdAt && observation.runId > row.runId)) {
      row.runId = observation.runId;
      row.branch = observation.branch;
      row.createdAt = observation.createdAt;
    }
  }
  return [...rows.values()].sort((a, b) =>
    (b.failed + b.flaky) - (a.failed + a.flaky) ||
    b.createdAt.localeCompare(a.createdAt) ||
    JSON.stringify([a.script, a.site, a.message]).localeCompare(JSON.stringify([b.script, b.site, b.message])));
}

class GhError extends Error {}

/**
 * One gh call, asked again up to twice on a server error (HTTP 5xx): one 502 among the hundreds of reads a day's scan
 * makes would otherwise end the whole scan with nothing. A refusal (4xx) answers the same again and is not repeated.
 */
async function gh(args: string[], attempts = 3): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const child = Bun.spawn(["gh", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code === 0) return stdout;
    const message = stderr.trim() || stdout.trim();
    if (attempt >= attempts || !/HTTP 5\d\d\b/.test(message)) throw new GhError(message);
  }
}

async function pooled<T, R>(items: readonly T[], visit: (item: T) => Promise<R>): Promise<R[]> {
  const queue = [...items];
  const results: R[] = [];
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) results.push(await visit(item));
    }
  }));
  return results;
}

interface Run {
  readonly id: number;
  readonly run_attempt: number;
  readonly head_branch: string;
  readonly created_at: string;
}

interface Job {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** Whether a job that passed says one of its scripts needed a second run (the lane's warning annotation). */
async function flaggedFlaky(repo: string, job: Job): Promise<boolean> {
  let text: string;
  try { text = await gh(["api", `repos/${repo}/check-runs/${job.id}/annotations?per_page=100`, "--paginate", "--slurp"]); }
  catch (error) {
    // annotations a server error keeps from us: its log is read instead, which says it as well
    if (error instanceof GhError && /HTTP 5\d\d\b/.test(error.message)) return true;
    throw error;
  }
  const pages: { title: string | null }[][] = JSON.parse(text);
  return pages.flat().some((annotation) => annotation.title?.startsWith("Flaky browser script") === true);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { hours: { type: "string", default: "24" }, repo: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const hours = Number(values.hours);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be a positive number");
  const repo = values.repo ?? (await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const runPages: { workflow_runs: Run[] }[] = JSON.parse(await gh([
    "api", `repos/${repo}/actions/workflows/ci.yml/runs?per_page=100&created=${encodeURIComponent(`>=${since}`)}`, "--paginate", "--slurp",
  ]));
  const runs = runPages.flatMap((page) => page.workflow_runs);
  // runsUnread, logsUnread: a run's job list or a job's log that a server error kept from us, after gh()'s retries
  const stats = { runs: runs.length, jobs: 0, jobsSkipped: 0, jobsClean: 0, logsRead: 0, runsUnread: 0, logsUnread: 0 };
  const groups = await pooled(runs, async (run) => {
    const jobs: { run: Run; job: Job }[] = [];
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      let text: string;
      try {
        text = await gh(["api", `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`, "--paginate", "--slurp"]);
      } catch (error) {
        // one run's job list a server error keeps from us is left out and counted, as a job's log is
        if (!(error instanceof GhError) || !/HTTP 5\d\d\b/.test(error.message)) throw error;
        stats.runsUnread++;
        continue;
      }
      const pages: { jobs: Job[] }[] = JSON.parse(text);
      for (const job of pages.flatMap((page) => page.jobs)) {
        if (!job.name.startsWith("Browser regression")) continue;
        stats.jobs++;
        // still running, or skipped on a draft: nothing ran to a result
        if (job.status !== "completed" || (job.conclusion !== "success" && job.conclusion !== "failure")) stats.jobsSkipped++;
        else jobs.push({ run, job });
      }
    }
    return jobs;
  });
  let allowEscapes = true;
  const observations = await pooled(groups.flat(), async ({ run, job }) => {
    if (job.conclusion === "success" && !(await flaggedFlaky(repo, job))) {
      stats.jobsClean++;
      return [];
    }
    const args = ["api", `repos/${repo}/actions/jobs/${job.id}/logs`];
    let log: string;
    try {
      try {
        log = await gh(allowEscapes ? [...args, "--allow-escape-sequences"] : args);
      } catch (error) {
        if (!(error instanceof GhError) || !/unknown flag.*allow-escape-sequences/.test(error.message)) throw error;
        allowEscapes = false;
        log = await gh(args);
      }
    } catch (error) {
      // gone (404, 410), or a server error that outlasted gh()'s retries: this job is left out and counted, the scan goes on
      if (!(error instanceof GhError) || !/HTTP (404|410|5\d\d)\b/.test(error.message)) throw error;
      if (/HTTP 5\d\d\b/.test(error.message)) stats.logsUnread++;
      else stats.jobsSkipped++;
      return [];
    }
    if (!log.trim()) {
      stats.jobsSkipped++;
      return [];
    }
    stats.logsRead++;
    return parseLaneLog(log).map((failure) => ({
      ...failure, runId: run.id, branch: run.head_branch, createdAt: run.created_at,
    }));
  });
  const rows = aggregateFailures(observations.flat());
  if (values.json) {
    console.log(JSON.stringify({ ...stats, rows }, null, 2));
    return;
  }
  console.log(`${stats.runs} CI runs since ${since}; browser jobs: ${stats.jobs}, of which ${stats.jobsClean} passed with no second run, ${stats.logsRead} had their log read and ${stats.jobsSkipped} were skipped (running, skipped or without a log).`);
  if (stats.jobs === 0) { console.log("Nothing was read."); return; }
  const unread = stats.runsUnread + stats.logsUnread;
  if (unread > 0) console.log(`Not read for a server error: ${stats.runsUnread} run attempts' job lists and ${stats.logsUnread} job logs.`);
  if (rows.length === 0) {
    console.log(unread > 0 ? "No browser script failed or needed a second run in what could be read." : "No browser script failed or needed a second run.");
    return;
  }
  console.log("failed\tflaky\tscript\tsite\tmessage\tmost recent run\tbranch");
  for (const row of rows) console.log([row.failed, row.flaky, row.script, row.site ?? "-", row.message ?? "-", row.runId, row.branch].join("\t"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
