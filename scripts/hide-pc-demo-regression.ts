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
// working; the PCs head's hidden count brings it back. On three PCs at 390 and 1280, light and dark, that
// count's menu shows each hidden PC again in place, by keyboard and by touch, gives the focus somewhere
// it can stay when the last one is shown or taken from outside, and goes to Settings, where the last PC shown stays locked on.
// Screenshots go to UI_EVIDENCE_DIR when it is set.
const app = mkdtempSync(join(tmpdir(), "herdr-hide-pc-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  let last = null;
  // the PCs a check asks for (open()'s roster), else the Host and Work PC
  let ids = window.hidePcRoster ?? ["local", "work"];
  const names = { local: "Laptop", work: "Work PC", lab: "Lab PC" };
  const roster = (original) => ids.map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = names[id];
    machine.state = "connected";
    return machine;
  });
  // the server's roster changing under the page (a PC removed elsewhere): the open streams carry the new one
  const sources = new Set();
  let lastRoster = null;
  window.hidePcSetRoster = (next) => {
    ids = next;
    for (const source of sources) if (lastRoster) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ...lastRoster, machines: roster(last) }) }));
  };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; lastRoster = message; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; sources.delete(this); }
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

type Theme = "light" | "dark";
interface OpenOptions { roster?: string[]; theme?: Theme; hidden?: string[] }

async function open(browser: Browser, width: number, query: string, options: OpenOptions = {}): Promise<{ page: Page; errors: string[]; phone: boolean; close: () => Promise<void> }> {
  const phone = width <= 480;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone, colorScheme: options.theme ?? "light" });
  await context.addInitScript(({ roster, theme, hidden }) => {
    if (roster !== null) Object.assign(window, { hidePcRoster: roster });
    // seeded once per page, so a reload keeps what the page itself stored
    if (sessionStorage.getItem("hide-pc-seeded") !== null) return;
    sessionStorage.setItem("hide-pc-seeded", "1");
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify(theme === null ? { language: "en" } : { language: "en", theme }));
    if (hidden !== null) localStorage.setItem("ovis:hidden-pcs", JSON.stringify(hidden));
  }, { roster: options.roster ?? null, theme: options.theme ?? null, hidden: options.hidden ?? null });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/${query}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { page, errors, phone, close: () => context.close() };
}

/** An item of the PCs head's hidden-PCs menu: a popover's item on a desktop, a sheet's on a phone (RowMenu.tsx). */
const hiddenChoice = (page: Page, phone: boolean, label: string) => phone
  ? page.locator(".row-sheet .row-sheet-item", { hasText: label })
  : page.getByRole("menu").getByRole("menuitem", { name: label, exact: true });
const hiddenChoices = (page: Page, phone: boolean) => phone ? page.locator(".row-sheet .row-sheet-item") : page.getByRole("menu").getByRole("menuitem");
const hiddenPill = (page: Page) => page.locator(".pcs-sidebar > .sidebar-section-head .sidebar-hidden-pcs");
const pcsToggle = (page: Page) => page.locator(".pcs-sidebar > .sidebar-section-head .sidebar-section-toggle");
const isFocused = (locator: ReturnType<Page["locator"]>): Promise<boolean> => locator.evaluate((node) => document.activeElement === node);
const storedHidden = (page: Page): Promise<unknown> => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:hidden-pcs") ?? "null"));
const group = (page: Page, name: string) => page.locator(`section.machine-group[aria-label="PC ${name}"]`);
// the demo's timeline raises a finish droplet at its own moment; the shots are of the sidebar
const NO_DROPLET = ".droplet { visibility: hidden !important; }";
const HIDDEN_HEAD = /Hidden on this device\s+A hidden PC stays connected\. A link or an alert still opens its panes\./;

/** The last hidden PC taken away from outside: the roster dropping it, or another tab showing it. */
async function takeLastHidden(page: Page, leave: "roster" | "another tab"): Promise<void> {
  if (leave === "roster") await page.evaluate(() => (window as unknown as { hidePcSetRoster(ids: string[]): void }).hidePcSetRoster(["local", "work"]));
  else await page.evaluate(() => {
    localStorage.setItem("ovis:hidden-pcs", "[]");
    window.dispatchEvent(new StorageEvent("storage", { key: "ovis:hidden-pcs" }));
  });
  await hiddenPill(page).waitFor({ state: "detached" });
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
          // the PCs head says it: an eye crossed out and the count, named in words
          assert.equal(await hiddenPill(page).getAttribute("aria-label"), "1 PC hidden on this device");
          assert.equal((await hiddenPill(page).innerText()).trim(), "1");
          assert.equal(await page.locator(".machine-hidden-note").count(), 0, "no line under the PCs says it any more");
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

          // the head's menu shows the PC again in place, and a pane a link opened on it stays selected
          await hiddenPill(page).click();
          await hiddenChoice(page, phone, "Show Work PC").waitFor();
          assert.equal(await hiddenChoice(page, phone, "Show Work PC").count(), 1, "the menu lists the hidden PC");
          const menuHead = page.locator(phone ? ".row-sheet .row-sheet-head" : ".row-menu .row-menu-header");
          assert.match(await menuHead.innerText(), HIDDEN_HEAD, "the menu says what it lists and what hiding does, on a desktop as on a phone");
          await hiddenChoice(page, phone, "Show Work PC").click();
          await workGroup(page).waitFor();
          assert.equal(await hiddenPill(page).count(), 0, "with nothing hidden, the head says nothing of it");
          assert.deepEqual(await storedHidden(page), [], "shown again on this device");
          assert.equal(await selection(page), "work", "showing a PC moves no selection");
          // and hidden again, the menu's other way goes to Settings
          await page.evaluate(() => localStorage.setItem("ovis:hidden-pcs", JSON.stringify(["work"])));
          await page.reload();
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 0);
          await hiddenPill(page).click();
          await hiddenChoice(page, phone, "Choose PCs in Settings…").click();
          const back = page.locator(".settings-dialog").getByRole("switch", { name: "Show Work PC in sidebar", exact: true });
          await back.click();
          await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Show Work PC in sidebar"]')?.getAttribute("aria-checked") === "true");
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          await sidebar(page, phone);
          assert.equal(await workGroup(page).count(), 1, "Settings' way back shows it again");
          assert.equal(await hiddenPill(page).count(), 0);
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
          console.log(`PASS ${width}px: Work PC hidden from the sidebar, Agents${phone ? "" : " and palette"}, selection moved, Laptop kept, reload kept, its link still opens, the PCs head shows it again`);
        } finally { await close(); }
      }

      // The PCs head's hidden count on three PCs, two hidden and a third id stored for a PC since removed
      for (const width of [390, 1280]) {
        for (const theme of ["light", "dark"] as const) {
          const { page, errors, phone, close } = await open(browser, width, "", { roster: ["local", "work", "lab"], theme, hidden: ["work", "lab", "gone"] });
          try {
            await sidebar(page, phone);
            const pill = hiddenPill(page);
            await pill.waitFor();
            assert.equal(await group(page, "Work PC").count() + await group(page, "Lab PC").count(), 0, "both hidden PCs are out of the sidebar");
            assert.equal(await pill.getAttribute("aria-label"), "2 PCs hidden on this device", "named in words, a removed PC's id not counted");
            assert.equal(await pill.getAttribute("title"), "2 PCs hidden on this device");
            assert.equal((await pill.innerText()).trim(), "2");
            assert.equal(await pill.getAttribute("aria-haspopup"), "menu");
            assert.equal(await pill.getAttribute("aria-expanded"), "false");
            const head = (await page.locator(".pcs-sidebar > .sidebar-section-head").boundingBox())!;
            const box = (await pill.boundingBox())!;
            assert.ok(box.y >= head.y - 0.5 && box.y + box.height <= head.y + head.height + 0.5, "the count sits in the PCs head's row");
            if (phone) assert.ok(box.width >= 44 && box.height >= 44, `a finger's target on a phone (${box.width}x${box.height})`);
            if (evidence) { await still(page); await page.screenshot({ path: join(evidence, `hidden-pcs-head-${width}-${theme}.png`), style: NO_DROPLET }); }

            // a tap on a phone; the keyboard on a desktop, which lands on the first item and returns on Escape
            if (phone) await pill.tap();
            else { await pill.focus(); await page.keyboard.press("Enter"); }
            await hiddenChoice(page, phone, "Show Work PC").waitFor();
            assert.equal(await pill.getAttribute("aria-expanded"), "true");
            assert.deepEqual((await hiddenChoices(page, phone).allInnerTexts()).map((text) => text.trim()), ["Show Work PC", "Show Lab PC", "Choose PCs in Settings…"], "each hidden PC in the roster's order, then Settings");
            assert.match(await page.locator(phone ? ".row-sheet .row-sheet-head" : ".row-menu .row-menu-header").innerText(), HIDDEN_HEAD);
            if (evidence) { await still(page); await page.screenshot({ path: join(evidence, `hidden-pcs-menu-${width}-${theme}.png`), style: NO_DROPLET }); }
            if (!phone) {
              await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem" && document.activeElement.textContent?.trim() === "Show Work PC");
              await page.keyboard.press("ArrowDown");
              assert.equal(await isFocused(hiddenChoice(page, phone, "Show Lab PC")), true, "the arrows walk the items");
              await page.keyboard.press("Escape");
              await page.getByRole("menu").waitFor({ state: "detached" });
              assert.equal(await isFocused(pill), true, "Escape gives the focus back to the count");
              assert.equal(await pill.getAttribute("aria-expanded"), "false");
              await page.keyboard.press("Enter");
              await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem" && document.activeElement.textContent?.trim() === "Show Work PC");
            }

            // Show Work PC: back in place, Lab PC still hidden, the removed PC's id dropped
            if (phone) await hiddenChoice(page, phone, "Show Work PC").tap();
            else await page.keyboard.press("Enter");
            await group(page, "Work PC").waitFor();
            assert.equal(await group(page, "Lab PC").count(), 0);
            assert.deepEqual(await storedHidden(page), ["lab"], "only Lab PC stays hidden; the removed PC's id is dropped");
            assert.equal(await pill.getAttribute("aria-label"), "1 PC hidden on this device");
            assert.equal((await pill.innerText()).trim(), "1");
            await page.waitForFunction(() => document.activeElement?.classList.contains("sidebar-hidden-pcs") === true);

            // Show Lab PC, the last one: the count leaves the head and the focus stays in it, on the PCs fold
            if (phone) await pill.tap();
            else await page.keyboard.press("Enter");
            await hiddenChoice(page, phone, "Show Lab PC").waitFor();
            assert.deepEqual((await hiddenChoices(page, phone).allInnerTexts()).map((text) => text.trim()), ["Show Lab PC", "Choose PCs in Settings…"]);
            if (phone) await hiddenChoice(page, phone, "Show Lab PC").tap();
            else { await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "Show Lab PC"); await page.keyboard.press("Enter"); }
            await group(page, "Lab PC").waitFor();
            await pill.waitFor({ state: "detached" });
            assert.deepEqual(await storedHidden(page), [], "nothing hidden on this device");
            await page.waitForFunction(() => document.activeElement?.matches(".pcs-sidebar > .sidebar-section-head .sidebar-section-toggle") === true);
            assert.equal(await isFocused(pcsToggle(page)), true, "the focus lands on the PCs head, not the page");
            if (!phone) {
              await page.keyboard.press("Tab");
              assert.equal(await page.evaluate(() => document.activeElement !== document.body && document.activeElement?.closest(".sidebar") !== null), true, "and Tab goes on from there");
            }
            assert.deepEqual(errors, []);
          } finally { await close(); }
        }

        // the menu's other way: Settings → Remote PCs at its Show in sidebar group, where the last PC shown stays on
        {
          const { page, errors, phone, close } = await open(browser, width, "", { roster: ["local", "work", "lab"], hidden: ["work", "lab"] });
          try {
            await sidebar(page, phone);
            if (phone) await hiddenPill(page).tap(); else await hiddenPill(page).click();
            if (phone) await hiddenChoice(page, phone, "Choose PCs in Settings…").tap();
            else await hiddenChoice(page, phone, "Choose PCs in Settings…").click();
            const dialog = page.locator(".settings-dialog");
            await dialog.getByRole("tabpanel", { name: "Remote PCs", exact: true }).waitFor();
            await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.section === "sidebar-pcs");
            const laptop = dialog.getByRole("switch", { name: "Show Laptop in sidebar", exact: true });
            assert.equal(await laptop.getAttribute("aria-checked"), "true");
            assert.equal(await laptop.isDisabled(), true, "the last PC shown cannot be hidden");
            assert.equal(await dialog.getByRole("switch", { name: "Show Work PC in sidebar", exact: true }).getAttribute("aria-checked"), "false");
            assert.equal(await dialog.getByRole("switch", { name: "Show Lab PC in sidebar", exact: true }).getAttribute("aria-checked"), "false");
            await page.keyboard.press("Escape");
            await dialog.waitFor({ state: "detached" });
            if (!phone) await page.waitForFunction(() => document.activeElement?.classList.contains("sidebar-hidden-pcs") === true);
            assert.deepEqual(await storedHidden(page), ["work", "lab"], "opening Settings changes nothing");
            assert.deepEqual(errors, []);
          } finally { await close(); }
        }

        // the last hidden PC taken away from outside while its menu holds the focus (the roster dropping it, or
        // another tab showing it): the count and its menu go, and the focus stays in the PCs head, not the page
        for (const leave of ["roster", "another tab"] as const) {
          const { page, errors, phone, close } = await open(browser, width, "", { roster: ["local", "work", "lab"], hidden: ["lab"] });
          try {
            await sidebar(page, phone);
            await hiddenPill(page).waitFor();
            if (phone) await hiddenPill(page).tap();
            else { await hiddenPill(page).focus(); await page.keyboard.press("Enter"); }
            await hiddenChoice(page, phone, "Show Lab PC").waitFor();
            await page.waitForFunction((phone) => document.activeElement?.closest(phone ? ".row-sheet" : ".row-menu") != null, phone);
            await takeLastHidden(page, leave);
            await page.locator(phone ? ".row-sheet" : ".row-menu").waitFor({ state: "detached" });
            await page.waitForFunction(() => document.activeElement?.matches(".pcs-sidebar > .sidebar-section-head .sidebar-section-toggle") === true, undefined, { timeout: 5000 })
              .catch(async () => assert.fail(`the ${leave} took the last hidden PC: the focus fell to ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? "nothing")}`));
            assert.deepEqual(errors, []);
          } finally { await close(); }
        }
        // with the menu closed and the count itself focused, the same change keeps the focus in the PCs head
        for (const leave of ["roster", "another tab"] as const) {
          const { page, errors, phone, close } = await open(browser, width, "", { roster: ["local", "work", "lab"], hidden: ["lab"] });
          try {
            await sidebar(page, phone);
            await hiddenPill(page).focus();
            await takeLastHidden(page, leave);
            await page.waitForFunction(() => document.activeElement?.matches(".pcs-sidebar > .sidebar-section-head .sidebar-section-toggle") === true, undefined, { timeout: 5000 })
              .catch(async () => assert.fail(`the ${leave} took the last hidden PC from the focused count: the focus fell to ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80) ?? "nothing")}`));
            assert.deepEqual(errors, []);
          } finally { await close(); }
        }
        // with the menu closed, the same change leaves the focus where the reader put it
        if (width > 480) {
          const { page, errors, close } = await open(browser, width, "", { roster: ["local", "work", "lab"], hidden: ["lab"] });
          try {
            await sidebar(page, false);
            await hiddenPill(page).waitFor();
            const field = page.locator(".sidebar-filter-input");
            await field.focus();
            await page.evaluate(() => (window as unknown as { hidePcSetRoster(ids: string[]): void }).hidePcSetRoster(["local", "work"]));
            await hiddenPill(page).waitFor({ state: "detached" });
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            assert.equal(await isFocused(field), true, "the focus is not taken from another control");
            assert.deepEqual(errors, []);
          } finally { await close(); }
        }

        // a stored list that hides every PC shows them all, so the head counts none and no PC is out of reach
        {
          const { page, errors, phone, close } = await open(browser, width, "", { roster: ["local", "work", "lab"], hidden: ["local", "work", "lab"] });
          try {
            await sidebar(page, phone);
            await group(page, "Lab PC").waitFor();
            assert.equal(await group(page, "Work PC").count(), 1);
            assert.equal(await hiddenPill(page).count(), 0, "nothing is said hidden while every PC is drawn");
            assert.deepEqual(errors, []);
          } finally { await close(); }
        }
        // between a phone's width and the desktop's the sidebar is a drawer and the menu a popover: the first Escape
        // closes the popover alone, the next the drawer (lib/useSidebarLayout.ts)
        if (width > 480) {
          const { page, errors, close } = await open(browser, 700, "", { roster: ["local", "work", "lab"], hidden: ["lab"] });
          try {
            await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
            await page.locator(".sidebar.is-open").waitFor();
            await hiddenPill(page).click();
            await page.getByRole("menu").waitFor();
            await page.keyboard.press("Escape");
            await page.getByRole("menu").waitFor({ state: "detached" });
            assert.equal(await page.locator(".sidebar.is-open").count(), 1, "700px: Escape on the popover leaves the drawer out");
            assert.equal(await isFocused(hiddenPill(page)), true, "700px: and gives the focus back to the count");
            await page.keyboard.press("Escape");
            await page.locator(".sidebar.is-open").waitFor({ state: "detached" });
            assert.deepEqual(errors, []);
          } finally { await close(); }
        }
        console.log(`PASS ${width}px hidden-PCs head: count in words, menu by ${width <= 480 ? "touch" : "keyboard"}, Show one keeps the rest, Show the last keeps the focus in the head, as does the last taken by the roster or another tab while the menu is open (and not from another control), Settings route keeps the last PC shown, light and dark`);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
