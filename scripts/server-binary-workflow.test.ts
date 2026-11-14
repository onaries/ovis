import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, releaseFile, SERVER_PLATFORMS, signManifest, verifyRelease, writeManifest } from "./server-manifest.ts";
import { parseWorkflow, root } from "./shell-workflow-rules.ts";

const release = parseWorkflow(join(root, ".github/workflows/release.yml"));
const job = (name: string) => release.jobs[name]!;
const step = (jobName: string, name: string) => job(jobName).steps!.find((candidate) => candidate.name === name)!;
const ATTESTS = { contents: "read", "id-token": "write", attestations: "write" };

test("Release publishes only after the server binaries are built, signed and attested", () => {
  expect(job("server-binary").needs).toBe("preflight");
  expect(job("server-binary-sign").needs).toBe("server-binary");
  expect(job("server-binary-attest").needs).toBe("server-binary-sign");
  expect(job("publish").needs).toEqual(["validate", "pty-sidecar", "server-binary-sign", "server-binary-attest"]);
  for (const name of ["server-binary", "server-binary-sign"]) expect(job(name).permissions).toEqual({ contents: "read" });
  expect(job("server-binary-attest").permissions).toEqual(ATTESTS);
  const attest = job("server-binary-attest").steps!.find((candidate) => candidate.uses?.startsWith("actions/attest-build-provenance@"))!;
  expect(attest.uses).toMatch(/^actions\/attest-build-provenance@[0-9a-f]{40}$/);
  expect(String(attest.with?.["subject-path"]).trim().split("\n")).toEqual(["server-binary/ovis-server-*", "server-binary/ovis-server.json", "server-binary/ovis-server.SHA256SUMS"]);
});

const workflowFiles = readdirSync(join(root, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name));
const allJobs = workflowFiles.flatMap((name) => Object.entries(parseWorkflow(join(root, ".github/workflows", name)).jobs).map(([id, candidate]) => ({ where: `${name}:${id}`, job: candidate })));
const environmentOf = (candidate: unknown): unknown => {
  const environment = (candidate as { environment?: unknown }).environment;
  return typeof environment === "object" && environment !== null ? (environment as { name?: unknown }).name : environment;
};

test("the key lives in the environment release-signing, which the sign job alone names, on main of this repository", () => {
  const sign = job("server-binary-sign");
  expect(environmentOf(sign)).toBe("release-signing");
  expect(sign.if).toBe("github.repository == 'devswha/ovis' && github.ref == 'refs/heads/main'");
  expect(allJobs.filter(({ job: candidate }) => environmentOf(candidate) === "release-signing").map(({ where }) => where)).toEqual(["release.yml:server-binary-sign"]);
  // a job that deploys reads its own environment, never the key's
  expect(allJobs.filter(({ job: candidate }) => JSON.stringify(candidate).includes("OVIS_SERVER_SIGNING_KEY")).map(({ where }) => where)).toEqual(["release.yml:server-binary-sign"]);
});

test("a sign job that failed or was skipped leaves publish, and so the tag and the release, unmade", () => {
  // GitHub runs a job only when every job it needs succeeded, unless its if calls a status function; publish and the
  // attest job between them call none
  const STATUS = /\b(always|failure|cancelled|success)\s*\(/i;
  for (const name of ["server-binary-attest", "publish"]) expect(STATUS.test(String(job(name).if ?? ""))).toBe(false);
  expect([job("publish").needs].flat()).toContain("server-binary-sign");
  expect(job("server-binary-attest").needs).toBe("server-binary-sign");
});

test("the signing key reaches one step, on GitHub's runner, with no package installed beside it", () => {
  const workflows = readdirSync(join(root, ".github/workflows")).map((name) => readFileSync(join(root, ".github/workflows", name), "utf8"));
  expect(workflows.join("\n").match(/secrets\.OVIS_SERVER_SIGNING_KEY\b/g)).toHaveLength(1);
  const sign = job("server-binary-sign");
  expect(sign["runs-on"]).toBe("ubuntu-24.04");
  expect(step("server-binary-sign", "Sign the manifest").env).toEqual({ OVIS_SERVER_SIGNING_KEY: "${{ secrets.OVIS_SERVER_SIGNING_KEY }}", RELEASE_VERSION: "${{ inputs.version }}" });
  const runs = sign.steps!.map((candidate) => `${candidate.uses ?? ""} ${candidate.run ?? ""}`).join("\n");
  expect(runs).not.toContain("bun install");
  expect(runs).not.toContain("setup-ci");
});

const SERVER_FILES = [...SERVER_PLATFORMS.map(releaseFile), "ovis-server.json", "ovis-server.json.sig", "ovis-server.SHA256SUMS"];

/** a signed release folder for version 1.2.3 under `temp`/server-binary, and its public key */
function signedFolder(temp: string): { publicKey: string; privateKeyPem: string } {
  const dir = join(temp, "server-binary");
  mkdirSync(dir, { recursive: true });
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `binary for ${platform}\n`);
  writeManifest(dir, { version: "1.2.3", sources: { server: "a".repeat(40), shared: "b".repeat(40) } });
  const { privateKeyPem, publicKey } = generateKeyPair();
  signManifest(dir, privateKeyPem);
  return { publicKey, privateKeyPem };
}

/**
 * publish's own lines from the server files to `gh release create`, run with a `gh` that records its arguments: what
 * the release would get, or the refusal.
 */
function runAttach(prepare: (dir: string, privateKeyPem: string) => void): { code: number; attached: string[]; err: string } {
  const temp = mkdtempSync(join(tmpdir(), "ovis-attach-step-"));
  try {
    const { publicKey, privateKeyPem } = signedFolder(temp);
    prepare(join(temp, "server-binary"), privateKeyPem);
    mkdirSync(join(temp, "pty-sidecar"));
    writeFileSync(join(temp, "pty-sidecar", "ovis-pty-sidecar.json"), "{}");
    mkdirSync(join(temp, "stub"));
    writeFileSync(join(temp, "stub", "gh"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(temp, "gh-args")}"\n`);
    chmodSync(join(temp, "stub", "gh"), 0o755);
    const lines = step("publish", "Publish the validated commit").run!.split("\n");
    const from = lines.findIndex((line) => line.trim().startsWith("server_files=("));
    const to = lines.findIndex((line) => line.trim().startsWith("gh release create"));
    expect(from).toBeGreaterThan(-1);
    const result = Bun.spawnSync(["bash", "-e", "-c", lines.slice(from, to + 1).join("\n")], {
      cwd: root, env: { ...process.env, PATH: `${join(temp, "stub")}:${process.env["PATH"]}`, RUNNER_TEMP: temp, RELEASE_VERSION: "1.2.3", GITHUB_SHA: "c".repeat(40), SERVER_PUBLIC_KEY: publicKey }, stdout: "pipe", stderr: "pipe",
    });
    const args = existsSync(join(temp, "gh-args")) ? readFileSync(join(temp, "gh-args"), "utf8").trim().split("\n") : [];
    return { code: result.exitCode, err: result.stderr.toString(), attached: args.filter((arg) => arg.includes("/server-binary/")).map((arg) => arg.split("/server-binary/")[1]!) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

test("publish downloads the signed server files and attaches each one by name, only once they verify", () => {
  const download = job("publish").steps!.find((candidate) => candidate.uses?.startsWith("actions/download-artifact@") && candidate.with?.["name"] === "ovis-server");
  expect(download?.with).toEqual({ name: "ovis-server", path: "${{ runner.temp }}/server-binary" });
  expect(step("publish", "Publish the validated commit").env?.["SERVER_PUBLIC_KEY"]).toBe("${{ needs.server-binary-sign.outputs.public_key }}");
  const { code, attached } = runAttach(() => {});
  expect(code).toBe(0);
  expect(attached.sort()).toEqual([...SERVER_FILES].sort());
});

test("publish names each server file it attaches: no glob over the folder", () => {
  const script = step("publish", "Publish the validated commit").run!;
  const create = script.split("\n").find((line) => line.trim().startsWith("gh release create"))!;
  expect(create).not.toMatch(/server-binary\/[^"\s]*[*?[]/);
  expect(script).toContain(`server_files=(${SERVER_FILES.join(" ")})`);
  expect(create).toContain('"${server_files[@]/#/$RUNNER_TEMP/server-binary/}"');
});

test("publish attaches nothing else that lands in the server folder, such as a key", () => {
  expect(runAttach((dir) => writeFileSync(join(dir, "ovis-server-signing-key.pem"), "secret")).code).not.toBe(0);
  expect(runAttach((dir) => writeFileSync(join(dir, "notes.txt"), "x")).attached).toEqual([]);
});

test("publish refuses server files signed for another version than the one it releases", () => {
  // signed again by the same key: the signature holds, only the version check can refuse it
  const { code, err, attached } = runAttach((dir, privateKeyPem) => {
    writeManifest(dir, { version: "1.2.2", sources: { server: "a".repeat(40), shared: "b".repeat(40) } });
    signManifest(dir, privateKeyPem);
  });
  expect(code).not.toBe(0);
  expect(err).toContain("is for version 1.2.2, not the expected 1.2.3");
  expect(attached).toEqual([]);
});

/** the sign step's own script, run as the job runs it, in a folder of stand-in binaries */
function runSignStep(key: string): { code: number; err: string; dir: string; output: string } {
  const temp = mkdtempSync(join(tmpdir(), "ovis-sign-step-"));
  const dir = join(temp, "server-binary");
  mkdirSync(dir);
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `binary for ${platform}\n`);
  writeManifest(dir, { version: "1.2.3", sources: { server: "a".repeat(40), shared: "b".repeat(40) } });
  const result = Bun.spawnSync(["bash", "-e", "-c", step("server-binary-sign", "Sign the manifest").run!], {
    cwd: root, env: { ...process.env, RUNNER_TEMP: temp, OVIS_SERVER_SIGNING_KEY: key, RELEASE_VERSION: "1.2.3", GITHUB_OUTPUT: join(temp, "github-output") }, stdout: "pipe", stderr: "pipe",
  });
  return { code: result.exitCode, err: result.stderr.toString(), dir, output: existsSync(join(temp, "github-output")) ? readFileSync(join(temp, "github-output"), "utf8") : "" };
}

test("without the secret the sign step fails and names it, and leaves nothing signed", () => {
  const { code, err, dir } = runSignStep("");
  try {
    expect(code).toBe(1);
    // the job's own annotation, which GitHub shows on the run's page, before the script is even started
    expect(err).toContain("::error title=Server binary not signed::");
    expect(err).toContain("OVIS_SERVER_SIGNING_KEY");
    expect(existsSync(join(dir, "ovis-server.json.sig"))).toBe(false);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});

/** every file under `dir`, however deep */
const filesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));

test("with a key the sign step writes a signature that key's public half verifies, hands on that key, and writes no key", () => {
  const { privateKeyPem, publicKey } = generateKeyPair();
  const { code, dir, output } = runSignStep(privateKeyPem);
  try {
    expect(code).toBe(0);
    expect(verifyRelease(dir, publicKey, { version: "1.2.3" })).toEqual({ ok: true, problems: [] });
    expect(output).toBe(`public_key=${publicKey}\n`);
    // no file the step leaves behind, in the uploaded folder or beside it, holds any line of the private key
    const keyLines = privateKeyPem.split("\n").filter((line) => line.length > 20 && !line.startsWith("-----"));
    for (const file of filesUnder(join(dir, ".."))) for (const line of keyLines) expect(readFileSync(file, "utf8")).not.toContain(line);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
});
