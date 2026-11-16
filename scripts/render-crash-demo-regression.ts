import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { chromePath } from "./chrome-path.ts";

// A render error never blanks the app. The lane's demo build has its test hooks on, so
// `?crash=<region>` makes that region throw while it renders (src/lib/crashProbe.ts):
// - root: the whole page is AppCrash, with Reload app (which reloads) and Copy details;
// - sidebar, pane: that region shows its notice and the rest of the app keeps working;
// - settings: the dialog shows its notice, holds the focus, sits over a file preview, and Escape,
//   Close or the system Back button returns to the app.
// The root and a pane slot are seen again on a phone, where copying can be refused: Copy details
// then opens the details with the text selected.
// On the unmodified app over the demo's fixture transport: no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-render-crash-demo-"));

interface OpenOptions { phone?: boolean; clipboardRefused?: boolean }

async function open(browser: Browser, search: string, { phone = false, clipboardRefused = false }: OpenOptions = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" }
    : { viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", fileOpen: "panel" })));
  // a plain-HTTP LAN address: no clipboard API, and the old copy command refused too
  if (clipboardRefused) await context.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = () => false;
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/herdr-web-ui/demo/app/${search}`);
  return { page, close: () => context.close() };
}

/** The sidebar row click, without moving the focus the way a real click would. */
const select = async (page: Page, paneId: string): Promise<void> => {
  const row = page.locator(`.pane-select[title^="${paneId} —"]`).first();
  await row.waitFor({ state: "attached" });
  await row.evaluate((node: HTMLElement) => node.click());
};

/** Asks `region` to throw from its next render on, as `?crash=` does on load. */
const startCrashing = (page: Page, region: string): Promise<void> => page.evaluate((name) => {
  const url = new URL(window.location.href);
  url.searchParams.set("crash", name);
  window.history.replaceState(window.history.state, "", url);
}, region);

/** Drops `crash` from the address, as the page would be without the hook, so Try again can succeed. */
const stopCrashing = (page: Page): Promise<void> => page.evaluate(() => {
  const url = new URL(window.location.href);
  url.searchParams.delete("crash");
  window.history.replaceState(window.history.state, "", url);
});

let port = 0;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `<script src="./demo-transport.js"></script>${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  port = server.port ?? 0;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const pane = `?pane=${encodeURIComponent(panes.omp)}&view=terminal`;

      // without the hook asked for, nothing throws: the probe is inert
      {
        const { page, close } = await open(browser, pane);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".pane-frame.is-current").waitFor();
        await page.locator(".sidebar-shell").waitFor();
        assert.equal(await page.getByRole("alert").filter({ hasText: /can't be shown|Something went wrong/ }).count(), 0, "no notice on a page that did not throw");
        assert.deepEqual(errors, []);
        await close();
      }

      // the root: AppCrash, its Reload app reloads the page, Copy details puts the error on the clipboard
      {
        const { page, close } = await open(browser, `${pane}&crash=root`);
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        const crash = page.locator(".app-crash");
        await crash.getByRole("heading", { name: "Something went wrong" }).waitFor();
        const reload = crash.getByRole("button", { name: "Reload app", exact: true });
        assert.equal(await reload.isVisible(), true, "Reload app is offered");
        await crash.getByRole("button", { name: "Copy details", exact: true }).click();
        await crash.getByRole("button", { name: "Copied", exact: true }).waitFor();
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        assert.match(copied, /crash probe: root/, "the details carry the error");
        await crash.locator("summary").click();
        assert.match(await crash.locator("pre").innerText(), /crash probe: root/, "the details are on the page too");
        const reloaded = page.waitForEvent("load");
        await reload.click();
        await reloaded;
        await crash.getByRole("button", { name: "Reload app", exact: true }).waitFor();
        await close();
      }

      // the sidebar: its notice, the pane still drawn; Try again draws the sidebar once it can
      {
        const { page, close } = await open(browser, `${pane}&crash=sidebar`);
        const notice = page.locator("#workspace-drawer").getByRole("alert").filter({ hasText: "The sidebar can't be shown." });
        await notice.waitFor();
        await page.locator(".pane-frame.is-current").waitFor();
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await stopCrashing(page);
        await notice.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".sidebar-shell").waitFor();
        assert.equal(await notice.count(), 0, "the notice gives way to the sidebar");
        await close();
      }

      // a pane slot: its notice, the sidebar still drawn
      {
        const { page, close } = await open(browser, `${pane}&crash=pane`);
        const notice = page.locator(".pane-slot").getByRole("alert").filter({ hasText: "This pane can't be shown." });
        await notice.waitFor();
        await page.locator(".sidebar-shell").waitFor();
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await stopCrashing(page);
        await notice.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".pane-frame.is-current").waitFor();
        await close();
      }

      // a pane slot that throws once its terminal was live: the header stops saying live, as no
      // terminal is attached there any more
      {
        const { page, close } = await open(browser, pane);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await startCrashing(page, "pane");
        await select(page, panes.web);
        await page.locator(".pane-slot").getByRole("alert").filter({ hasText: "This pane can't be shown." }).waitFor();
        await page.locator(".conn-reconnecting").waitFor({ state: "attached", timeout: 5000 });
        assert.equal(await page.locator(".conn-live").count(), 0, "no live connection is claimed for a pane that is not drawn");
        await close();
      }

      // Settings: its notice in the dialog, which holds the focus as Settings does; Escape and
      // Close both return to a working app
      {
        const { page, close } = await open(browser, `${pane}&settings=appearance&crash=settings`);
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        await page.locator(".sidebar-shell").waitFor();
        await page.locator(".pane-frame.is-current").waitFor();
        const focusInDialog = (): Promise<boolean> => page.evaluate(() => document.activeElement?.closest("[role=dialog]") != null);
        await page.waitForFunction(() => document.activeElement?.closest("[role=dialog]") != null, undefined, { timeout: 5000 });
        await page.keyboard.press("Tab");
        assert.equal(await focusInDialog(), true, "Tab stays inside the dialog");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await focusInDialog(), true, "Shift+Tab stays inside the dialog");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached", timeout: 5000 });
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await close();
      }
      {
        const { page, close } = await open(browser, `${pane}&settings=appearance&crash=settings`);
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await close();
      }

      // Settings opened by its shortcut over a file preview: its notice is drawn over the preview,
      // as Settings is, so Close is the control under the pointer
      {
        const { page, close } = await open(browser, `${pane}&file=README.md&crash=settings`);
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await page.keyboard.press("ControlOrMeta+Shift+Comma");
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        const closeButton = dialog.getByRole("button", { name: "Close", exact: true });
        const box = await closeButton.boundingBox();
        assert.ok(box, "Close is laid out");
        const onTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[role=dialog][aria-label=Settings]") != null, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
        assert.equal(onTop, true, "the notice is drawn over the file preview");
        await closeButton.click();
        await dialog.waitFor({ state: "detached" });
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await close();
      }

      // the system Back button closes the notice and stays in the app, as it closes Settings: the
      // dialog threw before it put an entry in the history, on a desktop and on a phone
      for (const phone of [false, true]) {
        const { page, close } = await open(browser, pane, { phone });
        await page.locator(".pane-frame.is-current").waitFor();
        await page.goto(`http://127.0.0.1:${port}/herdr-web-ui/demo/app/${pane}&settings=appearance&crash=settings`);
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        await page.evaluate(() => { (window as unknown as { crashMarker: boolean }).crashMarker = true; });
        await page.evaluate(() => window.history.back());
        await dialog.waitFor({ state: "detached", timeout: 5000 });
        assert.equal(await page.evaluate(() => (window as unknown as { crashMarker?: boolean }).crashMarker === true), true, `Back stays on this page (${phone ? "phone" : "desktop"})`);
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await close();
      }

      // on a phone, Settings throws once a page was opened from its list: one Back closes the
      // notice, not two
      {
        const { page, close } = await open(browser, `${pane}&settings=appearance`, { phone: true });
        const dialog = page.getByRole("dialog", { name: "Settings" });
        await dialog.getByText("Density", { exact: true }).waitFor();
        await page.waitForFunction(() => (window.history.state as Record<string, { depth?: number } | undefined> | null)?.["ovis:settings"]?.depth === 2, undefined, { timeout: 5000 });
        const compact = dialog.getByText("Compact", { exact: true });
        // Arm the failure on the actual tap, before React handles the density change.
        // Setting the URL earlier lets a content-readiness or roster render replace the
        // button with the crash fallback before Playwright can dispatch that tap.
        await compact.evaluate((button) => button.addEventListener("click", () => {
          const url = new URL(window.location.href);
          url.searchParams.set("crash", "settings");
          window.history.replaceState(window.history.state, "", url);
          Object.assign(window, { crashMarker: true });
        }, { once: true, capture: true }));
        await compact.tap();
        await dialog.getByRole("alert").filter({ hasText: "Settings can't be shown." }).waitFor();
        await page.waitForFunction(() => (window.history.state as Record<string, { depth?: number } | undefined> | null)?.["ovis:settings"]?.depth === 1, undefined, { timeout: 5000 });
        await page.evaluate(() => window.history.back());
        await dialog.waitFor({ state: "detached", timeout: 5000 });
        assert.equal(await page.evaluate(() => "crashMarker" in window), true, "one Back closes the crashed nested page without navigating away");
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await close();
      }

      // the root on a phone that refuses copying: Copy details opens the details, text selected
      {
        const { page, close } = await open(browser, `${pane}&crash=root`, { phone: true, clipboardRefused: true });
        const crash = page.locator(".app-crash");
        await crash.getByRole("heading", { name: "Something went wrong" }).waitFor();
        const reload = crash.getByRole("button", { name: "Reload app", exact: true });
        const box = await reload.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844, "Reload app is on the phone's screen");
        assert.equal(await crash.locator("details").evaluate((node: HTMLDetailsElement) => node.open), false, "the details start folded");
        await crash.getByRole("button", { name: "Copy details", exact: true }).tap();
        await crash.locator("details[open]").waitFor({ timeout: 5000 });
        assert.equal(await crash.getByRole("button", { name: "Copied", exact: true }).count(), 0, "nothing claims a copy that did not happen");
        assert.match(await page.evaluate(() => window.getSelection()?.toString() ?? ""), /crash probe: root/, "the details are selected for a long press");
        await close();
      }

      // a pane slot on a phone: its notice, and the workspace list still opens
      {
        const { page, close } = await open(browser, `${pane}&crash=pane`, { phone: true });
        const notice = page.locator(".pane-slot").getByRole("alert").filter({ hasText: "This pane can't be shown." });
        await notice.waitFor();
        assert.equal(await page.locator(".app-crash").count(), 0, "the page is not blanked");
        await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
        await page.locator("#workspace-drawer.is-open .sidebar-shell").waitFor();
        await page.touchscreen.tap(page.viewportSize()!.width - 8, page.viewportSize()!.height / 2);
        await page.locator("#workspace-drawer.is-open").waitFor({ state: "detached" });
        await stopCrashing(page);
        await notice.getByRole("button", { name: "Try again", exact: true }).tap();
        await page.locator(".pane-frame.is-current").waitFor();
        await close();
      }
      console.log("PASS a render error shows a notice with Reload app at the root, and stays inside the sidebar, a pane slot or Settings, on a desktop and a phone");
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
