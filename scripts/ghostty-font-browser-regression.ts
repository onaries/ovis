import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

const checkDir = process.env.CHECK_DIR;
if (!checkDir) throw new Error("Run through an isolated check directory");
const repo = join(import.meta.dir, "..");
const root = mkdtempSync(join(checkDir, "font-"));
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
symlinkSync(join(repo, "scripts/ghostty-font-fixture.ts"), join(root, "fixture.ts"));
writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="terminal" class="pane-terminal"></div><script type="module" src="/fixture.ts"></script></body></html>');
await build({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: join(root, "dist"), emptyOutDir: true } });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
  const path = new URL(request.url).pathname;
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  return new Response(Bun.file(join(root, "dist", path === "/" ? "index.html" : path.slice(1))));
} });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
const results: unknown[] = [];
try {
  for (const width of [390, 1440]) for (const dark of [false, true]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390 });
    const page = await context.newPage();
    await page.addInitScript(dark => {
      document.addEventListener("DOMContentLoaded", () => {
        document.body.style.background = dark ? "#171717" : "#fafafa";
        document.body.style.color = dark ? "#eee" : "#222";
      });
    }, dark);
    try {
      await page.goto("http://127.0.0.1:" + server.port + "/?dark=" + dark);
      await page.waitForFunction(() => Reflect.get(window, "fontFixture")?.ready);
      await page.locator('.pane-terminal[data-renderer="ghostty"]').waitFor();
      const measured = await page.evaluate(async () => {
        const fixture = Reflect.get(window, "fontFixture");
        const layer = document.querySelector<HTMLElement>(".ghostty-layer")!;
        const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const values: number[] = [];
        layer.style.letterSpacing = "4px";
        for (const cols of [43, 42, 43, 42]) {
          fixture.term.resize(cols, 12);
          await frames();
          values.push(parseFloat(layer.style.letterSpacing));
        }
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;letter-spacing:0";
        probe.textContent = "W".repeat(50);
        layer.querySelector(".ghostty-text")!.append(probe);
        const advance = probe.getBoundingClientRect().width / 50;
        probe.remove();
        const target = parseFloat(layer.style.getPropertyValue("--ghostty-cw")) - advance;
        return { values, target };
      });
      console.log(JSON.stringify({ width, dark, measured }));
      assert.ok(measured.values.every(value => Math.abs(value - measured.target) < 0.05), "refit inherits the previous spacing");
      await page.screenshot({ path: join(root, width + "-" + dark + "-mono.png") });
      await page.goto("http://127.0.0.1:" + server.port + "/?font=Arial&dark=" + dark);
      await page.waitForFunction(() => Reflect.get(window, "fontFixture")?.ready);
      await page.locator('.pane-terminal[data-renderer="ghostty"]').waitFor();
      assert.equal(await page.locator(".ghostty-layer").count(), 1, "libghostty keeps drawing proportional fonts");
      assert.ok(await page.locator(".ghostty-cell").count() > 0);
      assert.equal(await page.locator(".pane-terminal").getAttribute("data-fallback"), null);
      assert.match(await page.locator(".ghostty-text").textContent() ?? "", /Working for 55s/);
      await page.waitForFunction(() => [...document.querySelectorAll(".ghostty-row")].some(row => row.textContent?.trimEnd() === "WiWiWiWi"));
      const grid = await page.evaluate(() => {
        const fixture = Reflect.get(window, "fontFixture");
        const screen = document.querySelector<HTMLElement>(".xterm-screen")!;
        const row = [...screen.querySelectorAll(".ghostty-row")].find(row => row.textContent?.trimEnd() === "WiWiWiWi")!;
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        const left: number[] = [];
        for (let node = walker.nextNode(); node && left.length < 8; node = walker.nextNode()) for (let index = 0; index < (node.textContent?.length ?? 0) && left.length < 8; index++) {
          const range = document.createRange();
          range.setStart(node, index); range.setEnd(node, index + 1);
          left.push(range.getBoundingClientRect().left);
        }
        return { left, cell: screen.getBoundingClientRect().width / fixture.term.cols };
      });
      assert.equal(grid.left.length, 8);
      assert.ok(grid.left.slice(1).every((left, index) => Math.abs(left - grid.left[index]! - grid.cell) < 0.1), "proportional glyphs retain their grid columns");
      await page.screenshot({ path: join(root, width + "-" + dark + "-proportional.png") });
      results.push({ width, dark, stableRefits: true, proportionalGhostty: true });
    } finally { await context.close(); }
  }
  writeFileSync(join(root, "report.json"), JSON.stringify({ ok: true, results }, null, 2));
  console.log(JSON.stringify({ ok: true, root, cases: results.length }));
} finally { await browser.close(); server.stop(true); }
