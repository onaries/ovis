import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

// Settings → Remote PCs → Show in sidebar on the unmodified app over the demo's fixture transport,
// at a phone's and a desktop's width. Only this disposable fixture rewrites the roster into two
// connected PCs, the Host "Laptop" and "Work PC"; no herdr session is opened. Hiding Work PC takes
// it out of the sidebar, the Agents list and the command palette on this device, moves the
// selection off it, keeps the last PC shown, survives a reload, and leaves a link to its pane
// working; the sidebar's note brings it back. Screenshots go to UI_EVIDENCE_DIR when it is set.
const app = mkdtempSync(join(tmpdir(), "herdr-hide-pc-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  let last = null;
  const roster = (original) => ["local", "work"].map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = id === "local" ? "Laptop" : "Work PC";
    machine.state = "connected";
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

let origin = "";
const pane = encodeURIComponent(panes.web);
const workGroup = (page: Page) => page.locator('section.machine-group[aria-label="PC Work PC"]');
// a screenshot waits for the drawer and the sheet to finish moving, so it shows where they come to rest
const still = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
const selection = (page: Page): Promise<string | null> => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id ?? null);

async function open(browser: Browser, width: number, query: string): Promise<{ page: Page; errors: string[]; phone: boolean; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone });
  await context.addInitScript(() => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/${query}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, phone, close: () => context.close() };
}

/** The sidebar in view: a phone's drawer is opened for it. */
async function sidebar(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    const toggle = page.getByRole("button", { name: "Open workspace list", exact: true });
    if (await toggle.count() > 0) await toggle.click();
  }
  await page.locator('section.machine-group[aria-label="PC Laptop"]').waitFor();
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "hide-pc.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./hide-pc.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  origin = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const width of [390, 1440]) {
        const { page, errors, phone, close } = await open(browser, width, `?machine=work&pane=${pane}`);
        try {
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 1, "both PCs are shown until one is hidden");
          assert.ok(await page.locator('.agent-item[data-machine="work"]').count() > 0, "Work PC's agents are listed");
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "work");

          // as a person does it: the gear, then Remote PCs, on top of the pane open on Work PC
          await page.locator(".sidebar-footer-settings").click();
          await openSettingsPage(page, "Remote PCs");
          const dialog = page.locator(".settings-dialog");
          const work = dialog.getByRole("switch", { name: "Show Work PC in sidebar", exact: true });
          const laptop = dialog.getByRole("switch", { name: "Show Laptop in sidebar", exact: true });
          await work.waitFor();
          assert.equal(await work.getAttribute("aria-checked"), "true");
          assert.equal(await laptop.isEnabled(), true);
          await work.click();
          await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show Work PC in sidebar"]')?.getAttribute("aria-checked") === "false");
          assert.equal(await laptop.isDisabled(), true, "the last PC shown cannot be hidden");
          assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:hidden-pcs") ?? "null")), ["work"], "kept in this browser, in its own key");
          assert.equal(await page.evaluate(() => (localStorage.getItem("ovis:settings") ?? "").includes("hidden")), false, "and not in ovis:settings");
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "local");
          if (evidence) { await still(page); await page.screenshot({ path: join(evidence, `hide-pc-settings-${width}.png`) }); }

          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
          // closing Settings steps back over its history entries, onto the one that named Work PC's pane:
          // once it has landed, the address says the pane picked meanwhile, not Work PC's
          await page.waitForFunction(() => !(history.state !== null && typeof history.state === "object" && "ovis:settings" in history.state) && !location.search.includes("machine=work"));
          await page.locator(".machine-context-name").first().waitFor({ state: "attached" });
          assert.equal(await selection(page), "local", "the selection stays off the hidden PC after Settings closes");
          assert.equal(await page.locator(".machine-context-name").first().innerText(), "Laptop");
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 0, "a hidden PC leaves the sidebar");
          assert.equal(await page.locator('.agent-item[data-machine="work"]').count(), 0, "and the Agents list");
          assert.ok(await page.locator('.agent-item[data-machine="local"]').count() > 0);
          assert.equal(await page.locator(".machine-hidden-note").innerText(), "1 PC hidden on this device");
          if (evidence) { await still(page); await page.screenshot({ path: join(evidence, `hide-pc-sidebar-${width}.png`) }); }

          if (!phone) {
            await page.keyboard.press("ControlOrMeta+Shift+K");
            const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
            await palette.locator('.palette-pane[data-machine="local"]').first().waitFor();
            assert.equal(await palette.locator('.palette-pane[data-machine="work"]').count(), 0, "and the command palette");
            await page.keyboard.press("Escape");
            await palette.waitFor({ state: "detached" });
          }

          await page.reload();
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 0, "a reload keeps it hidden");

          // a link to the hidden PC's pane still opens it, and the switch stays as it was
          await page.goto(`${origin}/?machine=work&pane=${pane}`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "work");
          await page.locator(".machine-context-name", { hasText: "Work PC" }).first().waitFor({ state: "attached" });
          assert.equal(await page.getByText("That link's PC is not set up here").count(), 0);
          assert.equal(await selection(page), "work");
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 0);

          await page.locator(".machine-hidden-note").click();
          const back = page.locator(".settings-dialog").getByRole("switch", { name: "Show Work PC in sidebar", exact: true });
          await back.click();
          await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show Work PC in sidebar"]')?.getAttribute("aria-checked") === "true");
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 1, "the note's way back shows it again");
          assert.equal(await page.locator(".machine-hidden-note").count(), 0);
          assert.deepEqual(errors, []);

          if (phone) {
            // Settings opened from the phone's command palette takes the palette sheet's history entry over:
            // closing it must still keep the selection the hiding moved
            await page.goto(`${origin}/?machine=work&pane=${pane}`);
            await page.locator(".conn-live").waitFor({ state: "attached" });
            await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "work");
            await page.keyboard.press("ControlOrMeta+Shift+K");
            const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
            await palette.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Show in sidebar");
            await palette.getByRole("option").filter({ hasText: "Show in sidebar" }).first().click();
            const fromPalette = page.locator(".settings-dialog").getByRole("switch", { name: "Show Work PC in sidebar", exact: true });
            await fromPalette.click();
            await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "local");
            await page.keyboard.press("Escape");
            await page.locator(".settings-dialog").waitFor({ state: "detached" });
            await page.waitForFunction(() => !(history.state !== null && typeof history.state === "object" && "ovis:settings" in history.state) && !location.search.includes("machine=work"));
            assert.equal(await selection(page), "local", "Settings opened from the palette sheet keeps the moved selection when it closes");
            await page.evaluate(() => localStorage.removeItem("ovis:hidden-pcs"));
          }

          // a tab opened without a link restores its last selection: on a PC hidden meanwhile, it moves off it
          await page.evaluate((paneId) => {
            localStorage.setItem("ovis:hidden-pcs", JSON.stringify(["work"]));
            localStorage.setItem("ovis:selection", JSON.stringify({ machine_id: "work", pane_id: paneId }));
            sessionStorage.setItem("ovis:selection", JSON.stringify({ machine_id: "work", pane_id: paneId }));
          }, panes.web);
          await page.goto(`${origin}/`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:selection") ?? "null")?.machine_id === "local");
          assert.equal(await page.getByText("That link's PC is not set up here").count(), 0);
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: Work PC hidden from the sidebar, Agents${phone ? "" : " and palette"}, selection moved, Laptop kept, reload kept, its link still opens, the note shows it again`);
        } finally { await close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
