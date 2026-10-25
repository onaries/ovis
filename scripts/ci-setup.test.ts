import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const action = Bun.YAML.parse(readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8")) as {
  inputs: Record<string, { default: string }>;
  runs: { steps: Array<{ name?: string; uses?: string; if?: string; with?: Record<string, string>; env?: Record<string, string> }> };
};

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = { jobs?: Record<string, { uses?: string; steps?: Step[] }>; runs?: { steps: Step[] } };

const FULL_SHA = /^[0-9a-f]{40}$/;
const actionName = (uses: string) => uses.slice(0, uses.lastIndexOf("@"));
const actionFiles = [
  ...readdirSync(join(root, ".github/workflows")).filter((name) => name.endsWith(".yml")).map((name) => `.github/workflows/${name}`),
  ".github/actions/setup-ci/action.yml",
];

/** What is wrong with the action references of one workflow or composite action, step by step. */
function auditActions(file: string, text: string) {
  const doc = Bun.YAML.parse(text) as Workflow;
  const problems: string[] = [];
  const steps: Array<[string, Step]> = [];
  for (const [id, job] of Object.entries(doc.jobs ?? {})) {
    if (job.uses && !job.uses.startsWith("./")) problems.push(`${file} jobs.${id}: reusable workflow ${job.uses} is not local`);
    (job.steps ?? []).forEach((step, index) => steps.push([`jobs.${id}.steps[${index}]`, step]));
  }
  (doc.runs?.steps ?? []).forEach((step, index) => steps.push([`runs.steps[${index}]`, step]));
  for (const [where, step] of steps) {
    if (!step.uses || step.uses.startsWith("./")) continue;
    const at = `${file} ${where}${step.name ? ` (${step.name})` : ""}`;
    if (!FULL_SHA.test(step.uses.slice(step.uses.lastIndexOf("@") + 1))) problems.push(`${at}: ${step.uses} is not pinned to a full commit SHA`);
    if (actionName(step.uses) === "actions/checkout" && step.with?.["persist-credentials"] !== false) {
      problems.push(`${at}: checkout persists its Git credential`);
    }
  }
  // YAML parsing drops comments: the version Dependabot and readers go by is only in the text
  for (const [index, line] of text.split("\n").entries()) {
    const [, uses, comment] = line.match(/^\s*(?:- )?uses:\s*([^\s#]+)\s*(#.*)?$/) ?? [];
    if (!uses || uses.startsWith("./") || !FULL_SHA.test(uses.slice(uses.lastIndexOf("@") + 1))) continue;
    if (!/^# v\d+\.\d+\.\d+$/.test(comment?.trim() ?? "")) problems.push(`${file}:${index + 1}: ${uses} has no "# vX.Y.Z" version comment`);
  }
  return problems;
}

function prepared(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-preinstalled-"));
  const calls = join(dir, "calls");
  try {
    for (const name of ["bun", "node", "herdr", "sha256sum"]) {
      writeFileSync(join(dir, name), `#!/bin/sh
printf '%s\\n' '${name}' >> "$TEST_CALLS"
case '${name}' in
  bun) printf '%s\\n' "$TEST_BUN" ;;
  node) printf '%s\\n' "$TEST_NODE" ;;
  sha256sum) IFS= read -r line; exit "$TEST_CHECKSUM_EXIT" ;;
esac
`, { mode: 0o755 });
    }
    const result = spawnSync("bash", [join(root, "scripts/ci-preinstalled-tools.sh")], {
      encoding: "utf8", timeout: 5_000,
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        RUNNER_OS: "Linux", RUNNER_ARCH: "X64",
        EXPECTED_BUN_VERSION: action.inputs["bun-version"]!.default,
        NEED_NODE: "true", NEED_HERDR: "true",
        TEST_BUN: action.inputs["bun-version"]!.default, TEST_NODE: "v22.23.3",
        TEST_CHECKSUM_EXIT: "0", TEST_CALLS: calls, ...overrides,
      },
    });
    expect(result.error).toBeUndefined();
    return { ...result, calls: result.status === 0 ? readFileSync(calls, "utf8") : "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === "win32")("prepared CI tools", () => {
  it("checks the requested tools without downloading replacements", () => {
    const result = prepared();
    expect(result.status).toBe(0);
    expect(result.calls.trim().split("\n")).toEqual(["bun", "node", "sha256sum"]);
  });

  it("does not require optional tools for Bun-only jobs", () => {
    const result = prepared({ NEED_NODE: "false", NEED_HERDR: "false", TEST_NODE: "v18.0.0", TEST_CHECKSUM_EXIT: "1" });
    expect(result.status).toBe(0);
    expect(result.calls.trim()).toBe("bun");
  });

  for (const [name, env] of [
    ["stale Bun", { TEST_BUN: "1.0.0" }],
    ["wrong Node major", { TEST_NODE: "v24.0.0" }],
    ["untrusted herdr binary", { TEST_CHECKSUM_EXIT: "1" }],
    ["unsupported architecture", { RUNNER_ARCH: "ARM64" }],
    ["unsupported host OS", { RUNNER_OS: "Windows" }],
  ] as const) {
    it(`fails closed for ${name}`, () => {
      const result = prepared(env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Rebuild scripts/self-hosted-runner/Dockerfile");
    });
  }
});

describe("CI cache contract", () => {
  it("keeps the prepared image aligned with the workflow and lockfile", () => {
    const dockerfile = readFileSync(join(root, "scripts/self-hosted-runner/Dockerfile"), "utf8");
    const lockfile = readFileSync(join(root, "bun.lock"), "utf8");
    expect(dockerfile.match(/^ARG BUN_VERSION=(.+)$/m)?.[1]).toBe(action.inputs["bun-version"]!.default);
    const playwright = lockfile.match(/"playwright-core": \["playwright-core@([^"]+)"/)?.[1];
    expect(playwright).toBeDefined();
    expect(dockerfile.match(/^ARG PLAYWRIGHT_VERSION=(.+)$/m)?.[1]).toBe(playwright);
  });

  it("saves the dependency cache only when a job allows it", () => {
    const save = action.runs.steps.find((step) => step.name === "Cache Bun dependencies")!;
    const restore = action.runs.steps.find((step) => step.name === "Restore Bun dependencies (read-only)")!;
    expect(action.inputs.cache!.default).toBe("save");
    expect(save.if).toContain("inputs.cache != 'restore'");
    expect(restore.if).toContain("inputs.cache == 'restore'");
    expect(actionName(restore.uses!)).toBe("actions/cache/restore");
    expect(restore.with).toEqual(save.with);
    const canary = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/omp-question-compat.yml"), "utf8")) as {
      jobs: Record<string, { steps: Array<{ uses?: string; with?: Record<string, string> }> }>;
    };
    for (const job of Object.values(canary.jobs)) {
      expect(job.steps.find((step) => step.uses === "./.github/actions/setup-ci")!.with!.cache).toBe("restore");
    }
  });

  it("keeps dependency caches inside the workspace and separates runner environments", () => {
    const cache = action.runs.steps.find((step) => step.name === "Cache Bun dependencies")!;
    expect(cache.with!.path).toBe(".ci-cache/bun");
    expect(cache.with!.key).toContain("bun-workspace-v2-${{ runner.environment }}-");
    expect(cache.with!["restore-keys"]).toStartWith("bun-workspace-v2-${{ runner.environment }}-");
    const directory = action.runs.steps.find((step) => step.name === "Select workspace-local Bun cache")!;
    expect(directory.env!.BUN_CACHE_DIR).toBe(`\${{ github.workspace }}/${cache.with!.path}`);
  });

  it("does not transfer dependency or browser caches over the prepared image", () => {
    for (const name of ["Cache Bun dependencies", "Restore Bun dependencies (read-only)"]) {
      expect(action.runs.steps.find((step) => step.name === name)!.if).toStartWith("runner.environment != 'self-hosted' && ");
    }
    for (const name of ["oven-sh/setup-bun", "actions/setup-node"]) {
      expect(action.runs.steps.find((step) => step.uses && actionName(step.uses) === name)!.if).toContain("runner.environment != 'self-hosted'");
    }
    expect(action.runs.steps.find((step) => step.name === "Install checksum-pinned herdr 0.9.3")!.if)
      .toContain("runner.environment != 'self-hosted'");
    const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: Array<{ name?: string; if?: string; with?: Record<string, string> }> }>;
    };
    for (const job of ["browser-main", "browser-other"]) {
      const cache = workflow.jobs[job]!.steps.find((step) => step.name === "Cache Playwright browser")!;
      expect(cache.if).toContain("runner.environment != 'self-hosted'");
      expect(cache.with!.path).toBe(".ci-cache/playwright");
      expect(cache.with!.key).toStartWith("playwright-workspace-v2-");
    }
  });

  it.skipIf(process.platform === "win32")("restores dependency cache contents across different checkout depths", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-cache-layout-"));
    try {
      const hosted = join(dir, "home/runner/work/repo/repo");
      const selfHosted = join(dir, "w/repo/repo");
      const path = action.runs.steps.find((step) => step.name === "Cache Bun dependencies")!.with!.path!;
      mkdirSync(join(hosted, path), { recursive: true });
      mkdirSync(selfHosted, { recursive: true });
      writeFileSync(join(hosted, path, "dependency"), "cached bytes");
      const archive = join(dir, "cache.tgz");
      const pack = spawnSync("tar", ["-czf", archive, "-C", hosted, path], { timeout: 5_000 });
      expect(pack.status).toBe(0);
      const unpack = spawnSync("tar", ["-xzf", archive, "-C", selfHosted], { timeout: 5_000 });
      expect(unpack.status).toBe(0);
      expect(readFileSync(join(selfHosted, path, "dependency"), "utf8")).toBe("cached bytes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("action pins and checkout credentials", () => {
  it("pins every external action to a full commit SHA and keeps local actions and workflows relative", () => {
    const names = new Set<string>();
    for (const file of actionFiles) {
      const text = readFileSync(join(root, file), "utf8");
      expect(auditActions(file, text)).toEqual([]);
      for (const [, uses] of text.matchAll(/uses:\s*([^\s#]+)/g)) if (!uses!.startsWith("./")) names.add(actionName(uses!));
    }
    expect([...names].sort()).toEqual([
      "actions/cache", "actions/cache/restore", "actions/checkout", "actions/deploy-pages", "actions/download-artifact",
      "actions/setup-node", "actions/upload-artifact", "actions/upload-pages-artifact", "oven-sh/setup-bun",
    ]);
    const dependabot = Bun.YAML.parse(readFileSync(join(root, ".github/dependabot.yml"), "utf8")) as {
      updates: Array<{ "package-ecosystem": string; directories: string[] }>;
    };
    const actions = dependabot.updates.find((update) => update["package-ecosystem"] === "github-actions")!;
    expect(actions.directories).toEqual(["/", "/.github/actions/setup-ci"]);
  });

  it("names the step of a floating action, a missing version comment and a persisted checkout credential", () => {
    const sha = "3d3c42e5aac5ba805825da76410c181273ba90b1";
    const fixture = `jobs:
  build:
    steps:
      - uses: actions/checkout@v7
      - name: Set up Bun
        uses: oven-sh/setup-bun@v2
      - name: Cache
        uses: actions/cache@v4
      - uses: actions/checkout@${sha} # v7.0.1
        with:
          fetch-depth: 0
      - uses: actions/cache/restore@${sha}
      - uses: ./.github/actions/setup-ci
  call:
    uses: someone/repo/.github/workflows/ci.yml@main
`;
    expect(auditActions("fixture.yml", fixture)).toEqual([
      "fixture.yml jobs.call: reusable workflow someone/repo/.github/workflows/ci.yml@main is not local",
      "fixture.yml jobs.build.steps[0]: actions/checkout@v7 is not pinned to a full commit SHA",
      "fixture.yml jobs.build.steps[0]: checkout persists its Git credential",
      "fixture.yml jobs.build.steps[1] (Set up Bun): oven-sh/setup-bun@v2 is not pinned to a full commit SHA",
      "fixture.yml jobs.build.steps[2] (Cache): actions/cache@v4 is not pinned to a full commit SHA",
      "fixture.yml jobs.build.steps[3]: checkout persists its Git credential",
      `fixture.yml:12: actions/cache/restore@${sha} has no "# vX.Y.Z" version comment`,
    ]);
  });
});
