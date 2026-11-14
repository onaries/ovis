/**
 * The release's server binaries and what vouches for them: `ovis-server.json` (the version, the git trees of server/
 * and shared/ they were built from, and the SHA-256 of each platform's file), `ovis-server.SHA256SUMS`, and
 * `ovis-server.json.sig`, an Ed25519 signature over the manifest's exact bytes, base64 on one line.
 *
 * The private key lives only in the secret OVIS_SERVER_SIGNING_KEY (a PKCS#8 PEM) of the environment release-signing, which
 * only main may use, never in a repository secret, and with the owner
 * offline; the public key is 32 raw bytes in base64. This file imports Node's built-ins alone, so the release job
 * that signs runs it without installing a single package next to the key.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SERVER_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64"] as const;
export type ServerPlatform = typeof SERVER_PLATFORMS[number];
export const MANIFEST = "ovis-server.json";
export const SIGNATURE = `${MANIFEST}.sig`;
/** not plain SHA256SUMS: the release also carries the Rust PTY host's, under that name */
export const SUMS = "ovis-server.SHA256SUMS";
/** the environment release-signing's secret, and the variable the sign step reads it from */
export const SIGNING_KEY_VARIABLE = "OVIS_SERVER_SIGNING_KEY";
export const PUBLIC_KEY_VARIABLE = "OVIS_SERVER_PUBLIC_KEY";
export const KEY_FILE = "ovis-server-signing-key.pem";

/** The name a platform's binary has in a release. */
export const releaseFile = (platform: ServerPlatform): string => `ovis-server-${platform}${platform === "windows-x64" ? ".exe" : ""}`;

export interface ServerManifest {
  version: string;
  /** git tree ids of server/ and shared/ the binaries were built from */
  sources: { server: string; shared: string };
  assets: Record<ServerPlatform, { file: string; sha256: string }>;
}

const root = resolve(import.meta.dir, "..");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The git trees of server/ and shared/ in this checkout, or why there are none to name: outside a git checkout, or
 * with changes there that are not committed, a manifest would name sources the binaries were not built from.
 */
export function sourceTrees(cwd = root): { server: string; shared: string } | { error: string } {
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
  const status = git("status", "--porcelain", "--untracked-files=all", "--", "server", "shared");
  if (status.exitCode !== 0) return { error: "not a git checkout, so the binaries cannot be tied to their sources" };
  if (status.stdout.toString().trim() !== "") return { error: "server/ or shared/ has changes that are not committed, so the binaries would not be built from HEAD's sources" };
  const [server, shared] = ["server", "shared"].map((dir) => git("rev-parse", `HEAD:${dir}`).stdout.toString().trim());
  return { server: server!, shared: shared! };
}

/** Writes the manifest and the sums for the five binaries in `dir`, and drops a signature an earlier manifest had. */
export function writeManifest(dir: string, release: { version: string; sources: ServerManifest["sources"] }): ServerManifest {
  const names = new Set(SERVER_PLATFORMS.map(releaseFile));
  const missing = [...names].filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) throw new Error(`${dir} has no ${missing.join(", ")}`);
  const extra = readdirSync(dir).filter((name) => !names.has(name) && name !== MANIFEST && name !== SUMS && name !== SIGNATURE);
  if (extra.length > 0) throw new Error(`Unexpected files in ${dir}: ${extra.join(", ")}`);
  const assets = Object.fromEntries(SERVER_PLATFORMS.map((platform) => [platform, { file: releaseFile(platform), sha256: sha256(readFileSync(join(dir, releaseFile(platform)))) }])) as ServerManifest["assets"];
  const manifest: ServerManifest = { version: release.version, sources: release.sources, assets };
  rmSync(join(dir, SIGNATURE), { force: true });
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, SUMS), SERVER_PLATFORMS.map((platform) => `${assets[platform].sha256}  ${assets[platform].file}\n`).join(""));
  return manifest;
}

/** DER prefix of an Ed25519 SubjectPublicKeyInfo: the 32 raw key bytes follow it */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/**
 * `text` as the bytes it encodes, only when `text` is exactly their standard padded base64: no whitespace, no bytes
 * after the padding, nothing a lenient decoder would skip. Anything else is null.
 */
function strictBase64(text: string, length: number): Buffer | null {
  const bytes = Buffer.from(text, "base64");
  return bytes.length === length && bytes.toString("base64") === text ? bytes : null;
}

function publicKeyObject(publicKey: string) {
  const raw = strictBase64(publicKey, 32);
  if (!raw) throw new Error("The public key must be exactly 32 bytes in standard base64, with nothing around it");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: "der", type: "spki" });
}

/** The public key of a PEM private key, as `verify` takes it. */
export function publicKeyOf(privateKeyPem: string): string {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "der", type: "spki" });
  return der.subarray(ED25519_SPKI.length).toString("base64");
}

export function generateKeyPair(): { privateKeyPem: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { privateKeyPem, publicKey: publicKeyOf(privateKeyPem) };
}

/** Signs `dir`'s manifest; returns the public key that verifies it. */
export function signManifest(dir: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${SIGNING_KEY_VARIABLE} is not an Ed25519 private key`);
  const signature = sign(null, readFileSync(join(dir, MANIFEST)), key);
  writeFileSync(join(dir, SIGNATURE), `${signature.toString("base64")}\n`);
  return publicKeyOf(privateKeyPem);
}

const sameKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);

/**
 * The manifest, only when its bytes are exactly what writeManifest writes for it: the three fields, the two source
 * trees and the five platforms, in that order, each with its file and SHA-256, and nothing else. Comparing the bytes with
 * their own re-serialisation also refuses a duplicate key, which JSON.parse would otherwise settle silently.
 */
function canonicalManifest(bytes: Buffer): ServerManifest | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return `${MANIFEST} is not JSON`;
  }
  if (!sameKeys(parsed, ["version", "sources", "assets"])) return `${MANIFEST} must hold exactly version, sources and assets`;
  if (typeof parsed["version"] !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(parsed["version"])) return `${MANIFEST} names no version`;
  const sources = parsed["sources"];
  if (!sameKeys(sources, ["server", "shared"]) || !Object.values(sources).every((tree) => typeof tree === "string" && /^[0-9a-f]{40}$/.test(tree))) return `${MANIFEST} must name exactly the git trees of server and shared`;
  const assets = parsed["assets"];
  if (!sameKeys(assets, SERVER_PLATFORMS)) return `${MANIFEST} must name exactly the platforms ${SERVER_PLATFORMS.join(", ")}`;
  for (const platform of SERVER_PLATFORMS) {
    const entry = assets[platform];
    if (!sameKeys(entry, ["file", "sha256"]) || entry["file"] !== releaseFile(platform) || typeof entry["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(entry["sha256"])) {
      return `${platform}: ${MANIFEST} must name ${releaseFile(platform)} and its SHA-256, and nothing else`;
    }
  }
  if (bytes.toString("utf8") !== `${JSON.stringify(parsed, null, 2)}\n`) return `${MANIFEST} is not in its canonical form (a duplicate key, other spacing or another encoding)`;
  return parsed as unknown as ServerManifest;
}

/**
 * Checks `dir` as an installer will, and stops at the first part that fails:
 * - the folder holds exactly the five binaries, the manifest, its signature and the sums file;
 * - the signature, by `publicKey`, over the manifest's exact bytes (both strictly base64); only a manifest that passes is read;
 * - the manifest in its canonical form, and, when `expected.version` is given, for that version: a signature alone
 *   does not stop an older release, signed by the same key, from being offered as a newer one;
 * - every binary against its SHA-256, and the sums file, which is required, against the manifest.
 * Each problem is one line; a binary's names its platform.
 */
export function verifyRelease(dir: string, publicKey: string, expected: { version?: string } = {}): { ok: boolean; problems: string[] } {
  try {
    const key = publicKeyObject(publicKey);
    const allowed = new Set([...SERVER_PLATFORMS.map(releaseFile), MANIFEST, SIGNATURE, SUMS]);
    const present = readdirSync(dir);
    const extra = present.filter((name) => !allowed.has(name));
    if (extra.length > 0) return { ok: false, problems: [`${dir} holds files a release does not: ${extra.join(", ")}`] };
    const missing = [MANIFEST, SIGNATURE, SUMS].filter((name) => !present.includes(name));
    if (missing.length > 0) return { ok: false, problems: [`${dir} has no ${missing.join(", ")}`] };
    const bytes = readFileSync(join(dir, MANIFEST));
    const signatureText = readFileSync(join(dir, SIGNATURE), "utf8");
    const signature = signatureText.endsWith("\n") ? strictBase64(signatureText.slice(0, -1), 64) : null;
    if (!signature) return { ok: false, problems: [`${SIGNATURE} is not one line of standard base64 holding a 64-byte signature`] };
    if (!verify(null, bytes, key, signature)) return { ok: false, problems: [`${SIGNATURE} is not a signature of this ${MANIFEST} by the key ${publicKey}`] };
    const manifest = canonicalManifest(bytes);
    if (typeof manifest === "string") return { ok: false, problems: [manifest] };
    if (expected.version !== undefined && manifest.version !== expected.version) return { ok: false, problems: [`${MANIFEST} is for version ${manifest.version}, not the expected ${expected.version}`] };
    const problems: string[] = [];
    for (const platform of SERVER_PLATFORMS) {
      const { file, sha256: digest } = manifest.assets[platform];
      if (!present.includes(file)) problems.push(`${platform}: ${file} is missing`);
      else if (sha256(readFileSync(join(dir, file))) !== digest) problems.push(`${platform}: ${file} does not match its SHA-256 in ${MANIFEST}`);
    }
    const expectedSums = SERVER_PLATFORMS.map((platform) => `${manifest.assets[platform].sha256}  ${releaseFile(platform)}\n`).join("");
    if (readFileSync(join(dir, SUMS), "utf8") !== expectedSums) problems.push(`${SUMS} does not list exactly the sums ${MANIFEST} names`);
    return { ok: problems.length === 0, problems };
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  }
}
