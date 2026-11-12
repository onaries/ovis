import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

const evidence = process.env.UI_EVIDENCE_DIR || null;
if (evidence) mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(evidence ?? tmpdir(), "fixture-"));
const repo = join(import.meta.dir, "..");
symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
writeFileSync(join(root, "index.html"), '<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/fixture.tsx"></script></html>');
symlinkSync(join(repo, "scripts/omo-usage-fixture.tsx"), join(root, "fixture.tsx"));
await build({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: join(root, "dist"), emptyOutDir: true } });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
  const path = new URL(request.url).pathname;
  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  return new Response(Bun.file(join(root, "dist", path === "/" ? "index.html" : path.slice(1))));
} });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 700 }, isMobile: width === 390, hasTouch: width === 390 });
    try {
      await context.addInitScript(theme => localStorage.setItem("ovis:settings", JSON.stringify({ language: "ko", theme })), theme);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${server.port}`);
      const usage = page.locator(".chat-turn-usage");
      await usage.waitFor();
      assert.match(await usage.innerText(), /입력/);
      assert.match(await usage.innerText(), /출력/);
      assert.match(await usage.innerText(), /75%/);
      await page.locator(".chat-turn").hover();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const boxes = await usage.locator(":scope > span").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
      assert.ok(boxes.every(box => box.left >= 0 && box.right <= width));
      if (evidence) await page.screenshot({ path: join(evidence, `${width}-${theme}.png`) });
      console.log(`PASS ${width}px ${theme}: input, output and 75% cache hit rate, without overflow`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); server.stop(); }
