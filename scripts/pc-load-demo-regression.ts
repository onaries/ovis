import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

// The PC load line (components/MachineStats.tsx) on the unmodified app over the demo's fixture transport, at a
// phone's and a desktop's width. Only this disposable fixture rewrites the roster into three connected PCs: the
// Host "Laptop", "Work PC" under load and "Lab", a herdr-core machine; no herdr session is opened. With no choice
// made the line is on, under Laptop and Work PC and never under Lab (its server runs on the PC that reaches it).
// Work PC's high figures are red. While the sidebar is out of view (a phone's closed drawer, a desktop's hidden
// list) no PC is asked, however long it stays so; shown again, it asks at once. Settings -> Devices and PCs -> PC load
// in the sidebar turns it off on this device, in a key of its own. Screenshots go to UI_EVIDENCE_DIR when set.
const app = mkdtempSync(join(tmpdir(), "ovis-pc-load-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const PCS = [["local", "local", "Laptop"], ["work", "ssh", "Work PC"], ["lab", "hc", "Lab"]];
  let last = null;
  const roster = (original) => PCS.map(([id, kind, name]) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = kind; machine.name = name; machine.state = "connected";
    return machine;
  });
  const gib = 1024 ** 3;
  const loaded = () => ({ sampled_at: Date.now(), platform: "linux", uptime_s: 12 * 86400 + 4 * 3600, cpu_count: 16, cpu_percent: 93,
    memory: { used: 57 * gib, total: 64 * gib, percent: 89 }, load: [14.2, 12.8, 11.9],
    disks: [{ path: "/", used: 433 * gib, total: 466 * gib, percent: 93 }, { path: "/home/dev", used: 1.1 * 1024 * gib, total: 1.8 * 1024 * gib, percent: 61 }] });
  window.__systemAsks = { local: 0, work: 0, lab: 0 };
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
    if (path === "/api/system") {
      window.__systemAsks[machine] += 1;
      if (machine === "work") return json(loaded());
    }
    if (match && path === "/api/session" && last) return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

let origin = "";
const group = (page: Page, name: string) => page.locator(`section.machine-group[aria-label="PC ${name}"]`);
// a screenshot waits for the drawer and the sheet to finish moving, so it shows where they come to rest (a
// pulse that never ends is not a move)
const still = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
const asks = (page: Page): Promise<{ local: number; work: number; lab: number }> => page.evaluate(() => (window as unknown as { __systemAsks: { local: number; work: number; lab: number } }).__systemAsks);
const total = async (page: Page): Promise<number> => { const n = await asks(page); return n.local + n.work + n.lab; };

async function open(browser: Browser, width: number, theme: "dark" | "light" = "dark", sidebarWidth: number | null = null): Promise<{ page: Page; errors: string[]; phone: boolean; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone });
  await context.addInitScript(([theme, sidebarWidth]) => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
    if (sidebarWidth !== null) localStorage.setItem("ovis:sidebar-width", String(sidebarWidth));
  }, [theme, sidebarWidth] as const);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // the poll's 5 s waits run on this clock, so "no ask while hidden" is told by moving it, not by waiting
  await page.clock.install();
  await page.goto(`${origin}/`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, phone, close: () => context.close() };
}

/** The sidebar in view or out of it: a phone's drawer, a desktop's Show/Hide workspace list. */
async function showSidebar(page: Page, phone: boolean, shown: boolean): Promise<void> {
  const name = phone ? (shown ? "Open workspace list" : "Close workspace list") : (shown ? "Show workspace list" : "Hide workspace list");
  const toggle = page.getByRole("button", { name, exact: true });
  if (await toggle.count() > 0) await toggle.click();
  if (shown) await group(page, "Laptop").waitFor();
  await still(page);
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "pc-load.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./pc-load.js"></script><script type="module"'));
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
      for (const width of [390, 1280]) {
        const { page, errors, phone, close } = await open(browser, width);
        try {
          await showSidebar(page, phone, true);
          // no choice made, three connected PCs: on, except for the herdr-core machine
          const work = group(page, "Work PC").locator(".machine-stats-summary");
          await work.waitFor();
          await group(page, "Laptop").locator(".machine-stats-summary").waitFor();
          assert.equal(await group(page, "Lab").locator(".machine-stats").count(), 0, "a herdr-core machine shows no load");
          assert.equal((await asks(page)).lab, 0, "and is never asked for it");
          assert.match(await work.getAttribute("aria-label") ?? "", /CPU 93%, Memory 89%, Disk 93%$/, "the button says the figures aloud");
          assert.equal(await work.locator(".stats-meter.is-high").count(), 3, "figures from 85% are red");

          await work.click();
          await group(page, "Work PC").locator(".stats-disks .stats-disk").nth(1).waitFor();
          assert.equal(await work.getAttribute("aria-expanded"), "true");
          await work.click();

          // out of view, nothing is asked however long it stays so; back in view, it asks at once
          await showSidebar(page, phone, false);
          const before = await total(page);
          await page.clock.runFor(60_000);
          assert.equal(await total(page), before, `no PC is asked while the ${phone ? "drawer is closed" : "workspace list is hidden"}`);
          await showSidebar(page, phone, true);
          await page.waitForFunction((n) => { const a = (window as unknown as { __systemAsks: Record<string, number> }).__systemAsks; return a["local"]! + a["work"]! + a["lab"]! > n; }, before);

          // turned off on this device: the line leaves every PC, kept in its own key
          await page.locator(".sidebar-footer-settings").click();
          await openSettingsPage(page, "Devices and PCs");
          const toggle = page.locator(".settings-dialog").getByRole("switch", { name: "PC load in the sidebar", exact: true });
          assert.equal(await toggle.getAttribute("aria-checked"), "true");
          await toggle.click();
          await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="PC load in the sidebar"]')?.getAttribute("aria-checked") === "false");
          assert.equal(await page.evaluate(() => localStorage.getItem("ovis:pc-load")), "false");
          assert.equal(await page.evaluate(() => "pcLoad" in JSON.parse(localStorage.getItem("ovis:settings") ?? "{}")), false, "not in ovis:settings");
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          await showSidebar(page, phone, true);
          assert.equal(await page.locator(".machine-stats").count(), 0, "off, no PC shows its load");
          assert.deepEqual(errors, []);
          console.log(`PASS ${width}px: load under Laptop and Work PC (red from 85%), none under the herdr-core machine, no ask while the sidebar is out of view, off in Settings in its own key`);
        } finally { await close(); }
      }

      // the narrowest sidebar a desktop can drag to, and each theme at both widths: the three meters keep their
      // label and percent whole, side by side without touching
      for (const [width, theme, sidebarWidth] of [[1280, "dark", 240], [390, "dark", null], [390, "light", null], [1280, "dark", null], [1280, "light", null]] as const) {
        const { page, errors, phone, close } = await open(browser, width, theme, sidebarWidth);
        try {
          await showSidebar(page, phone, true);
          const work = group(page, "Work PC").locator(".machine-stats-summary");
          await work.waitFor();
          const fit = await work.evaluate((button) => {
            const meters = [...button.querySelectorAll<HTMLElement>(":scope > .stats-meter")];
            const boxes = meters.map((meter) => meter.getBoundingClientRect());
            const words = (meter: HTMLElement) => [meter.querySelector(".stats-meter-label")!, meter.querySelector(".stats-meter-value")!].map((part) => part.getBoundingClientRect());
            // each meter holds its words: nothing reaches past its box, and a label and its percent never cross
            const whole = meters.every((meter, i) => {
              const [label, value] = words(meter);
              const box = boxes[i]!;
              const crossed = label!.right > value!.left + 0.5 && label!.bottom > value!.top + 0.5;
              return !crossed && [label!, value!].every((part) => part.left >= box.left - 0.5 && part.right <= box.right + 0.5);
            });
            const apart = boxes.every((box, i) => i === 0 || boxes[i - 1]!.right <= box.left);
            const sizes = meters.map((meter, i) => [boxes[i]!, ...words(meter)].map((r) => [r.left, r.right, r.top, r.bottom].map((n) => Math.round(n * 10) / 10).join(",")).join("/")).join(" ");
            return { count: meters.length, whole, apart, sizes };
          });
          assert.deepEqual({ ...fit, sizes: undefined }, { count: 3, whole: true, apart: true, sizes: undefined }, `${width}px ${theme}${sidebarWidth === null ? "" : ` ${sidebarWidth}px sidebar`}: the meters fit (box:label+percent ${fit.sizes})`);
          const name = `pc-load-${width}${sidebarWidth === null ? "" : `-sidebar${sidebarWidth}`}-${theme}`;
          if (evidence) { await still(page); await page.screenshot({ path: join(evidence, `${name}.png`) }); }
          await work.click();
          await group(page, "Work PC").locator(".stats-disks .stats-disk").nth(1).waitFor();
          if (evidence) { await work.scrollIntoViewIfNeeded(); await still(page); await page.screenshot({ path: join(evidence, `${name}-open.png`) }); }
          assert.deepEqual(errors, []);
        } finally { await close(); }
      }
      console.log("PASS the meters fit a 240px sidebar and a phone, light and dark");
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
