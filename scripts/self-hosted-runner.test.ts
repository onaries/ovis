import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./self-hosted-runner/run.sh", import.meta.url));
const jobStarted = fileURLToPath(new URL("./self-hosted-runner/job-started.sh", import.meta.url));

/** Runs the hook as the runner does, under a process named Runner.Worker (a copy of bash) that goes on after it. */
function runJobStarted(eventName: string, payload: unknown, event: { raw?: string; path?: "missing" | "directory" | "unset"; repository?: "unset"; closedOutput?: boolean } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "herdr-runner-hook-test-"));
  try {
    let eventPath: string | undefined = join(tempDir, "event.json");
    writeFileSync(eventPath, event.raw ?? JSON.stringify(payload));
    if (event.path === "missing") eventPath = join(tempDir, "no-such-event.json");
    if (event.path === "directory") eventPath = tempDir;
    if (event.path === "unset") eventPath = undefined;
    const worker = join(tempDir, "Runner.Worker");
    copyFileSync(spawnSync("bash", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim(), worker);
    chmodSync(worker, 0o755);
    // closedOutput: the hook's stdout and stderr are a pipe nobody reads any more (a FIFO whose only
    // reader is closed before the hook starts), so its first write, even an error message, raises SIGPIPE
    const hook = event.closedOutput
      ? 'mkfifo "$1" && exec 4<>"$1" 5>"$1" 4<&- && bash "$0" >&5 2>&5; echo "next step ran"'
      : 'bash "$0"; echo "next step ran"';
    const result = spawnSync(worker, ["-c", hook, jobStarted, join(tempDir, "output.fifo")], {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_EVENT_NAME: eventName,
        ...(event.repository === "unset" ? {} : { GITHUB_REPOSITORY: "devswha/ovis" }),
        ...(eventPath === undefined ? {} : { GITHUB_EVENT_PATH: eventPath }),
      },
    });
    expect(result.error).toBeUndefined();
    return result;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runRunner(options: {
  count?: number;
  ghTokenExitCode?: number;
  dockerExitCode?: number;
  failedSlot?: number;
  /** "present" writes a host env file and passes it, "missing" passes a path that does not exist */
  envFile?: "present" | "missing" | "bare" | "secret" | "nul";
  /** a grep on PATH that fails with a read error (exit 2), as on a file that passes -r but cannot be read */
  grepReadError?: boolean;
  /** more launcher arguments, after --count */
  args?: string[];
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "herdr-self-hosted-runner-test-"));
  const binDir = join(tempDir, "bin");
  const logPath = join(tempDir, "commands.log");
  const path = [binDir, process.env.PATH].filter(Boolean).join(delimiter);

  try {
    mkdirSync(binDir);
    writeFileSync(join(binDir, "gh"), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$RUNNER_TEST_LOG"
case " $* " in
  *registration-token*)
    if [ "\${GH_TOKEN_EXIT_CODE:-0}" -ne 0 ]; then
      exit "$GH_TOKEN_EXIT_CODE"
    fi
    printf '%s\\n' mock-token
    ;;
esac
`);
    writeFileSync(join(binDir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$RUNNER_TEST_LOG"
case "$1" in
  image) exit 0 ;;
  run)
    # the shared network namespace container is detached and reads no token
    [ "$2" = -d ] && exit 0
    IFS= read -r token || exit 1
    shift
    name=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --name ]; then
        name="$2"
        shift 2
      else
        shift
      fi
    done
    if [ "\${name##*-}" = "\${DOCKER_FAIL_SLOT:-}" ]; then
      exit "\${DOCKER_EXIT_CODE:-42}"
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`);
    chmodSync(join(binDir, "gh"), 0o755);
    chmodSync(join(binDir, "docker"), 0o755);
    const envFile = join(tempDir, "host.env");
    if (options.envFile === "present") writeFileSync(envFile, "# P620\n\nCHECK_HOST_MAX_RUNS=6\nCHECK_HOST_BROWSER_WORKERS=10\n");
    if (options.envFile === "bare") writeFileSync(envFile, "CHECK_HOST_MAX_RUNS=6\nGH_TOKEN\n");
    if (options.envFile === "secret") writeFileSync(envFile, "# P620\nCHECK_HOST_MAX_RUNS=6\nGH_TOKEN=ghp_synthetic_secret\n");
    if (options.envFile === "nul") writeFileSync(envFile, "CHECK_HOST_MAX_RUNS=6\nCHECK_HOST_TEST_SHARDS=6\u0000\n");
    if (options.grepReadError) {
      writeFileSync(join(binDir, "grep"), "#!/bin/sh\necho 'grep: read error' >&2\nexit 2\n");
      chmodSync(join(binDir, "grep"), 0o755);
    }

    const result = spawnSync("bash", [
      script,
      "--repo",
      "owner/repo",
      "--once",
      "--count",
      String(options.count ?? 1),
      ...(options.args ?? []),
      ...(options.envFile ? ["--env-file", envFile] : []),
    ], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: path,
        RUNNER_TEST_LOG: logPath,
        GH_TOKEN_EXIT_CODE: String(options.ghTokenExitCode ?? 0),
        DOCKER_EXIT_CODE: String(options.dockerExitCode ?? 42),
        DOCKER_FAIL_SLOT: String(options.failedSlot ?? ""),
      },
    });
    expect(result.error).toBeUndefined();
    // a launcher that refused its arguments ran no gh or docker command, so wrote no log
    return { result, calls: existsSync(logPath) ? readFileSync(logPath, "utf8") : "", envFile };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** A runner container: it reads its registration token on stdin. */
const runnerRun = /^docker run --rm -i /;

describe.skipIf(process.platform === "win32")("self-hosted runner launcher", () => {
  it("runs without CPU or memory quotas by default", () => {
    const { result, calls } = runRunner();
    expect(result.status).toBe(0);
    const dockerRun = calls.split("\n").find((call) => runnerRun.test(call));
    expect(dockerRun).toBeDefined();
    expect(dockerRun).not.toContain("--cpus");
    expect(dockerRun).not.toContain("--memory");
    expect(dockerRun).toContain("--shm-size 2g");
  });

  it("hands a host env file to every runner container, never to the network namespace one", () => {
    const { result, calls, envFile } = runRunner({ count: 2, envFile: "present" });
    expect(result.status).toBe(0);
    const lines = calls.split("\n");
    const runners = lines.filter((call) => runnerRun.test(call));
    expect(runners).toHaveLength(2);
    // before the image: after it, docker would take it as the container's command
    for (const call of runners) expect(call).toContain(`--env-file ${envFile} herdr-ci-runner:local`);
    expect(lines.filter((call) => call.startsWith("docker run -d ")).every((call) => !call.includes("--env-file"))).toBe(true);
    expect(runRunner().calls).not.toContain("--env-file");
  });

  it("refuses a host env file it cannot read before starting anything", () => {
    const { result, calls } = runRunner({ envFile: "missing" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--env-file");
    expect(calls).not.toContain("docker run");
  });

  it("refuses a host env file line that would copy the launcher's own environment into the jobs", () => {
    const { result, calls } = runRunner({ envFile: "bare" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refused line(s): 2\n");
    expect(calls).not.toContain("docker run");
  });

  it("names a refused line by its number only, never its value", () => {
    const { result, calls } = runRunner({ envFile: "secret" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refused line(s): 3\n");
    expect(result.stderr).not.toContain("ghp_synthetic_secret");
    expect(result.stderr).not.toContain("GH_TOKEN");
    expect(calls).not.toContain("docker run");
  });

  it("refuses a NUL byte in the host env file and names its line", () => {
    const { result, calls } = runRunner({ envFile: "nul" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("refused line(s): 2\n");
    expect(calls).not.toContain("docker run");
  });

  it("checks a host env file named - as that file, never the launcher's stdin", () => {
    const cwd = mkdtempSync(join(tmpdir(), "herdr-runner-dash-"));
    try {
      writeFileSync(join(cwd, "-"), "GH_TOKEN\n");
      // stubs first on PATH: a launcher that wrongly went on must never reach the real gh or docker
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      for (const tool of ["gh", "docker"]) {
        writeFileSync(join(bin, tool), "#!/bin/sh\nexit 1\n");
        chmodSync(join(bin, tool), 0o755);
      }
      const result = spawnSync("bash", [script, "--repo", "owner/repo", "--once", "--env-file", "-"], {
        cwd, encoding: "utf8", timeout: 10_000, input: "",
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("refused line(s): 1\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to start when it cannot read the host env file to check it", () => {
    const { result, calls } = runRunner({ envFile: "present", grepReadError: true });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not read");
    expect(calls).not.toContain("docker run");
  });

  it("propagates a one-shot Docker failure status", () => {
    const { result } = runRunner({ dockerExitCode: 42, failedSlot: 1 });
    expect(result.status).toBe(42);
  });

  it("returns failure when registration-token retrieval fails", () => {
    const { result, calls } = runRunner({ ghTokenExitCode: 1 });
    expect(result.status).toBe(1);
    expect(calls.split("\n").filter((call) => runnerRun.test(call))).toEqual([]);
  });

  it("starts every runner in one shared network namespace, never the host's, and stops it last", () => {
    const { result, calls } = runRunner({ count: 2 });
    expect(result.status).toBe(0);
    const lines = calls.split("\n");
    const namespace = lines.findIndex((call) => /^docker run -d .*--entrypoint sleep .* infinity$/.test(call));
    expect(namespace).toBeGreaterThanOrEqual(0);
    const name = lines[namespace]!.match(/--name (\S+)/)![1]!;
    expect(name).toMatch(/^herdr-ci-.+-net$/);
    expect(lines[namespace]).toContain("--cap-drop ALL");
    expect(lines[namespace]).not.toContain("--network");
    const runners = lines.map((call, index) => ({ call, index })).filter(({ call }) => runnerRun.test(call));
    expect(runners).toHaveLength(2);
    for (const { call, index } of runners) {
      expect(index).toBeGreaterThan(namespace);
      expect(call).toContain(`--network container:${name}`);
      expect(call).not.toContain("--network host");
    }
    const stopped = lines.findIndex((call) => call.startsWith(`docker stop`) && call.endsWith(` ${name}`));
    expect(stopped).toBeGreaterThan(Math.max(...lines.map((call, index) => (call.startsWith("docker stop") && !call.endsWith(` ${name}`) ? index : -1))));
  });

  it("registers the reserved slots with their own labels and every other slot with --labels", () => {
    const labelsBySlot = (args: string[], count = 3) => {
      const { result, calls } = runRunner({ count, args });
      expect(result.status).toBe(0);
      return Object.fromEntries(calls.split("\n").filter((call) => runnerRun.test(call))
        .map((call) => [call.match(/--name herdr-ci-.+-(\d+) /)![1], call.match(/-e RUNNER_LABELS=(\S+) /)![1]]));
    };
    expect(labelsBySlot([])).toEqual({ 1: "self-hosted-ovis", 2: "self-hosted-ovis", 3: "self-hosted-ovis" });
    expect(labelsBySlot(["--reserved", "2"])).toEqual({ 1: "self-hosted-ovis-main", 2: "self-hosted-ovis-main", 3: "self-hosted-ovis" });
    expect(labelsBySlot(["--reserved", "1", "--reserved-labels", "main-only", "--labels", "pr-only"]))
      .toEqual({ 1: "main-only", 2: "pr-only", 3: "pr-only" });
    expect(labelsBySlot(["--reserved", "2"], 2)).toEqual({ 1: "self-hosted-ovis-main", 2: "self-hosted-ovis-main" });
  });

  it("refuses a --reserved it cannot honour before starting anything", () => {
    // 2^64 wraps to 0 in shell arithmetic
    for (const reserved of ["x", "-1", "1.5", "4", "18446744073709551616"]) {
      const { result, calls } = runRunner({ count: 3, args: ["--reserved", reserved] });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--reserved");
      expect(calls).toBe("");
    }
  });

  it("propagates a failed slot's status when multiple one-shot slots run", () => {
    for (const failedSlot of [1, 2]) {
      const { result } = runRunner({ count: 2, dockerExitCode: 42, failedSlot });
      expect(result.status).toBe(42);
    }
  });
});

// the runner image is Linux, and the hook finds the worker through /proc
describe.skipIf(process.platform !== "linux")("self-hosted runner job-started hook", () => {
  it("runs a job from this repository", () => {
    for (const [event, payload] of [
      ["push", { ref: "refs/heads/main" }],
      ["pull_request", { pull_request: { head: { repo: { full_name: "devswha/ovis" } } } }],
      ["workflow_run", { workflow_run: { head_repository: { full_name: "devswha/ovis" } } }],
    ] as const) {
      const result = runJobStarted(event, payload);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("next step ran");
    }
  });

  it("refuses a job carrying another repository's code before it runs", () => {
    for (const [event, payload] of [
      ["pull_request", { pull_request: { head: { repo: { full_name: "someone/ovis" } } } }],
      ["pull_request_target", { pull_request: { head: { repo: { full_name: "someone/ovis" } } } }],
      ["pull_request", { pull_request: { head: { repo: null } } }],
      ["workflow_run", { workflow_run: { head_repository: { full_name: "someone/ovis" } } }],
    ] as const) {
      const result = runJobStarted(event, payload);
      // a failing hook alone would let `if: always()` steps run: the worker itself is killed
      expect(result.signal).toBe("SIGKILL");
      expect(result.stdout).toContain("::error::");
      expect(result.stdout).not.toContain("next step ran");
    }
  });

  it("refuses a job it cannot check: fails closed on an unreadable or broken event", () => {
    const forkless = { ref: "refs/heads/main" };
    for (const event of [
      { path: "missing" },
      { path: "directory" },
      { path: "unset" },
      { raw: '{"pull_request": {"head":' },
      { raw: "not json" },
      { raw: '{"pull_request": "someone/ovis"}' },
      { repository: "unset" },
      { path: "missing", closedOutput: true },
      // the shell's own `${VAR:?}` message on a closed stderr
      { path: "unset", closedOutput: true },
      { repository: "unset", closedOutput: true },
    ] as const) {
      const result = runJobStarted("push", forkless, event);
      expect(result.signal).toBe("SIGKILL");
      // a closed output takes the refusal with it: the kill alone is the evidence there
      if (!("closedOutput" in event)) expect(result.stdout).toContain("::error::");
      expect(result.stdout).not.toContain("next step ran");
    }
  });
});
