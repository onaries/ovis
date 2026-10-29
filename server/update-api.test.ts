import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noInstalledNotes, noUpdateNotes, unmanagedUpdateStatus, type UpdateRequest, type UpdateStatus } from "../shared/update.ts";
import { connectUpdater, handleUpdateRequest, servedRevision, type UpdateService } from "./update-api.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("the served build's revision", () => {
  it("reads the commit dist/build.json names, as it is now", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-revision-"));
    directories.push(directory);
    const read = servedRevision(directory, 0);
    // no build yet, or one older than the file
    expect(await read()).toBeNull();
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", "build.json"), JSON.stringify({ revision: "a".repeat(40) }));
    expect(await read()).toBe("a".repeat(40));
    // what a plugin reinstall or a `git pull` and a build does under the running server
    writeFileSync(join(directory, "dist", "build.json"), JSON.stringify({ revision: "b".repeat(40) }));
    expect(await read()).toBe("b".repeat(40));
  });

  it("counts only a build written after the server started", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-before-"));
    directories.push(directory);
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", "build.json"), JSON.stringify({ revision: "a".repeat(40) }));
    // a pull without a build, then a restart: the build predates the server, and a restart cannot change it
    expect(await servedRevision(directory, Date.now() + 60_000)()).toBeNull();
    expect(await servedRevision(directory, 0)()).toBe("a".repeat(40));
  });

  it("answers null for a file that names no commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-garbage-"));
    directories.push(directory);
    mkdirSync(join(directory, "dist"));
    const read = servedRevision(directory, 0);
    for (const body of ["not json", "{}", JSON.stringify({ revision: null }), JSON.stringify({ revision: "../../etc" })]) {
      writeFileSync(join(directory, "dist", "build.json"), body);
      expect(await read()).toBeNull();
    }
  });
});

const offered = "a".repeat(40), moved = "b".repeat(40);
const offer = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true,
  latest_revision: offered, latest_version: "9.9.9", current_revision: "c".repeat(40), revision_bound_install: true, ...patch });
/** A service that keeps every request it is handed. */
function service(status: () => UpdateStatus): UpdateService & { requests: UpdateRequest[] } {
  const requests: UpdateRequest[] = [];
  return { requests, status, notes: noUpdateNotes, installed: noInstalledNotes, request: (request) => { requests.push(request); } };
}
const install = (body?: string) => new Request("http://127.0.0.1/api/updates/install", { method: "POST",
  headers: { "x-herdr-update": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body }) });
const answer = async (response: Response | Promise<Response>) => {
  const resolved = await response;
  return { status: resolved.status, code: ((await resolved.json()) as { error?: { code?: string } }).error?.code ?? null };
};

describe("a manual install", () => {
  it("rejects unbound manual installs", async () => {
    const updates = service(() => offer());
    for (const body of [undefined, "", "{}", "null", "[]", "not json", JSON.stringify({ expected_revision: null }),
      JSON.stringify({ expected_revision: "a".repeat(39) }), JSON.stringify({ expected_revision: "a".repeat(65) }),
      JSON.stringify({ expected_revision: "A".repeat(40) }), JSON.stringify({ expected_revision: `${"a".repeat(40)}\n` }),
      // more than an install's 1 KiB is not one, whatever it names
      JSON.stringify({ expected_revision: offered, padding: "x".repeat(1024) })]) {
      expect(await answer(handleUpdateRequest(install(body), "/api/updates/install", updates))).toEqual({ status: 400, code: "invalid_update_install" });
    }
    expect(updates.requests).toEqual([]);
  });

  it("installs only the revision it names, while that is the one on offer", async () => {
    let status = offer();
    const updates = service(() => status);
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 202, code: null });
    expect(updates.requests).toEqual([{ command: "install", expected_revision: offered }]);
    // another release came on offer since the person was shown this one: refused before anything is asked
    status = offer({ latest_revision: moved });
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_offer_changed" });
    status = offer({ available: false });
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_unavailable" });
    status = offer({ phase: "building" });
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_busy" });
    expect(updates.requests).toHaveLength(1);
    // a check still goes without a body
    status = offer();
    const check = new Request("http://127.0.0.1/api/updates/check", { method: "POST", headers: { "x-herdr-update": "1" } });
    expect(await answer(handleUpdateRequest(check, "/api/updates/check", updates))).toEqual({ status: 202, code: null });
    expect(updates.requests.at(-1)).toEqual({ command: "check" });
  });

  it("old supervisor cannot receive an unbound install", async () => {
    // an older supervisor tells its status without the capability: the bridge offers no install under it
    const sent: unknown[] = [];
    let deliver: (message: unknown) => void = () => {};
    const updates = connectUpdater({ send: (message) => { sent.push(message); }, onMessage: (listener) => { deliver = listener; } });
    const { revision_bound_install: _, ...older } = offer();
    deliver({ type: "update-status", status: older });
    expect(updates.status().revision_bound_install).toBeUndefined();
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_restart_required" });
    // a capability that is not exactly true is not told
    deliver({ type: "update-status", status: { ...older, revision_bound_install: "yes" } });
    expect(updates.status().revision_bound_install).toBeUndefined();
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_restart_required" });
    expect(sent).toEqual([{ type: "update-status-request" }]);
  });
});

describe("the update status", () => {
  const read = async (where?: () => Promise<Pick<UpdateStatus, "port" | "serving_url">>) => {
    const response = await handleUpdateRequest(new Request("http://127.0.0.1/api/updates"), "/api/updates", service(() => offer()), where);
    return { status: response.status, body: await response.json() as UpdateStatus };
  };

  it("tells where it answers only when asked to, and still answers when that cannot be read (#2191)", async () => {
    expect(await read(async () => ({ port: 7317, serving_url: "https://pc.example.ts.net" }))).toMatchObject({ status: 200, body: { latest_revision: offered, port: 7317, serving_url: "https://pc.example.ts.net" } });
    const plain = await read();
    expect(plain.status).toBe(200);
    expect("port" in plain.body || "serving_url" in plain.body).toBe(false);
    // tailscale that cannot be started: the status stands without them, and the asker falls back to /api/access
    const failed = await read(async () => { throw new Error("spawn EACCES"); });
    expect(failed.status).toBe(200);
    expect(failed.body.latest_revision).toBe(offered);
    expect("port" in failed.body).toBe(false);
  });
});
