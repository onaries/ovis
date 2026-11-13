/**
 * A phone's Back closes what is open, one thing at a time, and never leaves the app with something
 * still on the screen. At 390x844 by touch: the workspace drawer; a row's ⋯ menu over the drawer,
 * then the drawer; the New workspace dialog opened from the drawer, the agent list and the folder
 * browser inside it, then the dialog; the header's More sheet; the terminal's find bar, which goes
 * and leaves the terminal shown; the drawer with another pane opened before it, which stays the
 * pane shown; Files after a file opened from it closed by its X, or by Back; Add PC opened from Settings' Add
 * a connection, which stays up as Settings closes under it, then closes by Back with nothing of
 * Settings left. On its side (844x390) a menu is a
 * popover, and Back closes it the same. Back on the first screen, with nothing open, leaves the app.
 *
 * Chromium's own Back skips every entry of a page that added one with no tap since the user's last
 * Back or Forward, which leaves the app with the surface still up, and a script cannot press that
 * button. So each entry the app adds is counted with the taps since the user last moved in the
 * history (a step the page takes by itself ends nothing: Chromium counts a tap through it): none
 * may be added with no tap behind it.
 * On demo fixtures; UI_EVIDENCE_DIR=<dir> keeps the screenshots.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

type Screen = { label: string; width: number; height: number };
type Entry = { taps: number; keys: string };

const UPRIGHT: Screen = { label: "upright", width: 390, height: 844 };
const ON_ITS_SIDE: Screen = { label: "on its side", width: 844, height: 390 };

const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const keep = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `phone-back-${name}.png`) }); };

/** The app on the api pane, reached from a blank page: one step back from it leaves the app. */
async function open(browser: Browser, origin: string, screen: Screen, run: (page: Page, entries: Entry[]) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ viewport: { width: screen.width, height: screen.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "en-US" });
  const entries: Entry[] = [];
  try {
    // the blank page the app is reached from, and left for, has no storage
    await context.addInitScript(() => { if (location.protocol !== "about:") localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); });
    await context.exposeBinding("entryAdded", (_source, entry: Entry) => { entries.push(entry); });
    await context.addInitScript(() => {
      let taps = 0;
      const push = history.pushState.bind(history);
      history.pushState = (...args: Parameters<History["pushState"]>) => {
        const state: unknown = args[0];
        if (location.protocol !== "about:") void (window as unknown as { entryAdded: (entry: Entry) => Promise<void> }).entryAdded({ taps, keys: state !== null && typeof state === "object" ? Object.keys(state).join(",") : String(state) });
        return push(...args);
      };
      // a step the page takes by itself lands as a popstate too, and is none of the user's
      let own = false;
      for (const name of ["back", "forward", "go"] as const) {
        const step = (history[name] as (by?: number) => void).bind(history);
        (history as unknown as Record<string, (by?: number) => void>)[name] = (by) => { own = true; step(by); };
      }
      const navigation = (window as unknown as { navigation?: { traverseTo: (key: string) => unknown } }).navigation;
      if (navigation) {
        const traverse = navigation.traverseTo.bind(navigation);
        navigation.traverseTo = (key) => { own = true; return traverse(key); };
      }
      addEventListener("popstate", () => { if (own) own = false; else taps = 0; }, true);
      for (const type of ["pointerup", "touchend", "keydown"]) addEventListener(type, (event) => { if (event.isTrusted) taps += 1; }, true);
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("about:blank");
    await page.goto(`${origin}/?pane=${encodeURIComponent(panes.api)}`);
    await page.locator(".conn-live").waitFor();
    await run(page, entries);
    assert.deepEqual(errors, [], `${screen.label}: no page errors`);
    assert.deepEqual(entries.filter((entry) => entry.taps === 0), [], `${screen.label}: no history entry is added with no tap since the page last moved in its history`);
  } finally { await context.close(); }
}

/** The surface on top holds the history's entry: Back is its own. */
const entryHeld = (page: Page): Promise<unknown> => page.waitForFunction(() => typeof (history.state as Record<string, unknown> | null)?.["ovis:sheet"] === "string");
const drawerOpen = (page: Page): Promise<unknown> => page.locator("#workspace-drawer.is-open").waitFor();
const drawerClosed = (page: Page): Promise<unknown> => page.locator("#workspace-drawer.is-open").waitFor({ state: "detached" });
/** The pane the address names: the one shown, at any width. */
const paneShown = (page: Page): Promise<string | null> => page.evaluate(() => new URLSearchParams(location.search).get("pane"));

/** The system's Back, as one step back in the tab's history. */
async function back(page: Page): Promise<void> {
  await page.goBack({ waitUntil: "commit" });
}

async function stillHere(page: Page, origin: string, shown: string | null, label: string): Promise<void> {
  assert.ok(page.url().startsWith(origin), `${label}: Back stayed in the app (${page.url()})`);
  assert.equal(await paneShown(page), shown, `${label}: the pane shown is the one it was`);
}

const app = mkdtempSync(join(tmpdir(), "ovis-phone-back-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const origin = `http://127.0.0.1:${server.port}`;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await entryHeld(page);
      await keep(page, "drawer-open");
      await back(page);
      await drawerClosed(page);
      await stillHere(page, origin, shown, "the drawer");
      await keep(page, "drawer-after-back");
      // with nothing open, the first screen is where Back leaves the app
      await back(page);
      await page.waitForURL("about:blank");
    });

    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await page.getByRole("button", { name: "More for checkout-api" }).tap();
      const menu = page.locator(".row-sheet");
      await menu.waitFor();
      await entryHeld(page);
      await back(page);
      await menu.waitFor({ state: "detached" });
      assert.equal(await page.locator("#workspace-drawer.is-open").count(), 1, "a row's menu over the drawer: Back closes the menu and leaves the drawer");
      // the drawer has the entry again: the next Back, with no tap between, is the drawer's
      await entryHeld(page);
      await back(page);
      await drawerClosed(page);
      await stillHere(page, origin, shown, "the drawer under a menu");
    });

    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      const dialog = page.locator(".new-session-modal");
      const openDialog = async (): Promise<void> => {
        await page.locator(".drawer-toggle").tap();
        await drawerOpen(page);
        await page.locator("#drawer-new-workspace").tap();
        await dialog.waitFor();
        await entryHeld(page);
      };
      await openDialog();
      await back(page);
      await dialog.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "New workspace from the drawer");

      await openDialog();
      await dialog.locator(".agent-picker-trigger").tap();
      const list = page.locator(".agent-picker-menu");
      await list.waitFor();
      await back(page);
      await list.waitFor({ state: "detached" });
      assert.equal(await dialog.count(), 1, "the agent list in New workspace: Back closes the list and leaves the dialog");
      await entryHeld(page);

      await dialog.getByRole("button", { name: "Browse", exact: true }).tap();
      const folders = dialog.locator(".dir-browser");
      await folders.waitFor();
      await back(page);
      await folders.waitFor({ state: "detached" });
      assert.equal(await dialog.count(), 1, "the folder browser in New workspace: Back closes it and leaves the dialog");
      await entryHeld(page);

      await back(page);
      await dialog.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "New workspace after its list and its folder browser");
    });

    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".header-more-button").tap();
      const sheet = page.locator(".row-sheet");
      await sheet.waitFor();
      await entryHeld(page);
      await back(page);
      await sheet.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "the header's More sheet");

      // Find in terminal, from the same sheet: Back closes the bar and keeps the terminal
      await page.locator(".header-more-button").tap();
      // More folds the find items into Find… only where it also carries the pane's search (Tabs on a phone, In the header);
      // with the row under the header (the default) Find in terminal is More's own item
      const findGroup = sheet.getByRole("button", { name: "Find…" });
      const findItem = sheet.getByRole("button", { name: "Find in terminal" });
      await findGroup.or(findItem).first().waitFor();
      if (await findGroup.count() > 0) await findGroup.tap();
      await page.locator(".row-sheet").getByRole("button", { name: "Find in terminal" }).tap();
      const find = page.locator(".find-bar");
      await find.waitFor();
      await entryHeld(page);
      await back(page);
      await find.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "the terminal's find bar");
      assert.equal(await page.locator(".pane-column.is-chat").count(), 0, "the terminal's find bar: Back closes the bar and leaves the terminal shown");
      await page.locator(".lens-toggle").tap();
      await page.locator(".pane-column.is-chat").waitFor();

      // another pane opened first: Back with the drawer open closes the drawer, and does not go to the pane before
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await page.locator(".sidebar .workspace-select", { hasText: "flaky-retry-test" }).first().tap();
      await drawerClosed(page);
      await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, panes.flaky);
      const moved = await paneShown(page);
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await entryHeld(page);
      await back(page);
      await drawerClosed(page);
      await stillHere(page, origin, moved, "the drawer over a pane opened after another");
    });

    // a file opened from Files and closed by its X: the file steps back by itself, which is no Back of
    // the user's, so Files, on top again, has the entry at once and the next Back closes it
    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".header-more-button").tap();
      await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: "Browse files", exact: true }).tap();
      const files = page.getByRole("dialog", { name: "Files", exact: true });
      await files.getByRole("button", { name: "Documents", exact: true }).tap();
      await files.locator(".md-docs-item").first().tap();
      const viewer = page.locator(".modal.file-viewer");
      await viewer.waitFor();
      await viewer.getByRole("button", { name: "Close file", exact: true }).tap();
      await viewer.waitFor({ state: "detached" });
      assert.equal(await files.count(), 1, "a file closed by its X leaves Files up under it");
      await entryHeld(page);
      await back(page);
      await files.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "Files after a file closed by its X");
    });

    // the same file closed by Back: Files is in front again with no tap since, where the browser's
    // Back would skip an entry made now. Files takes the entry that Back left, and the next Back closes it
    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".header-more-button").tap();
      await page.getByRole("dialog", { name: "More", exact: true }).getByRole("button", { name: "Browse files", exact: true }).tap();
      const files = page.getByRole("dialog", { name: "Files", exact: true });
      await files.getByRole("button", { name: "Documents", exact: true }).tap();
      await files.locator(".md-docs-item").first().tap();
      const viewer = page.locator(".modal.file-viewer");
      await viewer.waitFor();
      await back(page);
      await viewer.waitFor({ state: "detached" });
      assert.equal(await files.count(), 1, "a file closed by Back leaves Files up under it");
      await entryHeld(page);
      // the entry Files took still named the file when it was gone onto: the file is not shown again,
      // read once whatever that traversal set off has been drawn
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      assert.equal(await viewer.count(), 0, "the entry Files takes after Back does not bring its file back");
      await keep(page, "files-after-file-back");
      await back(page);
      await files.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "Files after Back closed a file opened from it");
    });

    // Add PC opens as Settings closes (Add, in Add a connection's SSH tab): Settings steps back by
    // itself, which is no Back for Add PC, and Add PC's entry lies over the one Settings opened over
    await open(browser, origin, UPRIGHT, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".drawer-toggle").tap();
      await drawerOpen(page);
      await page.locator(".sidebar-footer-settings").tap();
      const settings = page.locator(".settings-dialog");
      await openSettingsPage(page, "Devices and PCs");
      await settings.getByRole("button", { name: "Add a connection", exact: true }).tap();
      const connect = page.getByRole("dialog", { name: "Add a connection", exact: true });
      await connect.locator('.connect-tabs [data-tab="ssh"]').tap();
      await connect.getByLabel("Or type an SSH address", { exact: true }).fill("qa@pc.invalid");
      await connect.locator(".connect-ssh-form").getByRole("button", { name: "Add", exact: true }).tap();
      const addPc = page.locator("dialog.machine-dialog");
      await addPc.waitFor();
      await settings.waitFor({ state: "detached" });
      await entryHeld(page);
      assert.equal(new URL(page.url()).searchParams.has("settings"), false, "Add PC opened from Settings: the address is the pane's, not a Settings page's");
      await keep(page, "add-pc-from-settings");
      await back(page);
      await addPc.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "Add PC opened from Settings");
      assert.equal(await settings.count(), 0, "Add PC opened from Settings: Back closes Add PC and does not bring Settings back");
      // nothing of Settings is left under it: from here Back leaves the app
      await back(page);
      await page.waitForURL("about:blank");
    });

    await open(browser, origin, ON_ITS_SIDE, async (page) => {
      const shown = await paneShown(page);
      await page.locator(".header-more-button").tap();
      const menu = page.locator(".row-menu");
      await menu.waitFor();
      await entryHeld(page);
      await keep(page, "on-its-side-menu");
      await back(page);
      await menu.waitFor({ state: "detached" });
      await stillHere(page, origin, shown, "a menu with the phone on its side");
    });
  } finally {
    // the server goes whatever else failed, a browser that did not start included: left up, it keeps this script from ending
    try { await browser?.close(); }
    finally { await server.stop(true); }
  }
  console.log("PASS a phone's Back closes the drawer, a menu over it, New workspace and its lists one at a time, Files after a file closed by its X or by Back and Add PC opened as Settings closed, upright and on its side, and adds no entry with no tap behind it");
} finally {
  rmSync(app, { recursive: true, force: true });
}
