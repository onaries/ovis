import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

// A long press on a pane on a touch screen is the phone's own (select text, copy): it does not
// open the pane menu. A right-click still does. On the unmodified app over the demo's fixture
// transport: no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-touch-long-press-demo-"));

/**
 * Fires a contextmenu on the chat as `pointerType` would, and says whether the page took it.
 * "legacy-touch": a browser whose contextmenu carries no pointer type, after a touch;
 * "keyboard": Shift+F10 after that touch, a contextmenu with no pointer type either;
 * "drag-select": Android Chrome after a dragged selection, a contextmenu typed "mouse" with no press of its own.
 */
const press = (page: Page, how: "touch" | "mouse" | "legacy-touch" | "empty-touch" | "mouse-touch" | "touchstart-only" | "keyboard" | "drag-select"): Promise<boolean> => page.locator(".pane-frame.is-current .pane-frame-body").evaluate((body, how) => {
  const target = body.querySelector(".chat-view, .terminal-stack") ?? body;
  const rect = target.getBoundingClientRect();
  const type = how === "mouse" ? "mouse" : "touch";
  const at = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 3, pointerType: type, isPrimary: true };
  if (how === "touchstart-only") {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true }));
  } else {
    target.dispatchEvent(new PointerEvent("pointerdown", { ...at, button: type === "mouse" ? 2 : 0, buttons: type === "mouse" ? 2 : 1 }));
    target.dispatchEvent(new PointerEvent("pointerup", { ...at, button: type === "mouse" ? 2 : 0, buttons: 0 }));
  }
  if (how === "keyboard") target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "F10", shiftKey: true }));
  const event = how === "empty-touch" ? new PointerEvent("contextmenu", { ...at, pointerType: "", button: 2 })
    : how === "mouse-touch" || how === "touchstart-only" ? new PointerEvent("contextmenu", { ...at, pointerType: "mouse", button: 2 })
    : how === "drag-select" ? new PointerEvent("contextmenu", { ...at, pointerType: "mouse", button: -1 })
    : how === "touch" || how === "mouse" ? new PointerEvent("contextmenu", { ...at, button: 2 }) : new MouseEvent("contextmenu", { ...at, button: 2 });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}, how);

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));
  const server = serveDemo(app);
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat" })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.omp)}&view=chat`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".pane-frame.is-current").waitFor();
      const paneMenu = page.getByRole("dialog", { name: /^Pane actions for / });

      assert.equal(await press(page, "touch"), false, "a touch long press keeps the phone's own selection and copy");
      assert.equal(await press(page, "drag-select"), false, "the contextmenu typed mouse that ends a dragged selection is the touch's");
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      assert.equal(await paneMenu.count(), 0, "a touch long press opens no pane menu");

      assert.equal(await press(page, "legacy-touch"), false, "a contextmenu with no pointer type right after a touch is the touch's");
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      assert.equal(await paneMenu.count(), 0, "it opens no pane menu either");

      const selected = await page.locator(".pane-frame.is-current .chat-view").evaluate((chat) => {
        const node = document.createTreeWalker(chat, NodeFilter.SHOW_TEXT).nextNode();
        if (!node) throw new Error("the chat fixture has no text to select");
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = window.getSelection();
        if (!selection) throw new Error("the browser has no selection");
        selection.removeAllRanges();
        selection.addRange(range);
        return selection.toString();
      });
      assert.ok(selected.length > 0, "the chat has selected text ready to copy");
      assert.equal(await press(page, "empty-touch"), false, "an empty pointer type after a touch keeps native selection and copy");
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      assert.equal(await paneMenu.count(), 0, "an empty pointer type opens no pane menu");
      assert.equal(await page.evaluate(() => window.getSelection()?.toString()), selected, "the long press leaves the selected text intact");

      for (const how of ["mouse-touch", "touchstart-only"] as const) {
        assert.equal(await press(page, how), false, "a touch-origin menu reported as a mouse keeps native selection");
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        assert.equal(await paneMenu.count(), 0, "a touch-origin mouse menu opens no pane menu");
        assert.equal(await page.evaluate(() => window.getSelection()?.toString()), selected, "touch-origin mouse events leave selected text intact");
      }

      assert.equal(await press(page, "keyboard"), true, "a menu asked for from the keyboard after a touch is the app's");
      await paneMenu.waitFor();
      await page.keyboard.press("Escape");
      await paneMenu.waitFor({ state: "detached" });

      assert.equal(await press(page, "mouse"), true, "a right-click is still the app's");
      await paneMenu.waitFor();
      assert.deepEqual(errors, []);
      console.log("PASS a touch long press on a pane is the phone's own; the keyboard and a right-click still open the pane menu");
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
