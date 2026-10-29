import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import installPiIntegration, { PI_INTEGRATION_OWNERSHIP_BANNER } from "./install-pi-integration.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function agentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "herdr-pi-installer-"));
  roots.push(root);
  return root;
}

it("rejects an unknown CLI flag before installing anything", async () => {
  const root = agentDir();

  // HOME and pi's agent directory point at the temp root too, so a regression could never install into the real home
  const command = Bun.spawn([process.execPath, join(import.meta.dir, "install-pi-integration.ts"), "--agent-dir", root], {
    stdout: "ignore", stderr: "ignore", env: { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: root },
  });

  expect(await command.exited).toBe(1);
  expect(existsSync(join(root, "extensions"))).toBe(false);
});

it("installs only its own extension, leaving pi's settings and other extensions alone", async () => {
  const root = agentDir();
  const extensions = join(root, "extensions");
  mkdirSync(extensions);
  writeFileSync(join(extensions, "herdr-agent-state.ts"), "herdr's own");
  writeFileSync(join(root, "settings.json"), "{\"theme\":\"dark\"}");

  const result = await installPiIntegration({ agentDir: root, build: async () => "export default function extension() {}" });

  const target = join(extensions, "herdr-web-ui.js");
  expect(result).toEqual({ action: "installed", path: target });
  expect(readFileSync(target, "utf8")).toBe(`${PI_INTEGRATION_OWNERSHIP_BANNER}\nexport default function extension() {}\n`);
  expect(readFileSync(join(extensions, "herdr-agent-state.ts"), "utf8")).toBe("herdr's own");
  expect(readFileSync(join(root, "settings.json"), "utf8")).toBe("{\"theme\":\"dark\"}");
  if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
  expect(readdirSync(extensions).sort()).toEqual(["herdr-agent-state.ts", "herdr-web-ui.js"]);
});

it("refuses to replace or remove a file it did not write", async () => {
  const root = agentDir();
  mkdirSync(join(root, "extensions"));
  const target = join(root, "extensions", "herdr-web-ui.js");
  writeFileSync(target, "someone else's\n");

  await expect(installPiIntegration({ agentDir: root, build: async () => "x" })).rejects.toThrow("ownership banner");
  await expect(installPiIntegration({ agentDir: root, remove: true })).rejects.toThrow("ownership banner");
  expect(readFileSync(target, "utf8")).toBe("someone else's\n");
});

it("removes only its extension without building or pruning the directory", async () => {
  const root = agentDir();
  mkdirSync(join(root, "extensions"));
  const target = join(root, "extensions", "herdr-web-ui.js");
  writeFileSync(target, `${PI_INTEGRATION_OWNERSHIP_BANNER}\ninstalled\n`);
  writeFileSync(join(root, "extensions", "other.js"), "preserve");

  expect(await installPiIntegration({ agentDir: root, remove: true, build: async () => { throw new Error("remove must not build"); } }))
    .toEqual({ action: "removed", path: target });
  expect(existsSync(target)).toBe(false);
  expect(readFileSync(join(root, "extensions", "other.js"), "utf8")).toBe("preserve");
});

it("replaces its own extension and leaves it untouched when building fails", async () => {
  const root = agentDir();
  mkdirSync(join(root, "extensions"));
  const target = join(root, "extensions", "herdr-web-ui.js");
  writeFileSync(target, `${PI_INTEGRATION_OWNERSHIP_BANNER}\nold\n`);

  await expect(installPiIntegration({ agentDir: root, build: async () => { throw new Error("build failed"); } })).rejects.toThrow("build failed");
  expect(readFileSync(target, "utf8")).toBe(`${PI_INTEGRATION_OWNERSHIP_BANNER}\nold\n`);
  expect(readdirSync(join(root, "extensions"))).toEqual(["herdr-web-ui.js"]);

  await installPiIntegration({ agentDir: root, build: async () => "export default 2;" });
  expect(readFileSync(target, "utf8")).toBe(`${PI_INTEGRATION_OWNERSHIP_BANNER}\nexport default 2;\n`);
});

it("refuses to replace or remove a symlink at its extension path", async () => {
  if (process.platform === "win32") return;
  const root = agentDir();
  mkdirSync(join(root, "extensions"));
  const target = join(root, "extensions", "herdr-web-ui.js");
  const foreign = join(root, "extensions", "foreign.js");
  writeFileSync(foreign, "foreign target\n");
  symlinkSync(foreign, target);

  await expect(installPiIntegration({ agentDir: root, build: async () => "replacement" })).rejects.toThrow("regular installer-owned file");
  await expect(installPiIntegration({ agentDir: root, remove: true })).rejects.toThrow("regular installer-owned file");
  expect(readFileSync(foreign, "utf8")).toBe("foreign target\n");
  expect(existsSync(target)).toBe(true);
});

it("bundles a standalone Node module that pi can load", async () => {
  const root = agentDir();
  const { path } = await installPiIntegration({ agentDir: root });
  const output = readFileSync(path, "utf8");

  expect(output.split("\n")[0]).toBe(PI_INTEGRATION_OWNERSHIP_BANNER);
  expect(output).toContain("@eko24ive/pi-ask:submit");
  expect(output).not.toMatch(/from ["']\.\.\/(?:server|shared)\//);
  const loaded = await import(path) as { default: unknown };
  expect(typeof loaded.default).toBe("function");
});
