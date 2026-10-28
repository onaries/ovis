/**
 * Purpose: the sidebar when it shows one PC, and without its filter, on the real client over the demo's fixture
 * transport. A lone Host is drawn without its header and loses nothing: its workspaces start the list, it is never
 * folded (a fold stored before stays harmless), its + is the New workspace row, and its state words stay when it is
 * offline; one PC shown of two (Settings → Remote PCs) looks the same and says the other is hidden; a lone PC that
 * is not the Host keeps its header (its name and manage menu); two PCs keep both headers. Settings → Appearance →
 * Sidebar filter off leaves the Filter field out, and the command palette's Filter workspaces and agents opens and
 * focuses it, at a phone's and a desktop's width, light and dark. On a desktop, that field's edges (#2079): its close
 * gives the focus to a row that can take it when what opened it is gone, a row's menu counts as the sidebar, and a
 * blur's late check never clears words typed after it. Screenshots go to UI_EVIDENCE_DIR when it is set.
 * Tags: sidebar, machines, filter, settings, palette, browser, regression, visual.
 * Usage: UI_EVIDENCE_DIR=<dir> bun scripts/sidebar-declutter-demo-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

// Only this disposable fixture rewrites the demo's roster: `pcs=2` makes the demo's one PC two (the Host "Laptop"
// and "Work PC"), `offline=1` disconnects the Host, `flat=1` takes the worktrees off its workspaces (no row then has a
// fold of its own, so a row's first button is its ⋯, which a desktop does not draw). No herdr session is opened, and nothing leaves the loopback.
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-declutter-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const params = new URLSearchParams(location.search);
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  let last = null;
  const roster = (original) => (params.get("pcs") === "2" ? ["local", "work"] : ["local"]).map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    if (params.get("pcs") === "2") { machine.id = id; machine.kind = id === "local" ? "local" : "ssh"; machine.name = id === "local" ? "Laptop" : "Work PC"; }
    if (id === "local" && params.has("offline")) { machine.state = "disconnected"; machine.error = null; }
    if (params.has("flat")) for (const workspace of machine.snapshot?.workspaces ?? []) delete workspace.worktree;
    return machine;
  });
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/machines") { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ ...value, machines: roster(last) }); }
    const match = url.pathname.match(/^\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (match && path === "/api/session" && last) return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

type Theme = "dark" | "light";
interface Scene { phone: boolean; theme: Theme }
const sceneName = (scene: Scene) => `${scene.phone ? 390 : 1440}-${scene.theme}`;
/** The Host's workspace names as the demo's transport gives them to the page, sorted. */
const rosterLabels = (page: Page): Promise<string[]> => page.evaluate(async () => {
  const { machines } = await (await fetch("/api/machines")).json() as { machines: { id: string; snapshot: { workspaces: { label: string }[] } | null }[] };
  return (machines.find((machine) => machine.id === "local")?.snapshot?.workspaces ?? []).map((workspace) => workspace.label).sort();
});

let url = "";

async function newPage(browser: Browser, scene: Scene, search: string, stored: Record<string, string> = {}, openSidebar = true): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext(scene.phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "en-US", colorScheme: scene.theme }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: "en-US", colorScheme: scene.theme });
  await context.addInitScript(({ settings, stored }) => {
    // once per page, not on each reload: a reload keeps what the page itself stored
    if (sessionStorage.getItem("declutter-seeded") !== null) return;
    sessionStorage.setItem("declutter-seeded", "1");
    localStorage.setItem("ovis:settings", JSON.stringify(settings));
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
  }, { settings: { language: "en", theme: scene.theme, defaultView: "chat" }, stored });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}?${search}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".machine-list .machine-group").first().waitFor({ state: "attached" });
  if (scene.phone && openSidebar) {
    await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await page.locator(".sidebar.is-open").waitFor();
  }
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}

const manifest: { file: string; state: string; viewport: number; theme: Theme }[] = [];
async function capture(page: Page, scene: Scene, state: string, wholePage = false): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  const file = `sidebar-declutter-${sceneName(scene)}-${state}.png`;
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
  // the demo's timeline raises a finish droplet at its own moment; the shots are of the sidebar
  const style = ".droplet { visibility: hidden !important; }";
  if (scene.phone || wholePage) {
    await page.mouse.move(-50, -50);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: join(evidence, file), style });
  } else await page.locator(".sidebar").screenshot({ path: join(evidence, file), style });
  manifest.push({ file, state, viewport: scene.phone ? 390 : 1440, theme: scene.theme });
}

const headers = (page: Page) => page.locator(".machine-list .machine-header");
const newRow = (page: Page) => page.locator(".machine-list .machine-new-row");
const filterRow = (page: Page) => page.locator(".sidebar-filter");
const filterFocused = (page: Page) => page.evaluate(() => document.activeElement?.classList.contains("sidebar-filter-input") ?? false);
/** Where the focus is after the field went: never the body, so a keyboard keeps its place. */
const focusHeld = (page: Page) => page.evaluate(() => { const active = document.activeElement; return active !== null && active !== document.body && active.isConnected ? active.className || active.tagName : null; });
const shownWorkspaces = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".machine-list .workspace-group")].filter((row) => !row.closest("[hidden]")).map((row) => row.querySelector(".workspace-name")?.textContent ?? "").sort());

/** The demo's one PC, the Host: no header, nothing lost. */
async function loneHost(browser: Browser, scene: Scene): Promise<void> {
  // a fold stored while the Host had a header must not hide its workspaces now that nothing can open them
  const { context, page, errors } = await newPage(browser, scene, "", { "ovis:pc-collapsed:local": "1" });
  try {
    // the group is drawn (newPage waited for it), and its header, were there one, with it
    assert.equal(await headers(page).count(), 0, `${sceneName(scene)}: a lone Host is drawn without its header`);
    await newRow(page).waitFor();
    const LABELS = await rosterLabels(page);
    assert.equal(await page.locator('section.machine-group[aria-label="PC workstation"]').count(), 1, "the group still names its PC to a screen reader");
    assert.deepEqual(await shownWorkspaces(page), LABELS, "its workspaces start the list, unfolded, whatever fold was stored");
    const first = await page.locator(".machine-list .workspace-group").first().boundingBox();
    const list = await page.locator(".machine-list").boundingBox();
    assert.ok(first && list && first.y - list.y < 16, `the first workspace row is the list's first row (${first?.y} vs ${list?.y})`);
    assert.equal((await newRow(page).innerText()).trim(), "New workspace");
    const rows = await page.locator(".machine-list .workspace-group, .machine-list .machine-new-row").evaluateAll((elements) => elements.map((element) => element.classList.contains("machine-new-row")));
    assert.equal(rows.at(-1), true, "the New workspace row is the list's last row");
    await capture(page, scene, "lone-host");
    await newRow(page).click();
    const dialog = page.getByRole("dialog", { name: /^New workspace/ });
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (scene.phone && await page.locator(".sidebar.is-open").count() === 0) {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor();
    }
    await page.locator(".sidebar-filter-input").fill(LABELS[0]!);
    await newRow(page).waitFor({ state: "detached" });
    assert.ok((await shownWorkspaces(page)).includes(LABELS[0]!), "the filter still finds the lone Host's rows");
    await page.locator(".sidebar-filter-clear").click();
    await newRow(page).waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: a lone Host has no header, never folds, and its + is the New workspace row`);
  } finally { await context.close(); }
}

/** The lone Host offline: its state still says so, and nothing offers a workspace it cannot make. */
async function loneHostOffline(browser: Browser, scene: Scene): Promise<void> {
  const { context, page, errors } = await newPage(browser, scene, "offline=1");
  try {
    const state = page.locator(".machine-list .machine-state:not(.visually-hidden)");
    await state.waitFor();
    assert.equal((await state.locator(".machine-state-word").innerText()).trim(), "Disconnected", "the state words stay without the header");
    assert.equal(await headers(page).count(), 0);
    assert.equal(await newRow(page).count(), 0, "an offline Host offers no New workspace row");
    await capture(page, scene, "lone-host-offline");
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: an offline lone Host still says it is disconnected`);
  } finally { await context.close(); }
}

/** Two PCs keep their headers; one shown of two looks like the lone Host, unless the one shown is not the Host. */
async function twoPcs(browser: Browser, scene: Scene): Promise<void> {
  {
    const { context, page, errors } = await newPage(browser, scene, "pcs=2");
    try {
      await page.waitForFunction(() => document.querySelectorAll(".machine-list .machine-header").length === 2);
      assert.equal(await newRow(page).count(), 0, "two PCs keep their own +");
      assert.deepEqual(await page.locator(".machine-list .machine-name").allInnerTexts(), ["Laptop", "Work PC"]);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await newPage(browser, scene, "pcs=2", { "ovis:hidden-pcs": JSON.stringify(["work"]) });
    try {
      await newRow(page).waitFor();
      assert.equal(await headers(page).count(), 0, "the Host shown alone of two has no header");
      assert.equal((await page.locator(".machine-hidden-note").innerText()).trim(), "1 PC hidden on this device", "the note says the other PC is hidden");
      await capture(page, scene, "host-shown-of-two");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await newPage(browser, scene, "pcs=2", { "ovis:hidden-pcs": JSON.stringify(["local"]) });
    try {
      await page.waitForFunction(() => document.querySelectorAll(".machine-list .machine-header").length === 1);
      assert.equal((await page.locator(".machine-list .machine-name").innerText()).trim(), "Work PC", "a lone PC that is not the Host keeps its name");
      assert.equal(await page.locator(".machine-list .machine-manage").count(), 1, "and its manage menu");
      assert.equal(await newRow(page).count(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  console.log(`PASS ${sceneName(scene)}: two PCs keep both headers; the Host shown alone of two has none; a lone remote PC keeps its own`);
}

async function paletteFilter(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  await palette.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Filter workspaces");
  await palette.getByRole("option").filter({ hasText: "Filter workspaces and agents" }).first().click();
  await palette.waitFor({ state: "detached" });
  await filterRow(page).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains("sidebar-filter-input") ?? false);
}

/** Settings → Appearance → Sidebar filter off: the field is out, and the palette brings it back for a filter's time. */
async function filterHidden(browser: Browser, scene: Scene): Promise<void> {
  // the drawer stays closed: the palette's action opens it
  const { context, page, errors } = await newPage(browser, scene, "", { "ovis:sidebar-filter": "false" }, false);
  try {
    if (scene.phone) {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor();
    }
    await newRow(page).waitFor();
    const LABELS = await rosterLabels(page);
    assert.equal(await filterRow(page).count(), 0, `${sceneName(scene)}: the filter row is out`);
    await capture(page, scene, "filter-off");
    if (scene.phone) {
      await page.getByRole("button", { name: "Close workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor({ state: "detached" });
    }
    await paletteFilter(page);
    if (scene.phone) await page.locator(".sidebar.is-open").waitFor();
    assert.equal(await page.locator(".sidebar-filter-clear").getAttribute("aria-label"), "Close filter", "an empty field the palette opened can be closed");
    await page.keyboard.type(LABELS[1]!);
    await page.waitForFunction((label) => [...document.querySelectorAll<HTMLElement>(".machine-list .workspace-group")].filter((row) => !row.closest("[hidden]")).some((row) => row.textContent?.includes(label)), LABELS[1]!);
    assert.ok((await shownWorkspaces(page)).length < LABELS.length, "typing filters the rows");
    await capture(page, scene, "filter-asked-typing");
    await page.locator(".sidebar-filter-clear").click();
    assert.equal(await page.locator(".sidebar-filter-input").inputValue(), "");
    assert.ok(await filterFocused(page), "the clear keeps the field, focused");
    await page.getByRole("button", { name: "Close filter", exact: true }).click();
    await filterRow(page).waitFor({ state: "detached" });
    assert.deepEqual(await shownWorkspaces(page), LABELS, "every row is back");
    assert.ok(await focusHeld(page), "Close filter gives the focus back, not to the body");
    if (!scene.phone) {
      await paletteFilter(page);
      await page.keyboard.type("zz");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".sidebar-filter-input").inputValue(), "", "Escape with words clears them");
      assert.ok(await filterFocused(page), "and keeps the field, focused");
      await page.evaluate(() => { const seen = window as unknown as { escapesSeen: number }; seen.escapesSeen = 0; window.addEventListener("keydown", (event) => { if (event.key === "Escape") seen.escapesSeen++; }); });
      await page.keyboard.press("Escape");
      await filterRow(page).waitFor({ state: "detached" });
      assert.ok(await focusHeld(page), "Escape in the empty field gives the focus back, not to the body");
      assert.equal(await page.evaluate(() => (window as unknown as { escapesSeen: number }).escapesSeen), 0, "the Escape that closed it goes no further");
      // the focus moving inside the sidebar keeps it, from the field or a row; leaving the sidebar takes it
      await paletteFilter(page);
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Close filter");
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.closest(".machine-list") !== null), true, "Tab goes on into the list");
      assert.equal(await filterRow(page).count(), 1, "a row taking the focus keeps the field");
      await page.locator(".machine-list .workspace-select").nth(1).click();
      assert.equal(await filterRow(page).count(), 1, "a press on a row keeps it");
      const header = await page.locator("header.app-header.is-zoned").boundingBox();
      assert.ok(header, "the app header is drawn");
      await page.mouse.click(header.x + header.width / 2, header.y + header.height / 2);
      await filterRow(page).waitFor({ state: "detached" });
      assert.deepEqual(await shownWorkspaces(page), LABELS);
    } else {
      await paletteFilter(page);
      await page.getByRole("button", { name: "Close workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor({ state: "detached" });
      assert.equal(await filterRow(page).count(), 0);
    }
    assert.equal(await page.evaluate(() => localStorage.getItem("ovis:sidebar-filter")), "false", "using it never turns the setting back on");
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: Sidebar filter off leaves the field out, and the palette's Filter workspaces and agents opens and focuses it`);
  } finally { await context.close(); }
}

/** The asked-for field's edges on a desktop (#2079). */
async function filterEdges(browser: Browser, scene: Scene): Promise<void> {
  {
    // the setting turned off while the field holds words: what had the focus then (Settings' switch) is gone when the
    // field closes, and the desktop draws no row's ⋯, so the focus goes to a row that can take it
    const { context, page, errors } = await newPage(browser, scene, "flat=1");
    try {
      await filterRow(page).waitFor();
      await page.locator(".sidebar-filter-input").fill("zz");
      await page.locator(".sidebar-footer-settings").click();
      await openSettingsPage(page, "Appearance");
      await page.locator(".settings-dialog").getByRole("switch", { name: "Sidebar filter", exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem("ovis:sidebar-filter") === "false");
      await page.keyboard.press("Escape");
      await page.locator(".settings-dialog").waitFor({ state: "detached" });
      assert.equal(await page.locator(".sidebar-filter-input").inputValue(), "zz", "the field keeps its words");
      await page.getByRole("button", { name: "Clear filter", exact: true }).click();
      await page.getByRole("button", { name: "Close filter", exact: true }).click();
      await filterRow(page).waitFor({ state: "detached" });
      assert.ok(await page.evaluate(() => document.activeElement?.closest(".machine-list") !== null && document.activeElement.getClientRects().length > 0), `Close filter gives the focus to a row it can be seen on when its opener is gone (on ${await focusHeld(page)})`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  const { context, page, errors } = await newPage(browser, scene, "", { "ovis:sidebar-filter": "false" });
  try {
    await newRow(page).waitFor();
    // a row's menu opened from the keyboard is drawn outside the sidebar, and is still the sidebar's
    await paletteFilter(page);
    const row = page.locator(".machine-list .workspace-select").first();
    await row.focus();
    const rowBox = await row.boundingBox();
    await row.evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => document.activeElement?.closest(".row-menu") !== null);
    assert.equal(await filterRow(page).count(), 1, "a row's menu taking the focus keeps the field");
    const menuBox = await page.locator(".row-menu").boundingBox();
    assert.ok(rowBox && menuBox && Math.abs(menuBox.y - rowBox.y - rowBox.height) < rowBox.height, `the menu sits under its row (${menuBox?.y} vs ${rowBox && rowBox.y + rowBox.height})`);
    // and a press on its item lands with the field still there
    await page.locator(".row-menu").getByRole("menuitem", { name: "Rename workspace", exact: true }).click();
    await page.locator(".workspace-rename-input").waitFor();
    assert.equal(await filterRow(page).count(), 1, "a press on a row's menu keeps the field");
    await page.keyboard.press("Escape");
    await page.locator(".workspace-rename-input").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Close filter", exact: true }).click();
    await filterRow(page).waitFor({ state: "detached" });
    // an empty field's blur to nowhere (another window taking the focus) takes it once the focus settles, also
    // right after the press that closed it last
    await paletteFilter(page);
    await page.evaluate(() => document.querySelector<HTMLInputElement>(".sidebar-filter-input")!.blur());
    await filterRow(page).waitFor({ state: "detached" });
    // a tab's menu is not the sidebar's: the focus going into it takes the empty field
    await paletteFilter(page);
    await page.locator(".tab-strip-tab").first().evaluate((element) => element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
    await page.waitForFunction(() => document.activeElement?.closest(".row-menu") !== null);
    await filterRow(page).waitFor({ state: "detached" });
    await page.keyboard.press("Escape");
    await page.locator(".row-menu").waitFor({ state: "detached" });
    // that blur is decided a frame later, on the words the field holds then: focus back, words typed and the focus
    // gone again before that frame keeps them
    await paletteFilter(page);
    const late = await page.evaluate(async () => {
      const input = document.querySelector<HTMLInputElement>(".sidebar-filter-input")!;
      input.blur();
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zz");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // a controlled field's change is committed in its own event
      const committed = document.querySelector(".sidebar-filter-clear")?.getAttribute("aria-label") === "Clear filter";
      input.blur();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { committed, value: document.querySelector<HTMLInputElement>(".sidebar-filter-input")?.value ?? null };
    });
    assert.ok(late.committed, "the words were in the field before it lost the focus again");
    assert.equal(late.value, "zz", "a blur's late check keeps words typed after it");
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: the asked-for field gives the focus to a row, keeps a row's menu as the sidebar and no tab's, and keeps later words`);
  } finally { await context.close(); }
}

/** The setting itself: on by default, turned off and on from Settings → Appearance, kept in its own key. */
async function filterSetting(browser: Browser, scene: Scene): Promise<void> {
  const { context, page, errors } = await newPage(browser, scene, "", {}, false);
  try {
    if (scene.phone) {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor();
    }
    await filterRow(page).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("ovis:sidebar-filter")), null, "shown by default, with nothing stored");
    await page.locator(".sidebar-footer-settings").click();
    await openSettingsPage(page, "Appearance");
    const toggle = page.locator(".settings-dialog").getByRole("switch", { name: "Sidebar filter", exact: true });
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await toggle.click();
    await page.waitForFunction(() => localStorage.getItem("ovis:sidebar-filter") === "false");
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("ovis:settings") ?? "{}")).sidebarFilter, undefined, "kept out of ovis:settings");
    await capture(page, scene, "settings-appearance", true);
    await page.keyboard.press("Escape");
    await page.locator(".settings-dialog").waitFor({ state: "detached" });
    if (scene.phone && await page.locator(".sidebar.is-open").count() === 0) {
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(".sidebar.is-open").waitFor();
    }
    await newRow(page).waitFor();
    assert.equal(await filterRow(page).count(), 0, "turned off, the row is gone");
    await page.reload();
    await page.locator(".machine-list .machine-group").first().waitFor({ state: "attached" });
    assert.equal(await filterRow(page).count(), 0, "and stays gone after a reload");
    assert.deepEqual(errors, []);
    console.log(`PASS ${sceneName(scene)}: Settings → Appearance → Sidebar filter is on by default and turns the row off`);
  } finally { await context.close(); }
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "sidebar-declutter.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./sidebar-declutter.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  url = `http://127.0.0.1:${server.port}/`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const phone of [false, true]) for (const theme of ["dark", "light"] as const) {
        const scene: Scene = { phone, theme };
        await loneHost(browser, scene);
        await loneHostOffline(browser, scene);
        await twoPcs(browser, scene);
        await filterHidden(browser, scene);
        if (!phone) await filterEdges(browser, scene);
        await filterSetting(browser, scene);
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
  if (evidence) writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
} finally {
  rmSync(app, { recursive: true, force: true });
}
