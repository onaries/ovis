import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import { herdrRpc, paneSplit, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { openLens } from "./header-lens.ts";

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type KeyboardQA = Window & { keyboardQA: (height: number | null) => void };

const TAB_LABELS = ["second", "a long tab name for review", "deploy", "release notes draft", "perf investigation", "docs"];
/** Where a touch screen still draws the tab row: wider than a phone (the sheets' 640px), as a tablet's portrait. */
const TABLET = { width: 700, height: 900 };

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const { left, top, right, bottom, width, height } = node.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  }, selector);
  assert.ok(found, `${selector} is on the page`);
  return found;
}

/** Settings -> Tabs on a phone at In the header: the header's row holds the tabs in the title's place, and its chevron lists them; no row under it. */
async function assertShell(page: Page, label: string, rowRoom = 60): Promise<void> {
  assert.equal(await page.locator(".app-header").getByRole("button", { name: "New tab" }).count(), 0, `${label}: the header has no New tab button of its own`);
  assert.equal(await page.locator(".app-header .header-more-button").isVisible(), true, `${label}: the header keeps its More menu`);
  const row = await box(page, ".app-header .header-tabs .tab-strip");
  assert.ok(row.width >= rowRoom, `${label}: the tabs keep their room in the header (${row.width}px)`);
  assert.equal(await page.locator(".pane-slot .tab-strip").count(), 0, `${label}: no tab row under the header`);
  const small = await page.locator('.app-header .header-tabs [role="tab"], .app-header .header-tabs-sheet').evaluateAll((nodes) => nodes
    .map((node) => node.getBoundingClientRect()).filter((rect) => rect.width > 0 && (rect.width < 44 || rect.height < 44)).length);
  assert.equal(small, 0, `${label}: each tab in the header and its chevron is a touch target`);
  await page.waitForFunction(() => {
    const strip = document.querySelector(".header-tabs .tab-strip")?.getBoundingClientRect();
    const open = document.querySelector(".header-tabs .tab-strip-item.is-active")?.getBoundingClientRect();
    return !!strip && !!open && open.left >= strip.left - 1 && open.right <= strip.right + 1;
  }, null, { timeout: 5_000 }).catch((cause) => { throw new Error(`${label}: the open tab is in the header's row`, { cause }); });
  assert.equal(await page.locator(".app-header .header-tabs-sheet").isVisible(), true, `${label}: the chevron opens the tabs`);
  assert.ok((await box(page, ".app-header")).height <= 56, `${label}: the header is one row`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: nothing overflows sideways`);
}

/** The header's list of the workspace's tabs (a bottom sheet), opened from the title. */
async function openTabs(page: Page) {
  await page.locator(".app-header .header-tabs-sheet").tap();
  const sheet = page.getByRole("dialog", { name: "Tabs of ovis-test-mobile-tabs", exact: true });
  await sheet.waitFor();
  return sheet;
}

/**
 * A sheet closed by its Cancel, and its history entry left: a phone sheet steps back off its entry a
 * task after it closes (src/lib/sheetHistory.ts), and that traversal aborts a page.goto it overtakes.
 */
async function cancelSheet(page: Page, sheet: Locator): Promise<void> {
  await sheet.getByRole("button", { name: "Cancel", exact: true }).tap();
  await sheet.waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const state: unknown = window.history.state;
    return state === null || typeof state !== "object" || !("ovis:sheet" in state);
  }, null, { timeout: 5_000 });
}

/** A tab opened from the header's list. */
async function pickTab(page: Page, name: string): Promise<void> {
  const sheet = await openTabs(page);
  await sheet.getByRole("button", { name, exact: true }).tap();
  await sheet.waitFor({ state: "detached" });
}

/** The open tab and the + are both inside the strip's visible part, and the + is not over the tab. */
async function activeTabInView(page: Page, label: string): Promise<void> {
  await page.waitForFunction(() => {
    const strip = document.querySelector(".tab-strip")?.getBoundingClientRect();
    const active = document.querySelector(".tab-strip-item.is-active")?.getBoundingClientRect();
    const add = document.querySelector(".tab-strip-add")?.getBoundingClientRect();
    if (!strip || !active || !add) return false;
    return active.left >= strip.left - 1 && active.right <= add.left + 1 && add.right <= strip.right + 1;
  }, null, { timeout: 5_000 }).catch(async (cause) => {
    throw new Error(`${label}: expected the open tab and the + in view; observed ${JSON.stringify({
      strip: await box(page, ".tab-strip"), active: await box(page, ".tab-strip-item.is-active"), add: await box(page, ".tab-strip-add"),
    })}`, { cause });
  });
}

/**
 * A phone's default, Tabs on a phone at Under the header: the row under a one-row header, every tab a
 * touch target, the open one and the + in view, and a tap on another opens it. No chevron lists them.
 */
async function checkPhoneRow(browser: Browser, origin: string, first: string, panes: string[]): Promise<void> {
  for (const width of [360, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 780 }, isMobile: true, hasTouch: true, locale: "en-US" });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
      await page.locator(".conn-live").waitFor();
      const label = `the row at ${width}px`;
      await page.locator(".pane-slot .tab-strip").waitFor();
      const header = await box(page, ".app-header");
      const strip = await box(page, ".pane-slot .tab-strip");
      assert.ok(header.height <= 56, `${label}: the header is one row`);
      assert.ok(strip.top >= header.bottom - 1 && strip.height >= 44, `${label}: the row is under the header, a touch target tall (${strip.top}, ${strip.height})`);
      assert.equal(await page.locator(".app-header .header-tabs-sheet, .app-header .context-tabs").count(), 0, `${label}: no chevron lists the tabs`);
      const small = await page.locator('.pane-slot .tab-strip [role="tab"], .pane-slot .tab-strip-menu, .pane-slot .tab-strip-add').evaluateAll((nodes) => nodes
        .map((node) => node.getBoundingClientRect()).filter((rect) => rect.width > 0 && (rect.width < 44 || rect.height < 44)).length);
      assert.equal(small, 0, `${label}: every tab, the ⋯ and the + are touch targets`);
      await activeTabInView(page, label);
      await page.locator('.pane-slot .tab-strip [role="tab"]', { hasText: "deploy" }).tap();
      await page.locator(`[data-layout-pane=${JSON.stringify(panes[2])}]`).waitFor({ state: "visible" });
      await activeTabInView(page, `${label}, after a tap on a tab further on`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: nothing overflows sideways`);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
}

/**
 * Tabs on a phone at In the header: a press held 450ms on another tab opens that tab's menu and the click
 * lifting it sends does not switch tabs; a press that moves more than 8px opens nothing; a tap still switches.
 * The page's clock is the script's (page.clock), so the 450ms is stepped, not waited for.
 */
async function checkHeaderLongPress(browser: Browser, origin: string, first: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    await context.addInitScript(() => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem("ovis:phone-tabs", JSON.stringify("header"));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.clock.install();
    await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
    await page.locator(".conn-live").waitFor();
    const row = page.locator(".app-header .header-tabs .tab-strip");
    const second = row.getByRole("tab", { name: "second", exact: true });
    await second.waitFor();
    const selected = (): Promise<string | null> => row.locator('[role="tab"][aria-selected="true"] .tab-strip-label').textContent();
    assert.equal(await selected(), "Tab 1", "the first tab is open");
    // a point on the second tab that is inside the row, not under its faded end
    const point = async (): Promise<{ x: number; y: number }> => {
      const tab = (await second.boundingBox())!;
      const strip = (await row.boundingBox())!;
      return { x: Math.min(tab.x + tab.width / 2, strip.x + strip.width - 24), y: tab.y + tab.height / 2 };
    };
    const cdp = await context.newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", at?: { x: number; y: number }) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
    const menu = page.getByRole("dialog", { name: "second", exact: true });

    // held: the tab's menu, and no switch when the finger lifts
    const at = await point();
    await touch("touchStart", at);
    await page.clock.runFor(600);
    await menu.waitFor();
    await touch("touchEnd");
    assert.equal(await selected(), "Tab 1", "a long press opens the tab's menu and does not open the tab");
    // the lift sent no click or focus that closes it: the menu is still there to use
    await menu.getByRole("button", { name: "Cancel", exact: true }).tap();
    await menu.waitFor({ state: "detached" });

    // a tap still opens the tab
    await second.tap();
    await row.locator('[role="tab"][aria-selected="true"] .tab-strip-label', { hasText: "second" }).waitFor();

    // moved past the slop: no menu once the 450ms have passed, and no tab opened (Tab 1, now beside the open one).
    // Last: under the page's clock the press's own events can leave the next tap unanswered, which a real clock does not
    const tab1 = row.getByRole("tab", { name: /^Tab 1/ });
    const box1 = (await tab1.boundingBox())!;
    const strip1 = (await row.boundingBox())!;
    const from = { x: Math.min(Math.max(box1.x + box1.width / 2, strip1.x + 12), strip1.x + strip1.width - 24), y: box1.y + box1.height / 2 };
    await touch("touchStart", from);
    await touch("touchMove", { x: from.x, y: from.y + 20 });
    await page.clock.runFor(600);
    await touch("touchEnd");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(await page.getByRole("dialog").count(), 0, "a press that moves opens no menu");
    assert.equal(await selected(), "second", "and opens no tab");
    // the open split tab says its pane in words, the digits hidden: its name is never "Tab 11/2"
    await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
    const position = row.locator('[role="tab"][aria-selected="true"] .tab-strip-position');
    await position.waitFor();
    assert.match((await position.locator('[aria-hidden="true"]').textContent()) ?? "", /^[12]\/2$/, "the digits are drawn, hidden from the tab's name");
    assert.match((await position.locator(".visually-hidden").textContent()) ?? "", /^, Pane [12] of 2$/, "and said in words");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

/** A phone's header and its list of a workspace's tabs, and a tablet's strip of more tabs than fit. */
export async function checkMobileTabs(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-mobile-tabs-")));
  let workspaceId: string | null = null;
  let otherWorkspaceId: string | null = null;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-mobile-tabs" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    // herdr keeps the first pane in front: the split one is seen only where the browser opens it
    const second = (await paneSplit(first, "right", false)).pane_id;
    const other = await workspaceCreate({ cwd: root, label: "ovis-test-mobile-tabs-other" });
    otherWorkspaceId = other.workspace.workspace_id;
    const panes: string[] = [];
    for (const label of TAB_LABELS) panes.push((await tabCreate({ workspaceId, cwd: root, label })).root_pane.pane_id);
    const last = panes.at(-1)!;
    await herdrRpc("pane.report_agent", { pane_id: first, source: "manual", agent: "claude", state: "idle" });

    await checkPhoneRow(browser, origin, first, panes);
    await checkHeaderLongPress(browser, origin, first);
    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      if (localStorage.getItem("ovis:phone-tabs") === null) localStorage.setItem("ovis:phone-tabs", JSON.stringify("header"));
      const viewport = window.visualViewport!;
      let height: number | null = null;
      Object.defineProperty(viewport, "height", { get: () => height ?? window.innerHeight });
      (window as unknown as KeyboardQA).keyboardQA = (value) => { height = value; viewport.dispatchEvent(new Event("resize")); };
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const evidence = process.env.UI_EVIDENCE_DIR;
    if (evidence) mkdirSync(evidence, { recursive: true });
    const screenshot = async (name: string): Promise<void> => {
      if (evidence) await page.screenshot({ path: join(evidence, `mobile-tabs-${name}.png`), animations: "disabled" });
    };

    await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(".app-header .header-tabs-sheet").waitFor();
    await openLens(page, "chat");
    const firstFrame = page.locator(`[data-layout-pane=${JSON.stringify(first)}]`);
    const composer = firstFrame.getByRole("textbox", { name: "Message", exact: true });
    await composer.waitFor();
    await assertShell(page, "chat");
    await screenshot("chat");

    await composer.tap();
    await page.evaluate(() => (window as unknown as KeyboardQA).keyboardQA(480));
    await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard") && Math.round(document.querySelector(".app")!.getBoundingClientRect().height) === 480);
    await assertShell(page, "chat with the keyboard up");
    assert.ok((await box(page, ".composer")).bottom <= 481, "the composer stays above the keyboard");
    await screenshot("chat-keyboard");
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); (window as unknown as KeyboardQA).keyboardQA(null); });
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-keyboard"));

    await openLens(page, "terminal");
    await firstFrame.locator(".key-bar").waitFor();
    assert.equal(await page.locator(".pane-frame:visible").count(), 1, "a phone shows the split tab's open pane alone");
    assert.equal(await page.locator(".pane-frame").count(), 2, "and keeps its sibling mounted");
    await assertShell(page, "terminal");

    // The title's list: every tab with a Close of its own, the open one marked, the open tab's move
    // and the ways to a new tab under them. It opens on its first row, and the title says it is open.
    const tabs = await openTabs(page);
    assert.equal(await page.locator(".app-header .header-tabs-sheet").getAttribute("aria-expanded"), "true", "the chevron says its list is open");
    assert.deepEqual(await tabs.locator(".row-sheet-item .row-sheet-label").allTextContents(), ["Tab 1", ...TAB_LABELS, "Move tab right", "New terminal", "New tab with agent…"],
      "the list holds the workspace's tabs in order, the first tab's one move, and New terminal and New tab with agent…");
    assert.equal(await tabs.locator('.row-sheet-item[aria-current="true"]').textContent(), "Tab 1", "the open tab is marked");
    assert.deepEqual(await tabs.locator(".row-sheet-aside").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label"))),
      ["Close Tab 1", ...TAB_LABELS.map((label) => `Close ${label}`)], "each tab has its own Close, named for it");
    const row = await tabs.locator('.row-sheet-item[aria-current="true"]').boundingBox();
    const close = await tabs.locator(".row-sheet-aside").first().boundingBox();
    assert.ok(row && close && row.height >= 44 && close.width >= 44 && close.height >= 44, "a tab and its Close are touch targets");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("row-sheet-item")), true, "the list takes the focus");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Close Tab 1", "the arrows reach each tab's Close after it");
    await screenshot("tabs");
    await cancelSheet(page, tabs);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("header-tabs-sheet")), true, "the focus goes back to the chevron");

    // More carries the open pane's and tab's actions where no row is drawn: a split tab's panes first, over its pane's actions
    await page.locator(".header-more-button").tap();
    const more = page.getByRole("dialog", { name: "More", exact: true });
    await more.waitFor();
    const ids = await more.locator(".row-sheet-item").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset["item"] ?? ""));
    // the pane's and tab's actions fold into one item, Pane and tab…, which opens them in a sheet of their own (G-143); the way into the agent inbox is More's last
    assert.deepEqual(ids.slice(-4).map((id) => id.startsWith("pane:") ? "pane" : id), ["pane", "pane", "pane-group", "enter-inbox"], `a split tab's two panes come before its pane's actions (${ids.join(", ")})`);
    await more.locator('.row-sheet-item[data-item="pane-group"]').tap();
    const actions = page.getByRole("dialog", { name: "Pane and tab…", exact: true });
    await actions.waitFor();
    const actionIds = await actions.locator(".row-sheet-item").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset["item"] ?? ""));
    assert.ok(actionIds.includes("rename") && actionIds.includes("close"), `the open pane's actions are in More on a phone (${actionIds.join(", ")})`);
    assert.deepEqual(actionIds.slice(-2), ["rename-tab", "close-tab"], "the open tab is renamed and closed from More, with no second way to a new tab");
    await cancelSheet(page, actions);

    await page.goto(`${origin}/?pane=${encodeURIComponent(last)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator(`[data-layout-pane=${JSON.stringify(last)}]`).waitFor({ state: "visible" });
    await assertShell(page, "the last tab");
    await screenshot("last-tab");

    await pickTab(page, "Tab 1");
    await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).waitFor({ state: "visible" });

    // The pane a tab and a workspace row were last seen on outlives a reload (a phone drops a page
    // left in the background): both open the split pane last seen, not the one herdr has in front.
    const shown = (pane: string) => page.locator(`[data-layout-pane=${JSON.stringify(pane)}]`).waitFor({ state: "visible" });
    await page.goto(`${origin}/?pane=${encodeURIComponent(second)}`);
    await page.locator(".conn-live").waitFor();
    await shown(second);
    await pickTab(page, "docs");
    await shown(last);
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await shown(last);
    await pickTab(page, "Tab 1");
    await shown(second);
    assert.equal(await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).isVisible(), false, "a tab opened again after a reload shows the pane it was left on");
    await page.goto(`${origin}/?pane=${encodeURIComponent(other.root_pane.pane_id)}`);
    await page.locator(".conn-live").waitFor();
    await page.reload();
    await page.locator(".conn-live").waitFor();
    await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspaceId)}] > .workspace-header .workspace-select`).tap();
    await shown(second);
    assert.equal(await page.locator(`[data-layout-pane=${JSON.stringify(first)}]`).isVisible(), false, "a workspace row picked after a reload opens the pane it was left on");

    await page.setViewportSize({ width: 320, height: 640 });
    await assertShell(page, "a 320px phone", 0);
    await screenshot("narrow");

    // Wider than a phone a touch screen keeps the row: the open tab's own touch menu beside its name
    await page.setViewportSize(TABLET);
    await page.locator(".tab-strip").waitFor();
    assert.equal(await page.locator(".app-header .header-tabs-sheet").count(), 0, "no chevron lists the tabs where the row is drawn");
    assert.equal(await page.locator(".tab-strip-close, .tab-strip-panes").count(), 0, "tabs have no close buttons or chevrons");
    assert.equal(await page.locator(".tab-strip-menu:visible").count(), 1, "only the active tab exposes a touch menu");
    const tab = await box(page, ".tab-strip-item.is-active .tab-strip-tab");
    const menu = await box(page, ".tab-strip-item.is-active .tab-strip-menu");
    assert.ok(menu.left >= tab.right - 0.5, `the tab's menu button is beside its name, not over it (${menu.left} vs ${tab.right})`);
    assert.ok(menu.width >= 40 && menu.height >= 40, "the tab menu button is a touch target");
    assert.ok((await box(page, ".tab-strip")).height >= 40, "the strip is a touch target tall");
    await activeTabInView(page, "a tablet's strip");
    assert.deepEqual(errors, []);

    // The app's faces come after the first paint (src/fonts/fonts.css, font-display: swap) and
    // every tab's name is redrawn with them, wider or narrower: the strip that brought the open
    // tab into view in the fallback brings it into view again. The font files are held here until
    // the fallback drawing is seen; no service worker, so that nothing answers them from a cache.
    // A strip the user scrolled themselves, to look at other tabs, is left where they put it by a
    // face that comes after: the scroll below is not the strip's own, which is all the app can
    // know of a wheel or a drag. Opening a tab ends that.
    for (const scrolled of [false, true]) {
      const slow = await browser.newContext({ viewport: TABLET, isMobile: true, hasTouch: true, locale: "en-US", serviceWorkers: "block" });
      try {
        await slow.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
        const late = await slow.newPage();
        const lateErrors: string[] = [];
        late.on("pageerror", (error) => lateErrors.push(error.message));
        let release = (): void => undefined;
        const released = new Promise<void>((done) => { release = done; });
        await late.route("**/*.woff2", async (route) => { await released; await route.continue().catch(() => undefined); });
        const strip = late.locator(".tab-strip");
        const openInView = (): Promise<boolean> => strip.evaluate((node) => {
          const item = node.querySelector(".tab-strip-item.is-active")!.getBoundingClientRect();
          return item.left >= node.getBoundingClientRect().left - 1 && item.right <= node.querySelector(".tab-strip-add")!.getBoundingClientRect().left + 1;
        });
        try {
          await late.goto(`${origin}/?pane=${encodeURIComponent(last)}`);
          await late.locator(".conn-live").waitFor();
          await late.locator('.tab-strip [role="tab"][aria-selected="true"]', { hasText: "docs" }).waitFor();
          assert.equal(await late.evaluate(() => [...document.fonts].filter((face) => face.family.replace(/["']/g, "") === "Pretendard Variable" && face.status === "loaded").length), 0, "the strip is first drawn before its face comes");
          await activeTabInView(late, "the last tab, before the faces came");
          if (scrolled) {
            await strip.evaluate((node) => { node.scrollLeft = 0; });
            await late.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            assert.equal(await openInView(), false, "the user scrolled the strip away from the open tab");
          }
        } finally { release(); }
        await appFaces(late);
        if (scrolled) {
          assert.equal(await strip.evaluate((node) => node.scrollLeft), 0, "a strip the user scrolled is left there when the faces come");
          assert.equal(await openInView(), false);
          await late.getByRole("tab", { name: "Tab 1", exact: true }).tap();
          await late.locator('.tab-strip [role="tab"][aria-selected="true"]', { hasText: "Tab 1" }).waitFor();
          await activeTabInView(late, "a tab opened after the user's scroll");
        } else {
          await activeTabInView(late, "the last tab, after the faces came");
        }
        assert.deepEqual(lateErrors, []);
      } finally { await slow.close(); }
    }
    console.log("PASS a phone's tabs are a row under the header by default, one tap to another; in the header, they keep a one-row header whose chevron lists them, in both lenses and with the keyboard up, reopens a tab and a workspace on the pane last seen after a reload, and a tablet keeps the open tab and the + in its strip");
  } finally {
    await context.close();
    if (workspaceId) await workspaceClose(workspaceId).catch(() => undefined);
    if (otherWorkspaceId) await workspaceClose(otherWorkspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-mobile-tabs-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkMobileTabs(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
