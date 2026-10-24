import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialBrowserScripts } from "./ci-browser-parallel.ts";

// Exercise the whole lane without installing Chromium, building, or opening a browser.
const stub = `
bun() {
  case "$1" in
    scripts/demo-build.ts) printf 'DEMO_DIR=%s\\n' "$HERDR_DEMO_BUILD";;
    scripts/*)
      [ "\${CHROME_PATH:-}" = /stub/chrome ] || return 91
      printf 'PASS stubbed browser step\\nFAIL stubbed browser marker\\nSERVER listening on http://127.0.0.1:3000\\nSTEP=%s EVIDENCE=%s\\n' "$1" "\${UI_EVIDENCE_DIR:-}";;
  esac
  if [ "$1" = "\${FAIL_SCRIPT:-}" ]; then return 7; fi
}
sudo() { return 0; }
bash() {
  if [ "$#" -eq 1 ] && [ "$1" = scripts/ci-chromium.sh ]; then
    printf '/stub/chrome\\n'
  else
    command bash "$@"
  fi
}
source "$1"
`;

async function lane(fail = "", kept = false, ci = "") {
  const dir = mkdtempSync(join(tmpdir(), "hwc-browser-test-"));
  try {
    const child = Bun.spawn(["bash", "-c", stub, "stub", join(import.meta.dir, "ci-browser.sh")], {
      cwd: dir,
      env: { ...process.env, BROWSER_PARALLEL: "", CI: ci, CHECK_DIR: kept ? dir : "", UI_EVIDENCE_DIR: "", FAIL_SCRIPT: fail, TMPDIR: dir },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe("");
    const demo = text.match(/^\[[^\]]+\] DEMO_DIR=(.+)$/m)?.[1];
    expect(demo).toBeDefined();
    expect(existsSync(demo ?? "")).toBe(false);
    return { text, code, evidence: existsSync(join(dir, kept ? "" : ".ci", "browser-evidence")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = (text: string) => [...text.matchAll(/^(scripts\/\S+)\s+(\d+)\s+(\d+)$/gm)].map((row) => ({
  script: row[1], seconds: Number(row[2]), code: Number(row[3]),
}));

describe("browser lane", () => {
  it("summarizes passing and failing scripts and stops at the original exit code", async () => {
    const { text, code } = await lane("scripts/sticky-modifiers-regression.ts");
    expect(code).toBe(7);
    expect(rows(text)).toEqual([
      { script: "scripts/demo-build.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/ui-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/ui-contexts-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/workspace-rows-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/pending-pane-switch-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/lan-exposure-notice-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/terminal-dispose-browser-qa.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/herdr-restart-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/sticky-modifiers-regression.ts", seconds: expect.any(Number), code: 7 },
    ]);
    expect(text).not.toMatch(/STEP=scripts\/key-bar-customization-demo-regression\.ts/);
    expect(text).toMatch(/^TIMING scripts\/sticky-modifiers-regression\.ts seconds=\d+ exit=7$/m);
    expect(text).toMatch(/^scripts\/sticky-modifiers-regression\.ts\s+\d+\s+7$/m);
    expect(text).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] SERVER listening on http:\/\/127\.0\.0\.1:3000$/m);
    expect(text).toMatch(/^PASS stubbed browser step$/m);
    expect(text).toMatch(/^FAIL stubbed browser marker$/m);
    expect(text).toMatch(/^Browser lane total: seconds=\d+ exit=7$/m);
  });

  it("summarizes every script and exits zero on success without enabling local evidence", async () => {
    const { text, code, evidence } = await lane();
    expect(code).toBe(0);
    expect(rows(text).map((row) => row.script)).toEqual(["scripts/demo-build.ts", ...serialBrowserScripts()]);
    expect(rows(text).map((row) => row.script)).toContain("scripts/codex-status-browser-regression.ts");
    expect(rows(text).every((row) => row.code === 0 && row.seconds >= 0)).toBe(true);
    expect(evidence).toBe(false);
    expect(text).not.toMatch(/EVIDENCE=.+/);
    expect(text).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] SERVER listening on http:\/\/127\.0\.0\.1:3000$/m);
    expect(text).toMatch(/^PASS stubbed browser step$/m);
    expect(text).toMatch(/^FAIL stubbed browser marker$/m);
  });

  it("keeps only cheap existing screenshots when CHECK_DIR is set", async () => {
    const { text, code, evidence } = await lane("", true);
    expect(code).toBe(0);
    expect(evidence).toBe(true);
    for (const script of ["sticky-modifiers-regression.ts", "file-viewer-regression.ts"]) {
      expect(text).toMatch(new RegExp(`^\\[[^\\]]+\\] STEP=scripts/${script} EVIDENCE=.+/browser-evidence$`, "m"));
    }
    for (const script of ["ui-regression.ts", "ui-contexts-regression.ts", "key-bar-customization-demo-regression.ts"]) {
      expect(text).toMatch(new RegExp(`^\\[[^\\]]+\\] STEP=scripts/${script} EVIDENCE=$`, "m"));
    }
  });

  it("creates evidence under .ci when CI has no CHECK_DIR", async () => {
    const { text, code, evidence } = await lane("", false, "1");
    expect(code).toBe(0);
    expect(evidence).toBe(true);
    expect(text).toMatch(/^\[[^\]]+\] STEP=scripts\/file-viewer-regression\.ts EVIDENCE=.ci\/browser-evidence$/m);
    expect(text).toMatch(/^Browser lane total: seconds=\d+ exit=0$/m);
  });
});

// Browser scripts that CI does not run: they are run by hand. A new browser script belongs in
// scripts/ci-browser.sh, or here when CI cannot run it.
const MANUAL_BROWSER_SCRIPTS = [
  "scripts/android-ime-regression.ts", // an Android emulator over ADB (docs/terminal-input.md)
  "scripts/chat-browser-qa.ts", // docs/development.md
  "scripts/font-swap-demo-regression.ts", // docs/development.md
  "scripts/keyboard-viewport-demo-regression.ts", // docs/development.md
  "scripts/machines-browser-qa.ts", // an SSH_TEST_KEEP=1 fixture (docs/remote-pcs.md)
  "scripts/output-browser-qa.ts", // docs/terminal-flow-control.md
  "scripts/pi-image-browser-qa.ts",
  "scripts/rewind-browser-qa.ts",
  "scripts/skill-activity-browser-qa.ts", // docs/chat-skill-activity.md
  "scripts/terminal-file-links-regression.ts",
  "scripts/update-browser-qa.ts", // a private Git remote and install (docs/app-updates.md)
  "scripts/windows-lens-browser-qa.ts",
  "scripts/windows-terminal-browser-qa.ts", // native Windows
];

/**
 * Every script the lane runs, plus every script those import (`from "./x.ts"`, `import("./x.ts")`)
 * or spawn (`spawn([..., join(import.meta.dir, "x.ts")`), transitively. A path built anywhere else
 * (a Bun.build entry, say) is not a run. A spawn counts only from a file that runs as a script: an
 * imported helper's spawn usually sits under `import.meta.main`.
 */
function laneReach(lane: string[]): Set<string> {
  const reached = new Set<string>();
  const ran = new Set<string>();
  const pending = lane.map((script) => ({ script, runs: true }));
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { script, runs } = next;
    const path = join(import.meta.dir, "..", script);
    // A name with no file behind it (terminal-dispose-fixture.ts is an in-memory Bun.build entry) has nothing to read.
    if ((runs ? ran : reached).has(script) || !existsSync(path)) continue;
    reached.add(script);
    if (runs) ran.add(script);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([\w.-]+\.tsx?)["']/g)) {
      pending.push({ script: `scripts/${match[1]}`, runs: false });
    }
    if (!runs) continue;
    for (const match of source.matchAll(/spawn(?:Sync)?\(\s*\[[^\]]*?import\.meta\.dir,\s*["']([\w.-]+\.tsx?)["']/g)) {
      pending.push({ script: `scripts/${match[1]}`, runs: true });
    }
  }
  return reached;
}

describe("browser lane assignment", () => {
  const lane = serialBrowserScripts();
  const onDisk = readdirSync(import.meta.dir).filter((name) => /-(regression|browser-qa)\.ts$/.test(name)).map((name) => `scripts/${name}`);

  it("runs each script once, and only scripts that exist", () => {
    expect(new Set(lane).size).toBe(lane.length);
    expect(lane.filter((script) => !existsSync(join(import.meta.dir, "..", script)))).toEqual([]);
  });

  it("runs every browser script on disk, directly or through a script it runs, unless it is manual", () => {
    const reached = laneReach(lane);
    expect(onDisk.filter((script) => !reached.has(script) && !MANUAL_BROWSER_SCRIPTS.includes(script))).toEqual([]);
  });

  it("keeps the manual list to scripts that exist and that CI does not run", () => {
    const reached = laneReach(lane);
    expect(MANUAL_BROWSER_SCRIPTS.filter((script) => !onDisk.includes(script) || reached.has(script))).toEqual([]);
  });
});
