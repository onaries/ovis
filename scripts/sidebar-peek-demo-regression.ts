import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { PEEK_CLOSE_MS, PEEK_OPEN_MS } from "../src/lib/sidebarPeek.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

// Settings → Show the sidebar on hover (#2588) on the demo roster: off by default; on, a mouse resting on
// the collapsed sidebar's toggle shows it over the pane (the pane keeps its width and the focus stays put),
// the trip into it keeps it, a row there still opens its pane, leaving both or Escape puts it away, a click
// on the toggle keeps it open, and a phone's tap and drawer are unchanged. Page timers run on Playwright's
// clock, so no wait is fixed. Only the disposable demo build is served; no live session is read.
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-peek-"));
const evidence = process.env["UI_EVIDENCE_DIR"];

const sidebar = (page: Page) => page.locator("#workspace-drawer");
const peeking = (page: Page) => page.locator("#workspace-drawer.is-peek");
const toggle = (page: Page) => page.locator(".sidebar-toggle");
const paneWidth = async (page: Page): Promise<number> => (await page.locator(".pane-column").first().boundingBox())!.width;
const focused = (page: Page): Promise<string> => page.evaluate(() => {
  const element = document.activeElement;
  return element === null ? "none" : `${element.tagName}.${element.className}`;
});
// along the header first, then down over the pane: the trip never crosses the sidebar's place
const away = async (page: Page): Promise<void> => {
  await page.mouse.move(900, 20, { steps: 4 });
  await page.mouse.move(900, 500, { steps: 4 });
};
const onToggle = async (page: Page): Promise<void> => {
  const box = (await toggle(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = (sidebarParam: string) => `http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.shell)}${sidebarParam}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const theme of ["dark", "light"] as const) {
        // desktop, with a mouse
        {
          const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", colorScheme: theme });
          try {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.clock.install();
            await context.addInitScript((value) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value })); }, theme);

            // never chosen: resting on the toggle shows nothing
            await page.goto(url("&sidebar=hidden"));
            await page.locator(".app.sidebar-collapsed").waitFor();
            await away(page);
            await onToggle(page);
            await page.clock.runFor(PEEK_OPEN_MS * 4);
            assert.equal(await peeking(page).count(), 0, "off by default, no peek");
            assert.equal(await sidebar(page).isVisible(), false, "the collapsed sidebar stays hidden");

            // turned on for this device from Settings → Appearance, then the sidebar hidden with its toggle
            await toggle(page).click();
            await page.locator(".sidebar-footer-settings").click();
            await openSettingsPage(page, "Appearance");
            const setting = page.locator(".settings-dialog").getByRole("switch", { name: "Show the sidebar on hover", exact: true });
            assert.equal(await setting.getAttribute("aria-checked"), "false", "off by default in Settings");
            await setting.click();
            await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").sidebarPeek === true);
            if (evidence) {
              mkdirSync(evidence, { recursive: true });
              await setting.evaluate((element) => element.scrollIntoView({ block: "center" }));
              await page.locator(".settings-dialog").screenshot({ path: join(evidence, `sidebar-peek-settings-1280-${theme}.png`) });
            }
            await page.keyboard.press("Escape");
            await page.locator(".settings-dialog").waitFor({ state: "detached" });
            await toggle(page).click();
            await page.locator(".app.sidebar-collapsed").waitFor();
            await away(page);
            const widthBefore = await paneWidth(page);
            const focusBefore = await focused(page);
            await onToggle(page);
            await page.clock.runFor(PEEK_OPEN_MS);
            await peeking(page).waitFor();
            assert.equal(await page.locator(".app.sidebar-collapsed").count(), 1, "the sidebar is still collapsed");
            assert.equal(await paneWidth(page), widthBefore, "the pane keeps its width");
            assert.equal(await focused(page), focusBefore, "the focus stays where it was");
            const box = (await sidebar(page).boundingBox())!;
            const header = (await page.locator(".app-header").boundingBox())!;
            assert.equal(box.x, 0, "from the window's left edge");
            assert.ok(Math.abs(box.y - (header.y + header.height)) <= 1, "right under the header");
            assert.ok(box.width >= 240 && box.width <= 640, `at its open width (${box.width}px)`);
            if (evidence) await page.screenshot({ path: join(evidence, `sidebar-peek-1280-${theme}.png`) });

            // its filter focused by keyboard on a fresh page, before the pointer ever entered it: the focus holds it (#3070)
            await page.goto(url("&sidebar=hidden"));
            await page.locator(".app.sidebar-collapsed").waitFor();
            await away(page);
            await onToggle(page);
            await page.clock.runFor(PEEK_OPEN_MS);
            await peeking(page).waitFor();
            const filter = page.locator("#workspace-drawer .sidebar-filter-input");
            await filter.focus();
            await away(page);
            await page.clock.runFor(PEEK_CLOSE_MS * 3);
            assert.equal(await peeking(page).count(), 1, "a field focused before the pointer came in holds it too");
            // Escape in the empty field puts the peek away, as nothing else takes it
            await page.keyboard.press("Escape");
            await peeking(page).waitFor({ state: "detached" });
            assert.equal(await toggle(page).evaluate((element) => element === document.activeElement), true, "the focus goes back to the toggle, not to the page");
            await onToggle(page);
            await page.clock.runFor(PEEK_OPEN_MS);
            await peeking(page).waitFor();

            // into it, it stays, and its rows still open their pane
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
            await page.clock.runFor(PEEK_CLOSE_MS * 3);
            assert.equal(await peeking(page).count(), 1, "the trip from the toggle into the sidebar keeps it");
            const row = page.locator(`.agent-list .agent-item[data-pane="${panes.api}"] .agent-select`);
            await row.hover();
            await row.click();
            await page.locator(`.agent-list .agent-item[data-pane="${panes.api}"].is-selected`).waitFor();
            assert.equal(await peeking(page).count(), 1, "picking a row keeps the sidebar while the pointer is on it");

            // a workspace renamed in it: the sidebar stays while the name is typed, with the pointer gone, and the
            // field's Escape cancels the rename, not the peek
            await page.locator(".machine-list .workspace-header").first().click({ button: "right" });
            await page.getByRole("menuitem", { name: "Rename workspace", exact: true }).click();
            const rename = page.locator(".workspace-rename-input");
            await rename.waitFor();
            await rename.pressSequentially("-x");
            await away(page);
            await page.clock.runFor(PEEK_CLOSE_MS * 3);
            assert.equal(await peeking(page).count(), 1, "kept while a name is typed in it");
            assert.equal(await rename.evaluate((element) => element === document.activeElement), true, "and the field keeps the focus");
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
            await page.keyboard.press("Escape");
            await rename.waitFor({ state: "detached" });
            await page.clock.runFor(PEEK_CLOSE_MS * 3);
            assert.equal(await peeking(page).count(), 1, "the rename's Escape leaves the peek");

            // a dialog the sidebar did not open holds nothing
            await page.evaluate(() => { const foreign = document.createElement("div"); foreign.id = "foreign-dialog"; foreign.setAttribute("role", "dialog"); document.body.append(foreign); });
            await away(page);
            await page.clock.runFor(PEEK_CLOSE_MS);
            await peeking(page).waitFor({ state: "detached" });
            await page.evaluate(() => document.getElementById("foreign-dialog")?.remove());
            await onToggle(page);
            await page.clock.runFor(PEEK_OPEN_MS);
            await peeking(page).waitFor();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });

            // a workspace dragged in it: the sidebar stays under the drag, and after the drop with the pointer still on it (#3070)
            const rows = page.locator(".machine-list [draggable=true]");
            const from = (await rows.nth(0).boundingBox())!;
            const over = (await rows.nth(1).boundingBox())!;
            await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 4 });
            await page.mouse.down();
            await page.mouse.move(over.x + over.width / 2, over.y + over.height / 2, { steps: 8 });
            await page.clock.runFor(PEEK_CLOSE_MS * 3);
            assert.equal(await peeking(page).count(), 1, "kept under a drag");
            await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2, { steps: 8 });
            await page.mouse.up();
            await page.clock.runFor(PEEK_CLOSE_MS * 3);
            assert.equal(await peeking(page).count(), 1, "and after the drop, with the pointer still on it");

            // leaving both puts it away after the grace
            await away(page);
            await page.clock.runFor(PEEK_CLOSE_MS);
            await peeking(page).waitFor({ state: "detached" });
            assert.equal(await sidebar(page).isVisible(), false, "hidden again");
            assert.equal(await paneWidth(page), widthBefore, "and the pane never moved");

            // Escape puts it away, and resting on the toggle does not bring it straight back
            await onToggle(page);
            await page.clock.runFor(PEEK_OPEN_MS);
            await peeking(page).waitFor();
            await page.keyboard.press("Escape");
            await peeking(page).waitFor({ state: "detached" });
            await page.clock.runFor(PEEK_OPEN_MS * 4);
            assert.equal(await peeking(page).count(), 0, "Escape's dismissal holds until the pointer comes back");

            // a click on the toggle keeps the sidebar open, as it always did
            await away(page);
            await onToggle(page);
            await page.clock.runFor(PEEK_OPEN_MS);
            await peeking(page).waitFor();
            await toggle(page).click();
            await page.locator(".app:not(.sidebar-collapsed)").waitFor();
            await away(page);
            await page.clock.runFor(PEEK_CLOSE_MS * 3);
            assert.equal(await peeking(page).count(), 0, "an open sidebar is no peek");
            assert.equal(await sidebar(page).isVisible(), true, "and it stays open when the pointer leaves");
            assert.ok(await paneWidth(page) < widthBefore, "the pinned sidebar takes its column back");
            assert.deepEqual(errors, []);
            console.log(`PASS desktop ${theme}: off by default; on, the toggle's hover shows the sidebar over the pane without moving it or the focus, the trip in keeps it, a row opens its pane, a keyboard-focused field or a drag in it holds it, leaving or Escape hides it and a click keeps it open`);
          } finally { await context.close(); }
        }

        // a phone: the setting changes nothing, its tap opens the drawer as before
        {
          const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US", colorScheme: theme });
          try {
            await context.addInitScript((value) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, sidebarPeek: true })), theme);
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(url(""));
            assert.equal(await toggle(page).isVisible(), false, "a phone has no collapse toggle to rest on");
            await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
            await page.locator("#workspace-drawer.is-open").waitFor();
            assert.equal(await peeking(page).count(), 0, "the drawer is no peek");
            await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
            if (evidence) await page.screenshot({ path: join(evidence, `sidebar-peek-390-${theme}.png`) });
            assert.deepEqual(errors, []);
            console.log(`PASS phone ${theme}: with the setting on, the drawer opens and closes by tap as before`);
          } finally { await context.close(); }
        }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
