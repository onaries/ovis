import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { tabCreate, tabRename, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const TAB_LABELS = ["api", "web", "docs", "deploy", "review", "tests", "release-notes", "migrations", "infra", "billing",
  "search", "mobile", "analytics", "onboarding", "payments", "metrics", "support", "staging", "backups", "last-tab"];

/**
 * More tabs than fit, on a desktop with a mouse (#1515): a vertical wheel over the strip scrolls it
 * sideways, by the wheel's own unit (pixels, lines or pages), until the last tab is in view, also
 * after a split closed under it drew the strip as a new node. A sideways wheel (a trackpad, a tilt
 * wheel), a pinch and a strip whose tabs fit are left to the browser.
 */
export async function checkTabOverflow(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-tab-overflow-")));
  let workspaceId: string | null = null;
  let fewId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-tab-overflow" });
    workspaceId = created.workspace.workspace_id;
    const first = created.root_pane.pane_id;
    await tabRename(created.tab.tab_id, TAB_LABELS[0]!);
    for (const label of TAB_LABELS.slice(1)) await tabCreate({ workspaceId, cwd: root, label });
    const few = await workspaceCreate({ cwd: root, label: "ovis-test-tab-overflow-few" });
    fewId = few.workspace.workspace_id;

    // 1024 wide: the 20 tabs overflow the strip by hundreds of pixels beside the sidebar
    const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, locale: "en-US" });
    try {
      await context.addInitScript(() => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      });
      const page = await context.newPage();
      const row = page.locator(".tab-strip");
      const overflowing = async (): Promise<void> => {
        await page.locator('.tab-strip [role="tab"]', { hasText: /^last-tab$/ }).waitFor({ state: "attached", timeout: 15_000 });
        await page.waitForFunction(() => {
          const node = document.querySelector(".tab-strip");
          return !!node && node.scrollWidth - node.clientWidth > 100;
        }, null, { timeout: 5_000 });
      };
      const scrollLeft = (): Promise<number> => row.evaluate((node) => node.scrollLeft);
      const wheelScrolls = async (when: string): Promise<void> => {
        await row.evaluate((node) => { node.scrollLeft = 0; });
        const box = await row.boundingBox();
        assert.ok(box, `${when}: the strip is drawn`);
        await page.mouse.move(box.x + 60, box.y + box.height / 2);
        await page.mouse.wheel(0, 400);
        await page.waitForFunction(() => (document.querySelector(".tab-strip")?.scrollLeft ?? 0) > 0, null, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: a vertical wheel over the overflowing strip left it unscrolled`); });
        const down = await scrollLeft();
        await page.mouse.wheel(0, -400);
        await page.waitForFunction((was) => (document.querySelector(".tab-strip")?.scrollLeft ?? was) < was, down, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: a wheel turned up did not scroll the strip back`); });
        // turned on down far enough, the wheel brings the last tab fully into view before the +
        await page.mouse.wheel(0, 10_000);
        await page.waitForFunction(() => {
          const node = document.querySelector(".tab-strip");
          const last = [...(node?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].find((tab) => tab.textContent === "last-tab");
          const add = node?.querySelector(".tab-strip-add");
          if (!node || !last || !add) return false;
          const strip = node.getBoundingClientRect();
          const item = last.getBoundingClientRect();
          return item.left >= strip.left && item.right <= add.getBoundingClientRect().left + 1;
        }, null, { timeout: 5_000 })
          .catch(() => { throw new Error(`${when}: wheeling down to the strip's end left the last tab out of view`); });
      };
      // whether the strip let the browser have a synthetic wheel: true when nothing cancelled it
      const leftAlone = (init: WheelEventInit): Promise<boolean> => row.evaluate((node, wheel) =>
        node.dispatchEvent(new WheelEvent("wheel", { ...wheel, bubbles: true, cancelable: true })), init);

      await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
      await overflowing();
      await wheelScrolls("solo strip");
      // a wheel that counts in lines (Firefox's) or pages moves the strip as far as one in pixels would
      for (const [mode, delta, least] of [[1, 3, 30], [2, 1, 200]] as const) {
        const moved = await row.evaluate((node, [deltaMode, deltaY]) => {
          node.scrollLeft = 0;
          node.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true }));
          return { moved: node.scrollLeft, room: node.scrollWidth - node.clientWidth };
        }, [mode, delta] as const);
        assert.ok(moved.moved >= Math.min(least, moved.room - 1), `a wheel in ${mode === 1 ? "lines" : "pages"} scrolls the strip (${moved.moved}px of ${moved.room})`);
      }
      assert.equal(await leftAlone({ deltaX: 120, deltaY: 10 }), true, "a sideways wheel or trackpad swipe is the browser's");
      assert.equal(await leftAlone({ deltaY: 120, ctrlKey: true }), true, "a pinch is the browser's");

      // a workspace whose tabs fit: its strip leaves the wheel to the page
      await page.goto(`${origin}/?pane=${encodeURIComponent(few.root_pane.pane_id)}`);
      await page.locator(".tab-strip-add").waitFor();
      assert.equal(await row.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the one tab fits");
      assert.equal(await leftAlone({ deltaY: 120 }), true, "a strip whose tabs fit leaves the wheel alone");

      // a split restored beside the strip, then closed: the strip is drawn as a new node, which
      // the wheel must still reach
      await page.evaluate((other) => {
        sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: other }, bSide: "right", active: "a" }));
      }, few.root_pane.pane_id);
      await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, null, { timeout: 15_000 });
      // the split half's own strip is drawn (the roster arrived) before the split closes under it
      await page.locator('.pane-slot[data-side="left"] .tab-strip [role="tab"]', { hasText: /^last-tab$/ }).waitFor({ state: "attached", timeout: 15_000 });
      await page.locator('.pane-slot[data-side="right"]').getByRole("button", { name: "Close this half", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1 && document.querySelectorAll(".tab-strip").length === 1);
      await overflowing();
      await wheelScrolls("after a split closed");
    } finally { await context.close(); }
    console.log("PASS a vertical mouse wheel scrolls an overflowing tab strip sideways to its last tab (pixels, lines, pages; also after a split closed), and leaves a sideways wheel, a pinch and a strip that fits to the browser");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
    if (fewId) await workspaceClose(fewId).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
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
