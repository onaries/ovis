/** Review regressions for the sidebar divider, using synthetic demo data only. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

interface Scene {
  storage?: Record<string, string>;
  settings?: Record<string, unknown>;
  viewport?: { width: number; height: number };
  touch?: boolean;
  forcedColors?: boolean;
}
const app = mkdtempSync(join(tmpdir(), "ovis-sidebar-split-access-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      /** Each check gets a fresh device's preferences, with no shared browser state. */
      const check = async (name: string, scene: Scene, run: (page: Page) => Promise<void>) => {
        const context = await browser.newContext({ viewport: scene.viewport ?? { width: 1280, height: 844 }, hasTouch: scene.touch, isMobile: scene.touch, forcedColors: scene.forcedColors ? "active" : "none", locale: "en-US" });
        try {
          await context.addInitScript(({ storage, settings }) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light", defaultView: "chat", ...settings }));
            localStorage.setItem("ovis:agents-collapsed", "0");
            for (const [key, value] of Object.entries(storage ?? {})) localStorage.setItem(key, value);
          }, scene);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          if ((scene.viewport?.width ?? 1280) <= 768) {
            await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
            await page.waitForFunction(() => (document.querySelector(".sidebar.is-open")?.getBoundingClientRect().left ?? -1) >= -0.5);
          }
          await page.evaluate(() => document.fonts.ready);
          await run(page);
          assert.deepEqual(errors, [], `${name}: no browser errors`);
          console.log(`PASS ${name}`);
        } finally { await context.close(); }
      };

      await check("a no-match filter reveals selection context without changing the saved PCs fold", { storage: { "ovis:pcs-collapsed": "1" } }, async (page) => {
        await page.locator(".sidebar-filter-input").fill("zzzz-unmatched-review");
        await page.locator(".machine-list .workspace-group").first().waitFor({ state: "attached" });
        assert.equal(await page.locator(".sidebar-section-toggle").getAttribute("aria-expanded"), "true");
        assert.ok(await page.locator(".machine-list .workspace-group").first().isVisible());
        assert.equal(await page.evaluate(() => localStorage.getItem("ovis:pcs-collapsed")), "1");
        await page.locator(".sidebar-filter-clear").click();
        assert.equal(await page.locator(".sidebar-section-toggle").getAttribute("aria-expanded"), "false");
      });
      await check("closing the temporary filter returns focus to the PCs heading when its opener is hidden", { storage: { "ovis:sidebar-filter": "false" } }, async (page) => {
        await page.locator(".machine-list .workspace-select").first().focus();
        await page.keyboard.press("ControlOrMeta+Shift+k");
        const search = page.getByRole("searchbox", { name: "Search panes and actions", exact: true });
        await search.fill("Filter workspaces and agents");
        await search.press("Enter");
        await page.getByRole("button", { name: "Close filter", exact: true }).waitFor();
        await page.locator(".sidebar-section-toggle").click();
        await page.getByRole("button", { name: "Close filter", exact: true }).click();
        assert.ok(await page.locator(".sidebar-section-toggle").evaluate((button) => document.activeElement === button));
      });
      await check("the divider has a visible keyboard focus outline in forced colors", { forcedColors: true }, async (page) => {
        const line = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
        await line.focus();
        const focus = await line.evaluate((element) => {
          const style = getComputedStyle(element);
          return { visible: element.matches(":focus-visible"), outline: style.outlineStyle, width: parseFloat(style.outlineWidth) };
        });
        assert.ok(focus.visible);
        assert.notEqual(focus.outline, "none");
        assert.ok(focus.width >= 1);
      });
      for (const [pcs, agents] of [["1", "1"], ["1", "0"], ["0", "1"]]) {
        await check(`short phone window keeps the footer reachable with folds ${pcs}/${agents}`, { viewport: { width: 390, height: 300 }, touch: true, storage: { "ovis:pcs-collapsed": pcs!, "ovis:agents-collapsed": agents! } }, async (page) => {
          const fits = await page.evaluate(() => {
            const shell = document.querySelector(".sidebar-shell")!.getBoundingClientRect();
            const footer = document.querySelector(".sidebar-footer")!.getBoundingClientRect();
            return footer.bottom <= shell.bottom + 1 && footer.top >= shell.top;
          });
          assert.ok(fits, "folded headings share the available room rather than pushing the footer out");
        });
      }
      await check("a click focuses the divider so the next arrow key resizes it", {}, async (page) => {
        await page.locator(".sidebar-filter-input").focus();
        const line = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
        await line.click();
        assert.ok(await line.evaluate((element) => document.activeElement === element));
        const before = await line.getAttribute("aria-valuenow");
        await page.keyboard.press("ArrowUp");
        assert.notEqual(await line.getAttribute("aria-valuenow"), before);
        assert.notEqual(await page.evaluate(() => localStorage.getItem("ovis:sidebar-split")), null);
      });
      await check("the divider reports its live percentage during a drag", {}, async (page) => {
        const line = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
        const box = (await line.boundingBox())!;
        const before = await line.getAttribute("aria-valuenow");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, box.y - 80, { steps: 8 });
        const during = await line.getAttribute("aria-valuenow");
        await page.mouse.up();
        assert.notEqual(during, before);
      });
      await check("only the first finger owns a divider drag", { viewport: { width: 390, height: 844 }, touch: true }, async (page) => {
        const line = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
        const box = (await line.boundingBox())!;
        const first = { id: 1, x: box.x + box.width / 3, y: box.y + box.height / 2 };
        const second = { id: 2, x: first.x + 30, y: first.y };
        const cdp = await page.context().newCDPSession(page);
        const before = await line.getAttribute("aria-valuenow");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first, second] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [first, { ...second, y: second.y - 80 }] });
        assert.equal(await line.getAttribute("aria-valuenow"), before, "a second finger cannot move the divider");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ ...second, y: second.y - 80 }] });
        assert.ok(await line.evaluate((element) => element.classList.contains("is-dragging")), "lifting the second finger cannot end the first finger's drag");
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...first, y: first.y - 60 }] });
        await page.waitForFunction((before) => document.querySelector(".sidebar-split")?.getAttribute("aria-valuenow") !== before, before);
        assert.notEqual(await line.getAttribute("aria-valuenow"), before);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        assert.notEqual(await page.evaluate(() => localStorage.getItem("ovis:sidebar-split")), null);
      });
      for (const [pcs, agents] of [["0", "0"], ["1", "0"], ["0", "1"], ["1", "1"]]) {
        await check(`cancelling a snap restores folds ${pcs}/${agents} and the saved split`, { viewport: { width: 390, height: 844 }, touch: true, storage: { "ovis:pcs-collapsed": pcs!, "ovis:agents-collapsed": agents!, "ovis:sidebar-split": "260" } }, async (page) => {
          const line = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
          const box = (await line.boundingBox())!;
          const top = await page.locator(".pcs-sidebar").boundingBox();
          const finger = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [finger] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ ...finger, y: top!.y + 10 }] });
          await page.locator(".sidebar-split.is-snapping").waitFor();
          await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
          await page.locator(".sidebar-split.is-dragging").waitFor({ state: "hidden" });
          assert.equal(await page.locator(".sidebar-section-toggle").getAttribute("aria-expanded"), pcs === "0" ? "true" : "false");
          assert.equal(await page.locator(".agent-section-toggle").getAttribute("aria-expanded"), agents === "0" ? "true" : "false");
          assert.equal(await page.evaluate(() => localStorage.getItem("ovis:sidebar-split")), "260");
          assert.equal(await page.locator(".will-fold").count(), 0);
          assert.ok(Math.abs((await line.boundingBox())!.y - box.y) <= 1, "cancel restores the previous allocation");
        });
      }
      await check("a cancellation in the first drag task restores the saved PCs fold", { viewport: { width: 390, height: 844 }, touch: true, storage: { "ovis:pcs-collapsed": "1" } }, async (page) => {
        const line = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
        await line.evaluate((element) => {
          document.addEventListener("pointerdown", (event) => {
            // Keep native capture from a real touch, but deliver move/cancel in one task so React
            // cannot render between them. Separate CDP calls would allow that render.
            queueMicrotask(() => {
              const init = { bubbles: true, cancelable: true, composed: true, pointerId: event.pointerId, pointerType: event.pointerType, isPrimary: true, clientX: event.clientX, clientY: event.clientY + 20 };
              element.dispatchEvent(new PointerEvent("pointermove", { ...init, buttons: 1 }));
              element.dispatchEvent(new PointerEvent("pointercancel", init));
            });
          }, { once: true });
        });
        const box = (await line.boundingBox())!;
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        await page.locator(".sidebar-split.is-dragging").waitFor({ state: "hidden" });
        assert.equal(await page.locator(".sidebar-section-toggle").getAttribute("aria-expanded"), "false");
        assert.equal(await page.evaluate(() => localStorage.getItem("ovis:pcs-collapsed")), "1");
      });
      await check("changing order during a held snap removes its dimmed preview", {}, async (page) => {
        const line = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
        const box = (await line.boundingBox())!;
        const pcs = (await page.locator(".pcs-sidebar").boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2, pcs.y + 10, { steps: 8 });
        await page.locator(".pcs-sidebar.will-fold").waitFor();
        await page.keyboard.press("ControlOrMeta+Shift+Comma");
        const appearance = page.locator(".settings-dialog").getByRole("tab", { name: "Appearance", exact: true });
        await appearance.focus();
        await page.keyboard.press("Enter");
        // Agents order's By state groups the list, picked from the keyboard
        const grouping = page.getByRole("group", { name: "Agents order", exact: true }).getByRole("button", { name: "By state", exact: true });
        await grouping.focus();
        await page.keyboard.press("Space");
        await page.keyboard.press("Escape");
        await page.locator(".sidebar-shell.is-agents-first").waitFor();
        await page.mouse.up();
        assert.equal(await page.locator(".will-fold").count(), 0);
        assert.equal(await page.locator(".sidebar-shell.is-splitting").count(), 0);
        await page.waitForFunction(() => getComputedStyle(document.querySelector(".pcs-sidebar")!).opacity === "1");
      });
      for (const density of ["comfortable", "compact"]) for (const grouped of [false, true]) {
        await check(`the Agents minimum holds a two-line row (${density}, ${grouped ? "agents" : "pcs"} first)`, { settings: { sidebarRows: "two", density }, storage: { "ovis:agent-groups": String(grouped), "ovis:sidebar-split": "2000", "ovis:sidebar-split-agents-first": "1" } }, async (page) => {
          const heights = await page.evaluate(() => ({
            list: document.querySelector(".agent-list-contents")!.getBoundingClientRect().height,
            row: document.querySelector(".agent-row")!.getBoundingClientRect().height,
          }));
          assert.ok(heights.list >= heights.row, `list viewport ${heights.list}px holds a ${heights.row}px row`);
        });
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
