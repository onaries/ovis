import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ovis-drawer-modal-"));
const app = join(root, "app");
await buildDemoApp(app);
const index = (await Bun.file(join(app, "index.html")).text()).replace(
  '<script type="module"',
  '<script src="/demo-transport.js"></script><script type="module"',
);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(index, { headers: { "content-type": "text/html" } });
  const file = Bun.file(join(app, path));
  return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
} });
// a launch that fails still stops the server and removes the demo build
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] }).catch((error: unknown) => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  throw error;
});
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1&view=chat`);
  await page.locator(".conn-live").first().waitFor();
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  const drawer = page.locator("#workspace-drawer");
  await drawer.waitFor({ state: "visible" });
  assert.equal(await drawer.getAttribute("role"), "dialog", "the phone drawer exposes dialog semantics");
  assert.equal(await drawer.getAttribute("aria-modal"), "true", "the trapped phone drawer is modal");
  // the header's toggle and + drawn as its top row belong to the modal for a screen reader too
  const owned = (await drawer.getAttribute("aria-owns"))?.split(" ") ?? [];
  assert.deepEqual(owned, ["drawer-toggle", "drawer-new-workspace"], "the open drawer owns the header's toggle and +");
  for (const id of owned) assert.equal(await page.locator(`.app-header #${id}`).count(), 1, `the owned ${id} is the header's own control`);
  // a tap that opened it shows no focus ring: the drawer holds the focus itself, no control in it
  const ringless = () => page.evaluate(() => document.activeElement?.id === "workspace-drawer" && document.querySelector(":focus-visible:not(#workspace-drawer)") === null);
  assert.equal(await ringless(), true, "the opened drawer holds the focus itself, with no control's ring");
  assert.equal(await page.locator(".pane-column").getAttribute("inert"), "", "the pane behind the drawer is inert");
  const drawerButtons = drawer.locator("button:visible");
  assert.ok(await drawerButtons.count() > 0, "the drawer has focusable controls");
  await drawerButtons.last().focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => {
    const active = document.activeElement;
    return active !== null && (active.matches(".drawer-toggle, .new-workspace-button") || active.closest("#workspace-drawer") !== null);
  }), true, "Tab stays within the drawer and its header controls");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open workspace list", exact: true }).waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a closed drawer is not modal");
  // modal or not, the drawer follows the finger: a swipe in from the left edge opens it, a swipe back closes it
  const cdp = await context.newCDPSession(page);
  const swipe = async (from: number, to: number): Promise<void> => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y: 420 }] });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from + ((to - from) * step) / 12, y: 420 }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe(6, 300);
  await page.locator("#workspace-drawer.is-open[aria-modal='true']").waitFor();
  assert.equal(await ringless(), true, "a drawer swiped open shows no control's focus ring");
  await swipe(300, 10);
  await page.locator("#workspace-drawer:not(.is-open)").waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a drawer swiped closed is not modal");
  assert.equal(await drawer.getAttribute("aria-owns"), null, "a closed drawer owns nothing of the header");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#workspace-drawer:not([role])").waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "the desktop sidebar is not modal");
  await context.close();
  console.log("PASS phone drawer is a modal focus-trapped surface");
} finally {
  await browser.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
