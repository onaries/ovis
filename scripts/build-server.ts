/**
 * The server as one compiled binary, whose first argument names the entry it runs (server/entries.ts):
 *
 *   bun scripts/build-server.ts <platform> <dir>   <dir>/ovis-server (ovis-server.exe on Windows), with the Node PTY
 *                                                 host script beside it; it serves dist/ from OVIS_ASSETS, else
 *                                                 from its own folder
 *   bun scripts/build-server.ts release <dir>      the five platforms' binaries as a release names them
 *   bun scripts/build-server.ts manifest <dir>     ovis-server.json and ovis-server.SHA256SUMS for those
 *   bun scripts/build-server.ts sign <dir>         ovis-server.json.sig, with the private key in OVIS_SERVER_SIGNING_KEY;
 *                                                 prints the public key that verifies it, alone, on stdout
 *   bun scripts/build-server.ts verify <dir> [--public-key <base64>] [--expect-version <X.Y.Z>]
 *                                                 the folder, the signature (key from the flag or OVIS_SERVER_PUBLIC_KEY),
 *                                                 the manifest, every binary and the sums; exit 1 with one line naming
 *                                                 what does not match. A consumer passes the version it asked for: the
 *                                                 signature alone does not stop an older release being offered
 *   bun scripts/build-server.ts keygen <dir>       a new signing key pair, once, for the owner (docs/development.md)
 *
 * Platforms: linux-x64, linux-arm64, darwin-arm64, darwin-x64, windows-x64. What else a folder that runs the binary
 * holds is scripts/server-artifact.ts; how the release signs and attaches these files is .github/workflows/release.yml.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateKeyPair, KEY_FILE, PUBLIC_KEY_VARIABLE, releaseFile, SERVER_PLATFORMS, type ServerPlatform, SIGNING_KEY_VARIABLE, signManifest, sourceTrees, verifyRelease, writeManifest } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");
const USAGE = `usage: bun scripts/build-server.ts <${SERVER_PLATFORMS.join("|")}> <dir> | release <dir> | manifest <dir> | sign <dir> | verify <dir> [--public-key <base64>] [--expect-version <X.Y.Z>] | keygen <dir>`;
const isPlatform = (value: string | undefined): value is ServerPlatform => (SERVER_PLATFORMS as readonly string[]).includes(value ?? "");
const fail = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

// the compile and what it needs load only for a build: sign and verify run where no package is installed
const artifact = () => import("./server-artifact.ts");

async function main(args: string[]): Promise<void> {
  const [verb, dir, ...rest] = args;
  if (dir === undefined) fail(USAGE, 2);
  const out = resolve(dir!);
  if (isPlatform(verb) && rest.length === 0) {
    const { binaryName, buildBinary } = await artifact();
    mkdirSync(out, { recursive: true });
    await buildBinary(verb, join(out, binaryName(verb)));
    copyFileSync(join(root, "server", "pty", "pty-host.mjs"), join(out, "pty-host.mjs"));
  } else if (verb === "release" && rest.length === 0) {
    const { binaryName, buildBinary } = await artifact();
    mkdirSync(out, { recursive: true });
    for (const platform of SERVER_PLATFORMS) {
      const staging = mkdtempSync(join(out, `.${platform}-`));
      try {
        await buildBinary(platform, join(staging, binaryName(platform)));
        renameSync(join(staging, binaryName(platform)), join(out, releaseFile(platform)));
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
  } else if (verb === "manifest" && rest.length === 0) {
    const sources = sourceTrees();
    if ("error" in sources) fail(sources.error);
    const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    console.log(JSON.stringify(writeManifest(out, { version, sources: sources as { server: string; shared: string } }), null, 2));
  } else if (verb === "sign" && rest.length === 0) {
    const key = process.env[SIGNING_KEY_VARIABLE]?.trim();
    if (!key) fail(`${SIGNING_KEY_VARIABLE} is not set, so ovis-server.json cannot be signed and the release must not be published. The owner adds the secret ${SIGNING_KEY_VARIABLE} to the environment release-signing (docs/development.md, "The server binary's signing key").`);
    let publicKey = "";
    try {
      publicKey = signManifest(out, `${key}\n`);
    } catch (error) {
      fail(`ovis-server.json was not signed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const check = verifyRelease(out, publicKey);
    if (!check.ok) fail(check.problems.join("\n"));
    console.error("signed ovis-server.json");
    console.log(publicKey);
  } else if (verb === "verify") {
    const options = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
      const [flag, value] = [rest[index]!, rest[index + 1]];
      if (!["--public-key", "--expect-version"].includes(flag) || value === undefined || options.has(flag)) fail(USAGE, 2);
      options.set(flag, value!);
    }
    const publicKey = options.get("--public-key") ?? process.env[PUBLIC_KEY_VARIABLE];
    if (!publicKey) fail(`verify needs the release's public key: pass --public-key <base64> or set ${PUBLIC_KEY_VARIABLE}`, 2);
    const version = options.get("--expect-version");
    const result = verifyRelease(out, publicKey!, version === undefined ? {} : { version });
    if (!result.ok) fail(result.problems.join("\n"));
    console.log(`ovis-server.json${version === undefined ? "" : ` for ${version}`} is signed by ${publicKey}, and every binary matches it`);
  } else if (verb === "keygen" && rest.length === 0) {
    // the file's mode keeps the key to its owner on Linux and macOS; on Windows a mode sets no access rule, and the key
    // would be as readable as the folder it lands in
    if (process.platform === "win32") fail("keygen does not run on Windows, where it cannot make the key file readable by you alone: run it on Linux or macOS");
    const { privateKeyPem, publicKey } = generateKeyPair();
    mkdirSync(out, { recursive: true });
    try {
      writeFileSync(join(out, KEY_FILE), privateKeyPem, { mode: 0o600, flag: "wx" });
    } catch (error) {
      fail(`${join(out, KEY_FILE)} was not written (${error instanceof Error ? error.message : String(error)}); an existing key is never replaced`);
    }
    console.log(publicKey);
    console.error(`private key: ${join(out, KEY_FILE)} (readable by you alone). Put it in the secret ${SIGNING_KEY_VARIABLE} of the environment release-signing, never a repository secret: gh secret set ${SIGNING_KEY_VARIABLE} --env release-signing --repo devswha/ovis < <that file>. Keep a copy offline, then delete this file.`);
  } else {
    fail(USAGE, 2);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
