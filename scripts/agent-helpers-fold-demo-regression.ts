import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// Settings > Appearance > Fold helpers under their agent (#772) on the demo roster: checkout-api's
// Claude is given three helpers (herdr-core's parent_pane_id), web-dashboard's Codex, which is
// blocked, and the OMP and CLI agents, which are not. Only this disposable demo fixture is
// rewritten; no live session is read.
const AGENT = panes.api;
const BLOCKED = panes.web;
const IDLE = [panes.omp, panes.cli];
const app = mkdtempSync(join(tmpdir(), "herdr-helpers-fold-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const patch = `(() => {
  const EventSourceDemo = window.EventSource;
  const parents = ${JSON.stringify(Object.fromEntries([BLOCKED, ...IDLE].map((pane) => [pane, AGENT])))};
  const roster = (machines) => machines.map((machine) => {
    const copy = structuredClone(machine);
    for (const pane of copy.snapshot?.panes ?? []) if (parents[pane.pane_id]) pane.parent_pane_id = parents[pane.pane_id];
    return copy;
  });
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") message.machines = roster(message.machines);
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; }
  };
})();`;

const row = (page: Page, pane: string) => page.locator(`.agent-list .agent-item[data-pane="${pane}"]`);
const line = (page: Page) => page.locator(`.agent-list .agent-helpers[data-helpers-of="local:${AGENT}"]`);
const toggle = (page: Page) => line(page).locator(".agent-helpers-toggle");

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "helpers-fold.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./helpers-fold.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const phone of [false, true]) for (const theme of ["dark", "light"] as const) {
        const label = `${phone ? "phone" : "desktop"} ${theme}`;
        const context = await browser.newContext(phone
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US", colorScheme: theme }
          : { viewport: { width: 1280, height: 900 }, locale: "en-US", colorScheme: theme });
        try {
          // the sidebar's Filter field is off until chosen (Settings → Sidebar filter); this check types in it
          await context.addInitScript((value) => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value })); localStorage.setItem("ovis:sidebar-filter-shown", "true"); }, theme);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const open = async () => {
            await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.shell)}`);
            if (phone) {
              await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
              // the phone's drawer starts with Agents folded
              const agents = page.locator(".agent-section-toggle");
              if (await agents.getAttribute("aria-expanded") === "false") await agents.click();
            }
            await row(page, AGENT).waitFor();
            // one-line rows (the default) fold the resting agents under "+N resting": the idle helpers this check
            // reads are among them, so the fold is opened first (this device then keeps it open)
            const resting = page.locator(".agent-resting-label .agent-background-toggle");
            if (await resting.count() > 0 && await resting.getAttribute("aria-expanded") === "false") await resting.click();
          };
          const shot = async (name: string) => {
            if (!evidence) return;
            mkdirSync(evidence, { recursive: true });
            await page.locator(".agents-sidebar").screenshot({ path: join(evidence, `helpers-fold-${name}-${phone ? "390" : "1280"}-${theme}.png`) });
          };

          // never chosen: every helper is listed under its agent, as today
          await open();
          await row(page, IDLE[0]!).waitFor();
          assert.equal(await page.locator(".agent-list .agent-helpers").count(), 0, "off by default, no helpers line");
          for (const pane of [BLOCKED, ...IDLE]) {
            assert.ok(await row(page, pane).isVisible(), `${pane} listed`);
            assert.equal(await row(page, pane).getAttribute("data-depth"), "1", `${pane} under its agent`);
          }

          // turned on for this device: the helpers fold under one line, the blocked one stays in sight
          await page.evaluate(() => localStorage.setItem("ovis:fold-helpers", "true"));
          await open();
          await line(page).waitFor();
          assert.equal(await toggle(page).getAttribute("aria-expanded"), "false");
          assert.equal((await line(page).locator(".agent-section-count").textContent())?.trim(), "3");
          assert.equal(await line(page).locator('.agent-named-group-dot[data-state="blocked"]').getAttribute("title"), "1 need you");
          for (const pane of IDLE) assert.equal(await row(page, pane).isVisible(), false, `${pane} folded away`);
          assert.ok(await row(page, BLOCKED).isVisible(), "a helper that needs you stays in sight");
          // the line hangs right under its agent, and the blocked helper under the line
          const order = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".agent-list:not(.agent-list-pinned) > li:not([hidden])")].map((item) => item.dataset["pane"] ?? (item.dataset["helpersOf"] ? "LINE" : "")));
          const at = order.indexOf(AGENT);
          assert.deepEqual(order.slice(at, at + 3), [AGENT, "LINE", BLOCKED], "agent, its helpers line, the helper in sight");
          // the line is drawn inside the list's width, a helper's height
          // both read in one frame: the phone's drawer may still be sliding in
          const [lineBox, helperBox] = await page.evaluate(([agent, helper]) => [
            document.querySelector(`.agent-list .agent-helpers[data-helpers-of="local:${agent}"]`)!.getBoundingClientRect().toJSON(),
            document.querySelector(`.agent-list .agent-item[data-pane="${helper}"]`)!.getBoundingClientRect().toJSON(),
          ] as { x: number; width: number; height: number }[], [AGENT, BLOCKED] as const);
          assert.ok(Math.abs(lineBox!.height - helperBox!.height) <= 1, `the line is a helper's height (${lineBox!.height} vs ${helperBox!.height})`);
          assert.ok(Math.abs(lineBox!.x - helperBox!.x) <= 1 && Math.abs(lineBox!.width - helperBox!.width) <= 1, "and as wide as a row");
          await shot("folded");

          // opened, every helper is listed, and this device keeps it open
          await toggle(page).click();
          assert.equal(await toggle(page).getAttribute("aria-expanded"), "true");
          for (const pane of IDLE) assert.ok(await row(page, pane).isVisible(), `${pane} listed once opened`);
          await shot("open");
          await open();
          await line(page).waitFor();
          assert.equal(await toggle(page).getAttribute("aria-expanded"), "true", "kept open across a reload");
          await toggle(page).click();
          assert.equal(await row(page, IDLE[0]!).isVisible(), false, "folded again");

          // a helper pinned while open and unpinned while folded lands out of sight: the helpers line takes the focus
          await toggle(page).click();
          const item = (name: string) => page.getByRole(phone ? "button" : "menuitem", { name, exact: true });
          const menu = async (list: string) => {
            const target = page.locator(`${list} .agent-item[data-pane="${IDLE[0]}"]`);
            await (phone ? target.locator(".row-menu-toggle").click() : target.locator(".agent-select").click({ button: "right" }));
          };
          await menu(".agent-list:not(.agent-list-pinned)");
          await item("Pin agent").click();
          await page.locator(`.agent-list-pinned .agent-item[data-pane="${IDLE[0]}"]`).waitFor();
          await toggle(page).click();
          await menu(".agent-list-pinned");
          await item("Unpin agent").click();
          await page.locator(`.agent-list-pinned .agent-item[data-pane="${IDLE[0]}"]`).waitFor({ state: "detached" });
          assert.equal(await row(page, IDLE[0]!).isVisible(), false, "the unpinned helper is back in its folded family");
          await page.waitForFunction(() => document.activeElement?.classList.contains("agent-helpers-toggle") ?? false);

          // the filter shows what it kept: no fold, no line
          await page.locator(".sidebar-filter-input").fill("omp");
          await row(page, IDLE[0]!).waitFor({ state: "visible" });
          assert.equal(await page.locator(".agent-list .agent-helpers").count(), 0, "no helpers line under the filter");
          await page.locator(".sidebar-filter-clear").click();
          await line(page).waitFor();
          assert.equal(await row(page, IDLE[0]!).isVisible(), false, "folded again once the filter is cleared");
          assert.deepEqual(errors, []);
          console.log(`PASS ${label}: off by default; on, helpers fold under a counted line that keeps a blocked helper in sight, opens and stays open on this device, and gives way to the filter`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
