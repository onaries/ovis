import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import type { Machine } from "../shared/machines.ts";
import type { AgentStatus } from "../shared/protocol.ts";

declare global {
  interface Window {
    inboxFixture: {
      /** rosters the app has been handed since the page loaded */
      rosters: number;
      /** hands the app the roster again, as the server's next push would */
      publish(): Promise<void>;
      /** sets a pane's state as herdr would: its pane-status event, then the roster */
      set(paneId: string, status: AgentStatus, finish?: number): Promise<void>;
    };
  }
}

// Holds the demo's agents still, whatever its own timers do: Codex waits for an answer, Claude works
// (the demo would finish it 4.5s in), the flaky-test agent is done and not looked at, the rest are idle.
// Loaded after demo-transport.js and before the app; what it forces survives a reload.
function installInboxFixture(): void {
  const key = "phone-inbox-regression:forced";
  const stored = sessionStorage.getItem(key);
  const state: { epoch: string; forced: Record<string, { status: AgentStatus; finish: number }> } = stored ? JSON.parse(stored) : {
    epoch: `inbox-fixture-${Date.now()}`,
    forced: {
      "w1D:p1": { status: "blocked", finish: 0 },
      "w1C:p1": { status: "working", finish: 0 },
      "w1H:p1": { status: "done", finish: 1 },
      "w1J:p1": { status: "idle", finish: 0 },
      "w1K:p1": { status: "idle", finish: 0 },
      "w1L:p1": { status: "idle", finish: 0 },
    },
  };
  const save = (): void => sessionStorage.setItem(key, JSON.stringify(state));
  save();
  const patch = (machines: Machine[]): Machine[] => {
    for (const machine of machines) {
      const snapshot = machine.snapshot;
      if (!snapshot) continue;
      snapshot.finish_epoch = `${state.epoch}:${machine.id}`;
      for (const pane of snapshot.panes) {
        const forced = state.forced[pane.pane_id];
        if (forced) { pane.agent_status = forced.status; pane.finish_id = forced.finish; }
      }
      for (const agent of snapshot.agents) {
        const forced = state.forced[agent.pane_id];
        if (forced) agent.agent_status = forced.status;
      }
    }
    return machines;
  };
  const sources = new Set<EventSource>();
  const fetchDemo = window.fetch;
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const response = await fetchDemo(input, init);
    if (url.pathname !== "/api/machines" || !response.ok) return response;
    const body = await response.json();
    return Response.json({ ...body, machines: patch(body.machines) });
  }, fetchDemo);
  const DemoSource = window.EventSource;
  window.EventSource = class extends DemoSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      sources.add(this);
      let receive: EventSource["onmessage"] = null;
      Object.defineProperty(this, "onmessage", {
        get: () => (event: MessageEvent<string>) => {
          const body = JSON.parse(event.data);
          if (body.type === "machines") { body.machines = patch(body.machines); window.inboxFixture.rosters++; }
          if (body.type === "machine-message" && body.message.type === "pane-status") {
            body.message.finish_epoch = `${state.epoch}:${body.machine_id}`;
            const forced = state.forced[body.message.pane_id];
            if (forced) { body.message.agent_status = forced.status; body.message.finish_id = forced.finish; }
          }
          receive?.call(this, new MessageEvent("message", { data: JSON.stringify(body) }));
        },
        set: (handler: EventSource["onmessage"]) => { receive = handler; },
      });
    }
    close(): void { sources.delete(this); super.close(); }
  };
  const send = (body: unknown): void => {
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(body) }));
  };
  window.inboxFixture = {
    rosters: 0,
    async publish() {
      const { machines } = await (await fetch("/api/machines")).json();
      send({ type: "machines", machines });
    },
    async set(paneId, status, finish = 0) {
      state.forced[paneId] = { status, finish };
      save();
      send({ type: "machine-message", machine_id: "local", message: { type: "pane-status", pane_id: paneId, agent_status: status, finish_id: finish, finish_epoch: `${state.epoch}:local` } });
      await this.publish();
    },
  };
}

// The phone's agent inbox on the unmodified app over the demo's fixture transport: the list as the first
// screen, its rows, filters and search, a thread opened from it and the ways back, the drawer, New workspace,
// a watching device, the setting off, a wide window, and the Settings row that turns it on. All files and
// HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const BLOCKED = "w1D:p1";      // Codex, waiting: "Allow command?"
const WORKING = "w1C:p1";      // Claude
const DONE = "w1H:p1";         // the flaky-test agent, finished and not looked at
const IDLE = ["w1J:p1", "w1K:p1", "w1L:p1"];
const BLOCKED_TITLE = "Guard the export button";

const app = mkdtempSync(join(tmpdir(), "ovis-phone-inbox-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const errors: string[] = [];
/** steps that failed without stopping the run, so the steps after them still report */
const failures: string[] = [];

type Settings = Record<string, unknown>;
interface Row { pane: string | null; state: string | null; name: string; words: string | null; chip: string | null; badges: number }

const rows = (page: Page): Promise<Row[]> => page.locator(".inbox-item").evaluateAll((items) => items.map((item) => ({
  pane: item.getAttribute("data-pane"), state: item.getAttribute("data-state"),
  name: item.querySelector(".inbox-name")?.textContent ?? "", words: item.querySelector(".inbox-words")?.textContent ?? null,
  chip: item.querySelector(".badge.inbox-chip")?.textContent ?? null, badges: item.querySelectorAll(".badge").length,
})));
const rowCount = (page: Page, count: number) => page.waitForFunction((n) => document.querySelectorAll(".inbox-item").length === n, count, { timeout: 30_000 });
const questionShown = (page: Page) => page.waitForFunction((pane) =>
  /Allow command\?/.test(document.querySelector(`.inbox-item[data-pane="${pane}"] .inbox-words`)?.textContent ?? ""), BLOCKED, { timeout: 15_000 });
const paneInAddress = (page: Page): string | null => new URL(page.url()).searchParams.get("pane");
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const row = (page: Page, pane: string) => page.locator(`.inbox-item[data-pane="${pane}"] .inbox-row`);
/** opens a row's thread: the list leaves, Back to agents takes the drawer toggle's place */
async function openThread(page: Page, pane: string): Promise<void> {
  await row(page, pane).tap();
  await page.locator(".agent-inbox").waitFor({ state: "detached" });
  await page.locator("#inbox-back").waitFor();
}
async function backToList(page: Page): Promise<void> {
  await page.locator("#inbox-back").tap();
  await page.locator(".agent-inbox").waitFor();
}
async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  await appFaces(page);
  await page.screenshot({ path: join(evidence, name), animations: "disabled" });
}

/**
 * One tab of a fresh browser profile: the settings are seeded once, so a reload keeps what the app stored since.
 * The inbox is this device's own choice, a JSON boolean of its own beside the settings record: `phoneInbox` in a
 * seed is stored there, and a seed without it leaves the inbox off.
 */
async function withPage(browser: Browser, base: string, settings: Settings, path: string, run: (page: Page) => Promise<void>, wide = false): Promise<void> {
  const context = await browser.newContext({
    viewport: wide ? { width: 1280, height: 900 } : { width: 390, height: 844 },
    isMobile: !wide, hasTouch: !wide, locale: "en-US",
  });
  try {
    await context.addInitScript((seed) => {
      if (sessionStorage.getItem("phone-inbox-regression:seeded")) return;
      sessionStorage.setItem("phone-inbox-regression:seeded", "1");
      const { phoneInbox, ...settings } = seed;
      localStorage.setItem("ovis:settings", JSON.stringify(settings));
      if (phoneInbox === true) localStorage.setItem("ovis:phone-inbox", JSON.stringify(true));
    }, settings);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${path}: ${error.message}`));
    try {
      await page.goto(base + path);
      await run(page);
    } catch (error) {
      if (evidence) await page.screenshot({ path: join(evidence, "phone-inbox-failure.png") }).catch(() => undefined);
      throw error;
    }
  } finally {
    await context.close();
  }
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(join(app, "inbox-fixture.js"), `(${installInboxFixture.toString()})();`);
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./inbox-fixture.js"></script>\n    <script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      if (evidence) mkdirSync(evidence, { recursive: true });
      for (const theme of ["light", "dark"]) {
        const on: Settings = { language: "en", theme, phoneInbox: true };
        const off: Settings = { language: "en", theme };
        const pass = (step: number, what: string) => console.log(`PASS ${theme} (${step}) ${what}`);

        await withPage(browser, base, on, "/", async (page) => {
          await page.locator(".agent-inbox").waitFor();
          assert.equal(await page.locator(".pane-slot").count(), 0, "nothing is mounted for a pane under a cold list");
          assert.equal(paneInAddress(page), null);
          pass(1, "a cold start shows the list, no pane slot, and the address names no pane");

          await rowCount(page, 6);
          await questionShown(page);
          const drawn = await rows(page);
          assert.deepEqual(drawn.map((item) => item.pane), [BLOCKED, WORKING, DONE, ...drawn.slice(3).map((item) => item.pane)]);
          assert.deepEqual(new Set(drawn.slice(3).map((item) => item.pane)), new Set(IDLE));
          assert.deepEqual(drawn.map((item) => item.chip), ["INPUT", "RUN", "DONE", null, null, null]);
          assert.deepEqual(drawn.slice(3).map((item) => item.badges), [0, 0, 0], "an idle row draws no badge");
          assert.match(drawn[0]!.words ?? "", /Allow command\?/);
          assert.equal(await page.locator(`.inbox-item[data-pane="${BLOCKED}"] .inbox-dot`).count(), 1);
          assert.equal(await page.locator(".inbox-new").count(), 1, "a device that drives is offered New workspace");
          await shot(page, `inbox-390-${theme}.png`);
          pass(2, "six rows: the waiting one first as INPUT with its question, then RUN and DONE, no badge on the idle rows");

          for (const [filter, want] of [["blocked", [BLOCKED]], ["working", [WORKING]], ["done", [DONE]]] as const) {
            await page.locator(`.inbox-filter[data-status="${filter}"]`).tap();
            await page.waitForFunction((pane) => {
              const items = document.querySelectorAll(".inbox-item");
              return items.length === 1 && items[0]?.getAttribute("data-pane") === pane;
            }, want[0]);
            assert.equal(await page.locator('.inbox-filter[aria-checked="true"]').getAttribute("data-status"), filter);
          }
          await page.locator('.inbox-filter[data-status="all"]').tap();
          await rowCount(page, 6);
          pass(3, "Needs you, Working and Done each narrow the list to their row, and All draws the six again");

          const search = page.locator(".inbox-search-input");
          await search.fill("export");
          await rowCount(page, 1);
          assert.equal(await page.locator(".inbox-item .inbox-name").textContent(), BLOCKED_TITLE);
          await page.locator(".inbox-search-clear").tap();
          await rowCount(page, 6);
          assert.equal(await search.inputValue(), "");
          await search.fill("zzqq no such agent");
          await page.locator(".inbox-empty").waitFor();
          assert.equal(await page.locator(".inbox-empty").textContent(), "No agents match");
          await page.locator(".inbox-search-clear").tap();
          await rowCount(page, 6);
          pass(4, "search: export leaves one row, clearing it draws six, a query with no match says No agents match");

          await page.locator('.inbox-filter[data-status="blocked"]').tap();
          await rowCount(page, 1);
          await openThread(page, BLOCKED);
          await page.locator(".prompt-card").first().waitFor();
          assert.equal(paneInAddress(page), BLOCKED);
          await shot(page, `thread-390-${theme}.png`);
          pass(5, "a tap on the waiting row opens its chat with the prompt card and Back to agents, and the address names its pane");

          await backToList(page);
          assert.equal(await page.locator('.inbox-filter[aria-checked="true"]').getAttribute("data-status"), "blocked");
          await rowCount(page, 1);
          const slot = await page.evaluate(() => [...document.querySelectorAll(".pane-slot")].map((node) => getComputedStyle(node).visibility));
          assert.ok(slot.length >= 1, "the opened pane stays mounted under the list");
          assert.ok(slot.every((visibility) => visibility === "hidden"), `the pane under the list is not visible: ${slot.join()}`);
          // six rows fill no 844px phone: the scroll is kept on a shorter one
          await page.locator('.inbox-filter[data-status="all"]').tap();
          await rowCount(page, 6);
          await page.setViewportSize({ width: 390, height: 560 });
          const scroller = page.locator(".inbox-scroll");
          await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await page.waitForFunction(() => (document.querySelector(".inbox-scroll")?.scrollTop ?? 0) > 0);
          const top = await scroller.evaluate((node) => node.scrollTop);
          const last = await page.locator(".inbox-item").last().getAttribute("data-pane");
          await openThread(page, last!);
          await backToList(page);
          await questionShown(page);
          const kept = await page.waitForFunction((at) => Math.abs((document.querySelector(".inbox-scroll")?.scrollTop ?? -9) - at) <= 1, top, { timeout: 5_000 }).then(() => true, () => false);
          const now = await scroller.evaluate((node) => ({ top: node.scrollTop, range: node.scrollHeight - node.clientHeight }));
          if (kept) pass(6, `Back to agents returns to the list with its filter and its scroll (${Math.round(top)}px) kept, the pane slot mounted and hidden`);
          else {
            failures.push(`${theme} (6)`);
            console.log(`FAIL ${theme} (6) the list scrolled to its end (${Math.round(top)}px) came back at ${Math.round(now.top)}px of ${Math.round(now.range)}px; its filter and the hidden pane slot were kept`);
          }
        });

        await withPage(browser, base, on, "/", async (page) => {
          await rowCount(page, 6);
          await openThread(page, WORKING);
          assert.equal(paneInAddress(page), WORKING);
          await page.goBack();
          await page.locator(".agent-inbox").waitFor();
          assert.equal(paneInAddress(page), null);
          await page.goForward();
          await page.locator("#inbox-back").waitFor();
          await page.locator(".agent-inbox").waitFor({ state: "detached" });
          assert.equal(paneInAddress(page), WORKING);
          pass(7, "the system Back shows the list and Forward the thread again");
        });

        await withPage(browser, base, on, "/", async (page) => {
          await rowCount(page, 6);
          await page.locator("#drawer-toggle").tap();
          await page.locator('#drawer-toggle[aria-expanded="true"]').waitFor();
          assert.equal(await page.locator(".agent-inbox").count(), 1, "the drawer opens over the list");
          await page.locator(".sidebar .agent-section-toggle").tap();
          const pick = page.locator(".sidebar .agents-sidebar .agent-item .agent-row").filter({ hasText: BLOCKED_TITLE }).first();
          await pick.tap();
          await page.locator(".agent-inbox").waitFor({ state: "detached" });
          await page.locator("#inbox-back").waitFor();
          assert.equal(paneInAddress(page), BLOCKED);
          pass(8, "the drawer opens over the list from its toggle, and a pick in it opens that thread");
        });

        await withPage(browser, base, on, "/", async (page) => {
          await rowCount(page, 6);
          await page.locator(".inbox-new").tap();
          const dialog = page.getByRole("dialog").filter({ hasText: "New workspace" }).first();
          await dialog.waitFor();
          if (theme === "light") await shot(page, "new-workspace-390-light.png");
          await page.goBack();
          await dialog.waitFor({ state: "detached" });
          await page.locator(".agent-inbox").waitFor();
          await rowCount(page, 6);
          assert.equal(paneInAddress(page), null);
          pass(9, "New workspace opens its dialog from the list, and the system Back closes it onto the list");
        });

        await withPage(browser, base, on, "/", async (page) => {
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.reload();
          await page.locator("#inbox-back").waitFor();
          await page.locator(".pane-slot").first().waitFor();
          assert.equal(await page.locator(".agent-inbox").count(), 0);
          assert.equal(paneInAddress(page), WORKING);
          await backToList(page);
          await page.reload();
          await page.locator(".agent-inbox").waitFor();
          await rowCount(page, 6);
          assert.equal(paneInAddress(page), null);
          pass(10, "a reload on a thread keeps the thread, and on the list the list");
        });

        await withPage(browser, base, on, `/?pane=${encodeURIComponent(BLOCKED)}`, async (page) => {
          await page.locator("#inbox-back").waitFor();
          await page.locator(".pane-slot").first().waitFor();
          assert.equal(await page.locator(".agent-inbox").count(), 0, "a link naming a pane opens the pane");
          await backToList(page);
          await rowCount(page, 6);
          assert.equal(paneInAddress(page), null);
          pass(11, "a cold link to a pane shows its thread, and Back to agents shows the list and drops pane= from the address");
        });

        await withPage(browser, base, on, "/?demo_devices=watch", async (page) => {
          await rowCount(page, 6);
          assert.equal(await page.locator(".inbox-new").count(), 0);
          pass(12, "a device that only watches is offered no New workspace");
        });

        await withPage(browser, base, off, "/", async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator(".context-title-text").waitFor();
          assert.equal(await page.locator(".agent-inbox").count(), 0);
          assert.equal(await page.locator("#inbox-back").count(), 0);
          assert.equal(await page.locator("#drawer-toggle").count(), 1);
          pass(13, "with the setting off a phone starts on the pane as before");
        });

        await withPage(browser, base, on, "/", async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator(".agents-sidebar .agent-item").first().waitFor();
          assert.equal(await page.locator(".agent-inbox").count(), 0);
          assert.equal(await page.locator("#inbox-back").count(), 0);
          pass(14, "at 1280x900 with the setting on there is no list and no Back to agents");
        }, true);

        await withPage(browser, base, on, "/", async (page) => {
          await rowCount(page, 6);
          // the working agent's pane is opened, then covered by the list: it finishes there, unread
          await openThread(page, WORKING);
          await page.locator(".pane-slot").first().waitFor();
          await backToList(page);
          await page.evaluate((pane) => window.inboxFixture.set(pane, "done", 2), WORKING);
          await page.waitForFunction((pane) => document.querySelector(`.inbox-item[data-pane="${pane}"]`)?.getAttribute("data-state") === "done", WORKING);
          const seen = await page.evaluate(() => window.inboxFixture.rosters);
          await page.evaluate(() => window.inboxFixture.publish());
          await page.waitForFunction((count) => window.inboxFixture.rosters > count, seen);
          await frames(page);
          const after = await rows(page);
          for (const pane of [WORKING, DONE]) {
            const item = after.find((candidate) => candidate.pane === pane);
            assert.equal(item?.chip, "DONE", `${pane} is still DONE after the roster came again: ${JSON.stringify(item)}`);
          }
          pass(15, "a finish under the list, of the pane it covers and of one never opened, is still DONE after a roster republish");
        });

        await withPage(browser, base, off, "/", async (page) => {
          await page.locator(".context-title-text").waitFor();
          await page.locator("#drawer-toggle").tap();
          await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().tap();
          const settings = page.locator(".settings-dialog");
          await settings.waitFor();
          await settings.locator(".settings-search-input").first().fill("Agent inbox");
          const toggle = settings.getByRole("switch", { name: "Agent inbox on a phone" });
          await toggle.tap();
          await page.waitForFunction(() => document.querySelector('.settings-dialog [role="switch"][aria-label="Agent inbox on a phone"]')?.getAttribute("aria-checked") === "true");
          await page.getByRole("button", { name: "Close settings" }).tap();
          await settings.waitFor({ state: "detached" });
          if (await page.locator('#drawer-toggle[aria-expanded="true"]').count() > 0) await page.locator("#drawer-toggle").tap();
          await page.locator("#inbox-back").waitFor();
          const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:phone-inbox") ?? "null"));
          assert.equal(stored, true);
          await backToList(page);
          await rowCount(page, 6);
          pass(17, "the Settings row turns the inbox on: the thread keeps its place with Back to agents, which opens the list");
        });

        await withPage(browser, base, on, "/", async (page) => {
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.locator(".pane-slot").first().waitFor();
          // the drawer's toggle is Back to agents here: the drawer opens by a swipe in from the left edge (lib/edgeSwipe.ts)
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 4, y: 420 }] });
          for (let x = 24; x <= 304; x += 40) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 422 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await page.locator('#drawer-toggle[aria-expanded="true"]').waitFor();
          // a tap on the scrim beside it puts it away
          await page.touchscreen.tap(375, 420);
          await page.locator("#inbox-back").waitFor();
          await page.waitForFunction(() => document.activeElement?.id === "inbox-back", undefined, { timeout: 5_000 });
          pass(18, "the drawer swiped open over a thread from the list gives the focus back to Back to agents when it closes");
        });

        await withPage(browser, base, on, "/", async (page) => {
          await rowCount(page, 6);
          await openThread(page, WORKING);
          const sheet = page.locator(".row-sheet");
          await page.locator(".header-more-button").tap();
          const item = sheet.locator('[data-item="open-drawer"]');
          await item.waitFor();
          assert.equal((await item.textContent())?.trim(), "Open workspace list");
          await item.tap();
          await sheet.waitFor({ state: "detached" });
          await page.locator('#drawer-toggle[aria-expanded="true"]').waitFor();
          // a tap on the scrim beside it puts it away, and the focus goes back to More, which opened it
          await page.touchscreen.tap(375, 420);
          await page.locator("#inbox-back").waitFor();
          await page.waitForFunction(() => document.activeElement?.classList.contains("header-more-button") === true, undefined, { timeout: 5_000 });
          pass(19, "in a thread from the list More has Open workspace list, which opens the drawer, and the focus goes back to More when it closes");
        });

        await withPage(browser, base, { ...on, shortcutOverrides: { "close-pane": "ctrl+alt+x" } }, "/", async (page) => {
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.locator(".pane-slot").first().waitFor();
          const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          // the key is bound: in the thread it asks to close the working agent's pane
          const confirm = page.locator(".confirm-dialog");
          await blur();
          await page.keyboard.press("Control+Alt+x");
          await confirm.waitFor();
          await page.keyboard.press("Escape");
          await confirm.waitFor({ state: "detached" });
          await backToList(page);
          await blur();
          await page.keyboard.press("Control+Alt+x");
          await frames(page);
          assert.equal(await confirm.count(), 0, "the key asks nothing of the pane under the list");
          assert.equal(await page.locator(`.inbox-item[data-pane="${WORKING}"]`).count(), 1, "the pane under the list is still in the roster");
          pass(20, "a key bound to Close pane closes the thread's pane, and nothing while the list covers it");
        });

        await withPage(browser, base, { ...on, keepScreenOn: true }, "/", async (page) => {
          // a wake lock that counts the locks held, from the next load on
          await page.context().addInitScript(() => {
            const lock = { held: 0 };
            Object.defineProperty(window, "wakeLockHeld", { get: () => lock.held });
            Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request: async () => {
              lock.held += 1;
              let released = false;
              return { release: async () => { if (!released) { released = true; lock.held -= 1; } } };
            } } });
          });
          await page.reload();
          await rowCount(page, 6);
          const held = (count: number) => page.waitForFunction((n) => (window as unknown as { wakeLockHeld: number }).wakeLockHeld === n, count, { timeout: 5_000 });
          await frames(page);
          assert.equal(await page.evaluate(() => (window as unknown as { wakeLockHeld: number }).wakeLockHeld), 0, "a cold list holds no lock");
          await openThread(page, WORKING);
          await held(1);
          await backToList(page);
          await held(0);
          pass(21, "Keep screen on holds a lock in a thread and lets it go on the list");
        });

        await withPage(browser, base, on, "/", async (page) => {
          await rowCount(page, 6);
          // the demo's second PC holds the same pane ids as the first
          await page.evaluate(() => (window as unknown as { __herdrDemoOrder: { addPc: () => string } }).__herdrDemoOrder.addPc());
          await rowCount(page, 12);
          const names: Record<string, string> = await page.evaluate(async () => Object.fromEntries((await (await fetch("/api/machines")).json()).machines.map((machine: Machine) => [machine.id, machine.name])));
          const places = await page.locator(".inbox-item").evaluateAll((items) => items.map((item) => [item.getAttribute("data-machine") ?? "", item.querySelector(".inbox-place")?.textContent ?? ""]));
          for (const [machine, place] of places) assert.equal(place!.split(" \u00b7 ")[0], names[machine!], `a row of ${machine} names its PC: ${place}`);
          await page.locator(`.inbox-item[data-machine="laptop"][data-pane="${WORKING}"] .inbox-row`).tap();
          await page.locator(".agent-inbox").waitFor({ state: "detached" });
          await page.locator("#inbox-back").waitFor();
          assert.equal(new URL(page.url()).searchParams.get("machine"), "laptop");
          assert.equal(paneInAddress(page), WORKING);
          pass(22, "with two PCs holding the same pane ids each row names its PC, and the other PC's row opens that PC's pane");
        });

        assert.deepEqual(errors, []);
        pass(16, "no page error");
      }
      assert.deepEqual(failures, [], "every step passes");
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
