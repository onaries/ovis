import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A tap on the dimmed page around a phone's sheet closes the sheet and goes nowhere else: the whole tap (its touch,
// pointer and mouse events and the click the browser sends after the touch ends) lands on the scrim, not on the row
// or the pane behind it. Real touch input in an Android WebView's shape (Playwright's touchscreen, a mobile context):
// a click dispatched on the scrim would not show it, since the leak was the rest of the tap hit-testing through a
// sheet that had already closed on its pointerdown. On the unmodified app over the demo's fixture transport.
const app = mkdtempSync(join(tmpdir(), "ovis-sheet-outside-tap-"));
const PHONE = { width: 390, height: 844 };
const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36";
const errors: string[] = [];
/** the steps that failed: each says where it failed, and the steps after it still run */
const failures: string[] = [];

interface Seen { type: string; target: string; onScrim: boolean; inList: boolean }
interface Point { x: number; y: number }

declare global {
  interface Window { tapSeen: Seen[] }
}

/** Notes every event of a tap on the document, in its capture phase: before the app's own handlers see it. */
function recordTaps(): void {
  window.tapSeen = [];
  const describe = (node: Element): string => `${node.tagName.toLowerCase()}${typeof node.className === "string" && node.className ? `.${node.className.trim().split(/\s+/).join(".")}` : ""}`;
  for (const type of ["touchstart", "pointerdown", "touchend", "pointerup", "mousedown", "mouseup", "click"]) {
    document.addEventListener(type, (event) => {
      const target = event.target instanceof Element ? event.target : document.documentElement;
      window.tapSeen.push({ type, target: describe(target), onScrim: target.closest(".modal-scrim") !== null, inList: target.closest(".mode-inbox") !== null });
    }, true);
  }
}

const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const address = (page: Page) => page.evaluate(() => {
  const query = new URL(location.href).searchParams;
  return { app: query.get("app"), pane: query.get("pane") };
});

/** The centre of the first of `selector`'s elements that lies wholly above `top`: outside a sheet risen to there. */
const pointAbove = (page: Page, selector: string, top: number): Promise<Point | null> => page.locator(selector).evaluateAll((nodes, top) => {
  for (const node of nodes) {
    const box = node.getBoundingClientRect();
    if (box.height > 0 && box.bottom < top - 4) return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  }
  return null;
}, top);
const topOf = (page: Page, selector: string): Promise<number> => page.locator(selector).first().evaluate((node) => node.getBoundingClientRect().top);

/** a finger on a touch screen, or a mouse on a narrow window: both see the sheet */
type Pointer = "touch" | "mouse";

/**
 * One real tap (or mouse click) at `point`, and what it reached: every event of it. A touch's click comes last, after
 * the touch has ended and the mouse events the browser makes of it, so it is waited for. A mouse click is done when
 * its button is up: a press and a release on different elements (a sheet gone from under it) make no click at all.
 */
async function tap(page: Page, point: Point, pointer: Pointer = "touch"): Promise<Seen[]> {
  await page.evaluate(() => { window.tapSeen.length = 0; });
  if (pointer === "touch") {
    await page.touchscreen.tap(point.x, point.y);
    await page.waitForFunction(() => window.tapSeen.some((seen) => seen.type === "click"), undefined, { timeout: 5_000 });
  } else await page.mouse.click(point.x, point.y);
  await frames(page);
  return page.evaluate(() => window.tapSeen);
}
/** what of the tap landed anywhere but on the scrim, in words */
const behind = (seen: Seen[]): string[] => seen.filter((event) => !event.onScrim).map((event) => `${event.type} on ${event.target}`);

async function withPhone(browser: Browser, base: string, path: string, what: string, run: (page: Page) => Promise<void>, pointer: Pointer = "touch"): Promise<void> {
  const touch = pointer === "touch";
  const context = await browser.newContext(touch ? { viewport: PHONE, isMobile: true, hasTouch: true, locale: "en-US", userAgent: ANDROID_WEBVIEW } : { viewport: PHONE, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      if (location.protocol === "about:") return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light" }));
    });
    await context.addInitScript(recordTaps);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${what}: ${error.message}`));
    try {
      await page.goto(base + path);
      await run(page);
      console.log(`PASS ${what}`);
    } catch (error) {
      failures.push(what);
      console.log(`FAIL ${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    await context.close();
  }
}

/** A sheet of the mode's list, opened from `button`, then a tap on a row above it: the sheet goes and the list stays. */
async function listSheet(page: Page, button: string, name: string, pointer: Pointer = "touch"): Promise<void> {
  await page.locator(".mode-inbox .inbox-item").first().waitFor({ timeout: 20_000 });
  if (pointer === "touch") await page.locator(button).tap();
  else await page.locator(button).click();
  await page.locator(".row-sheet").waitFor();
  const point = await pointAbove(page, ".mode-inbox .inbox-item", await topOf(page, ".row-sheet"));
  assert.ok(point !== null, `a row of the list shows above the ${name}`);
  const seen = await tap(page, point, pointer);
  await page.locator(".row-sheet").waitFor({ state: "detached", timeout: 5_000 });
  const at = await address(page);
  assert.ok(await page.locator(".mode-inbox").count() === 1 && at.app === "inbox" && at.pane === null,
    `a tap on a row outside the ${name} closes it and opens no thread: the address says ${JSON.stringify(at)}, the list ${await page.locator(".mode-inbox").count() === 1 ? "shows" : "is gone"}, and the tap reached ${behind(seen).join(", ") || "only the scrim"}`);
  assert.deepEqual(behind(seen), [], `every event of the tap outside the ${name} lands on its scrim`);
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      await withPhone(browser, base, "/?app=inbox", "(a) the list's More sheet: a tap on a row outside it closes it alone", (page) => listSheet(page, ".mode-inbox .inbox-more", "More sheet"));
      await withPhone(browser, base, "/?app=inbox", "(b) the state filter's sheet: a tap on a row outside it closes it alone", (page) => listSheet(page, ".mode-inbox .inbox-filter-toggle", "filter sheet"));
      await withPhone(browser, base, "/?app=inbox", "(e) the list's More sheet under a mouse on a narrow window: a click on a row outside it closes it alone", (page) => listSheet(page, ".mode-inbox .inbox-more", "More sheet", "mouse"), "mouse");

      // Settings closes on its scrim's mousedown, after the touch has ended: the guard that a dialog's close leaves
      // the list alone too
      await withPhone(browser, base, "/?app=inbox", "(c) Settings from the list's More: a tap above it closes it alone", async (page) => {
        await page.locator(".mode-inbox .inbox-item").first().waitFor({ timeout: 20_000 });
        await page.locator(".mode-inbox .inbox-more").tap();
        await page.locator('.row-sheet [data-item="settings"]').tap();
        await page.locator(".settings-dialog").waitFor();
        // a user taps what has risen: the dialog and its scrim have ended their entrance
        await page.waitForFunction(() => {
          const dialog = document.querySelector(".settings-dialog");
          return dialog !== null && dialog.getAnimations().length === 0 && dialog.parentElement?.getAnimations().length === 0;
        }, undefined, { timeout: 5_000 });
        const top = await topOf(page, ".settings-dialog");
        assert.ok(top >= 8, `Settings leaves a gap above it to tap: its top is at ${top}`);
        const seen = await tap(page, { x: PHONE.width / 2, y: Math.round(top / 2) });
        await page.locator(".settings-dialog").waitFor({ state: "detached", timeout: 5_000 });
        const at = await address(page);
        assert.ok(await page.locator(".mode-inbox").count() === 1 && at.app === "inbox" && at.pane === null, `the list stays: the address says ${JSON.stringify(at)}`);
        // its scrim goes on the mousedown, so the mouseup after it is hit-tested onto the list: no click follows it there
        assert.deepEqual(seen.filter((event) => event.type === "click" && event.inList).map((event) => event.target), [], "the tap's click reaches nothing in the list");
      });

      // older than the mode: the classic app's More over a pane
      await withPhone(browser, base, `/?pane=${encodeURIComponent(panes.omp)}&view=chat`, "(d) the classic More sheet over a pane: a tap above it lands on its scrim alone", async (page) => {
        await page.locator(".pane-frame.is-current").waitFor({ timeout: 20_000 });
        await page.locator(".header-more-button").tap();
        await page.locator(".row-sheet").waitFor();
        const top = await topOf(page, ".row-sheet");
        const seen = await tap(page, { x: PHONE.width / 2, y: Math.round(top / 2) });
        await page.locator(".row-sheet").waitFor({ state: "detached", timeout: 5_000 });
        assert.deepEqual(behind(seen), [], "every event of the tap outside the sheet lands on its scrim, none on the pane behind");
      });

      assert.deepEqual(errors, [], "no page errors");
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
  assert.deepEqual(failures, [], "every step passes");
} finally {
  rmSync(app, { recursive: true, force: true });
}
