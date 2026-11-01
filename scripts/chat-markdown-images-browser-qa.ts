/** Real browser and HTTP bytes; the pane API fixture has a foreground cwd different from the hint. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-chat-images-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let status = 503;
let kind = "image";
const stats: URL[] = [];
const reads: string[] = [];
const foreground = "/repo/subproject";
const foregroundPath = `${foreground}/out/diagram.svg`;
const image = (width: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="80"><rect width="${width}" height="80" fill="teal"/></svg>`;

try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-markdown-images-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"production"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/machines/fixture-pc/fs/stat") {
      stats.push(url);
      assert.equal(url.searchParams.get("pane_id"), "w1:p1");
      if (status !== 200) return Response.json({ error: { code: "not_found", message: "not ready" } }, { status });
      const target = url.searchParams.get("path")!;
      const path = posix.isAbsolute(target) ? target : posix.resolve(foreground, target);
      return Response.json({ path, name: posix.basename(path), size: 100, modified: "2026-10-30T00:00:00Z", mime: "image/svg+xml", kind });
    }
    if (url.pathname === "/api/machines/fixture-pc/fs/file") {
      assert.equal(url.searchParams.get("pane_id"), "w1:p1");
      const path = url.searchParams.get("path")!;
      reads.push(path);
      return new Response(image(path === foregroundPath ? 240 : 16), { headers: { "content-type": "image/svg+xml", "cache-control": "no-store" } });
    }
    if (url.pathname === "/") return new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-markdown-images-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-markdown-images-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    if (/^\/chat-markdown-images-fixture\.(?:js|css)$/.test(url.pathname)) return new Response(Bun.file(join(root, url.pathname.slice(1))));
    return new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  const decoded = () => page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>("img.markdown-image");
    return image?.complete && image.naturalWidth === 240;
  });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await retry.waitFor();
  const before = stats.length;
  await page.evaluate(() => window.imageQa.update("Updated answer: ![Diagram](./out/diagram.svg)"));
  await page.getByText("Updated answer:", { exact: true }).waitFor();
  assert.equal(stats.length, before, "text updates neither hide Retry nor start an automatic loop");
  status = 200;
  await retry.click();
  await decoded();
  assert.equal(stats.length, before + 1);
  assert.equal(stats.at(-1)!.searchParams.get("path"), "./out/diagram.svg");
  assert.equal(reads.at(-1), foregroundPath);
  console.log("PASS A 503 recovers on Try again without reconnect or remount; relative stat and canonical bytes keep the owning PC and pane");

  status = 404;
  await page.reload();
  await retry.waitFor();
  status = 200;
  await retry.click();
  await decoded();
  console.log("PASS A missing image can be retried after it becomes available");

  kind = "text";
  await page.reload();
  await page.getByText("Diagram", { exact: true }).waitFor();
  assert.equal(await retry.count(), 0);
  assert.equal(await page.locator("img.markdown-image").count(), 0);
  console.log("PASS A non-image reference stays fallback without a retry button");
  kind = "image";
  await page.reload();
  await decoded();
  await page.getByRole("button", { name: "Diagram", exact: true }).click();
  const viewer = page.getByRole("dialog", { name: "Image viewer", exact: true });
  await viewer.waitFor();
  assert.equal(await viewer.getByRole("link", { name: "Download", exact: true }).getAttribute("download"), "diagram.svg");
  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "detached" });
  console.log("PASS The recovered image still opens in the viewer with its actual filename");

  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
