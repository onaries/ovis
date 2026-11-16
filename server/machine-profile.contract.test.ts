import { afterEach, expect, it as test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { unmanagedUpdateStatus } from "../shared/update.ts";
import { createServer } from "./index.ts";
import { herdrRpc, paneRead } from "./herdr/client.ts";
import { harmlessGroups, trustRefusal } from "./herdr-core/discovery.ts";
import { claimServerState, MachineProfileError } from "./machine-profile.ts";
import { guardLibrary } from "./owner-guard.ts";
import { RelayService } from "./relay/service.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";
import { connectUpdater } from "./update-api.ts";
import { updateStateDir } from "./update-state.ts";

/**
 * serve() refuses the machine profile on Windows (its owner's door is a unix socket in a folder only this
 * account may enter): every case here runs a profile or compares a server with one, so all are skipped there,
 * and the one case of `test.if` below checks that refusal instead.
 */
const it = process.platform === "win32" ? test.skip : test;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const root = resolve(import.meta.dir, "..");
const token = "machine-contract-owner";
const headers = { authorization: `Bearer ${token}`, "x-herdr-update": "1", "x-herdr-machine": "1" };
/**
 * Where the state folders of launched servers are made. The profile walks its state folder's path at start
 * and refuses one under a folder another account may write: a TMPDIR the walk refuses (a group-writable
 * folder whose group cannot be shown to be private) leaves these folders in root's sticky /tmp, where every
 * CI runner has them. Nothing else of these tests goes there (`scratch`).
 */
const parent = trustRefusal(realpathSync(tmpdir()), harmlessGroups(), true) === null ? tmpdir() : "/tmp";
function folder(under: string, prefix = "ovis-machine-profile-") {
  const dir = mkdtempSync(join(under, prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
/** A state folder a launched server walks. */
const state = () => folder(parent);
/** A folder nothing walks: a launched server's HOME, an in-process server's state. */
const scratch = () => folder(tmpdir());
/** The local owner's call: on the profile's socket in its state folder, addressed as the command line addresses it. */
function owner(stateDir: string, path: string, init: RequestInit = {}) {
  return fetch(`http://localhost${path}`, { ...init, unix: join(stateDir, "serve.sock") });
}
const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
/** A device paired at the machine's own address before: a row with no relay key, whose cookie is `secret`. */
function cookieRow(stateDir: string, secret: string): string {
  const id = "machine-contract-cookie-row";
  const at = new Date().toISOString();
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: at, devices: [
    { id, label: "a browser at the machine's address", role: "drive", token_hash: createHash("sha256").update(secret).digest("hex"), created_at: at, last_seen_at: null },
  ] }), { mode: 0o600 });
  return id;
}
/** A state folder a profile has taken before: its marker, as the profile writes it. */
function marked(stateDir: string) {
  writeFileSync(join(stateDir, "machine-profile.json"), '{"profile":"machine"}', { mode: 0o600 });
}
/** Every entry under `dir` with its bytes: what a refusal must leave as it was. */
function contents(dir: string) {
  return (readdirSync(dir, { recursive: true }) as string[]).sort().map((name) => {
    const path = join(dir, name);
    const entry = lstatSync(path);
    return [name, entry.isFile() ? readFileSync(path, "base64") : entry.isDirectory() ? "folder" : "other"];
  });
}
/** A herdr at `socket` that answers ping with protocol 22, and counts the connections it gets. */
function fakeHerdr(socket: string) {
  let connections = 0;
  const listener = Bun.listen<{ line: string }>({ unix: socket, socket: {
    open(client) { connections++; client.data = { line: "" }; },
    data(client, chunk) {
      client.data.line += chunk.toString();
      if (!client.data.line.includes("\n")) return;
      const { id } = JSON.parse(client.data.line) as { id: string };
      client.write(`${JSON.stringify({ id, result: { version: "fixture", protocol: 22 } })}\n`);
      client.end();
    },
  } });
  cleanup.push(() => listener.stop(true));
  return { connections: () => connections };
}
/**
 * A folder for XDG_CONFIG_HOME, its herdr folder `<it>/herdr`: a short path, as a unix socket's in it must be, and
 * with no link in it (macOS's temporary folder is reached through one), as the profile requires of a herdr socket.
 */
const herdrConfig = () => realpathSync(folder(parent, "ovis-h-"));
/** The start of a selected socket's refusal, which tools match on; the walk's reason for the owner may follow it. */
const unsafeSocket = expect.stringMatching(/^The selected herdr socket cannot be used safely by this account/);
/**
 * The PATH a launched server gets: the system's folders only (it runs by Bun's full path). A server reads the
 * versions of the agent tools it finds on its PATH, each in a process group of its own that outlives a server
 * a test ends, and those tools would write into the HOME of a server whose folders the test has removed.
 */
const launchPath = "/usr/bin:/bin";
/**
 * `undefined` in `env` leaves that variable out of the server's environment; `umask` is the one the server starts
 * under. HOME is a folder of its own unless `env` names one: Bun writes its cache into HOME before the server
 * runs, and a profile starts only on an empty state folder or one it marked.
 */
function launch(stateDir: string, env: Record<string, string | undefined> = {}, umask?: string) {
  const ready = deferred<string>();
  let output = "";
  let errors = "";
  const merged: Record<string, string | undefined> = { ...process.env, OVIS_PROFILE: "machine", OVIS_PREVIEW: "fleet", OVIS_RUNTIME: "herdr", OVIS_STATE_DIR: stateDir,
    HOME: env["HOME"] ?? scratch(), OVIS_TOKEN: token, PATH: launchPath, PORT: "0", HOST: "127.0.0.1", HERDR_REMOTE_SOCKET: process.env["HERDR_SOCKET"] ?? "",
    OVIS_MANAGED: "0", OVIS_TAILSCALE_SERVE_ONLY: "0", OVIS_RELAY_URL: "wss://relay.invalid", ...env };
  const command = umask === undefined ? [process.execPath, "server/main.ts", "serve"] : ["/bin/sh", "-c", `umask ${umask} && exec "$0" server/main.ts serve`, process.execPath];
  const child = Bun.spawn(command, {
    cwd: root, env: Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const read = async (stream: ReadableStream<Uint8Array>, standardError: boolean) => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      output += text;
      if (standardError) errors += text;
      const match = /Ovis listening on (http:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) ready.resolve(match[1]);
    }
  };
  const drained = Promise.all([read(child.stdout, false), read(child.stderr, true)]);
  const exited = child.exited.then(async (code) => { await drained; ready.reject(new Error(output || `Server exited ${code}`)); return code; });
  // A refused second start is observed through exited, not ready.
  void ready.promise.catch(() => undefined);
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await bounded(exited, 15_000); });
  return { child, ready: ready.promise, exited, output: () => output, errors: () => errors };
}

/** A refusal at the profile's start: exit 1 and one sentence on standard error, no stack or source excerpt. */
async function refused(server: ReturnType<typeof launch>): Promise<string> {
  expect(await bounded(server.exited, 20_000)).toBe(1);
  const sentence = server.errors().trim();
  expect(sentence).not.toContain("\n");
  expect(sentence).toMatch(/^[A-Z].*\.$/);
  return sentence;
}

it("binds the machine profile only to IPv4 loopback despite publishing settings", async () => {
  const dir = state();
  const herdr = join(dir, "bin", "herdr");
  const server = launch(dir, { HOST: "0.0.0.0", OVIS_IPV6_LOOPBACK: "1", OVIS_LAN_HTTPS: "1", OVIS_TAILSCALE_SERVE_ONLY: "1", OVIS_HERDR_BIN: herdr });
  const base = await bounded(server.ready, 20_000);
  expect(new URL(base).hostname).toBe("127.0.0.1");
  expect(server.output()).toContain(`herdr binary: ${herdr} (from OVIS_HERDR_BIN)\n`);
  const response = await owner(dir, "/api/health", { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, machine_profile: { engine: "herdr" } });
  const direct = await owner(dir, "/api/relay/direct", { method: "POST", headers: { ...headers, origin: "http://localhost", "content-type": "application/json" }, body: '{"on":true}' });
  expect(direct.status).toBe(409);
  expect(server.output()).not.toContain("LAN HTTPS on");
});

it.each(["environment", "saved"])("refuses herdr-core selected by %s in its health and runs no hc process", async (source) => {
  const dir = state();
  const bin = scratch();
  const calls = join(bin, "hc-calls");
  const hc = join(bin, "hc");
  writeFileSync(hc, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = --version ]; then echo 'hc 0.1.18'; else exit 1; fi\n`, { mode: 0o700 });
  // a choice saved in a folder the profile took before
  if (source === "saved") { marked(dir); writeFileSync(join(dir, "runtime-0.json"), JSON.stringify({ runtime: "herdr-core", previous: "herdr" })); }
  // the core's own folders are this test's: no core of the user's is ever looked at. Under root's sticky
  // /tmp: a core socket is taken only on a path that no other account can write
  const core = mkdtempSync("/tmp/ovis-machine-core-absent-");
  cleanup.push(() => rmSync(core, { recursive: true, force: true }));
  const server = launch(dir, { OVIS_RUNTIME: source === "environment" ? "herdr-core" : "", OVIS_HC_BIN: hc, HC_SOCKET: join(core, "absent.sock"),
    XDG_RUNTIME_DIR: core, XDG_STATE_HOME: core, XDG_CONFIG_HOME: core });
  await bounded(server.ready, 20_000);
  for (const path of ["/api/health", "/api/health?scope=bridge"]) {
    const response = await owner(dir, path, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, machine_profile: {
      engine: "herdr-core", runtime_down: true, reason: "herdr-core is not supported for a machine yet",
    } });
  }
  // Request-triggered lookups must not construct a core connection either.
  await (await owner(dir, "/api/session", { headers })).text();
  expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
});

it("a second machine start on another port and canonical spelling leaves the first owner answering", async () => {
  const dir = state();
  const alias = `${dir}-alias`;
  symlinkSync(dir, alias, "junction");
  cleanup.push(() => rmSync(alias));
  const first = launch(dir, {});
  await bounded(first.ready, 20_000);
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reservation.port;
  reservation.stop();
  const second = launch(alias, { PORT: String(port) });
  const outcome = await bounded(Promise.race([second.exited.then((code) => ({ code })), second.ready.then(() => ({ code: 0 }), () => second.exited.then((code) => ({ code })))]), 20_000);
  expect(outcome.code).toBe(1);
  expect(await refused(second)).toContain("already owns this Ovis state directory");
  expect((await owner(dir, "/api/health?scope=bridge")).status).toBe(200);
});

it("refuses the machine profile without OVIS_PREVIEW=fleet before its state folder is touched, and starts it with the preview on", async () => {
  const dir = state();
  // a HOME of its own: Bun keeps its transpiler cache there, which is not the server's writing
  expect(await refused(launch(dir, { OVIS_PREVIEW: undefined, HOME: scratch() }))).toContain("OVIS_PREVIEW=fleet");
  expect(readdirSync(dir)).toEqual([]);
  await bounded(launch(dir).ready, 20_000);
  const health = await (await owner(dir, "/api/health")).json() as Record<string, unknown>;
  expect(health["machine_profile"]).toBeDefined();
});

test.if(process.platform === "win32")("refuses the machine profile on Windows before its state folder is touched", async () => {
  // a folder nothing walks: the walk's fallback /tmp is no folder on Windows
  const dir = scratch();
  expect(await refused(launch(dir))).toContain("Windows");
  expect(readdirSync(dir)).toEqual([]);
});

it("keeps an ordinary server's health free of the profile's facts, with OVIS_PREVIEW set or not", async () => {
  for (const preview of [undefined, "fleet"]) {
    const base = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: preview }).ready, 20_000);
    const answer = await fetch(`${base}/api/health`, { headers });
    expect(answer.status).toBe(200);
    const body = await answer.json() as Record<string, unknown>;
    expect(body["auth"]).toMatchObject({ authenticated: true });
    expect(body).not.toHaveProperty("machine_profile");
    const stranger = await (await fetch(`${base}/api/health`)).json() as Record<string, unknown>;
    expect(stranger["auth"]).toMatchObject({ authenticated: false });
    expect(stranger).not.toHaveProperty("machine_profile");
  }
});

it("has an ordinary server hold its state folder only with OVIS_PREVIEW=fleet", async () => {
  for (const [preview, held] of [[undefined, false], ["fleet", true]] as const) {
    const dir = state();
    await bounded(launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: preview, HOME: scratch() }).ready, 20_000);
    expect(existsSync(join(dir, "serve.own"))).toBe(held);
  }
});

it("ordinary servers on one state folder and different ports both answer without a lease", async () => {
  const dir = state();
  const first = launch(dir, { OVIS_PROFILE: "" });
  const one = await bounded(first.ready, 20_000);
  const second = launch(dir, { OVIS_PROFILE: "" });
  const two = await bounded(second.ready, 20_000);
  expect(one).not.toBe(two);
  for (const base of [one, two]) {
    const answer = await fetch(base + "/api/health?scope=bridge", { headers });
    expect(answer.status).toBe(200);
    expect(await answer.json()).not.toHaveProperty("machine_profile");
  }
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
});

/** A process that holds `lock` as an Ovis supervisor holds its supervisor.lock (server/supervisor.ts), until it is ended. */
async function supervisorRecord(lock: string) {
  // the supervisor makes its update state folder first, then takes the lock in it
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const holder = Bun.spawn([process.execPath, "-e", `const { acquireOwnerDirectory } = await import(${JSON.stringify(join(root, "server/owner-guard.ts"))});
acquireOwnerDirectory(${JSON.stringify(lock)}, { running: "running", starting: "starting" });
console.log("held");
setInterval(() => {}, 60_000);`], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const held = deferred<void>();
  void (async () => { for await (const chunk of holder.stdout) if (new TextDecoder().decode(chunk).includes("held")) held.resolve(); })();
  void holder.exited.then((code) => held.reject(new Error(`the record's holder exited ${code}`)));
  cleanup.push(async () => { holder.kill(); await bounded(holder.exited, 15_000); });
  await bounded(held.promise, 20_000);
  return holder;
}

/** A process that holds `path` shared as an ordinary server started with OVIS_PREVIEW=fleet holds serve.own (server/index.ts), until the test ends. */
async function sharedHold(path: string) {
  const holder = Bun.spawn([process.execPath, "-e", `const { holdForLife } = await import(${JSON.stringify(join(root, "server/owner-guard.ts"))});
holdForLife(${JSON.stringify(path)}, "shared");
console.log("held");
setInterval(() => {}, 60_000);`], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const held = deferred<void>();
  void (async () => { for await (const chunk of holder.stdout) if (new TextDecoder().decode(chunk).includes("held")) held.resolve(); })();
  void holder.exited.then((code) => held.reject(new Error(`the hold's holder exited ${code}`)));
  cleanup.push(async () => { holder.kill(); await bounded(holder.exited, 15_000); });
  await bounded(held.promise, 20_000);
}

it("refuses a state folder where an Ovis supervisor alive records itself, and starts once that owner is gone", async () => {
  const dir = state();
  // a folder the profile took before, which a supervisor then took
  marked(dir);
  // where a real Ovis records itself: <state folder>/updates/<checkout and port>/supervisor.lock
  const lock = join(updateStateDir(root, 7317, dir), "supervisor.lock");
  const holder = await supervisorRecord(lock);
  const before = readdirSync(dir).sort();
  // a HOME of its own: Bun itself writes into HOME, which the state folder is in the other launches
  const server = launch(dir, { HOME: scratch() });
  expect(await refused(server)).toContain(`An Ovis already runs on this state folder (lock ${lock}, owner pid ${holder.pid} generation `);
  expect(readdirSync(dir).sort()).toEqual(before);
  holder.kill();
  await bounded(holder.exited, 15_000);
  // the record names a dead owner now: it stays where it is and blocks nothing
  expect(existsSync(join(lock, "owner.json"))).toBe(true);
  const after = launch(dir);
  await bounded(after.ready, 20_000);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

const spellings: [string, (home: string) => string | undefined][] = [
  ["OVIS_STATE_DIR unset", () => undefined],
  ["the default folder", (home) => join(home, ".config", "ovis")],
  ["the older default folder", (home) => join(home, ".config", "herdr-web-ui")],
  ["a trailing slash", (home) => `${join(home, ".config", "ovis")}/`],
  ["a path through ..", (home) => join(home, ".config", "herdr-web-ui", "..", "ovis")],
  ["a relative path", (home) => relative(root, join(home, ".config", "ovis"))],
  ["a symlink", (home) => { const alias = join(home, "alias"); symlinkSync(join(home, ".config", "ovis"), alias, "junction"); return alias; }],
];
it.each(spellings)("refuses a default Ovis state folder named by %s and writes nothing there", async (_, spelling) => {
  const home = scratch();
  // the folders an own Ovis keeps its state in
  for (const name of ["ovis", "herdr-web-ui"]) {
    mkdirSync(join(home, ".config", name), { recursive: true });
    writeFileSync(join(home, ".config", name, "devices.json"), "{}");
  }
  const server = launch(home, { HOME: home, XDG_CONFIG_HOME: undefined, OVIS_STATE_DIR: spelling(home) });
  expect(await refused(server)).toContain("default Ovis state folder");
  for (const name of ["ovis", "herdr-web-ui"]) expect(readdirSync(join(home, ".config", name))).toEqual(["devices.json"]);
});

it("removes its lease, its socket and the recorded listener when stopped cleanly", async () => {
  const dir = state();
  const server = launch(dir);
  const base = await bounded(server.ready, 20_000);
  expect(JSON.parse(readFileSync(join(dir, "serve.lock", "http.json"), "utf8"))).toEqual({ port: Number(new URL(base).port), hostname: "127.0.0.1", socket: join(realpathSync(dir), "serve.sock"), door: 1 });
  server.child.kill("SIGTERM");
  expect(await bounded(server.exited, 20_000)).toBe(0);
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
  expect(existsSync(join(dir, "serve.sock"))).toBe(false);
});

it("names HERDR_SOCKET when the socket it gives cannot be used, and says which herdr it runs", async () => {
  const dir = state();
  const server = launch(dir, { HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: "relative/herdr.sock", OVIS_HERDR_BIN: "" });
  await bounded(server.ready, 20_000);
  expect(server.output()).toMatch(/herdr binary: [^\n]+ \(from PATH\)\n/);
  const response = await owner(dir, "/api/health", { headers });
  expect(await response.json()).toMatchObject({ machine_profile: { runtime_down: true, reason: "HERDR_SOCKET must be an absolute path ending in /herdr.sock" } });
});

it.each([["does not exist yet", false], ["exists", true]] as const)("keeps authenticated health while the selected herdr is absent under this account's herdr folder that %s, and uses that herdr once it starts", async (_, made) => {
  const dir = state();
  const config = herdrConfig();
  if (made) mkdirSync(join(config, "herdr"), { mode: 0o700 });
  // a named session whose herdr has not started yet
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  const response = await owner(dir, "/api/health", { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, auth: { authenticated: true }, machine_profile: { engine: "herdr", runtime_down: true, reason: "herdr is not running for the selected session" } });
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const herdr = fakeHerdr(socket);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null }, herdr: { protocol: 22 } });
  expect(herdr.connections()).toBeGreaterThan(0);
});

it("refuses an absent HERDR_REMOTE_SOCKET in a folder another account may write, and never uses a socket made there later", async () => {
  // outside every herdr folder of this account, where anyone could make the socket once the profile runs
  const open = scratch();
  chmodSync(open, 0o777);
  const socket = join(open, "herdr.sock");
  const dir = state();
  const server = launch(dir, { HERDR_REMOTE_SOCKET: socket, XDG_CONFIG_HOME: undefined });
  await bounded(server.ready, 20_000);
  const refusal = { machine_profile: { engine: "herdr", runtime_down: true, reason: unsafeSocket } };
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject(refusal);
  const planted = fakeHerdr(socket);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject(refusal);
  await (await owner(dir, "/api/session", { headers })).text();
  expect(planted.connections()).toBe(0);
});

it("connects to nothing that appears at the selected path but this account's own socket", async () => {
  const dir = state();
  const config = herdrConfig();
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  // what appears at the selected path is a link to a herdr in a folder anyone may write
  const open = scratch();
  chmodSync(open, 0o777);
  const planted = fakeHerdr(join(open, "herdr.sock"));
  const selected = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(selected), { recursive: true, mode: 0o700 });
  symlinkSync(join(open, "herdr.sock"), selected);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: true, reason: unsafeSocket } });
  await (await owner(dir, "/api/session", { headers })).text();
  expect(planted.connections()).toBe(0);
});

it("finds the one herdr session that starts after it, when none was selected", async () => {
  const dir = state();
  const config = herdrConfig();
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: true, reason: "herdr is not running for the selected session" } });
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  fakeHerdr(socket);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null }, herdr: { protocol: 22 } });
});

/** A HOME everyone may write with a private ~/.config in it, and the socket of its herdr session `a`. */
function openHome() {
  const home = herdrConfig();
  chmodSync(home, 0o777);
  mkdirSync(join(home, ".config"), { mode: 0o700 });
  return { home, socket: join(home, ".config", "herdr", "sessions", "a", "herdr.sock") };
}

it.each(["absent", "running"])("refuses a named session whose herdr is %s under a HOME another account may write, and names that folder to its owner alone", async (herdr) => {
  // that account could rename ~/.config between the check and a connection, with no link on the path
  const { home, socket } = openHome();
  let planted: ReturnType<typeof fakeHerdr> | undefined;
  if (herdr === "running") { mkdirSync(dirname(socket), { recursive: true, mode: 0o700 }); planted = fakeHerdr(socket); }
  const dir = state();
  const server = launch(dir, { HOME: home, XDG_CONFIG_HOME: undefined, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  const base = await bounded(server.ready, 20_000);
  const health = await (await owner(dir, "/api/health", { headers })).json() as { machine_profile: { reason: string } };
  // read first: toMatchObject puts its matcher where it matched
  const { reason } = health.machine_profile;
  expect(health).toMatchObject({ machine_profile: { runtime_down: true, reason: unsafeSocket } });
  // the walk's reason names the folder another account may write, in the start's engine line too, never on standard error
  expect(reason).toContain(`${home} `);
  expect(server.output()).toContain(`Machine engine: herdr (${reason})\n`);
  expect(server.errors()).not.toContain(home);
  // nobody without full access reads it: TCP answers liveness, and the socket a request naming another host 401
  expect(await (await fetch(`${base}/api/health`, { headers })).text()).toBe('{"ok":true}');
  const stranger = await owner(dir, "/api/health", { headers: { ...headers, host: "evil.example" } });
  expect([stranger.status, (await stranger.text()).includes(home)]).toEqual([401, false]);
  expect(planted?.connections() ?? 0).toBe(0);
});

it("refuses its pinned herdr at once when a folder on the way becomes writable by everyone", async () => {
  const dir = state();
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const herdr = fakeHerdr(socket);
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null } });
  const used = herdr.connections();
  // well inside the age the profile keeps its ACL answers: a folder's mode is read before every connection
  chmodSync(join(config, "herdr"), 0o777);
  const health = await (await owner(dir, "/api/health", { headers })).json() as { machine_profile: { reason: string } };
  const { reason } = health.machine_profile;
  expect(health).toMatchObject({ machine_profile: { runtime_down: true, reason: unsafeSocket } });
  expect(reason).toContain(join(config, "herdr"));
  expect(herdr.connections()).toBe(used);
});

it("connects to no session its walk refuses while it looks for one, names why to its owner, and takes it once its place is safe", async () => {
  const { home, socket } = openHome();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const unsafe = fakeHerdr(socket);
  const dir = state();
  const server = launch(dir, { HOME: home, XDG_CONFIG_HOME: undefined, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  // the one session under a HOME everyone may write is not a session found: the discovery before the start did not even connect to it
  expect(unsafe.connections()).toBe(0);
  // but a herdr runs there, so the owner reads the walk's reason for that folder, not that none runs
  const health = await (await owner(dir, "/api/health", { headers })).json() as { machine_profile: { reason: string } };
  const { reason } = health.machine_profile;
  expect(health).toMatchObject({ machine_profile: { runtime_down: true, reason: unsafeSocket } });
  expect(reason).toContain(`${home} `);
  expect(server.output()).toContain(`Machine engine: herdr (${reason})\n`);
  expect(server.errors()).not.toContain(home);
  expect(unsafe.connections()).toBe(0);
  chmodSync(home, 0o700);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null }, herdr: { protocol: 22 } });
});

it("pins the one safe session running beside an unsafe one", async () => {
  const { home, socket } = openHome();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const unsafe = fakeHerdr(socket);
  const config = herdrConfig();
  const safe = join(config, "herdr", "sessions", "b", "herdr.sock");
  mkdirSync(dirname(safe), { recursive: true, mode: 0o700 });
  fakeHerdr(safe);
  const dir = state();
  const server = launch(dir, { HOME: home, XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null }, herdr: { protocol: 22 } });
  expect(unsafe.connections()).toBe(0);
});

it("still asks which one when two safe sessions run", async () => {
  const config = herdrConfig();
  for (const name of ["a", "b"]) {
    const socket = join(config, "herdr", "sessions", name, "herdr.sock");
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    fakeHerdr(socket);
  }
  const dir = state();
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: true, reason: "Several herdr sessions are running; select one with HERDR_REMOTE_SOCKET" } });
});

it("looks for a herdr that started after it on a session request too, before any health check", async () => {
  const dir = state();
  const config = herdrConfig();
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const herdr = fakeHerdr(socket);
  await (await owner(dir, "/api/session", { headers })).text();
  expect(herdr.connections()).toBeGreaterThan(0);
});

it("takes a state folder holding only an unheld serve.own, as a start killed before its mark leaves it", async () => {
  const dir = state();
  writeFileSync(join(dir, "serve.own"), "", { mode: 0o600 });
  await bounded(launch(dir).ready, 20_000);
  expect(JSON.parse(readFileSync(join(dir, "machine-profile.json"), "utf8"))).toEqual({ profile: "machine" });
});

it("refuses a state folder whose serve.own an ordinary server holds shared, as owned by another server", async () => {
  const dir = state();
  await sharedHold(join(dir, "serve.own"));
  expect(await refused(launch(dir))).toContain("already owns this Ovis state directory");
  expect(readdirSync(dir)).toEqual(["serve.own"]);
});

it("refuses a state folder an ordinary server has used, and leaves it as it was", async () => {
  const dir = state();
  // an ordinary server without the preview takes no hold: the folder is told apart by what is in it
  const ordinary = launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined });
  await bounded(ordinary.ready, 20_000);
  ordinary.child.kill("SIGKILL");
  await bounded(ordinary.exited, 15_000);
  const before = contents(dir);
  expect(before.length).toBeGreaterThan(0);
  const profile = launch(dir);
  expect(await bounded(profile.ready.then(() => "started", () => profile.exited), 20_000)).toBe(1);
  expect(await refused(profile)).toContain(realpathSync(dir));
  expect(contents(dir)).toEqual(before);
});

it("refuses a folder another server wrote into while the profile took its hold, and leaves what that server left", () => {
  const dir = realpathSync(state());
  // the other server, an ordinary one with the preview: between the profile's first look at the empty folder and
  // its hold, it holds the folder, writes its state and is gone
  guardLibrary.posix = (calls) => ({ ...calls, flock: (fd, operation) => { writeFileSync(join(dir, "telemetry.json"), "{}"); return calls.flock(fd, operation); } });
  cleanup.push(() => { delete guardLibrary.posix; });
  expect(() => claimServerState(dir)).toThrow(MachineProfileError);
  // nothing of the profile's stays: not its marker, not the serve.own its hold made
  expect(readdirSync(dir)).toEqual(["telemetry.json"]);
});

it("leaves the serve.own another server made right before this start would make it, when it refuses the folder", () => {
  const dir = realpathSync(state());
  const hold = join(dir, "serve.own");
  const open = fs.openSync;
  let theirs: number | undefined;
  // the other server, an ordinary one with the preview: as this start is about to make serve.own, it makes it,
  // holds it, writes its state and is gone
  const made = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    if (path === hold && theirs === undefined) {
      writeFileSync(hold, "", { mode: 0o600 });
      theirs = lstatSync(hold).ino;
      writeFileSync(join(dir, "telemetry.json"), "{}");
    }
    return (open as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync);
  cleanup.push(() => { made.mockRestore(); });
  expect(() => claimServerState(dir)).toThrow(MachineProfileError);
  expect(theirs).toBeDefined();
  expect(lstatSync(hold).ino).toBe(theirs ?? -1);
  expect(readdirSync(dir).sort()).toEqual(["serve.own", "telemetry.json"]);
});

it("refuses an ordinary server whose folder a profile marked after its first look, before the device list is read", () => {
  const dir = state();
  // the marker, written after serve()'s first look and before createServer's: the second look sees it
  marked(dir);
  let error: unknown;
  try {
    const server = createServer({ stateDir: dir, port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false });
    cleanup.push(() => server.stop());
  } catch (thrown) { error = thrown; }
  expect(String(error)).toContain(join(dir, "machine-profile.json"));
  // nothing written: no device list, nothing else
  expect(readdirSync(dir)).toEqual(["machine-profile.json"]);
});

it("refuses a state folder whose machine-profile.json is not its own, naming that file, and leaves it as it was", async () => {
  const dir = realpathSync(state());
  writeFileSync(join(dir, "machine-profile.json"), '{"profile":"other"}', { mode: 0o600 });
  const before = contents(dir);
  expect(await refused(launch(dir))).toContain(join(dir, "machine-profile.json"));
  expect(contents(dir)).toEqual(before);
});

it("takes an empty state folder and marks it as its own, and starts again on the folder it marked", async () => {
  const dir = state();
  const first = launch(dir);
  await bounded(first.ready, 20_000);
  const marker = join(dir, "machine-profile.json");
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ profile: "machine" });
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  first.child.kill("SIGKILL");
  await bounded(first.exited, 15_000);
  await bounded(launch(dir).ready, 20_000);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

const restricted = [
  "/api/herdr/update", "/api/runtime", "/api/runtime/move", "/api/runtime/move/install",
  "/api/runtime/move/stop", "/api/runtime/move/stop-all", "/api/runtime/move/start", "/api/runtime/move/cancel",
  "/api/portal", "/api/portal/start", "/api/relay/direct", "/api/machines", "/api/machines/ssh-candidates",
  "/api/fleet/machines", "/api/fleet/invites", "/api/fleet/restore/confirm", "/api/bridge",
];
it.each(restricted)("refuses %s even to an owner in the machine profile", async (path) => {
  const stateDir = scratch();
  const server = createServer({ profile: "machine", stateDir, port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false });
  cleanup.push(() => server.stop());
  const response = await owner(stateDir, path, { method: "POST", headers: { ...headers, origin: "http://localhost", "content-type": "application/json" }, body: '{}' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "machine_profile" } });
});

it("answers its owner's check for updates as unmanaged, and asks the updater nothing, even when given a managed one", async () => {
  // a managed updater as a supervisor's channel makes it (server/update-api.ts)
  const sent: unknown[] = [];
  let deliver: (message: unknown) => void = () => {};
  const updates = connectUpdater({ send: (message) => { sent.push(message); }, onMessage: (listener) => { deliver = listener; } });
  deliver({ type: "update-status", status: { ...unmanagedUpdateStatus(), managed: true, blocked_reason: null } });
  expect(updates.status().managed).toBe(true);
  const stateDir = scratch();
  const server = createServer({ profile: "machine", stateDir, port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false, updates });
  cleanup.push(() => server.stop());
  const response = await owner(stateDir, "/api/updates/check", { method: "POST", headers: { origin: "http://localhost", "x-herdr-update": "1" } });
  expect([response.status, (await response.json() as { error?: { code: string } }).error?.code]).toEqual([409, "updates_unmanaged"]);
  expect(sent).toEqual([{ type: "update-status-request" }]);
});

it.each(["", "?scope=bridge"])("gives an unknown caller only plain liveness at /api/health%s", async (query) => {
  const options = { profile: "machine" as const, stateDir: scratch(), port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false };
  const server = createServer(options);
  cleanup.push(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${server.port}/api/health${query}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

/** A profile server, and beside it an ordinary one with the same options as the control: an ordinary server's door. */
function pair(options: NonNullable<Parameters<typeof createServer>[0]>) {
  const stateDir = scratch();
  const profile = createServer({ profile: "machine", stateDir, port: 0, hostname: "127.0.0.1", sidecar: false, ...options });
  const ordinary = createServer({ stateDir: scratch(), port: 0, hostname: "127.0.0.1", sidecar: false, ...options });
  cleanup.push(() => profile.stop(), () => ordinary.stop());
  return { profile: profile.port, ordinary: ordinary.port, stateDir };
}

it("closes the pairing gate from the profile's first answer", async () => {
  const { stateDir, ordinary } = pair({ token: "", tailscaleOwner: null });
  const first = await (await owner(stateDir, "/api/health")).json();
  expect(first).toMatchObject({ auth: { via: "local" }, security: { pairing_gate: "closed" } });
  expect(await (await fetch(`http://127.0.0.1:${ordinary}/api/health`)).json()).toMatchObject({ security: { pairing_gate: "open" } });
});

it("lets a DNS-rebinding page in nowhere before the relay was ever on, while this PC's own account still gets in on its socket", async () => {
  const { profile, ordinary, stateDir } = pair({ token: "", tailscaleOwner: null });
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { label: "ovis-test-machine-door", cwd: root, focus: false });
  cleanup.push(async () => { await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id }); });
  const paneId = created.root_pane.pane_id;
  // the page's own name as Host, its own origin, no Tailscale login to compare with
  const page = (port: number) => ({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` });
  // control: an ordinary server whose pairing gate is still open answers this as an open install; the profile, whose gate is closed, does not
  const forwarded = { "x-forwarded-for": "203.0.113.7" };
  expect((await fetch(`http://127.0.0.1:${ordinary}/api/session`, { headers: forwarded })).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: forwarded })).status).toBe(401);
  // the page's own name from loopback is a rebound name on an ordinary server too (#3876): it is asked to pair
  expect((await fetch(`http://127.0.0.1:${ordinary}/api/session`, { headers: page(ordinary) })).status).toBe(401);
  expect((await (await fetch(`http://127.0.0.1:${ordinary}/api/health`, { headers: page(ordinary) })).json()).auth).toMatchObject({ authenticated: false, reason: "pairing_required" });
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: page(profile) })).status).toBe(401);
  const typed = await fetch(`http://127.0.0.1:${profile}/api/pane/input`, { method: "POST", headers: { ...page(profile), "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, text: "MACHINE_REBIND" }) });
  expect(typed.status).toBe(401);
  const socket = await fetch(`http://127.0.0.1:${profile}/ws`, { headers: { ...page(profile), ...upgrade } });
  expect(socket.status).toBe(401);
  // a program of this PC's own account on loopback TCP with no header of value is nobody either
  const loopback = await fetch(`http://127.0.0.1:${profile}/api/pane/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, text: "MACHINE_LOOPBACK" }) });
  expect(loopback.status).toBe(401);
  // this account types next, on the socket; once its text is in the pane, the others' would have been there before it
  const own = await owner(stateDir, "/api/pane/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, text: "MACHINE_OWNER" }) });
  expect(own.status).toBe(200);
  const deadline = Date.now() + 15_000;
  let text = "";
  while (!text.includes("MACHINE_OWNER")) {
    if (Date.now() > deadline) throw new Error(`the owner's text never reached the pane: ${text}`);
    text = (await paneRead({ paneId, source: "recent", format: "text", lines: 200 })).text ?? "";
    if (!text.includes("MACHINE_OWNER")) await Bun.sleep(25);
  }
  expect(text).not.toContain("MACHINE_REBIND");
  expect(text).not.toContain("MACHINE_LOOPBACK");
});

it("lets nobody in by a Tailscale identity header, the machine's own login included", async () => {
  const { profile, ordinary } = pair({ token: "", tailscaleOwner: "owner@example.com" });
  const identity = { "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.7" };
  // control: an ordinary server admits it "via tailscale"
  const admitted = await fetch(`http://127.0.0.1:${ordinary}/api/health`, { headers: identity });
  expect(await admitted.json()).toMatchObject({ auth: { authenticated: true, via: "tailscale" } });
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: identity })).status).toBe(401);
  const health = await fetch(`http://127.0.0.1:${profile}/api/health`, { headers: identity });
  expect(await health.text()).toBe('{"ok":true}');
});

it("treats the bridge token as nobody in the profile", async () => {
  const bridgeToken = "machine-contract-bridge-token";
  const { profile, ordinary } = pair({ token, bridgeToken, tailscaleOwner: null });
  const bearer = { authorization: `Bearer ${bridgeToken}` };
  // control: on an ordinary server, the connection server reads this PC's session with it
  expect((await fetch(`http://127.0.0.1:${ordinary}/api/session`, { headers: bearer })).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: bearer })).status).toBe(401);
  expect(await (await fetch(`http://127.0.0.1:${profile}/api/health?scope=bridge`, { headers: bearer })).text()).toBe('{"ok":true}');
});

/**
 * A profile made by createServer, as serve() makes it but with no engine to ask, the relay and the account service
 * of the test, and the token given: `prepare` writes into its state folder before it starts.
 */
function profileServer(prepare: (stateDir: string) => void = () => {}) {
  const stateDir = scratch();
  prepare(stateDir);
  const account = new FakeAccountService();
  const server = createServer({ profile: "machine", stateDir, port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false,
    machineRefusal: () => "no engine in this test", relay: new RelayService({ stateDir, relay: "wss://relay.invalid" }),
    accountService: { url: "https://account.test", fetch: account.fetch } });
  cleanup.push(() => server.stop());
  return { stateDir, base: `http://127.0.0.1:${server.port}` };
}

it("answers only liveness on TCP to every caller: the token, a device paired at the machine's own address, the command line's headers", async () => {
  const secret = "machine-contract-cookie";
  let id = "";
  const { stateDir, base } = profileServer((dir) => { id = cookieRow(dir, secret); });
  const shapes: Record<string, string>[] = [
    { ...headers, origin: base },
    { cookie: `ovis_device=${secret}`, origin: base },
    { authorization: `Device ${secret}`, "x-herdr-machine": "1", origin: base },
    {},
  ];
  const calls: [string, string][] = [["GET", "/api/session"], ["GET", "/api/devices"], ["GET", "/api/account/status"], ["POST", "/api/relay/start"],
    ["POST", "/api/relay/offer"], ["POST", "/api/devices/pair/start"], ["POST", "/api/auth"], ["POST", "/api/devices/pair"], ["GET", "/api/nothing"]];
  for (const shape of shapes) {
    for (const [method, path] of calls) {
      const response = await fetch(base + path, { method, headers: { ...shape, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      const body = await response.json() as { error?: { code?: string } };
      expect([method, path, response.status, body.error?.code]).toEqual([method, path, 401, "unauthorized"]);
    }
    for (const query of ["", "?scope=bridge"]) {
      const health = await fetch(`${base}/api/health${query}`, { headers: shape });
      expect([health.status, await health.text()]).toEqual([200, '{"ok":true}']);
    }
    expect((await fetch(`${base}/ws`, { headers: { ...shape, ...upgrade } })).status).toBe(401);
    expect((await fetch(`${base}/`, { headers: shape })).status).toBe(404);
  }
  // nothing on TCP started the relay or paired anyone
  expect(await (await owner(stateDir, "/api/relay")).json()).toMatchObject({ phase: "off" });
  expect((await (await owner(stateDir, "/api/devices")).json() as { devices: { id: string }[] }).devices.map((device) => device.id)).toEqual([id]);
});

it("takes the caller on its socket as the local owner, and a cookie there adds nothing", async () => {
  const secret = "machine-contract-cookie";
  const { stateDir } = profileServer((dir) => cookieRow(dir, secret));
  for (const extra of [{}, { cookie: `ovis_device=${secret}` }, { authorization: `Device ${secret}` }] as Record<string, string>[]) {
    const health = await owner(stateDir, "/api/health", { headers: { "x-herdr-machine": "1", ...extra } });
    expect(health.status).toBe(200);
    const body = await health.json() as { auth: Record<string, unknown> };
    expect(body).toMatchObject({ ok: true, auth: { authenticated: true, via: "local", role: "drive" }, machine_profile: { engine: "herdr" }, security: { pairing_gate: "closed" } });
    expect(body.auth).not.toHaveProperty("device");
  }
  expect((await owner(stateDir, "/api/devices")).status).toBe(200);
  expect((await owner(stateDir, "/api/account/status")).status).toBe(200);
  // a change from the command line with its origin is judged for what it asks (the relay is off), not for who asks
  const offer = await owner(stateDir, "/api/relay/offer", { method: "POST", headers: { origin: "http://localhost", "x-herdr-update": "1" } });
  expect([offer.status, (await offer.json() as { error: { code: string } }).error.code]).toEqual([409, "relay_off"]);
});

it("refuses on its socket a request that names another host or shows a proxy, a change from another site, and a cookie's pairing", async () => {
  const { stateDir } = profileServer();
  for (const host of ["localhost:80", "127.0.0.1", hostname(), "evil.example"]) {
    for (const path of ["/api/devices", "/api/health"]) {
      const response = await owner(stateDir, path, { headers: { host } });
      expect([host, path, response.status]).toEqual([host, path, 401]);
    }
  }
  const proxied: [string, string][] = [["x-forwarded-for", "203.0.113.7"], ["x-forwarded-host", "localhost"], ["x-forwarded-proto", "http"], ["x-real-ip", "203.0.113.7"],
    ["forwarded", "for=203.0.113.7"], ["via", "1.1 proxy"], ["tailscale-user-login", "owner@example.com"], ["tailscale-funnel-request", "?1"],
    ["x-forwarded-port", "443"], ["x-forwarded-server", "proxy"], ["x-forwarded-scheme", "https"], ["x-original-forwarded-for", "203.0.113.7"],
    ["cf-connecting-ip", "203.0.113.7"], ["true-client-ip", "203.0.113.7"], ["x-client-ip", "203.0.113.7"], ["fly-client-ip", "203.0.113.7"],
    ["x-envoy-external-address", "203.0.113.7"], ["cdn-loop", "cloudflare"]];
  for (const [name, value] of proxied) {
    const response = await owner(stateDir, "/api/devices", { headers: { [name]: value } });
    expect([name, response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([name, 401, "unauthorized"]);
  }
  for (const other of [{ origin: "http://evil.example" }, { origin: "http://localhost", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    const change = await owner(stateDir, "/api/relay/offer", { method: "POST", headers: { ...other, "x-herdr-update": "1" } });
    expect([change.status, (await change.json() as { error: { code: string } }).error.code]).toEqual([403, "invalid_origin"]);
    expect((await owner(stateDir, "/ws", { headers: { ...other, ...upgrade } })).status).toBe(403);
  }
  const paired = await owner(stateDir, "/api/devices/pair", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: '{"code":"123456"}' });
  expect([paired.status, (await paired.json() as { error: { code: string } }).error.code]).toEqual([409, "machine_profile"]);
});

it("refuses on its socket a request that names no host at all, as HTTP/1.0 may", async () => {
  const { stateDir } = profileServer();
  let answer = "";
  const closed = deferred<void>();
  await Bun.connect({ unix: join(stateDir, "serve.sock"), socket: {
    open(client) { client.write("GET /api/devices HTTP/1.0\r\n\r\n"); },
    data(_client, chunk) { answer += chunk.toString(); },
    close() { closed.resolve(); },
  } });
  await bounded(closed.promise);
  expect(answer.split("\r\n")[0]).toBe("HTTP/1.1 401 Unauthorized");
  expect(JSON.parse(answer.slice(answer.indexOf("\r\n\r\n") + 4))).toMatchObject({ error: { code: "unauthorized" } });
});

it("ignores OVIS_TOKEN and says so once at its start, and names the devices paired at its own address that cannot reach it", async () => {
  const dir = state();
  const secret = "machine-contract-cookie";
  // a folder the profile took before, with rows paired at the machine's own address in it
  marked(dir);
  const id = cookieRow(dir, secret);
  const server = launch(dir);
  const base = await bounded(server.ready, 20_000);
  expect(server.output().split("\n").filter((line) => line.includes("OVIS_TOKEN"))).toHaveLength(1);
  expect(server.output()).toContain(id);
  for (const shape of [headers, { cookie: `ovis_device=${secret}` }]) {
    expect((await fetch(`${base}/api/session`, { headers: shape })).status).toBe(401);
    expect(await (await fetch(`${base}/api/health`, { headers: shape })).text()).toBe('{"ok":true}');
  }
  expect(await (await owner(dir, "/api/health")).json()).toMatchObject({ auth: { via: "local" } });
});

it("makes its folder 0700 and its socket 0600 under umask 002, gives the umask back, and names the socket in its lease", async () => {
  const dir = join(state(), "made");
  // a HOME of its own: Bun makes HOME's folders itself before the server runs
  const server = launch(dir, { HOME: scratch() }, "002");
  const base = await bounded(server.ready, 20_000);
  const socket = join(realpathSync(dir), "serve.sock");
  expect(statSync(dir).mode & 0o7777).toBe(0o700);
  expect(lstatSync(socket).isSocket()).toBe(true);
  expect(lstatSync(socket).mode & 0o7777).toBe(0o600);
  // what the files and processes it makes afterwards get, where /proc shows it
  if (process.platform === "linux") expect(/^Umask:\s+(\d+)$/m.exec(readFileSync(`/proc/${server.child.pid}/status`, "utf8"))?.[1]).toBe("0002");
  expect(JSON.parse(readFileSync(join(dir, "serve.lock", "http.json"), "utf8"))).toEqual({ port: Number(new URL(base).port), hostname: "127.0.0.1", socket, door: 1 });
  // the kernel checks the folder at every connect, for this account too
  chmodSync(dir, 0o600);
  try {
    const connected = await Bun.connect({ unix: socket, socket: { data() {} } }).then((client) => { client.end(); return "connected"; }, (error: { code?: string }) => error.code);
    expect(connected).toBe("EACCES");
  } finally { chmodSync(dir, 0o700); }
});

const unsafe: [string, () => { told: string; looked: string }][] = [
  ["a folder above it that everyone can write", () => { const above = state(); chmodSync(above, 0o777); cleanup.push(() => chmodSync(above, 0o700)); return { told: join(above, "state"), looked: above }; }],
  ["a state folder of mode 0755", () => { const dir = state(); chmodSync(dir, 0o755); return { told: dir, looked: dir }; }],
];
it.each(unsafe)("refuses to start with %s, and writes nothing", async (_, setup) => {
  const { told, looked } = setup();
  const before = readdirSync(looked).sort();
  const sentence = await refused(launch(told, { HOME: scratch() }));
  expect(sentence).toContain(realpathSync(looked));
  expect(readdirSync(looked).sort()).toEqual(before);
});

it.skipIf(process.getuid?.() === 0)("refuses a state folder that root owns", async () => {
  const sentence = await refused(launch("/root", { HOME: scratch() }));
  expect(sentence).toContain("/root");
  expect(sentence).not.toContain("EACCES");
});

it("starts in a folder of a mktemp -d under /tmp", async () => {
  const dir = mkdtempSync("/tmp/ovis-machine-walk-");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  await bounded(launch(join(dir, "state"), { HOME: scratch() }).ready, 20_000);
  expect((await owner(join(dir, "state"), "/api/health")).status).toBe(200);
});

it("refuses a state folder whose socket path would be longer than 100 bytes, and writes nothing", async () => {
  const above = realpathSync(state());
  const dir = join(above, "x".repeat(Math.max(1, 110 - above.length)));
  mkdirSync(dir, { mode: 0o700 });
  expect(Buffer.byteLength(join(dir, "serve.sock"))).toBeGreaterThan(100);
  expect(await refused(launch(dir, { HOME: scratch() }))).toContain("OVIS_STATE_DIR");
  expect(readdirSync(dir)).toEqual([]);
});

it("starts again where a killed profile left its socket", async () => {
  const dir = state();
  const first = launch(dir);
  await bounded(first.ready, 20_000);
  first.child.kill("SIGKILL");
  await bounded(first.exited, 15_000);
  expect(lstatSync(join(dir, "serve.sock")).isSocket()).toBe(true);
  const second = launch(dir);
  await bounded(second.ready, 20_000);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

it("leaves no socket and no lease when its port is taken", async () => {
  const dir = state();
  const squatter = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  cleanup.push(() => squatter.stop(true));
  await refused(launch(dir, { PORT: String(squatter.port), HOME: scratch() }));
  expect(existsSync(join(dir, "serve.sock"))).toBe(false);
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
});

it("keeps an ordinary server with the preview off a folder a profile marked, running or killed, and a profile off a folder an ordinary server uses", async () => {
  const dir = state();
  // a HOME of its own for each: Bun and the programs a server asks write into HOME
  const profile = launch(dir, { HOME: scratch() });
  await bounded(profile.ready, 20_000);
  const before = readdirSync(dir).sort();
  // the marker is read before the hold is tried: its sentence, naming the marker, is the one
  expect(await refused(launch(dir, { OVIS_PROFILE: "", HOME: scratch() }))).toContain(join(dir, "machine-profile.json"));
  expect(readdirSync(dir).sort()).toEqual(before);
  profile.child.kill("SIGKILL");
  await bounded(profile.exited, 15_000);
  // a killed profile holds nothing, but the folder it marked is still its own
  expect(await refused(launch(dir, { OVIS_PROFILE: "", HOME: scratch() }))).toContain(join(dir, "machine-profile.json"));
  const other = state();
  const ordinary = launch(other, { OVIS_PROFILE: "", HOME: scratch() });
  const base = await bounded(ordinary.ready, 20_000);
  await refused(launch(other, { HOME: scratch() }));
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

it("refuses an ordinary server without the preview on a folder a profile runs on, leaves the folder as it was, and the profile keeps answering", async () => {
  const dir = state();
  const profile = launch(dir);
  await bounded(profile.ready, 20_000);
  const before = contents(dir);
  const ordinary = launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined });
  expect(await bounded(ordinary.ready.then(() => "started", () => ordinary.exited), 20_000)).toBe(1);
  expect(await refused(ordinary)).toContain(join(dir, "machine-profile.json"));
  expect(contents(dir)).toEqual(before);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

it("refuses an ordinary server without the preview on a folder a stopped profile marked, and leaves it as it was", async () => {
  const dir = state();
  const profile = launch(dir);
  await bounded(profile.ready, 20_000);
  profile.child.kill("SIGTERM");
  expect(await bounded(profile.exited, 20_000)).toBe(0);
  const before = contents(dir);
  expect(before.map(([name]) => name)).toContain("machine-profile.json");
  const ordinary = launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined });
  expect(await bounded(ordinary.ready.then(() => "started", () => ordinary.exited), 20_000)).toBe(1);
  expect(await refused(ordinary)).toContain(join(dir, "machine-profile.json"));
  expect(contents(dir)).toEqual(before);
});

it("starts an ordinary server without the preview on a folder whose machine-profile.json is a FIFO, as main does", async () => {
  const dir = state();
  // opened for reading, a FIFO would wait for a writer that never comes
  expect(Bun.spawnSync(["mkfifo", join(dir, "machine-profile.json")]).exitCode).toBe(0);
  const base = await bounded(launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined }).ready, 20_000);
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

it("starts an ordinary server without the preview beside a machine-profile.json that is not a profile's marker", async () => {
  const dir = state();
  writeFileSync(join(dir, "machine-profile.json"), '{"profile":"other"}', { mode: 0o600 });
  const base = await bounded(launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined }).ready, 20_000);
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

it("lets exactly one of a profile and an ordinary server started at the same moment on one folder run", async () => {
  const pairs = Array.from({ length: 5 }, () => {
    const dir = state();
    return [launch(dir, { HOME: scratch() }), launch(dir, { OVIS_PROFILE: "", HOME: scratch() })];
  });
  const outcomes = await Promise.all(pairs.map((started) => Promise.all(started.map((server) => bounded(server.ready.then(() => "ready", () => server.exited), 30_000)))));
  // the ones that run are ended at once, together: an ordinary server's own stop waits for its sidecars
  await Promise.all(pairs.flat().map((server) => { server.child.kill("SIGKILL"); return bounded(server.exited, 15_000); }));
  for (const outcome of outcomes) expect(outcome.filter((one) => one === "ready")).toHaveLength(1);
});

it("starts an ordinary server whose hold cannot be taken for another reason, and refuses a profile there", async () => {
  const dir = state();
  mkdirSync(join(dir, "serve.own"));
  const ordinary = launch(dir, { OVIS_PROFILE: "", HOME: scratch() });
  await bounded(ordinary.ready, 20_000);
  expect(ordinary.errors()).toContain(join(dir, "serve.own"));
  ordinary.child.kill("SIGTERM");
  await bounded(ordinary.exited, 20_000);
  // marked only now, as if the profile had taken it before: an ordinary server does not start on a marked folder
  // (so it is marked after that server), and what refuses the profile is the hold
  marked(dir);
  expect(await refused(launch(dir, { HOME: scratch() }))).toContain("serve.own");
});
