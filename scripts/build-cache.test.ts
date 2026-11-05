import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitBuild, cacheKey, deliver, evict, mayWrite, refreshLock, releaseLock, restore, store, takeLock } from "./build-cache.ts";

const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); made.push(dir); return dir; };

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (root: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd: root, env: { ...process.env, ...identity }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

/** A committed checkout of its own, with dist/ and node_modules/ ignored as in the repository. */
function checkout(): string {
  const root = temp("ovis-build-cache-repo-");
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "dist/\nnode_modules/\n.env\n*.log\n");
  writeFileSync(join(root, "main.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  return root;
}

const keyOf = (root: string, env: Record<string, string | undefined> = {}, args: string[] = []): string => {
  const result = cacheKey(root, env, args);
  if (!("key" in result)) throw new Error(`expected a key, got bypass: ${result.bypass}`);
  return result.key;
};

describe("cacheKey", () => {
  it("names the same inputs the same way, whatever variables the build does not read", () => {
    const root = checkout();
    expect(keyOf(root, { PATH: "/a", HOME: "/x" })).toBe(keyOf(root, { PATH: "/b" }));
  });

  it("misses after any change to a build input", () => {
    const root = checkout();
    const base = keyOf(root);
    const keys = new Set([base]);
    const changed = (key: string): void => { expect(keys.has(key)).toBe(false); keys.add(key); };
    changed(keyOf(root, { VITE_FLAG: "1" }));
    changed(keyOf(root, { HERDR_TEST_HOOKS: "1" }));
    changed(keyOf(root, { NODE_ENV: "development" }));
    changed(keyOf(root, {}, ["--mode", "shell"]));
    writeFileSync(join(root, ".env"), "VITE_A=1\n");
    changed(keyOf(root));
    writeFileSync(join(root, ".env"), "VITE_A=2\n");
    changed(keyOf(root));
    rmSync(join(root, ".env"));
    expect(keyOf(root)).toBe(base);
    // a commit that changes a source file, and one that changes the lockfile
    writeFileSync(join(root, "main.ts"), "export const a = 2;\n");
    git(root, "commit", "-q", "-am", "two");
    changed(keyOf(root));
    writeFileSync(join(root, "bun.lock"), "{}\n");
    git(root, "add", "bun.lock");
    git(root, "commit", "-q", "-m", "lock");
    changed(keyOf(root));
    // same tree, new commit: the client embeds the commit's hash, so it is another build
    git(root, "commit", "-q", "--allow-empty", "-m", "empty");
    changed(keyOf(root));
  });

  it("never uses the cache for a checkout git has uncommitted changes in", () => {
    const root = checkout();
    writeFileSync(join(root, "main.ts"), "export const a = 3;\n");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "the checkout has uncommitted changes" });
    git(root, "checkout", "-q", "--", "main.ts");
    writeFileSync(join(root, "new.ts"), "export {};\n");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "the checkout has uncommitted changes" });
    rmSync(join(root, "new.ts"));
    git(root, "add", "-A");
    expect("key" in cacheKey(root, {}, [])).toBe(true);
  });

  it("is used in GitHub Actions only by pull request runs and pushes to main", () => {
    const root = checkout();
    expect("key" in cacheKey(root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" }, [])).toBe(true);
    expect("key" in cacheKey(root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }, [])).toBe(true);
    for (const [event, ref] of [["push", "refs/tags/v1.0.0"], ["push", "refs/heads/other"], ["workflow_dispatch", "refs/heads/main"], ["pull_request_target", ""], [undefined, ""]] as const) {
      expect(cacheKey(root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: event, GITHUB_REF: ref }, [])).toEqual({ bypass: "only pull request runs and pushes to main use it" });
    }
  });

  it("never uses the cache when a .env file refers to other variables", () => {
    const root = checkout();
    writeFileSync(join(root, ".env"), "VITE_A=$HOME\n");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: ".env refers to other variables" });
  });

  it("never uses the cache while ignored files sit where the build reads them", () => {
    const root = checkout();
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public/extra.log"), "copied into dist/ by Vite");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "ignored files where the build reads" });
    rmSync(join(root, "public/extra.log"));
    writeFileSync(join(root, "top.log"), "not read by the build");
    expect("key" in cacheKey(root, {}, [])).toBe(true);
    // what typecheck emits for shared/vendor/paseo-e2ee, which Vite never bundles; elsewhere a .d.ts still counts
    mkdirSync(join(root, "public/dist"), { recursive: true });
    writeFileSync(join(root, "public/dist/x.d.ts"), "");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "ignored files where the build reads" });
    rmSync(join(root, "public/dist"), { recursive: true });
    mkdirSync(join(root, "shared/vendor/x/dist"), { recursive: true });
    writeFileSync(join(root, "shared/vendor/x/a.ts"), "export {};\n");
    git(root, "add", "-f", "shared/vendor/x/a.ts");
    git(root, "commit", "-q", "-m", "vendor");
    for (const name of ["a.d.ts", "a.d.ts.map", "tsconfig.tsbuildinfo"]) writeFileSync(join(root, "shared/vendor/x/dist", name), "");
    expect("key" in cacheKey(root, {}, [])).toBe(true);
    writeFileSync(join(root, "shared/vendor/x/dist/a.js"), "");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "ignored files where the build reads" });
  });

  it("never uses the cache while the commit tracks a link where the build reads", () => {
    const root = checkout();
    mkdirSync(join(root, "src"));
    symlinkSync("/etc/hostname", join(root, "src/link"));
    git(root, "add", "src/link");
    git(root, "commit", "-q", "-m", "link");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "a tracked link where the build reads" });
  });

  it("does not use the cache outside a git checkout", () => {
    expect(cacheKey(temp("ovis-build-cache-nogit-"), {}, [])).toEqual({ bypass: "no git commit" });
  });
});

describe("store and restore", () => {
  const dist = (root: string, files: Record<string, string>): string => {
    const dir = join(root, "dist");
    rmSync(dir, { recursive: true, force: true });
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  };
  const files = (dir: string): Record<string, string> => Object.fromEntries(
    (readdirSync(dir, { recursive: true }) as string[]).sort()
      .filter((name) => !name.endsWith("assets"))
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );

  it("restores exactly the stored files, replacing whatever dist/ held", () => {
    const root = temp("ovis-build-cache-dist-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "<p>", "assets/a.js": "a" }), 1 << 30);
    dist(root, { "stale.js": "old" });
    expect(restore(cache, "k", join(root, "dist"))).toBe(true);
    expect(files(join(root, "dist"))).toEqual({ "assets/a.js": "a", "index.html": "<p>" });
  });

  it("misses an entry that is absent or was never finished", () => {
    const root = temp("ovis-build-cache-miss-");
    const cache = join(root, "cache");
    mkdirSync(join(cache, "half"), { recursive: true });
    writeFileSync(join(cache, "half", "index.html"), "partial");
    dist(root, { "index.html": "mine" });
    expect(restore(cache, "absent", join(root, "dist"))).toBe(false);
    expect(restore(cache, "half", join(root, "dist"))).toBe(false);
    expect(files(join(root, "dist"))).toEqual({ "index.html": "mine" });
  });

  it("refuses an entry whose files do not match its manifest: missing, changed or added", () => {
    const root = temp("ovis-build-cache-short-");
    const cache = join(root, "cache");
    const damage: ((entry: string) => void)[] = [
      (entry) => rmSync(join(entry, "assets"), { recursive: true }),
      (entry) => writeFileSync(join(entry, "index.html"), "<p>planted"),
      (entry) => writeFileSync(join(entry, "extra.js"), "planted"),
    ];
    for (const change of damage) {
      rmSync(cache, { recursive: true, force: true });
      store(cache, "k", dist(root, { "index.html": "<p>", "assets/a.js": "a" }), 1 << 30);
      change(join(cache, "k"));
      dist(root, { "index.html": "mine" });
      expect(() => restore(cache, "k", join(root, "dist"))).toThrow("the entry's files do not match its manifest");
      expect(files(join(root, "dist"))).toEqual({ "index.html": "mine" });
    }
    expect(readdirSync(join(root, "node_modules/.cache"))).toEqual([]);
  });

  it("restores dist/ readable by others, as a fresh build leaves it", () => {
    const root = temp("ovis-build-cache-mode-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "<p>" }), 1 << 30);
    rmSync(join(root, "dist"), { recursive: true });
    expect(restore(cache, "k", join(root, "dist"))).toBe(true);
    expect(statSync(join(root, "dist")).mode & 0o777).toBe(0o755);
  });

  it("refuses an entry holding a link, even one its manifest names", () => {
    const root = temp("ovis-build-cache-link-");
    const cache = join(root, "cache");
    writeFileSync(join(root, "secret"), "token");
    const sum = new Bun.CryptoHasher("sha256").update("token").digest("hex");
    mkdirSync(join(cache, "k"), { recursive: true });
    symlinkSync(join(root, "secret"), join(cache, "k", "leak"));
    writeFileSync(join(cache, "k", ".manifest"), `${sum}  ./leak\n`);
    expect(() => restore(cache, "k", join(root, "dist"))).toThrow("./leak is not a file or a directory");
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  it("hands a build to the outbox without touching the cache", () => {
    const root = temp("ovis-build-cache-outbox-");
    const outbox = join(root, "outbox");
    mkdirSync(outbox);
    deliver(outbox, "k", dist(root, { "index.html": "<p>", "assets/a.js": "a" }), "123", "2");
    expect(readdirSync(outbox).sort()).toEqual(["k.claim", "k.tar"]);
    expect(readFileSync(join(outbox, "k.claim"), "utf8")).toBe("123 2\n");
    const listed = spawnSync("tar", ["-tf", join(outbox, "k.tar")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
    expect(listed).toEqual(["./", "./assets/", "./assets/a.js", "./index.html"]);
  });

  it("stores no build that holds a file named like the manifest", () => {
    const root = temp("ovis-build-cache-own-manifest-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "<p>", ".manifest": "the app's own" }), 1 << 30);
    expect(existsSync(join(cache, "k"))).toBe(false);
    expect(restore(cache, "k", join(root, "dist"))).toBe(false);
  });

  it("keeps the first entry written for a key", () => {
    const root = temp("ovis-build-cache-first-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "first" }), 1 << 30);
    store(cache, "k", dist(root, { "index.html": "second" }), 1 << 30);
    restore(cache, "k", join(root, "dist"));
    expect(files(join(root, "dist"))).toEqual({ "index.html": "first" });
    expect(readdirSync(cache).sort()).toEqual(["k"]);
  });

  it("evicts the least recently used entries past the size limit", () => {
    const root = temp("ovis-build-cache-lru-");
    const cache = join(root, "cache");
    for (const key of ["old", "mid", "new"]) store(cache, key, dist(root, { "a.js": "x".repeat(1000) }), 1 << 30);
    const at = (key: string, seconds: number): void => { const t = new Date(seconds * 1000); utimesSync(join(cache, key), t, t); };
    at("old", 1_000); at("mid", 2_000); at("new", 3_000);
    // a restore counts as a use: "old" becomes the newest
    restore(cache, "old", join(root, "dist"));
    evict(cache, 2_500);
    expect(readdirSync(cache).sort()).toEqual(["new", "old"]);
  });
});

describe("mayWrite", () => {
  const event = (pull: unknown): string => {
    const path = join(temp("ovis-build-cache-event-"), "event.json");
    writeFileSync(path, JSON.stringify({ pull_request: pull }));
    return path;
  };
  const actions = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "owner/repo" };
  const pr = (author: string, actor: string, head = "owner/repo") => ({ ...actions, GITHUB_EVENT_NAME: "pull_request", GITHUB_TRIGGERING_ACTOR: actor, GITHUB_EVENT_PATH: event({ user: { login: author }, head: { repo: { full_name: head } } }) });

  it("expects a build to be taken in only from a run the launcher trusts", () => {
    expect(mayWrite({}, undefined)).toBe(true);
    expect(mayWrite({ ...actions, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }, undefined)).toBe(true);
    expect(mayWrite({ ...actions, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/other" }, "w")).toBe(false);
    expect(mayWrite(pr("w", "w"), "w")).toBe(true);
    expect(mayWrite(pr("w", "w"), undefined)).toBe(false);
    expect(mayWrite(pr("other", "w"), "w")).toBe(false);
    expect(mayWrite(pr("w", "other"), "w")).toBe(false);
    expect(mayWrite(pr("w", "w", "fork/repo"), "w")).toBe(false);
    expect(mayWrite({ ...pr("w", "w"), GITHUB_EVENT_PATH: "/nonexistent" }, "w")).toBe(false);
  });
});

describe("one build per key", () => {
  it("releases a lock without failing, even one another job put something unremovable in", () => {
    const dir = temp("ovis-build-cache-release-");
    const token = takeLock(dir, "k")!;
    mkdirSync(join(dir, ".lock-k", "sub"));
    writeFileSync(join(dir, ".lock-k", "sub", "f"), "");
    chmodSync(join(dir, ".lock-k", "sub"), 0o000);
    try {
      expect(() => releaseLock(dir, "k", token)).not.toThrow();
    } finally {
      chmodSync(join(dir, ".lock-k", "sub"), 0o755);
    }
  });

  it("stops waiting on a lock left stale by a job that died", async () => {
    const dir = temp("ovis-build-cache-stale-");
    takeLock(dir, "k");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".lock-k"), old, old);
    const started = Date.now();
    await awaitBuild(dir, "k", 30_000, { lock: join(dir, ".lock-k"), staleMs: 30_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(takeLock(dir, "k", 30_000)).toBeTruthy();
  });

  it("releases or refreshes only the lock it holds, never one another job took over", () => {
    const dir = temp("ovis-build-cache-owner-");
    const first = takeLock(dir, "k");
    expect(first).toBeTruthy();
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".lock-k"), old, old);
    const second = takeLock(dir, "k", 30_000);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    releaseLock(dir, "k", first as string);
    expect(existsSync(join(dir, ".lock-k"))).toBe(true);
    utimesSync(join(dir, ".lock-k"), old, old);
    refreshLock(dir, "k", first as string);
    expect(statSync(join(dir, ".lock-k")).mtimeMs).toBeLessThan(Date.now() - 30_000);
    refreshLock(dir, "k", second as string);
    expect(statSync(join(dir, ".lock-k")).mtimeMs).toBeGreaterThan(Date.now() - 30_000);
    releaseLock(dir, "k", second as string);
    expect(existsSync(join(dir, ".lock-k"))).toBe(false);
  });

  it("tells a lock it could not make from one another job holds", () => {
    const dir = temp("ovis-build-cache-lockerr-");
    writeFileSync(join(dir, "not-a-directory"), "");
    expect(() => takeLock(join(dir, "not-a-directory"), "k")).toThrow();
  });

  it("lets one job take a key's build, and another once it is released or left stale", () => {
    const cache = temp("ovis-build-cache-lock-");
    const token = takeLock(cache, "k");
    expect(token).toBeTruthy();
    expect(takeLock(cache, "k")).toBeNull();
    expect(takeLock(cache, "other")).toBeTruthy();
    releaseLock(cache, "k", token!);
    expect(takeLock(cache, "k")).toBeTruthy();
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(cache, ".lock-k"), old, old);
    expect(takeLock(cache, "k", 30_000)).toBeTruthy();
  });

  it("waits for the job building a key until its entry is stored", async () => {
    const root = temp("ovis-build-cache-wait-");
    const cache = join(root, "cache");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.html"), "built");
    mkdirSync(cache);
    takeLock(cache, "k");
    const waited = awaitBuild(cache, "k", 30_000, { lock: join(cache, ".lock-k") }).then(() => existsSync(join(cache, "k")));
    store(cache, "k", join(root, "dist"), 1 << 30);
    expect(await waited).toBe(true);
  });

  it("stops waiting once the building job gives up, or at its deadline", async () => {
    const cache = temp("ovis-build-cache-giveup-");
    const token = takeLock(cache, "k")!;
    const waited = awaitBuild(cache, "k", 30_000, { lock: join(cache, ".lock-k") });
    releaseLock(cache, "k", token);
    await waited;
    takeLock(cache, "k");
    const started = Date.now();
    await awaitBuild(cache, "k", 300, { lock: join(cache, ".lock-k") });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("bun scripts/build-cache.ts", () => {
  const script = join(import.meta.dir, "build-cache.ts");

  /** A checkout whose `vite` writes dist/ from main.ts and counts its runs. */
  function project(): { root: string; runs: () => number } {
    const root = checkout();
    const bin = join(root, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "vite"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync("node_modules/runs", "x");
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist");
fs.writeFileSync("dist/index.html", fs.readFileSync("main.ts", "utf8") + (process.env.VITE_FLAG ?? ""));
if (process.env.EDIT_DURING_BUILD) fs.writeFileSync("main.ts", process.env.EDIT_DURING_BUILD);
`);
    chmodSync(join(bin, "vite"), 0o755);
    return { root, runs: () => existsSync(join(root, "node_modules/runs")) ? readFileSync(join(root, "node_modules/runs"), "utf8").length : 0 };
  }
  const buildEnv = (cache: string | null, extra: Record<string, string> = {}): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = { ...process.env };
    // the run's own GitHub Actions variables would turn the cache off outside a pull request run
    // and a runner's own cache (its outbox, locks and writer) would take the fixture's builds
    for (const name of Object.keys(env)) if (name.startsWith("OVIS_BUILD_CACHE_") || name === "GITHUB_ACTIONS" || name === "GITHUB_EVENT_NAME") delete env[name];
    Object.assign(env, extra);
    if (cache) env["OVIS_BUILD_CACHE_DIR"] = cache;
    return env;
  };
  /** The key the build in `root` computes with `buildEnv(null)`'s variables (none of the extra ones above touch it). */
  const keyFor = (root: string): string => (cacheKey(root, buildEnv(null), []) as { key: string }).key;
  const build = (root: string, cache: string | null, extra: Record<string, string> = {}): string => {
    const result = spawnSync(process.execPath, [script], { cwd: root, env: buildEnv(cache, extra), encoding: "utf8" });
    expect(result.status).toBe(0);
    return readFileSync(join(root, "dist/index.html"), "utf8");
  };

  it("builds once per set of inputs and restores the same dist/ for the rest", () => {
    const { root, runs } = project();
    const cache = join(temp("ovis-build-cache-dir-"), "cache");
    expect(build(root, cache)).toBe("export const a = 1;\n");
    expect(runs()).toBe(1);
    rmSync(join(root, "dist"), { recursive: true });
    expect(build(root, cache)).toBe("export const a = 1;\n");
    expect(runs()).toBe(1);
    expect(build(root, cache, { VITE_FLAG: "!" })).toBe("export const a = 1;\n!");
    expect(runs()).toBe(2);
    writeFileSync(join(root, "main.ts"), "export const a = 2;\n");
    expect(build(root, cache)).toBe("export const a = 2;\n");
    expect(runs()).toBe(3);
    git(root, "commit", "-q", "-am", "two");
    expect(build(root, cache)).toBe("export const a = 2;\n");
    expect(runs()).toBe(4);
    expect(build(root, cache)).toBe("export const a = 2;\n");
    expect(runs()).toBe(4);
  }, 60_000);

  it("stores nothing when the checkout changed while it built", () => {
    const { root, runs } = project();
    const cache = join(temp("ovis-build-cache-dir-"), "cache");
    expect(build(root, cache, { EDIT_DURING_BUILD: "export const a = 9;\n" })).toBe("export const a = 1;\n");
    git(root, "checkout", "-q", "--", "main.ts");
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
    build(root, cache);
    expect(runs()).toBe(2);
  }, 60_000);

  it("builds a commit once when its jobs start together", async () => {
    const { root, runs } = project();
    const cache = join(temp("ovis-build-cache-dir-"), "cache");
    const env = buildEnv(cache);
    const jobs = [0, 1, 2, 3].map(() => {
      const copy = temp("ovis-build-cache-job-");
      git(copy, "clone", "-q", root, ".");
      spawnSync("cp", ["-a", join(root, "node_modules"), copy]);
      return { copy, proc: Bun.spawn([process.execPath, script], { cwd: copy, env, stdout: "pipe", stderr: "pipe" }) };
    });
    for (const { proc } of jobs) expect(await proc.exited).toBe(0);
    const built = jobs.map(({ copy }) => existsSync(join(copy, "node_modules/runs")) ? readFileSync(join(copy, "node_modules/runs"), "utf8").length : 0);
    expect(built.reduce((a, b) => a + b, 0)).toBe(1);
    for (const { copy } of jobs) expect(readFileSync(join(copy, "dist/index.html"), "utf8")).toBe("export const a = 1;\n");
    expect(readdirSync(cache).filter((name) => name.startsWith(".lock-"))).toEqual([]);
    expect(runs()).toBe(0);
  }, 60_000);

  it("on the runner, writes only its own outbox, never the cache", () => {
    const { root, runs } = project();
    const base = temp("ovis-build-cache-runner-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [cache, outbox, locks]) mkdirSync(dir);
    // as the runner mounts it: read-only
    chmodSync(cache, 0o555);
    try {
      expect(build(root, cache, { OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks, OVIS_BUILD_CACHE_PROMOTE_SECONDS: "0", GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" })).toBe("export const a = 1;\n");
    } finally {
      chmodSync(cache, 0o755);
    }
    expect(runs()).toBe(1);
    expect(readdirSync(cache)).toEqual([]);
    expect(readdirSync(outbox).map((name) => name.replace(/^[0-9a-f]{64}/, "<key>")).sort()).toEqual(["<key>.claim", "<key>.tar"]);
    expect(readdirSync(locks)).toEqual([]);
  }, 60_000);

  it("records a restore only in its own outbox, never through a link another job planted in the shared locks", () => {
    const { root } = project();
    const base = temp("ovis-build-cache-planted-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [outbox, locks]) mkdirSync(dir);
    // an entry for this checkout, as the launcher would have taken it in
    const key = keyFor(root);
    const built = join(base, "built");
    mkdirSync(built);
    writeFileSync(join(built, "index.html"), "export const a = 1;\n");
    store(cache, key, built, 1 << 30);
    const victim = join(base, "victim.ts");
    writeFileSync(victim, "process.exit(1);\n");
    symlinkSync(victim, join(locks, `used-${key}`));
    expect(build(root, cache, { OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks })).toBe("export const a = 1;\n");
    expect(readFileSync(victim, "utf8")).toBe("process.exit(1);\n");
    expect(readdirSync(outbox)).toEqual([`used-${key}`]);
  }, 60_000);

  it("builds at once, waiting for no other job, in a run whose build would not be taken in", async () => {
    const { root, runs } = project();
    const base = temp("ovis-build-cache-untrusted-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [cache, outbox, locks]) mkdirSync(dir);
    const key = keyFor(root);
    // another job of the run holds the lock
    mkdirSync(join(locks, `.lock-${key}`));
    const started = Date.now();
    expect(build(root, cache, { OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks, OVIS_BUILD_CACHE_WRITER: "w", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_TRIGGERING_ACTOR: "other" })).toBe("export const a = 1;\n");
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(runs()).toBe(1);
    expect(readdirSync(outbox)).toEqual([]);
  }, 60_000);

  it("stops waiting as soon as the launcher has judged its build, taken in or not", async () => {
    const { root } = project();
    const base = temp("ovis-build-cache-refused-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [cache, outbox, locks]) mkdirSync(dir);
    const env = buildEnv(cache, { OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks, OVIS_BUILD_CACHE_PROMOTE_SECONDS: "120", GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" });
    const job = Bun.spawn([process.execPath, script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const claimed = (): string | undefined => readdirSync(outbox).find((name) => name.endsWith(".claim"));
    const deadline = Date.now() + 30_000;
    while (!claimed() && Date.now() < deadline) await Bun.sleep(25);
    // the launcher refuses it: it deletes the claim and the build, then gives its verdict
    const key = claimed()!.slice(0, -".claim".length);
    for (const name of readdirSync(outbox)) rmSync(join(outbox, name));
    mkdirSync(join(outbox, `judged-${key}`));
    const refusedAt = Date.now();
    expect(await job.exited).toBe(0);
    expect(Date.now() - refusedAt).toBeLessThan(10_000);
    expect(await new Response(job.stdout).text()).toContain("was not taken in");
    expect(readdirSync(locks)).toEqual([]);
  }, 60_000);

  it("builds a commit once on the runner when its jobs start together, however slowly GitHub answers the launcher", async () => {
    const { root, runs } = project();
    const base = temp("ovis-build-cache-promoted-");
    const [entries, outboxes, locks, bin] = ["entries", "outboxes", "locks", "bin"].map((name) => join(base, name));
    const slots = ["s1", "s2", "s3", "s4"];
    for (const dir of [entries, locks, bin, ...slots.map((slot) => join(outboxes, slot))]) mkdirSync(dir, { recursive: true });
    // a trusted push to main, each answer half a second late
    writeFileSync(join(base, "jobs.json"), JSON.stringify({ jobs: slots.map((slot) => ({ runner_name: slot, status: "in_progress" })) }));
    writeFileSync(join(base, "run.json"), JSON.stringify({ event: "push", head_branch: "main", head_repository: { full_name: "owner/repo" } }));
    writeFileSync(join(bin, "gh"), `#!/bin/sh
sleep 0.5
case "$2" in
  */jobs*) cat "${base}/jobs.json" ;;
  repos/owner/repo/actions/runs/7) cat "${base}/run.json" ;;
  repos/owner/repo) echo main ;;
  *) exit 1 ;;
esac
`);
    chmodSync(join(bin, "gh"), 0o755);
    const promoter = join(import.meta.dir, "self-hosted-runner/build-cache-promote.sh");
    const jobs = slots.map((slot) => {
      const copy = temp("ovis-build-cache-job-");
      git(copy, "clone", "-q", root, ".");
      spawnSync("cp", ["-a", join(root, "node_modules"), copy]);
      const env = buildEnv(entries, { OVIS_BUILD_CACHE_OUTBOX: join(outboxes, slot), OVIS_BUILD_CACHE_LOCKS: locks, OVIS_BUILD_CACHE_PROMOTE_SECONDS: "30", GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" });
      return { copy, proc: Bun.spawn([process.execPath, script], { cwd: copy, env, stdout: "pipe", stderr: "pipe" }) };
    });
    let ended = false;
    void Promise.all(jobs.map(({ proc }) => proc.exited)).then(() => { ended = true; });
    // the launcher's loop: one pass after another until the jobs end
    const deadline = Date.now() + 50_000;
    while (!ended && Date.now() < deadline) {
      spawnSync("bash", [promoter, "owner/repo", base, outboxes, "", "2048", ...slots], { env: { ...process.env, PATH: [bin, process.env.PATH].join(":") } });
      await Bun.sleep(50);
    }
    for (const { proc } of jobs) expect(await proc.exited).toBe(0);
    const built = jobs.map(({ copy }) => existsSync(join(copy, "node_modules/runs")) ? readFileSync(join(copy, "node_modules/runs"), "utf8").length : 0);
    expect(built.reduce((a, b) => a + b, 0)).toBe(1);
    for (const { copy } of jobs) expect(readFileSync(join(copy, "dist/index.html"), "utf8")).toBe("export const a = 1;\n");
    expect(readdirSync(entries).filter((name) => !name.startsWith("."))).toHaveLength(1);
    expect(runs()).toBe(0);
  }, 60_000);

  it("always builds without OVIS_BUILD_CACHE_DIR", () => {
    const { root, runs } = project();
    build(root, null);
    build(root, null);
    expect(runs()).toBe(2);
  }, 60_000);
});
