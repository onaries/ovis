import { describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  /** XDG_CACHE_HOME for the launcher, kept after the run; a fresh one inside the run's temp dir otherwise */
  cacheHome?: string;
  gitFetchExitCode?: number;
  /** exit status of the container that builds the Bun cache */
  cacheBuildExitCode?: number;
  /** "fetch" makes the mirror's git fetch, "ls-remote" its default-branch query, "build" the Bun cache build, wait until killed; each writes a byte to the FIFO <tempDir>/hung first */
  hang?: "fetch" | "ls-remote" | "build";
  /** the hung stub ignores SIGTERM, as a git or docker client that will not stop; "helper": the git stub
   * stops, but leaves a child (a transport helper) that ignores it */
  stubborn?: boolean | "helper";
  repo?: string;
  /** what GitHub names as the default branch: a branch, "" for no answer, or "fail" for a failed ls-remote */
  defaultBranch?: string;
  /** branches the mirror holds; main's commit and lock are commitSha and lockBlob, any other branch's otherCommit and otherLock */
  branches?: string[];
} = {}) {
  const { tempDir, args, env, logPath, envFile } = prepareRunner(options);
  try {
    const result = spawnSync("bash", args, { encoding: "utf8", timeout: 10_000, env });
    expect(result.error).toBeUndefined();
    // a launcher that refused its arguments ran no gh or docker command, so wrote no log
    return { result, calls: existsSync(logPath) ? readFileSync(logPath, "utf8") : "", envFile };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

type RunnerOptions = NonNullable<Parameters<typeof runRunner>[0]>;

/**
 * How long a launcher may take to reach its stub's hang, or to end after it, on a loaded host. A
 * bound, not a wait: each wait ends at its event. The hung stub (120 s) outlasts it, so a launcher
 * that waits for the hang still ends late.
 */
const LOADED_BOUND_MS = 30_000;
/** The longest one runRunnerUntilHung call can take: the hang, the end, and its stderr closing. */
const HUNG_RUN_MS = 3 * LOADED_BOUND_MS;
/** A stop "at once": under the 5 s after which run.sh's timeouts kill what ignored the stop. */
const STOP_AT_ONCE_MS = 4_000;

/** Runs `argv` until it ends, or kills it after `ms`: whether it ended by itself with status 0. */
async function endsWithin(argv: string[], ms: number) {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
  const status = await Promise.race([proc.exited, Bun.sleep(ms).then(() => null)]);
  if (status === null) proc.kill("SIGKILL");
  await proc.exited;
  return status === 0;
}

/**
 * Starts the launcher as runRunner does, waits until its stub hangs (options.hang), then sends it
 * `signal` (none: lets it go on, and lets a runner have its token). Returns how it ended, within
 * `endMs` of the hang.
 */
async function runRunnerUntilHung(options: RunnerOptions & { hang: "fetch" | "ls-remote" | "build" }, signal: NodeJS.Signals | null, endMs = LOADED_BOUND_MS) {
  const { tempDir, args, env, logPath } = prepareRunner(options);
  const child = Bun.spawn(["bash", ...args], { env, stdout: "ignore", stderr: "pipe" });
  // read as it comes: a process left holding stderr must not hold the test past its bound
  const stderrText = new Response(child.stderr).text();
  let release: ReturnType<typeof Bun.spawn> | undefined;
  try {
    // the hanging stub writes a byte to this FIFO as it hangs: reading it blocks until then
    if (!await endsWithin(["head", "-c", "1", env.RUNNER_TEST_HUNG!], LOADED_BOUND_MS)) throw new Error("the stub never hung");
    // the gh stub hands out a token once this FIFO opens: only now, so no runner starts before the hang
    if (!signal) release = Bun.spawn(["sh", "-c", 'echo go > "$0"', env.RUNNER_TEST_TOKEN_GATE!], { stdout: "ignore", stderr: "ignore" });
    if (signal) child.kill(signal);
    const ended = await Promise.race([child.exited, Bun.sleep(endMs).then(() => "still running" as const)]);
    const stuck = spawnSync("pgrep", ["-f", tempDir], { encoding: "utf8" }).stdout.trim();
    return { ended, stderr: await Promise.race([stderrText, Bun.sleep(LOADED_BOUND_MS).then(() => "")]), calls: existsSync(logPath) ? readFileSync(logPath, "utf8") : "", stuck, cacheHome: env.XDG_CACHE_HOME! };
  } finally {
    release?.kill("SIGKILL");
    child.kill("SIGKILL");
    spawnSync("pkill", ["-KILL", "-f", tempDir]);
    await child.exited;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function prepareRunner(options: RunnerOptions) {
  const tempDir = mkdtempSync(join(tmpdir(), "herdr-self-hosted-runner-test-"));
  const binDir = join(tempDir, "bin");
  const logPath = join(tempDir, "commands.log");
  const path = [binDir, process.env.PATH].filter(Boolean).join(delimiter);

  {
    mkdirSync(binDir);
    writeFileSync(join(binDir, "gh"), `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$RUNNER_TEST_LOG"
case " $* " in
  *registration-token*)
    # a refresh set to hang hangs before any runner starts, however soon --cache-wait runs out: the
    # test opens this FIFO once it has seen the hang
    if [ -n "\${RUNNER_TEST_TOKEN_GATE:-}" ]; then read -r go < "$RUNNER_TEST_TOKEN_GATE"; fi
    if [ "\${GH_TOKEN_EXIT_CODE:-0}" -ne 0 ]; then
      exit "$GH_TOKEN_EXIT_CODE"
    fi
    printf '%s\\n' mock-token
    ;;
esac
`);
    // one line per call: the Bun cache build's script spans several
    writeFileSync(join(binDir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$(printf '%s' "$*" | tr '\\n' ' ')" >> "$RUNNER_TEST_LOG"
case "$1" in
  image) exit 0 ;;
  run)
    # the shared network namespace container is detached and reads no token
    [ "$2" = -d ] && exit 0
    shift
    name=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --name ]; then
        name="$2"
        shift 2
      elif [ "$1" = -v ] && [ "\${2%:/cache/bun}" != "$2" ]; then
        touch "\${2%:/cache/bun}/package@1.0.0"
        shift 2
      else
        shift
      fi
    done
    # the Bun cache build (it filled the directory mounted at /cache/bun above) reads no token
    case "$name" in *-cache)
      if [ -n "\${RUNNER_TEST_HANG_BUILD:-}" ]; then
        [ -n "\${RUNNER_TEST_STUBBORN:-}" ] && trap '' TERM
        printf x > "$RUNNER_TEST_HUNG"; exec "$(dirname "$0")/hang-sleep" 120
      fi
      exit "\${DOCKER_CACHE_EXIT:-0}" ;;
    esac
    IFS= read -r token || exit 1
    if [ "\${name##*-}" = "\${DOCKER_FAIL_SLOT:-}" ]; then
      exit "\${DOCKER_EXIT_CODE:-42}"
    fi
    exit 0
    ;;
  *) exit 0 ;;
esac
`);
    // the launcher's git mirror: no network, and HEAD resolves once symbolic-ref has named the branch
    writeFileSync(join(binDir, "git"), `#!/bin/sh
printf 'git %s\\n' "$*" >> "$RUNNER_TEST_LOG"
dir=""
while :; do
  case "$1" in
    -C) dir="$2"; shift 2 ;;
    -c) shift 2 ;;
    *) break ;;
  esac
done
for last; do :; done
case "$1" in
  init) mkdir -p "$last/objects/pack" ;;
  config)
    shift
    [ "$1" = --add ] && shift
    if [ "$#" -ge 2 ]; then printf '%s\\n' "$2" >> "$dir/config.$1"; else head -n 1 "$dir/config.$1" 2>/dev/null; fi ;;
  fetch)
    if [ -n "\${RUNNER_TEST_HANG_FETCH:-}" ]; then
      if [ "\${RUNNER_TEST_STUBBORN:-}" = helper ]; then
        (trap '' TERM; exec "$(dirname "$0")/hang-sleep" 120) &
      elif [ -n "\${RUNNER_TEST_STUBBORN:-}" ]; then
        trap '' TERM
      fi
      printf x > "$RUNNER_TEST_HUNG"; exec "$(dirname "$0")/hang-sleep" 120
    fi
    exit "\${GIT_FETCH_EXIT:-0}" ;;
  ls-remote)
    if [ -n "\${RUNNER_TEST_HANG_LSREMOTE:-}" ]; then
      [ -n "\${RUNNER_TEST_STUBBORN:-}" ] && trap '' TERM
      printf x > "$RUNNER_TEST_HUNG"; exec "$(dirname "$0")/hang-sleep" 120
    fi
    case "$RUNNER_TEST_DEFAULT_BRANCH" in
      fail) exit 128 ;;
      '') ;;
      *) printf 'ref: refs/heads/%s\\tHEAD\\n' "$RUNNER_TEST_DEFAULT_BRANCH" ;;
    esac ;;
  # a new bare repository's HEAD names refs/heads/main (init.defaultBranch), as with real git
  symbolic-ref)
    if [ "$2" = -q ]; then cat "$dir/head" 2>/dev/null || echo refs/heads/main; else printf '%s\\n' "$last" > "$dir/head"; fi ;;
  rev-parse)
    rev="$last"
    case "$rev" in HEAD*) rev="$(cat "$dir/head" 2>/dev/null || echo refs/heads/main)\${rev#HEAD}" ;; esac
    for branch in $RUNNER_TEST_BRANCHES; do
      if [ "$branch" = main ]; then commit=${commitSha} lock=${lockBlob}; else commit=${otherCommit} lock=${otherLock}; fi
      case "$rev" in
        "refs/heads/$branch"|"refs/heads/$branch^{commit}") echo "$commit"; exit 0 ;;
        "refs/heads/$branch:bun.lock") echo "$lock"; exit 0 ;;
      esac
    done
    exit 1 ;;
esac
exit 0
`);
    chmodSync(join(binDir, "gh"), 0o755);
    chmodSync(join(binDir, "docker"), 0o755);
    chmodSync(join(binDir, "git"), 0o755);
    // a sleep named by its path in this run's directory, so a test can find one left running
    copyFileSync(spawnSync("bash", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim(), join(binDir, "hang-sleep"));
    chmodSync(join(binDir, "hang-sleep"), 0o755);
    // FIFOs: the test waits for the hang, and the gh stub for the test, by blocking on them, not polling
    if (options.hang) spawnSync("mkfifo", [join(tempDir, "hung"), join(tempDir, "token-gate")]);
    const envFile = join(tempDir, "host.env");
    if (options.envFile === "present") writeFileSync(envFile, "# P620\n\nCHECK_HOST_MAX_RUNS=6\nCHECK_HOST_BROWSER_WORKERS=10\n");
    if (options.envFile === "bare") writeFileSync(envFile, "CHECK_HOST_MAX_RUNS=6\nGH_TOKEN\n");
    if (options.envFile === "secret") writeFileSync(envFile, "# P620\nCHECK_HOST_MAX_RUNS=6\nGH_TOKEN=ghp_synthetic_secret\n");
    if (options.envFile === "nul") writeFileSync(envFile, "CHECK_HOST_MAX_RUNS=6\nCHECK_HOST_TEST_SHARDS=6\u0000\n");
    if (options.grepReadError) {
      writeFileSync(join(binDir, "grep"), "#!/bin/sh\necho 'grep: read error' >&2\nexit 2\n");
      chmodSync(join(binDir, "grep"), 0o755);
    }

    const args = [
      script,
      "--repo",
      options.repo ?? "owner/repo",
      "--once",
      "--count",
      String(options.count ?? 1),
      ...(options.args ?? []),
      ...(options.envFile ? ["--env-file", envFile] : []),
    ];
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PATH: path,
      RUNNER_TEST_LOG: logPath,
      RUNNER_TEST_HUNG: join(tempDir, "hung"),
      ...(options.hang ? { RUNNER_TEST_TOKEN_GATE: join(tempDir, "token-gate") } : {}),
      ...(options.hang === "fetch" ? { RUNNER_TEST_HANG_FETCH: "1" } : {}),
      ...(options.hang === "build" ? { RUNNER_TEST_HANG_BUILD: "1" } : {}),
      ...(options.hang === "ls-remote" ? { RUNNER_TEST_HANG_LSREMOTE: "1" } : {}),
      ...(options.stubborn ? { RUNNER_TEST_STUBBORN: options.stubborn === "helper" ? "helper" : "1" } : {}),
      RUNNER_TEST_DEFAULT_BRANCH: options.defaultBranch ?? "main",
      RUNNER_TEST_BRANCHES: (options.branches ?? ["main"]).join(" "),
      XDG_CACHE_HOME: options.cacheHome ?? join(tempDir, "cache"),
      GIT_FETCH_EXIT: String(options.gitFetchExitCode ?? 0),
      DOCKER_CACHE_EXIT: String(options.cacheBuildExitCode ?? 0),
      GH_TOKEN_EXIT_CODE: String(options.ghTokenExitCode ?? 0),
      DOCKER_EXIT_CODE: String(options.dockerExitCode ?? 42),
      DOCKER_FAIL_SLOT: String(options.failedSlot ?? ""),
    };
    return { tempDir, args, env, logPath, envFile };
  }
}

/** A runner container: it reads its registration token on stdin. */
const runnerRun = /^docker run --rm -i /;
/** What the git stub reports for the mirror's default branch and its bun.lock. */
const commitSha = "1".repeat(40);
const lockBlob = "2".repeat(40);
const otherCommit = "3".repeat(40);
const otherLock = "4".repeat(40);
const cacheBuild = /^docker run --rm --init --name herdr-ci-.+-cache /;

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

  it.skipIf(process.platform !== "linux")("refreshes the host caches before the first runner and hands them to every runner read-only", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      const { result, calls } = runRunner({ count: 2, cacheHome });
      expect(result.status).toBe(0);
      const lines = calls.split("\n");
      // one directory per repository
      const cacheDir = join(cacheHome, "ovis-ci-runner/owner/repo");
      const mirror = join(cacheDir, "git/repo.git");
      // this repository's branches and tags only, from GitHub
      // set up under another name, then moved into place whole
      const setup = lines.find((call) => call.includes(" config remote.origin.url "))!.match(/^git -C (\S+) /)![1]!;
      expect(setup).toStartWith(join(cacheDir, "git/.new-"));
      expect(lines).toContain(`git -C ${setup} config remote.origin.url https://github.com/owner/repo.git`);
      // a job reads the mirror's objects in place: git never collects one on its own
      for (const setting of ["gc.pruneExpire never", "gc.auto 0", "maintenance.auto false", "fetch.unpackLimit 1"]) expect(lines).toContain(`git -C ${setup} config ${setting}`);
      expect(existsSync(join(mirror, "objects"))).toBe(true);
      expect(existsSync(setup)).toBe(false);
      expect(lines.filter((call) => call.includes("remote.origin.fetch")).map((call) => call.split(" ").at(-1)))
        .toEqual(["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
      // bounded: a stalled transfer gives up instead of holding the refresh
      const fetched = lines.findIndex((call) => call.startsWith(`git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 -C ${mirror} fetch `));
      const runners = lines.map((call, index) => ({ call, index })).filter(({ call }) => runnerRun.test(call));
      expect(runners).toHaveLength(2);
      for (const { call, index } of runners) {
        expect(index).toBeGreaterThan(fetched);
        expect(fetched).toBeGreaterThanOrEqual(0);
        expect(call).toContain(`-v ${cacheDir}:/cache:ro `);
        expect(call).toContain("-e GIT_ALTERNATE_OBJECT_DIRECTORIES=/cache/git/repo.git/objects ");
        expect(call.match(/-v \S+/g)).toEqual([`-v ${cacheDir}:/cache:ro`]);
        expect(call).toContain("--security-opt no-new-privileges --cap-drop ALL --pids-limit 8192 ");
        expect(call).toEndWith(" herdr-ci-runner:local");
      }
      expect(readlinkSync(join(cacheDir, "bun/current"))).toBe(lockBlob);
      expect(readdirSync(join(cacheDir, "bun", lockBlob))).toEqual(["package@1.0.0"]);
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("builds the Bun cache from the default branch's lockfile only, hardened, read-only to it and without package scripts", () => {
    const { result, calls } = runRunner();
    expect(result.status).toBe(0);
    const builds = calls.split("\n").filter((call) => cacheBuild.test(call));
    expect(builds).toHaveLength(1);
    const build = builds[0]!;
    // --init: a PID 1 that passes the deadline's SIGTERM on to the build
    expect(build).toMatch(/^docker run --rm --init --name /);
    expect(build).toContain("--security-opt no-new-privileges --cap-drop ALL --pids-limit 8192 ");
    expect(build).toContain(`-e COMMIT=${commitSha} `);
    expect(build).toMatch(/-v \S+\/git\/repo\.git:\/cache\/git\/repo\.git:ro /);
    expect(build).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(build).not.toContain("--network");
    expect(build).not.toContain("docker.sock");
  });

  it.skipIf(process.platform !== "linux")("mounts no cache and touches no mirror with --no-cache", () => {
    const { result, calls } = runRunner({ args: ["--no-cache"] });
    expect(result.status).toBe(0);
    expect(calls).not.toContain("git ");
    expect(calls).not.toContain("/cache");
    expect(calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
  });

  it.skipIf(process.platform !== "linux")("still starts the runners when a refresh or a build fails, builds nothing after a failed refresh, and retries a failed build only after 30 minutes", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      // a refresh that failed builds nothing: what the mirror holds was not confirmed this time
      const unfetched = runRunner({ cacheHome, gitFetchExitCode: 1 });
      expect(unfetched.result.status).toBe(0);
      expect(unfetched.result.stderr).toContain("[cache] could not refresh the git mirror");
      expect(unfetched.calls.split("\n").filter((call) => cacheBuild.test(call))).toEqual([]);
      expect(unfetched.calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      const first = runRunner({ cacheHome, cacheBuildExitCode: 1 });
      expect(first.result.status).toBe(0);
      expect(first.result.stderr).toContain("[cache] could not build the Bun cache");
      expect(first.calls.split("\n").filter((call) => cacheBuild.test(call))).toHaveLength(1);
      expect(first.calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      const bun = join(cacheHome, "ovis-ci-runner/owner/repo/bun");
      // nothing half-built is left for a runner to read
      expect(readdirSync(bun)).toEqual([`.failed-${lockBlob}`]);
      const again = runRunner({ cacheHome });
      expect(again.result.status).toBe(0);
      expect(again.calls.split("\n").filter((call) => cacheBuild.test(call))).toEqual([]);
      const past = new Date(Date.now() - 31 * 60_000);
      utimesSync(join(bun, `.failed-${lockBlob}`), past, past);
      const later = runRunner({ cacheHome });
      expect(later.calls.split("\n").filter((call) => cacheBuild.test(call))).toHaveLength(1);
      expect(readdirSync(bun).sort()).toEqual([lockBlob, "current"]);
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("waits 30 minutes after a crashed Bun cache build as after any other failure", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      // the OOM killer or the pids limit ends the build with 137, a crash with 139
      for (const status of [137, 139]) {
        rmSync(join(cacheHome, "ovis-ci-runner"), { recursive: true, force: true });
        const { result } = runRunner({ cacheHome, cacheBuildExitCode: status });
        expect(result.status).toBe(0);
        expect(readdirSync(join(cacheHome, "ovis-ci-runner/owner/repo/bun"))).toEqual([`.failed-${lockBlob}`]);
      }
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("starts the runners after --cache-wait when the first refresh hangs, and leaves nothing of it running", async () => {
    for (const hang of ["fetch", "build"] as const) {
      const { ended, stderr, calls, stuck } = await runRunnerUntilHung({ hang, args: ["--cache-wait", "1"] }, null);
      // --once: its one runner ran its job, so the launcher ended, stopping the hung refresh
      expect(ended).toBe(0);
      expect(stderr).toContain("[cache] the caches are not ready after 1s");
      expect(calls).toContain("registration-token");
      expect(calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      expect(stuck).toBe("");
    }
  }, 2 * HUNG_RUN_MS);

  it.skipIf(process.platform !== "linux")("stops at once on SIGTERM during the first refresh, and records no failure for a build it stopped", async () => {
    for (const hang of ["fetch", "build"] as const) {
      const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
      try {
        const { ended, calls, stuck } = await runRunnerUntilHung({ hang, cacheHome }, "SIGTERM", STOP_AT_ONCE_MS);
        expect(ended).toBe(143);
        expect(calls).not.toContain("registration-token");
        expect(stuck).toBe("");
        if (hang === "build") expect(readdirSync(join(cacheHome, "ovis-ci-runner/owner/repo/bun")).filter((name) => name.startsWith(".failed-"))).toEqual([]);
      } finally {
        rmSync(cacheHome, { recursive: true, force: true });
      }
    }
  }, 2 * HUNG_RUN_MS);

  it.skipIf(process.platform !== "linux")("keeps each repository's caches apart, and sets up again a mirror of anything else", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      const first = runRunner({ cacheHome });
      const second = runRunner({ cacheHome, repo: "other/repo" });
      expect(first.result.status).toBe(0);
      expect(second.result.status).toBe(0);
      const mount = (calls: string) => calls.split("\n").find((call) => runnerRun.test(call))!.match(/-v (\S+):\/cache:ro/)![1];
      expect(mount(first.calls)).toBe(join(cacheHome, "ovis-ci-runner/owner/repo"));
      expect(mount(second.calls)).toBe(join(cacheHome, "ovis-ci-runner/other/repo"));
      expect(second.calls).toContain("config remote.origin.url https://github.com/other/repo.git");
      // a mirror whose origin is another repository's is not reused
      const mirror = join(cacheHome, "ovis-ci-runner/owner/repo/git/repo.git");
      writeFileSync(join(mirror, "config.remote.origin.url"), "https://github.com/someone/else.git\n");
      const again = runRunner({ cacheHome });
      expect(again.result.stderr).toContain("does not mirror https://github.com/owner/repo.git");
      expect(readFileSync(join(mirror, "config.remote.origin.url"), "utf8")).toBe("https://github.com/owner/repo.git\n");
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("builds the Bun cache from the branch GitHub names as the default, not the mirror's initial HEAD", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      const { result, calls } = runRunner({ cacheHome, defaultBranch: "stable", branches: ["main", "stable"] });
      expect(result.status).toBe(0);
      expect(calls.split("\n").find((call) => cacheBuild.test(call))).toContain(`-e COMMIT=${otherCommit} `);
      expect(readlinkSync(join(cacheHome, "ovis-ci-runner/owner/repo/bun/current"))).toBe(otherLock);
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("builds no Bun cache when GitHub names no default branch the mirror holds", () => {
    for (const github of [{ defaultBranch: "fail" }, { defaultBranch: "" }, { defaultBranch: "stable", branches: ["main"] }]) {
      const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
      try {
        const { result, calls } = runRunner({ cacheHome, ...github });
        expect(result.status).toBe(0);
        expect(result.stderr).toContain("[cache] could not refresh the git mirror");
        // never the mirror's initial HEAD (main) nor any other branch
        expect(calls.split("\n").filter((call) => cacheBuild.test(call))).toEqual([]);
        expect(existsSync(join(cacheHome, "ovis-ci-runner/owner/repo/bun/current"))).toBe(false);
        expect(calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      } finally {
        rmSync(cacheHome, { recursive: true, force: true });
      }
    }
  });

  it.skipIf(process.platform !== "linux")("outlives no git or Bun cache build that ignores SIGTERM, and removes the build container last", async () => {
    for (const [hang, stubborn] of [["fetch", true], ["fetch", "helper"], ["ls-remote", true], ["build", true]] as const) {
      const { ended, calls, stuck } = await runRunnerUntilHung({ hang, stubborn }, "SIGTERM");
      expect(ended).toBe(143);
      // checked the moment the launcher ended: nothing of the refresh may be left
      expect(stuck).toBe("");
      if (hang === "build") {
        const cacheCalls = calls.split("\n").filter((call) => /^docker \S+ .*herdr-ci-.+-cache\b/.test(call));
        expect(cacheCalls.at(-1)).toMatch(/^docker rm -f herdr-ci-.+-cache$/);
      }
    }
  }, 4 * HUNG_RUN_MS);

  it.skipIf(process.platform !== "linux")("starts the runners without caches when the cache directory or the repository name cannot hold them", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      writeFileSync(join(cacheHome, "ovis-ci-runner"), "not a directory");
      for (const run of [runRunner({ cacheHome }), runRunner({ repo: "owner/../escape" })]) {
        expect(run.result.status).toBe(0);
        expect(run.result.stderr).toContain("[cache]");
        expect(run.calls).not.toContain("/cache:ro");
        expect(run.calls.split("\n").filter((call) => runnerRun.test(call))).toHaveLength(1);
      }
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("keeps a replaced Bun cache for an hour after it was replaced, then removes it", () => {
    const cacheHome = mkdtempSync(join(tmpdir(), "herdr-runner-cache-"));
    try {
      const bun = join(cacheHome, "ovis-ci-runner/owner/repo/bun");
      const hoursAgo = new Date(Date.now() - 2 * 3_600_000);
      for (const version of ["replaced-earlier", "replaced-now"]) {
        mkdirSync(join(bun, version), { recursive: true });
        utimesSync(join(bun, version), hoursAgo, hoursAgo);
      }
      // a symlink as the launcher writes it: the default branch's lockfile was replaced-now's until this run
      spawnSync("ln", ["-s", "replaced-now", join(bun, "current")]);
      const { result } = runRunner({ cacheHome });
      expect(result.status).toBe(0);
      expect(readlinkSync(join(bun, "current"))).toBe(lockBlob);
      expect(readdirSync(bun).sort()).toEqual([lockBlob, "current", "replaced-now"]);
    } finally {
      rmSync(cacheHome, { recursive: true, force: true });
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
