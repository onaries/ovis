import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { tabCreate, tabRename, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const TAB_LABELS = ["api", "web", "docs", "deploy", "review", "tests", "release-notes", "migrations", "infra", "billing",
  "search", "mobile", "analytics", "onboarding", "payments", "metrics", "support", "staging", "backups", "last-tab"];
const HEADER = ".header-tabs .tab-strip";
const HALF = '.pane-slot[data-side="left"] .tab-strip';
const TAB_MIN = 120;

/** What the header's row shows: each drawn tab's name, width and whether its close is in view, and the More button's count. */
async function headerRow(page: Page): Promise<{ tabs: { name: string; width: number; selected: boolean; closeShown: boolean }[]; more: string | null; overflow: number }> {
  return page.evaluate((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    const items = [...(row?.querySelectorAll<HTMLElement>(".tab-strip-item") ?? [])];
    return {
      tabs: items.map((item) => {
        const tab = item.querySelector<HTMLElement>('[role="tab"]');
        const close = item.querySelector<HTMLElement>(".tab-strip-close");
        return {
          name: tab?.textContent ?? "",
          width: item.getBoundingClientRect().width,
          selected: tab?.getAttribute("aria-selected") === "true",
          closeShown: !!close && getComputedStyle(close).display !== "none" && close.getBoundingClientRect().width > 0,
        };
      }),
      more: document.querySelector<HTMLElement>(".header-tabs .tab-strip-more")?.textContent ?? null,
      overflow: row ? row.scrollWidth - row.clientWidth : -1,
    };
  }, HEADER);
}

/**
 * More tabs than fit. The header's row on a desktop (the owner's report: tabs shrank until their
 * close took most of each, and a click meant for a tab closed it) never draws a tab narrower than
 * TAB_MIN: the tabs that do not fit wait behind a More button after the +, whose list opens any of
 * them, and the open tab is always in the row. A split half's strip still scrolls (#1515): a vertical
 * wheel over it moves it sideways, by the wheel's own unit (pixels, lines or pages), until the last
 * tab is in view. A sideways wheel (a trackpad, a tilt wheel), a diagonal trackpad swipe (#2103), a
 * pinch and a strip whose tabs fit are left to the browser.
 */
export async function checkTabOverflow(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-tab-overflow-")));
  let workspaceId: string | null = null;
  let fewId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-tab-overflow" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    let last = first;
    await tabRename(created.tab.tab_id, TAB_LABELS[0]!);
    for (const label of TAB_LABELS.slice(1)) last = (await tabCreate({ workspaceId, cwd: root, label })).root_pane.pane_id;
    const few = await workspaceCreate({ cwd: root, label: "ovis-test-tab-overflow-few" });
    fewId = few.workspace.workspace_id;

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
    try {
      await context.addInitScript(() => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      });
      const page = await context.newPage();

      // the header's row with the last tab open: the row keeps it, and the rest that do not fit wait behind More
      const rowSettled = async (when: string, open: string): Promise<Awaited<ReturnType<typeof headerRow>>> => {
        await page.locator(`${HEADER} [role="tab"][aria-selected="true"]`, { hasText: new RegExp(`^${open}$`) }).waitFor({ timeout: 15_000 });
        await page.locator(".header-tabs .tab-strip-more").waitFor({ timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: 20 tabs that do not fit show no More button in the header's row`); });
        // the row draws fewer tabs once it has measured its new width (a resize, a split closed)
        await page.waitForFunction((selector) => {
          const node = document.querySelector(selector);
          return !!node && node.scrollWidth - node.clientWidth <= 1;
        }, HEADER, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: the header's row still scrolls past its end`); });
        const row = await headerRow(page);
        const narrow = row.tabs.filter((tab) => tab.width < TAB_MIN - 0.5);
        assert.deepEqual(narrow, [], `${when}: no tab in the header's row is narrower than ${TAB_MIN}px`);
        assert.ok(row.overflow <= 1, `${when}: the header's row does not scroll (${row.overflow}px past its end)`);
        assert.ok(row.tabs.length >= 2 && row.tabs.length < TAB_LABELS.length, `${when}: some tabs are in the row and some are not (${row.tabs.length})`);
        assert.equal(row.more?.replace(/\D/g, ""), String(TAB_LABELS.length - row.tabs.length), `${when}: More counts the tabs left out of the row`);
        assert.ok(row.tabs.some((tab) => tab.selected && tab.name === open), `${when}: the open tab ${open} is in the row`);
        return row;
      };

      await page.goto(`${origin}/?pane=${encodeURIComponent(last)}`);
      const row = await rowSettled("20 tabs, the last open", "last-tab");
      await closeOnlyOnFullTabs(page);
      const hidden = TAB_LABELS.filter((label) => !row.tabs.some((tab) => tab.name === label));
      assert.ok(hidden.includes("metrics"), "metrics waits behind More");

      // More lists every tab left out of the row; one picked from it opens and comes into the row
      await page.locator(".header-tabs .tab-strip-more").click();
      const listed = await page.getByRole("menu").getByRole("menuitem").allTextContents();
      assert.deepEqual(listed.map((text) => text.trim()), hidden, "More lists the tabs left out of the row, in their order");
      await page.getByRole("menu").getByRole("menuitem", { name: "metrics", exact: true }).click();
      await rowSettled("metrics picked from More", "metrics");

      // a narrower window keeps the tabs as wide, and fewer of them in the row
      await page.setViewportSize({ width: 1024, height: 900 });
      await rowSettled("at 1024px", "metrics");
      await page.setViewportSize({ width: 1280, height: 900 });
      console.log("PASS the header's row keeps every tab at least 120px wide and its close only on a full-size tab; the tabs that do not fit are listed behind More, and one picked there opens in the row");

      // a split half's own strip still scrolls under the wheel
      const strip = page.locator(HALF);
      const overflowing = async (): Promise<void> => {
        await page.locator(`${HALF} [role="tab"]`, { hasText: /^last-tab$/ }).waitFor({ state: "attached", timeout: 15_000 });
        await page.waitForFunction((selector) => {
          const node = document.querySelector(selector);
          return !!node && node.scrollWidth - node.clientWidth > 100;
        }, HALF, { timeout: 5_000 });
      };
      const scrollLeft = (): Promise<number> => strip.evaluate((node) => node.scrollLeft);
      const wheelScrolls = async (when: string): Promise<void> => {
        await strip.evaluate((node) => { node.scrollLeft = 0; });
        const box = await strip.boundingBox();
        assert.ok(box, `${when}: the strip is drawn`);
        await page.mouse.move(box.x + 60, box.y + box.height / 2);
        await page.mouse.wheel(0, 400);
        await page.waitForFunction((selector) => (document.querySelector(selector)?.scrollLeft ?? 0) > 0, HALF, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: a vertical wheel over the overflowing strip left it unscrolled`); });
        const down = await scrollLeft();
        await page.mouse.wheel(0, -400);
        await page.waitForFunction(([selector, was]) => (document.querySelector(selector as string)?.scrollLeft ?? was) < (was as number), [HALF, down] as const, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: a wheel turned up did not scroll the strip back`); });
        // turned on down far enough, the wheel brings the last tab fully into view before the +
        await page.mouse.wheel(0, 10_000);
        await page.waitForFunction((selector) => {
          const node = document.querySelector(selector);
          const end = [...(node?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find((tab) => tab.textContent === "last-tab");
          const add = node?.querySelector(".tab-strip-add");
          if (!node || !end || !add) return false;
          const box = node.getBoundingClientRect();
          const item = end.getBoundingClientRect();
          return item.left >= box.left && item.right <= add.getBoundingClientRect().left + 1;
        }, HALF, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: wheeling down to the strip's end left the last tab out of view`); });
      };
      // whether the strip let the browser have a synthetic wheel: true when nothing cancelled it
      const leftAlone = (selector: string, init: WheelEventInit): Promise<boolean> => page.locator(selector).first().evaluate((node, wheel) =>
        node.dispatchEvent(new WheelEvent("wheel", { ...wheel, bubbles: true, cancelable: true })), init);

      await page.evaluate((other) => {
        sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: other }, bSide: "right", active: "a" }));
      }, few.root_pane.pane_id);
      await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, null, { timeout: 15_000 });
      await overflowing();
      await wheelScrolls("split half");
      // a wheel that counts in lines (Firefox's) or pages moves the strip as far as one in pixels would
      for (const [mode, delta, least] of [[1, 3, 30], [2, 1, 200]] as const) {
        const moved = await strip.evaluate((node, [deltaMode, deltaY]) => {
          node.scrollLeft = 0;
          node.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true }));
          return { moved: node.scrollLeft, room: node.scrollWidth - node.clientWidth };
        }, [mode, delta] as const);
        assert.ok(moved.moved >= Math.min(least, moved.room - 1), `a wheel in ${mode === 1 ? "lines" : "pages"} scrolls the strip (${moved.moved}px of ${moved.room})`);
      }
      assert.equal(await leftAlone(HALF, { deltaX: 120, deltaY: 10 }), true, "a sideways wheel or trackpad swipe is the browser's");
      // mostly down, a little sideways either way: turned into sideways scroll from deltaY alone, the
      // strip would move against the swipe's own sideways part (#2103)
      for (const deltaX of [20, -20]) assert.equal(await leftAlone(HALF, { deltaX, deltaY: 40 }), true, `a diagonal trackpad swipe (deltaX ${deltaX}) is the browser's`);
      assert.equal(await leftAlone(HALF, { deltaY: 120, ctrlKey: true }), true, "a pinch is the browser's");
      const fewStrip = '.pane-slot[data-side="right"] .tab-strip';
      assert.equal(await page.locator(fewStrip).evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the one tab fits");
      assert.equal(await leftAlone(fewStrip, { deltaY: 120 }), true, "a strip whose tabs fit leaves the wheel alone");

      // the split closed: the header's row is drawn again, with its More and no tab under the minimum
      await page.locator('.pane-slot[data-side="right"]').getByRole("button", { name: "Close this half", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length <= 1, null, { timeout: 15_000 });
      await rowSettled("after a split closed", "api");
    } finally { await context.close(); }
    console.log("PASS a vertical mouse wheel scrolls a split half's overflowing tab strip sideways to its last tab (pixels, lines, pages), and leaves a sideways wheel, a diagonal swipe, a pinch and a strip that fits to the browser");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
    if (fewId) await workspaceClose(fewId).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

/** the pointer over a tab that is not open shows that tab's close, and only a full-size tab shows one */
async function closeOnlyOnFullTabs(page: Page): Promise<void> {
  await page.locator(`${HEADER} .tab-strip-item`).first().hover();
  const hovered = await headerRow(page);
  assert.ok(hovered.tabs[0]?.closeShown, "the hovered tab shows its close");
  for (const tab of hovered.tabs.filter((entry) => entry.closeShown)) assert.ok(tab.width >= TAB_MIN - 0.5, `${tab.name}: a close shows only on a full-size tab (${tab.width}px)`);
  assert.deepEqual(hovered.tabs.filter((tab) => tab.closeShown && !tab.selected).map((tab) => tab.name), [hovered.tabs[0]!.name], "only the hovered and the open tab show a close");
  await page.mouse.move(0, 400);
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-tab-overflow-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkTabOverflow(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
