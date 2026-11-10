import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The existing compact title names its pane's full context without adding a second h1.
// A desktop split uses this title too; an ordinary desktop uses its tab strip instead.
const app = mkdtempSync(join(tmpdir(), "ovis-header-context-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
        try {
          await context.addInitScript(({ width, theme }) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
            if (width === 1440) sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: "w1C:p1" }, bSide: "right", active: "a" }));
          }, { width, theme });
          for (const pane of [
            { id: "w1H:p1", title: "Fix the flaky retry test", agent: "Claude Code", workspace: "flaky-retry-test" },
            { id: "w1D:p1", title: "Guard the export button", agent: "Codex", workspace: "export-guard" },
          ]) {
            const page = await context.newPage();
            try {
              const errors: string[] = [];
              page.on("pageerror", (error) => errors.push(error.message));
              await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane.id)}`);
              const title = page.locator(".context-title-text");
              await title.waitFor();
              await appFaces(page);
              const snapshot = await title.ariaSnapshot();
              const full = `${pane.agent} · workstation · ${pane.workspace} · ${pane.title} · /home/demo/.herdr/worktrees/checkout-api/${pane.workspace}`;
              const label = `${width}-${theme}-${pane.workspace}`;
              if (evidence) {
                writeFileSync(join(evidence, `${label}.txt`), snapshot);
                await page.screenshot({ path: join(evidence, `${label}.png`), animations: "disabled" });
              }
              assert.ok(snapshot.includes(`group "${full}"`), `${label}: accessible title names the agent, PC, workspace, title and complete path: ${snapshot}`);
              assert.equal(await title.textContent(), pane.title, "visible text is unchanged");
              assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1, "the copy lane's hidden h1 stays the only first-level heading");
              assert.equal(await page.locator("h1.visually-hidden").textContent(), pane.title);
              assert.deepEqual(errors, []);
              console.log(`PASS ${label}: full accessible context and one unchanged h1`);
            } finally { await page.close(); }
          }
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
