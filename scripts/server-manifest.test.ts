import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, MANIFEST, releaseFile, SERVER_PLATFORMS, SIGNATURE, signManifest, SUMS, verifyRelease, writeManifest } from "./server-manifest.ts";

/** a signed release folder and the key that signs it, for attacks that change something and sign again */
function signedRelease(): { dir: string; privateKeyPem: string; publicKey: string } {
  const dir = releaseDir();
  const pair = generateKeyPair();
  writeManifest(dir, { version: "1.2.3", sources });
  signManifest(dir, pair.privateKeyPem);
  return { dir, ...pair };
}
/** the manifest rewritten as `edit` makes it, then signed again by the release's own key: only the key holder could */
function resigned(dir: string, privateKeyPem: string, edit: (text: string) => string): void {
  writeFileSync(join(dir, MANIFEST), edit(readFileSync(join(dir, MANIFEST), "utf8")));
  signManifest(dir, privateKeyPem);
}
const rejects = (dir: string, publicKey: string, expected: string, options: { version?: string } = {}) => {
  const result = verifyRelease(dir, publicKey, options);
  expect(result.ok).toBe(false);
  expect(result.problems).toHaveLength(1);
  expect(result.problems[0]).toContain(expected);
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** a release folder: one stand-in binary per platform, each with other bytes */
function releaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-server-release-"));
  dirs.push(dir);
  for (const platform of SERVER_PLATFORMS) writeFileSync(join(dir, releaseFile(platform)), `binary for ${platform}\n`);
  return dir;
}
const sources = { server: "a".repeat(40), shared: "b".repeat(40) };
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const script = join(import.meta.dir, "build-server.ts");
const cli = (args: string[], env: Record<string, string> = {}) => {
  const base: Record<string, string | undefined> = { ...process.env, OVIS_SERVER_PUBLIC_KEY: undefined, OVIS_SERVER_SIGNING_KEY: undefined };
  const result = Bun.spawnSync([process.execPath, script, ...args], { env: { ...base, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};

describe("the server's release manifest", () => {
  it("names each platform's binary with the SHA-256 of its bytes, and lists the same sums", () => {
    const dir = releaseDir();
    const manifest = writeManifest(dir, { version: "1.2.3", sources });
    const written = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
    expect(written).toEqual(manifest);
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.sources).toEqual(sources);
    expect(Object.keys(manifest.assets).sort()).toEqual([...SERVER_PLATFORMS].sort());
    for (const platform of SERVER_PLATFORMS) {
      expect(manifest.assets[platform]).toEqual({ file: releaseFile(platform), sha256: sha256(join(dir, releaseFile(platform))) });
    }
    const sums = readFileSync(join(dir, SUMS), "utf8").trim().split("\n").sort();
    expect(sums).toEqual(SERVER_PLATFORMS.map((platform) => `${sha256(join(dir, releaseFile(platform)))}  ${releaseFile(platform)}`).sort());
  });

  it("refuses a folder that misses a platform or holds anything else", () => {
    const missing = releaseDir();
    rmSync(join(missing, releaseFile("darwin-x64")));
    expect(() => writeManifest(missing, { version: "1.2.3", sources })).toThrow(releaseFile("darwin-x64"));
    const extra = releaseDir();
    writeFileSync(join(extra, "notes.txt"), "x");
    expect(() => writeManifest(extra, { version: "1.2.3", sources })).toThrow("notes.txt");
  });

  it("drops a signature left from an earlier manifest: it would not be over these bytes", () => {
    const dir = releaseDir();
    const { privateKeyPem } = generateKeyPair();
    writeManifest(dir, { version: "1.2.3", sources });
    signManifest(dir, privateKeyPem);
    writeManifest(dir, { version: "1.2.4", sources });
    expect(() => statSync(join(dir, SIGNATURE))).toThrow();
  });
});

describe("signing and verifying a release", () => {
  it("accepts the signed manifest and every binary it names", () => {
    const dir = releaseDir();
    const { privateKeyPem, publicKey } = generateKeyPair();
    writeManifest(dir, { version: "1.2.3", sources });
    expect(signManifest(dir, privateKeyPem)).toBe(publicKey);
    expect(verifyRelease(dir, publicKey)).toEqual({ ok: true, problems: [] });
  });

  it("rejects the manifest after one byte of it changes", () => {
    const dir = releaseDir();
    const { privateKeyPem, publicKey } = generateKeyPair();
    writeManifest(dir, { version: "1.2.3", sources });
    signManifest(dir, privateKeyPem);
    const bytes = readFileSync(join(dir, MANIFEST));
    bytes[bytes.length - 2] ^= 1;
    writeFileSync(join(dir, MANIFEST), bytes);
    const result = verifyRelease(dir, publicKey);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain(SIGNATURE);
  });

  it("rejects a manifest signed with another key", () => {
    const dir = releaseDir();
    writeManifest(dir, { version: "1.2.3", sources });
    signManifest(dir, generateKeyPair().privateKeyPem);
    expect(verifyRelease(dir, generateKeyPair().publicKey).ok).toBe(false);
  });

  it("names the platform whose binary no longer matches the signed manifest", () => {
    const dir = releaseDir();
    const { privateKeyPem, publicKey } = generateKeyPair();
    writeManifest(dir, { version: "1.2.3", sources });
    signManifest(dir, privateKeyPem);
    const binary = join(dir, releaseFile("linux-arm64"));
    const bytes = readFileSync(binary);
    bytes[0] ^= 1;
    writeFileSync(binary, bytes);
    const result = verifyRelease(dir, publicKey);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("linux-arm64");
  });
});

describe("bun scripts/build-server.ts", () => {
  it("keygen writes the private key for the owner alone and prints only the public key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-server-key-"));
    dirs.push(dir);
    const result = cli(["keygen", dir]);
    expect(result.code).toBe(0);
    const key = join(dir, "ovis-server-signing-key.pem");
    if (process.platform !== "win32") expect(statSync(key).mode & 0o777).toBe(0o600);
    const pem = readFileSync(key, "utf8");
    expect(pem).toStartWith("-----BEGIN PRIVATE KEY-----");
    const printed = result.out.trim();
    expect(printed).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(result.out + result.err).not.toContain(pem.split("\n")[1]!);
    // a second run never overwrites a key
    expect(cli(["keygen", dir]).code).not.toBe(0);
    expect(readFileSync(key, "utf8")).toBe(pem);
  });

  it("sign refuses without the signing key and names the secret", () => {
    const dir = releaseDir();
    writeManifest(dir, { version: "1.2.3", sources });
    const result = cli(["sign", dir], { OVIS_SERVER_SIGNING_KEY: "" });
    expect(result.code).toBe(1);
    expect(result.err).toContain("OVIS_SERVER_SIGNING_KEY");
    expect(() => statSync(join(dir, SIGNATURE))).toThrow();
  });

  it("verify refuses without a public key, accepts a signed release and exits 1 naming a changed platform", () => {
    const dir = releaseDir();
    const { privateKeyPem, publicKey } = generateKeyPair();
    writeManifest(dir, { version: "1.2.3", sources });
    expect(cli(["sign", dir], { OVIS_SERVER_SIGNING_KEY: privateKeyPem }).out.trim()).toContain(publicKey);
    const none = cli(["verify", dir]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("OVIS_SERVER_PUBLIC_KEY");
    expect(cli(["verify", dir, "--public-key", publicKey]).code).toBe(0);
    expect(cli(["verify", dir], { OVIS_SERVER_PUBLIC_KEY: publicKey }).code).toBe(0);
    const binary = join(dir, releaseFile("windows-x64"));
    writeFileSync(binary, Buffer.concat([readFileSync(binary), Buffer.from([0])]));
    const changed = cli(["verify", dir, "--public-key", publicKey]);
    expect(changed.code).toBe(1);
    expect(changed.err).toContain("windows-x64");
  });
});

it("keeps each platform's file name as installers fetch it", () => {
  expect(SERVER_PLATFORMS.map(releaseFile)).toEqual(["ovis-server-linux-x64", "ovis-server-linux-arm64", "ovis-server-darwin-arm64", "ovis-server-darwin-x64", "ovis-server-windows-x64.exe"]);
});

describe("verify accepts only the release as written, even when the key signed something else", () => {
  it("names each platform whose binary changed, every one of the five", () => {
    for (const platform of SERVER_PLATFORMS) {
      const { dir, publicKey } = signedRelease();
      const binary = join(dir, releaseFile(platform));
      writeFileSync(binary, Buffer.concat([readFileSync(binary), Buffer.from("x")]));
      rejects(dir, publicKey, `${platform}: ${releaseFile(platform)} does not match`);
    }
  });

  it("refuses a platform entry that names another file, even one that matches its hash", () => {
    const { dir, privateKeyPem, publicKey } = signedRelease();
    const other = releaseFile("linux-arm64");
    resigned(dir, privateKeyPem, (text) => text.replace(`"file": "${releaseFile("linux-x64")}"`, `"file": "${other}"`).replace(/("linux-x64": \{\s*"file": "[^"]+",\s*"sha256": ")[0-9a-f]{64}/, `$1${createHash("sha256").update(readFileSync(join(dir, other))).digest("hex")}`));
    rejects(dir, publicKey, "linux-x64");
  });

  it("refuses an extra platform, an unknown field and a duplicate key, in either order", () => {
    const extraPlatform = signedRelease();
    resigned(extraPlatform.dir, extraPlatform.privateKeyPem, (text) => text.replace('"assets": {', `"assets": {\n    "freebsd-x64": { "file": "x", "sha256": "${"0".repeat(64)}" },`));
    rejects(extraPlatform.dir, extraPlatform.publicKey, "platforms");
    const unknownField = signedRelease();
    resigned(unknownField.dir, unknownField.privateKeyPem, (text) => text.replace('{\n  "version"', '{\n  "channel": "beta",\n  "version"'));
    rejects(unknownField.dir, unknownField.publicKey, "exactly version, sources and assets");
    for (const bogusFirst of [true, false]) {
      const duplicate = signedRelease();
      resigned(duplicate.dir, duplicate.privateKeyPem, (text) => {
        const entry = /"linux-x64": \{[^}]*\}/.exec(text)![0];
        const bogus = entry.replace(/[0-9a-f]{64}/, "0".repeat(64));
        return text.replace(entry, bogusFirst ? `${bogus},\n    ${entry}` : `${entry},\n    ${bogus}`);
      });
      rejects(duplicate.dir, duplicate.publicKey, "canonical");
    }
    const notObject = signedRelease();
    resigned(notObject.dir, notObject.privateKeyPem, () => "[]\n");
    rejects(notObject.dir, notObject.publicKey, "exactly version, sources and assets");
    const notJson = signedRelease();
    resigned(notJson.dir, notJson.privateKeyPem, () => "{\n");
    rejects(notJson.dir, notJson.publicKey, "not JSON");
  });

  it("requires the sums file and that it lists exactly the manifest's sums", () => {
    const missing = signedRelease();
    rmSync(join(missing.dir, SUMS));
    rejects(missing.dir, missing.publicKey, `has no ${SUMS}`);
    const changed = signedRelease();
    writeFileSync(join(changed.dir, SUMS), readFileSync(join(changed.dir, SUMS), "utf8").replace(/^[0-9a-f]/, (c) => (c === "0" ? "1" : "0")));
    rejects(changed.dir, changed.publicKey, SUMS);
  });

  it("refuses a file a release does not have, and a missing signature", () => {
    const extra = signedRelease();
    writeFileSync(join(extra.dir, "ovis-server-signing-key.pem"), "x");
    rejects(extra.dir, extra.publicKey, "ovis-server-signing-key.pem");
    const unsigned = signedRelease();
    rmSync(join(unsigned.dir, SIGNATURE));
    rejects(unsigned.dir, unsigned.publicKey, SIGNATURE);
  });

  it("takes the signature and the public key only in their one canonical encoding", () => {
    for (const edit of [(text: string) => `${text.trim()}  \n`, (text: string) => `${text.trim()}AA\n`, (text: string) => text.trim(), (text: string) => `${text.trim()}\n\n`]) {
      const { dir, publicKey } = signedRelease();
      writeFileSync(join(dir, SIGNATURE), edit(readFileSync(join(dir, SIGNATURE), "utf8")));
      rejects(dir, publicKey, SIGNATURE);
    }
    const { dir, publicKey } = signedRelease();
    const raw = Buffer.from(publicKey, "base64");
    for (const other of [`${publicKey} `, ` ${publicKey}`, `${publicKey}AA`, raw.toString("hex"), raw.toString("base64url"), "A".repeat(43) + "="]) {
      expect(verifyRelease(dir, other).ok).toBe(false);
    }
    expect(verifyRelease(dir, publicKey).ok).toBe(true);
  });

  it("refuses a release of another version than the one asked for, which the signature alone would let through", () => {
    const { dir, privateKeyPem, publicKey } = signedRelease();
    resigned(dir, privateKeyPem, (text) => text.replace('"version": "1.2.3"', '"version": "1.2.2"'));
    expect(verifyRelease(dir, publicKey).ok).toBe(true);
    rejects(dir, publicKey, "not the expected 1.2.3", { version: "1.2.3" });
    expect(verifyRelease(dir, publicKey, { version: "1.2.2" }).ok).toBe(true);
  });

  it("says what is wrong in one line and exits 1, never with a stack trace", () => {
    const { dir, privateKeyPem, publicKey } = signedRelease();
    for (const args of [["--public-key", "not base64 at all"], ["--public-key", publicKey, "--expect-version", "9.9.9"]]) {
      const result = cli(["verify", dir, ...args]);
      expect(result.code).toBe(1);
      expect(result.err.trim().split("\n")).toHaveLength(1);
      expect(result.err).not.toMatch(/\n\s+at /);
    }
    resigned(dir, privateKeyPem, () => "[1,");
    const malformed = cli(["verify", dir, "--public-key", publicKey]);
    expect(malformed.code).toBe(1);
    expect(malformed.err.trim().split("\n")).toHaveLength(1);
    for (const args of [["--public-key"], ["--other", "x"], ["--public-key", publicKey, "--public-key", publicKey]]) expect(cli(["verify", dir, ...args]).code).toBe(2);
  });
});
