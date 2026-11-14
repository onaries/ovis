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
import { SHEET_HISTORY_KEY } from "../src/lib/historyKeys.ts";
import { KO } from "../src/lib/i18n.ko.ts";

declare global {
  interface Window {
    inboxFixture: {
      /** rosters the app has been handed since the page loaded */
      rosters: number;
      /** hands the app the roster again, as the server's next push would */
      publish(): Promise<void>;
      /** sets a pane's state as herdr would: its pane-status event, then the roster */
      set(paneId: string, status: AgentStatus, finish?: number): Promise<void>;
      /** every size the app has asked of a pane's pty since the page loaded, in order */
      resizes: { pane: string; cols: number; rows: number }[];
      /** every frame a pane's terminal sent since the page loaded, on any of the page's sockets: attach, detach, resize, release-size */
      frames: { type: string; pane: string; cols?: number; rows?: number }[];
      /**
       * loses the roster's event stream, and gives it back, as a browser's EventSource does while it reconnects: the
       * demo carries the roster on its stand-in for the stream, which its own connection switch does not reach
       */
      dropRoster(): void;
      restoreRoster(): void;
      /** whether the roster's load fails (the page's `?inbox_fail=roster` starts it failing): a 500, and no roster pushed meanwhile */
      failRoster(failing: boolean): void;
      /** whether a read of the roster waits on its way (a Retry's read in flight); let go, every read held goes on */
      holdRoster(holding: boolean): void;
      /** how many times the page has asked for the roster (/api/machines), failed or not */
      rosterReads: number;
    };
    /** every shell the page has committed since its document began, in order (the first-paint step notes them) */
    inboxShells: string[];
    /** the demo's `?demo_connection=switch`: the page loses the bridge connection, and has it back, when asked */
    herdrDemoLoseConnection(): void;
    herdrDemoRestoreConnection(): void;
  }
}

// Holds the demo's agents still, whatever its own timers do: Codex waits for an answer, Claude works
// (the demo would finish it 4.5s in), the flaky-test agent is done and not looked at, the rest are idle.
// Loaded after demo-transport.js and before the app; what it forces survives a reload.
function installInboxFixture(): void {
  const key = "inbox-mode-regression:forced";
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
  let rosterFails = new URLSearchParams(location.search).get("inbox_fail") === "roster";
  let rosterHeld: (() => void)[] | null = null;
  const fetchDemo = window.fetch;
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/api/machines") window.inboxFixture.rosterReads++;
    if (url.pathname === "/api/machines" && rosterHeld !== null) await new Promise<void>((go) => rosterHeld!.push(go));
    if (rosterFails && url.pathname === "/api/machines") return Response.json({ error: { code: "internal", message: "The roster could not be read" } }, { status: 500 });
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
          if (body.type === "machines" && rosterFails) return;
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
  // the demo's socket is a class of its own that no browser event reports: each size the app asks of a pty is noted
  const DemoSocket = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new DemoSocket(url, protocols);
    const sendFrame = socket.send.bind(socket);
    socket.send = (data: Parameters<WebSocket["send"]>[0]): void => {
      if (typeof data === "string") {
        const frame = JSON.parse(data);
        if (frame.type === "resize") window.inboxFixture.resizes.push({ pane: frame.pane_id, cols: frame.cols, rows: frame.rows });
        if (["attach", "detach", "resize", "release-size"].includes(frame.type)) window.inboxFixture.frames.push({ type: frame.type, pane: frame.pane_id, cols: frame.cols, rows: frame.rows });
      }
      sendFrame(data);
    };
    return socket;
  } as unknown as typeof WebSocket;
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: DemoSocket[name] });
  window.WebSocket = Recorded;
  window.inboxFixture = {
    rosters: 0,
    resizes: [],
    frames: [],
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
    dropRoster() {
      for (const source of sources) { Object.assign(source, { readyState: 0 }); source.onerror?.(new Event("error")); }
    },
    restoreRoster() {
      for (const source of sources) { Object.assign(source, { readyState: 1 }); source.onopen?.(new Event("open")); }
    },
    failRoster(failing) { rosterFails = failing; },
    holdRoster(holding) {
      if (holding) { rosterHeld ??= []; return; }
      const held = rosterHeld ?? [];
      rosterHeld = null;
      for (const go of held) go();
    },
    rosterReads: 0,
  };
}

// The agent inbox as a mode of the app, on the unmodified app over the demo's fixture transport: the two entries and
// the exit, the list as a phone's screen (its rows, state marks, filter and search), a thread with the terminal behind
// its monitor button, the history (Back, Forward, reloads, a cold address), New workspace, a watching device, the
// device setting that starts a phone in the mode, the two panes of a wide window with the boxes classic has, and a
// pane that shows its terminal while the mode is entered and left: its pty is sent no size and its box stays. After
// the two themes, once each: a phone that left the mode stays out of it over a reload, the focus after Back to
// Ovis, the palette from More, the first paint of a cold load, the pressed fills, the rows under a scrollbar that
// takes room, which waits a row can time, the list's word while the connection is lost, entering with a file
// open, the system Back with More open, and an address whose pane is gone. All
// files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const BLOCKED = "w1D:p1";      // Codex, waiting: "Allow command?"
const WORKING = "w1C:p1";      // Claude
const DONE = "w1H:p1";         // the flaky-test agent, finished and not looked at
const IDLE = ["w1J:p1", "w1K:p1", "w1L:p1"];
const BLOCKED_TITLE = "Guard the export button";
const WORKING_TITLE = "Idempotent payments";
/** what the mode's shell never draws */
const ABSENT = [".inbox-filters", ".inbox-chip", ".inbox-place", ".inbox-title", ".inbox-dot", ".tab-strip", ".context-tabs", ".view-switch", ".status-bar", "#drawer-toggle", "#workspace-drawer", ".sidebar-toggle", ".pane-split.is-split"];
const PHONE = { width: 390, height: 844 };
/** how long nothing may be sent to a pty: past the terminal's own wait for its box to settle before it fits */
const NO_RESIZE_WAIT_MS = 1_000;

const app = mkdtempSync(join(tmpdir(), "ovis-inbox-mode-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const errors: string[] = [];
/** the blocks that failed: each is reported where it fails, and the blocks after it still run */
const failures: string[] = [];

type Settings = Record<string, unknown>;
interface Box { x: number; y: number; w: number; h: number; right: number; bottom: number }
interface Row { pane: string | null; machine: string | null; state: string | null; name: string; words: string | null; mark: string | null; markLabel: string | null; asking: boolean; time: string | null; datetime: string | null; buttons: number; current: string | null }
/** what the address says of the mode: null for a parameter it does not hold */
interface Address { app: string | null; pane: string | null; machine: string | null }

const rows = (page: Page): Promise<Row[]> => page.locator(".mode-inbox .inbox-item").evaluateAll((items) => items.map((item) => {
  const mark = item.querySelector(".inbox-state.is-drawn .sidebar-status");
  return {
    pane: item.getAttribute("data-pane"), machine: item.getAttribute("data-machine"), state: item.getAttribute("data-state"),
    name: item.querySelector(".inbox-name")?.textContent ?? "", words: item.querySelector(".inbox-words")?.textContent ?? null,
    mark: mark?.getAttribute("data-status") ?? null, markLabel: mark?.getAttribute("aria-label") ?? null, asking: item.classList.contains("is-asking"),
    time: item.querySelector("time.inbox-time")?.textContent ?? null, datetime: item.querySelector("time.inbox-time")?.getAttribute("datetime") ?? null,
    buttons: item.querySelectorAll("button").length, current: item.querySelector(".inbox-row")?.getAttribute("aria-current") ?? null,
  };
}));
const box = (page: Page, selector: string): Promise<Box> => page.locator(selector).first().evaluate((node) => {
  const r = node.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
});
/** the done row's last words and its time, read from the demo's own chat after the list is drawn */
const summaryShown = (page: Page) => page.waitForFunction((pane) => {
  const item = document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"]`);
  return Boolean(item?.querySelector(".inbox-words")?.textContent?.trim()) && item?.querySelector("time.inbox-time") !== null;
}, DONE, { timeout: 15_000 });
const rowCount = (page: Page, count: number) => page.waitForFunction((n) => document.querySelectorAll(".mode-inbox .inbox-item").length === n, count, { timeout: 30_000 });
const questionShown = (page: Page) => page.waitForFunction((pane) =>
  /Allow command\?/.test(document.querySelector(`.mode-inbox .inbox-item[data-machine="local"][data-pane="${pane}"] .inbox-words`)?.textContent ?? ""), BLOCKED, { timeout: 15_000 });
const address = (page: Page): Promise<Address> => page.evaluate(() => {
  const query = new URL(location.href).searchParams;
  return { app: query.get("app"), pane: query.get("pane"), machine: query.get("machine") };
});
/** The address says `want`, for each parameter given. The app writes its address after it has drawn, so this waits for it. */
async function addressIs(page: Page, want: Partial<Address>, what: string): Promise<void> {
  const said = await page.waitForFunction((fields) => {
    const query = new URL(location.href).searchParams;
    return Object.entries(fields).every(([name, value]) => query.get(name) === value);
  }, want, { timeout: 5_000 }).then(() => true, () => false);
  if (!said) assert.fail(`${what}: the address says ${JSON.stringify(await address(page))}, wanted ${JSON.stringify(want)}`);
}
const historyLength = (page: Page): Promise<number> => page.evaluate(() => history.length);
const frames = (page: Page) => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const row = (page: Page, pane: string, machine = "local") => page.locator(`.mode-inbox .inbox-item[data-machine="${machine}"][data-pane="${pane}"] .inbox-row`);
const near = (got: number, want: number, by: number, what: string): void => assert.ok(Math.abs(got - want) <= by, `${what}: ${got}, wanted ${want} within ${by}`);
/** the same box, to half a pixel on each side */
const sameBox = (got: Box, want: Box, what: string): void => {
  for (const side of ["x", "y", "w", "h"] as const) near(got[side], want[side], 0.5, `${what} (${side})`);
};
/** the list as a phone's screen: no header over it, and the mode's mark in the address */
async function listScreen(page: Page): Promise<void> {
  await page.locator(".mode-inbox").waitFor();
  await page.locator(".app-header").waitFor({ state: "detached" });
  await addressIs(page, { app: "inbox", pane: null }, "the list's address says the mode and names no pane");
}
/** opens a row's thread on a phone: the list leaves, and the header has Back and the thread's title */
async function openThread(page: Page, pane: string, machine = "local"): Promise<void> {
  await row(page, pane, machine).tap();
  await page.locator(".mode-inbox").waitFor({ state: "detached" });
  await page.locator("#inbox-back").waitFor();
  await page.locator(".thread-title").waitFor();
  await addressIs(page, { app: "inbox", pane }, "a thread's address names its pane and keeps the mode");
}
async function backToList(page: Page): Promise<void> {
  await page.locator("#inbox-back").tap();
  await page.locator(".mode-inbox").waitFor();
}
/** a phone's sheet, from the header's More, the list's own or the filter's button */
async function openSheet(page: Page, button: string): Promise<void> {
  await page.locator(button).tap();
  await page.locator(".row-sheet").waitFor();
}
/**
 * A sheet that closed is gone from the page and from the history: one closed by an item that went nowhere, or by
 * Cancel, steps back off its own entry a moment later (lib/sheetHistory.ts). A press that pushed an entry before
 * that step landed would put it after the sheet's, and the step would land back on the sheet's. The next press
 * comes after the step.
 */
async function sheetClosed(page: Page): Promise<void> {
  await page.locator(".row-sheet").waitFor({ state: "detached" });
  await page.waitForFunction((key) => (history.state as Record<string, unknown> | null)?.[key] === undefined, SHEET_HISTORY_KEY, { timeout: 5_000 });
}
/** picks one of the state filter's four choices from its sheet */
async function pickFilter(page: Page, choice: "all" | "blocked" | "working" | "done"): Promise<void> {
  await openSheet(page, ".inbox-filter-toggle");
  await page.locator(`.row-sheet [data-item="${choice}"]`).tap();
  await sheetClosed(page);
}
/** enters the mode as a user does on a phone: More, then Open agent inbox */
async function enterFromMore(page: Page): Promise<void> {
  await openSheet(page, ".header-more-button");
  await page.locator('.row-sheet [data-item="enter-inbox"]').tap();
  await sheetClosed(page);
  await listScreen(page);
}
/** the visible terminal mount's box, once the terminal lens shows */
async function terminalBox(page: Page): Promise<Box> {
  await page.waitForFunction(() => {
    const mount = document.querySelector(".terminal-stack:not(.is-chat) .pane-terminal .xterm-screen");
    return mount !== null && mount.getBoundingClientRect().width > 0;
  }, undefined, { timeout: 15_000 });
  await frames(page);
  return box(page, ".terminal-stack:not(.is-chat) .pane-terminal");
}
/** every pane mounted under the list is hidden, and at least one is mounted */
async function paneHiddenUnderList(page: Page, what: string): Promise<void> {
  const slots = await page.evaluate(() => [...document.querySelectorAll(".pane-slot")].map((node) => getComputedStyle(node).visibility));
  assert.ok(slots.length >= 1 && slots.every((visibility) => visibility === "hidden"), `${what}: ${slots.join()}`);
}
async function shot(page: Page, name: string): Promise<void> {
  if (!evidence) return;
  await appFaces(page);
  await page.screenshot({ path: join(evidence, name), animations: "disabled" });
}

/**
 * One block of the script in one tab of a fresh browser profile: the settings are seeded once, so a reload keeps what
 * the app stored since. Where a phone starts is this device's own choice, a JSON boolean of its own beside the
 * settings record: `phoneInbox` in a seed is stored there, and a seed without it leaves the device starting in the
 * classic app. A block that fails says where and is counted; the blocks after it still run.
 */
async function withPage(browser: Browser, base: string, settings: Settings, path: string, what: string, run: (page: Page) => Promise<void>, viewport: { width: number; height: number } = PHONE, touch: boolean = viewport.width < 769, locale = "en-US"): Promise<void> {
  const context = await browser.newContext({ viewport, isMobile: touch, hasTouch: touch, locale });
  try {
    await context.addInitScript((seed) => {
      // the blank page the tab began on, which Back out of the app returns to, has no storage to seed
      if (location.protocol === "about:") return;
      if (sessionStorage.getItem("inbox-mode-regression:seeded")) return;
      sessionStorage.setItem("inbox-mode-regression:seeded", "1");
      const { phoneInbox, ...settings } = seed;
      localStorage.setItem("ovis:settings", JSON.stringify(settings));
      if (phoneInbox === true) localStorage.setItem("ovis:phone-inbox", JSON.stringify(true));
    }, settings);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${what}: ${error.message}`));
    try {
      await page.goto(base + path);
      await run(page);
    } catch (error) {
      failures.push(what);
      console.log(`FAIL ${what}: ${error instanceof Error ? error.message : String(error)}`);
      if (evidence) await page.screenshot({ path: join(evidence, `inbox-mode-failure-${failures.length}.png`) }).catch(() => undefined);
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
        const off: Settings = { language: "en", theme };
        const on: Settings = { language: "en", theme, phoneInbox: true };
        const pass = (step: number, what: string) => console.log(`PASS ${theme} (${step}) ${what}`);
        const block = (what: string): string => `${theme}: ${what}`;

        // ---- a phone: the entry, the list, a thread ----
        await withPage(browser, base, off, "/", block("the entry in More, the list, a thread, the way out"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator("#drawer-toggle").waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0, "a fresh device opens the classic app");
          await page.waitForFunction(() => new URL(location.href).searchParams.get("pane") !== null);
          await addressIs(page, { app: null }, "the classic app's address has no mode");
          const entries = await historyLength(page);
          await openSheet(page, ".header-more-button");
          const last = page.locator(".row-sheet .row-sheet-item").last();
          assert.equal(await last.getAttribute("data-item"), "enter-inbox", "More's last item is the way in");
          assert.equal((await last.locator(".row-sheet-label").textContent())?.trim(), "Open agent inbox");
          await shot(page, `inbox-mode-entry-390-${theme}.png`);
          await last.tap();
          await sheetClosed(page);
          await listScreen(page);
          assert.equal(await historyLength(page), entries + 1, "entering is one entry: the sheet's own was taken over");
          await paneHiddenUnderList(page, "the pane stays mounted under the list, hidden");
          pass(1, "More's last item, Open agent inbox, opens the list as the screen by one history entry, the pane mounted and hidden under it");

          await rowCount(page, 6);
          await questionShown(page);
          await summaryShown(page);
          await appFaces(page);
          // drawn: the pane under the list keeps the classic shell's tab row, hidden with it, so its terminal keeps its box
          for (const selector of ABSENT) assert.equal(await page.locator(selector).filter({ visible: true }).count(), 0, `the mode draws no ${selector}`);
          assert.equal(await page.locator(".mode-inbox :is(h1, h2, h3, h4, h5, h6, [role='heading'])").count(), 0, "the list has no heading");
          assert.equal(await page.locator(".mode-inbox").getAttribute("aria-label"), "Agent inbox");
          assert.equal(await page.locator(".mode-inbox .inbox-top button").count(), 2, "exactly two controls at the top");
          const { width, height } = page.viewportSize()!;
          const [more, add, filter, search] = await Promise.all([box(page, ".inbox-more"), box(page, ".inbox-add"), box(page, ".inbox-filter-toggle"), box(page, ".inbox-search-input")]);
          for (const [name, control] of [["More", more], ["New workspace", add], ["the filter", filter]] as const) assert.deepEqual([control.w, control.h], [44, 44], `${name} is 44 by 44`);
          near(more.x, 18, 2, "More's inset"); near(width - add.right, 18, 2, "New workspace's inset");
          // with no safe area over them the two controls still touch no edge
          near(more.y, 8, 0.5, "More under the top edge"); near(add.y, 8, 0.5, "New workspace under the top edge");
          near(filter.x, 18, 2, "the filter's inset"); near(width - search.right, 18, 2, "the search field's inset");
          assert.equal(search.h, 44, "the search field is 44 tall");
          near(search.x - filter.right, 12, 2, "between the filter and the search field");
          near(height - filter.bottom, 12, 2, "under the foot");
          near(search.w, width - 92, 2, "the search field's width");
          const boxes = await page.locator(".mode-inbox .inbox-item").evaluateAll((items) => items.map((item) => {
            const r = item.querySelector(".inbox-row")!.getBoundingClientRect();
            const a = item.querySelector(".inbox-avatar")!.getBoundingClientRect();
            const b = item.querySelector(".inbox-body")!.getBoundingClientRect();
            const words = item.querySelector(".inbox-words")!;
            return { top: r.top, height: r.height, avatar: [a.left, a.width, a.height], text: b.left - a.right, wordsHeight: words.getBoundingClientRect().height, wordsSize: getComputedStyle(words).fontSize, nameSize: getComputedStyle(item.querySelector(".inbox-name")!).fontSize };
          }));
          near(boxes[0]!.top - more.bottom, 16, 4, "the first row under the top controls");
          for (const item of boxes) {
            near(item.height, 80, 2, "a row's height");
            assert.deepEqual(item.avatar, [22, 44, 44], "the mark is 44px, 22px in");
            near(item.text, 16, 2, "from the mark to the text");
            assert.deepEqual([item.nameSize, item.wordsSize], ["16px", "15px"]);
            assert.ok(item.wordsHeight < 30, `the words are one line: ${item.wordsHeight}px`);
          }
          const drawn = await rows(page);
          assert.deepEqual(drawn.map((item) => item.pane), [BLOCKED, WORKING, DONE, ...drawn.slice(3).map((item) => item.pane)]);
          assert.deepEqual(new Set(drawn.slice(3).map((item) => item.pane)), new Set(IDLE));
          assert.deepEqual(drawn.map((item) => item.mark), ["blocked", "working", "done", null, null, null], "each state its own mark, none for a ready agent");
          assert.deepEqual(drawn.slice(0, 3).map((item) => item.markLabel), ["Needs you", "Working", "Done"], "a state's mark is named in the words its chip and the filters use");
          assert.deepEqual(drawn.map((item) => item.asking), [true, false, true, false, false, false], "the rows that ask for a look draw their words stronger");
          assert.deepEqual(drawn.map((item) => item.buttons), [1, 1, 1, 1, 1, 1], "a row is one button and holds no other");
          assert.match(drawn[0]!.words ?? "", /Allow command\?/);
          assert.ok((drawn[2]!.words ?? "").trim() !== "", "the done row says what its agent last said");
          assert.match(drawn[2]!.time ?? "", /^(<1m|\d+[mhd])$/, "the done row says how long it has been done");
          assert.ok(drawn[2]!.datetime !== null && !Number.isNaN(Date.parse(drawn[2]!.datetime)), "the done row's time carries a datetime");
          await shot(page, `inbox-mode-list-390-${theme}.png`);
          pass(2, "the list: no title and nothing the mode leaves out, two 44px round controls at the top and a round filter and a search pill at the foot on their insets, six 80px rows with a 44px mark, a 16px name and one 15px line, the waiting row first with its question, each state's own mark and none on the ready rows");

          await openSheet(page, ".inbox-filter-toggle");
          assert.equal(await page.locator('.row-sheet [role="menu"] [role="menuitemradio"]').count(), 4, "the four filters are one menu of radio items");
          assert.equal(await page.locator('.row-sheet [role="menuitemradio"][aria-checked="true"]').getAttribute("data-item"), "all");
          // the keyboard as a menu's radio items take it: the focus starts on the chosen one, the arrows walk the four and
          // choose nothing, Tab takes them as one stop before Cancel, from any of them, and comes back to the chosen one
          const focusedItem = (want: string | null, why: string): Promise<unknown> => page.waitForFunction((item) => {
            const at = document.activeElement;
            return item === null ? at?.classList.contains("row-sheet-cancel") === true : at?.getAttribute("data-item") === item;
          }, want, { timeout: 5_000 }).catch(() => { throw new Error(`the sheet's focus is not on ${want ?? "Cancel"}: ${why}`); });
          await focusedItem("all", "the sheet opens on the chosen filter");
          await page.keyboard.press("ArrowDown");
          await focusedItem("blocked", "ArrowDown moves to the next filter");
          await page.keyboard.press("ArrowUp");
          await page.keyboard.press("ArrowUp");
          await focusedItem("done", "ArrowUp from the first filter goes round to the last");
          assert.equal(await page.locator('.row-sheet [role="menuitemradio"][aria-checked="true"]').getAttribute("data-item"), "all", "the arrows choose nothing");
          await page.keyboard.press("ArrowUp");
          await focusedItem("working", "ArrowUp moves to the filter before");
          await page.keyboard.press("Tab");
          await focusedItem(null, "Tab from a middle filter leaves the four for Cancel");
          await page.keyboard.press("Tab");
          await focusedItem("all", "Tab comes back to the filters on the chosen one");
          await page.keyboard.press("Shift+Tab");
          await focusedItem(null, "Shift+Tab leaves the four filters for Cancel");
          await page.keyboard.press("Shift+Tab");
          await focusedItem("all", "Shift+Tab from Cancel comes back to the chosen filter, not the last one");
          await page.locator('.row-sheet [data-item="working"]').tap();
          await sheetClosed(page);
          await rowCount(page, 1);
          assert.equal((await rows(page))[0]!.pane, WORKING);
          assert.equal(await page.locator(".inbox-filter-toggle.is-on").getAttribute("aria-label"), "Filter by state: Working");
          await openSheet(page, ".inbox-filter-toggle");
          assert.equal(await page.locator('.row-sheet [role="menuitemradio"][aria-checked="true"]').getAttribute("data-item"), "working");
          await focusedItem("working", "the sheet opens on the chosen filter, not the first one");
          await page.locator('.row-sheet [data-item="all"]').tap();
          await sheetClosed(page);
          await rowCount(page, 6);
          assert.equal(await page.locator(".inbox-filter-toggle").getAttribute("aria-label"), "Filter by state");
          pass(3, "the filter's button opens All, Needs you, Working and Done as a menu of radio items that the arrows walk and Tab takes as one stop; Working narrows the list to its row and fills the button, All draws the six again");

          const field = page.locator(".inbox-search-input");
          await field.fill("export");
          await rowCount(page, 1);
          assert.equal(await page.locator(".mode-inbox .inbox-item .inbox-name").textContent(), BLOCKED_TITLE);
          await page.locator(".inbox-search-clear").tap();
          await rowCount(page, 6);
          assert.equal(await field.inputValue(), "");
          await field.fill("zzqq no such agent");
          await page.locator(".inbox-empty").waitFor();
          assert.equal(await page.locator(".inbox-empty").textContent(), "No results");
          await page.locator(".inbox-search-clear").tap();
          await rowCount(page, 6);
          pass(4, "search: export leaves one row, clearing it draws six, a query with no match says No results");

          await pickFilter(page, "blocked");
          await rowCount(page, 1);
          await openThread(page, BLOCKED);
          await page.locator(".prompt-card").first().waitFor();
          assert.equal((await page.locator(".thread-name").textContent())?.replace(/^Codex: /, ""), BLOCKED_TITLE);
          assert.equal(await page.locator(".thread-state").textContent(), "Needs you");
          for (const selector of ABSENT) assert.equal(await page.locator(selector).count(), 0, `a thread draws no ${selector}`);
          const dock = await page.evaluate(() => {
            const card = document.querySelector(".prompt-dock .prompt-card")!.getBoundingClientRect();
            const composer = document.querySelector(".composer-surface")!.getBoundingClientRect();
            return { above: card.bottom <= composer.top + 1, left: card.left - composer.left, right: card.right - composer.right };
          });
          assert.ok(dock.above && Math.abs(dock.left) <= 1 && Math.abs(dock.right) <= 1, `the prompt card is docked above the composer on its column: ${JSON.stringify(dock)}`);
          // the header's three controls are one family: a finger's size each, and none in a box of its own
          for (const selector of ["#inbox-back", ".lens-toggle", ".header-more-button"]) {
            const control = await box(page, selector);
            assert.ok(control.w >= 44 && control.h >= 44, `${selector} is a finger's size: ${control.w} by ${control.h}`);
            assert.equal(await page.locator(selector).evaluate((node) => node.classList.contains("is-outlined")), false, `${selector} has no box of its own`);
          }
          // the one agent that waits is this thread's, its question on the screen: More counts none
          assert.equal(await page.locator(".header-more-dot.is-waiting").count(), 0, "More counts no waiting agent but the others");
          assert.doesNotMatch(await page.locator(".header-more-button").getAttribute("aria-label") ?? "", /waiting for you/);
          await shot(page, `inbox-mode-thread-390-${theme}.png`);
          pass(5, "a tap on the waiting row opens its chat under Back, the agent's name over Needs you, the monitor button and More as one family of plain buttons, the prompt card docked above the composer, and no count on More for the thread's own question");

          const lens = page.locator(".lens-toggle");
          assert.equal(await lens.getAttribute("aria-label"), "Show the terminal");
          await lens.tap();
          await page.locator('.lens-toggle[data-view="terminal"]').waitFor();
          assert.equal(await lens.getAttribute("aria-label"), "Show the chat");
          const inMode = await terminalBox(page);
          await shot(page, `inbox-mode-terminal-390-${theme}.png`);
          await lens.tap();
          await page.locator('.lens-toggle[data-view="chat"]').waitFor();
          await page.locator(".prompt-card").first().waitFor();

          await backToList(page);
          // the reader's place after Back is the row whose thread it left
          assert.equal(await page.evaluate(() => document.activeElement?.closest(".inbox-item")?.getAttribute("data-pane") ?? null), BLOCKED, "Back from a thread gives the focus to that thread's row");
          assert.equal(await page.locator(".inbox-filter-toggle.is-on").getAttribute("aria-label"), "Filter by state: Needs you");
          await rowCount(page, 1);
          await paneHiddenUnderList(page, "the opened pane stays mounted under the list, hidden");
          // six rows barely scroll on an 844px phone: the scroll is kept on a shorter one, where it has room to
          await pickFilter(page, "all");
          await rowCount(page, 6);
          await page.setViewportSize({ width: 390, height: 560 });
          const scroller = page.locator(".inbox-scroll");
          await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await page.waitForFunction(() => (document.querySelector(".inbox-scroll")?.scrollTop ?? 0) > 0);
          const top = await scroller.evaluate((node) => node.scrollTop);
          const end = await page.evaluate(() => ({ row: [...document.querySelectorAll(".mode-inbox .inbox-item")].at(-1)!.getBoundingClientRect().bottom, foot: document.querySelector(".inbox-filter-toggle")!.getBoundingClientRect().top }));
          assert.ok(end.row <= end.foot, `at the list's end the last row ends above the foot's controls: row ${end.row}, foot ${end.foot}`);
          const lastPane = await page.locator(".mode-inbox .inbox-item").last().getAttribute("data-pane");
          assert.ok(lastPane !== null);
          await openThread(page, lastPane);
          await backToList(page);
          await questionShown(page);
          const kept = await page.waitForFunction((at) => Math.abs((document.querySelector(".inbox-scroll")?.scrollTop ?? -9) - at) <= 1, top, { timeout: 5_000 }).then(() => true, () => false);
          const now = await scroller.evaluate((node) => ({ top: node.scrollTop, range: node.scrollHeight - node.clientHeight }));
          assert.ok(kept, `the list scrolled to its end (${Math.round(top)}px) came back at ${Math.round(now.top)}px of ${Math.round(now.range)}px`);
          pass(6, `the monitor button shows the terminal in the thread's place and gives the chat back; Back returns to the list with its filter and its scroll (${Math.round(top)}px) kept, the pane mounted and hidden, the last row clear of the foot`);

          await page.setViewportSize(PHONE);
          await openSheet(page, ".inbox-more");
          assert.deepEqual(await page.locator(".row-sheet .row-sheet-item").evaluateAll((items) => items.map((item) => item.getAttribute("data-item"))), ["exit-inbox", "palette", "alerts", "settings"], "the list's More begins with the way out and the palette, and holds the app's items");
          assert.equal((await page.locator('.row-sheet [data-item="exit-inbox"] .row-sheet-label').textContent())?.trim(), "Back to Ovis");
          assert.equal(await page.locator('.row-sheet [data-item="exit-inbox"] img.ovis-mark').count(), 1, "Back to Ovis is drawn with the app's own mark, as at the column's foot");
          await shot(page, `inbox-mode-more-390-${theme}.png`);
          const inModeEntries = await historyLength(page);
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator("#drawer-toggle").waitFor();
          await sheetClosed(page);
          await addressIs(page, { app: null, pane: lastPane }, "Back to Ovis from the list leaves the mode's address and opens the pane under the list");
          assert.equal(await historyLength(page), inModeEntries, "leaving is one entry: the sheet's own was taken over");
          await page.goBack();
          await listScreen(page);
          await page.goForward();
          await page.locator("#drawer-toggle").waitFor();
          await addressIs(page, { app: null, pane: lastPane }, "Forward returns to the classic app on that pane");
          // the terminal is the size it has in the classic app: entering the mode refits nothing
          await page.goto(`${base}/?pane=${encodeURIComponent(BLOCKED)}&view=terminal`);
          const classic = await terminalBox(page);
          near(inMode.w, classic.w, 1, "the terminal's width in the mode against classic's");
          near(inMode.h, classic.h, 1, "the terminal's height in the mode against classic's");
          pass(7, `Back to Ovis, first in the list's More, opens the classic app on the pane under the list by one entry that Back undoes; a thread's terminal is the size classic's is (${Math.round(classic.w)} by ${Math.round(classic.h)})`);
        });

        // ---- a phone: the history ----
        await withPage(browser, base, off, "/?app=inbox", block("Back, Forward and reloads from the list's own address"), async (page) => {
          await listScreen(page);
          assert.equal(await page.locator(".pane-slot").count(), 0, "nothing is mounted for a pane under a cold list");
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.goBack();
          await listScreen(page);
          await page.goForward();
          await page.locator("#inbox-back").waitFor();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await addressIs(page, { app: "inbox", pane: WORKING }, "Forward shows the thread again");
          pass(8, "the system Back shows the list and Forward the thread again");

          await page.reload();
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0);
          await addressIs(page, { app: "inbox", pane: WORKING }, "a reload in a thread keeps the thread");
          await backToList(page);
          await page.reload();
          await listScreen(page);
          await rowCount(page, 6);
          pass(9, "a reload in a thread keeps the thread, and on the list the list");
        });

        await withPage(browser, base, off, "/?app=inbox", block("Back on a list opened by its own address"), async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          // the page's first entry is the list's: nothing of the app lies under it
          await page.goBack({ waitUntil: "commit" });
          await page.waitForURL("about:blank");
          pass(10, "opened by its own address, Back on the list leaves the app");
        });

        await withPage(browser, base, off, `/?app=inbox&pane=${encodeURIComponent(BLOCKED)}`, block("a thread opened by its own address"), async (page) => {
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          await page.locator(".pane-slot").first().waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0, "an address naming a pane opens its thread");
          const entries = await historyLength(page);
          await backToList(page);
          await rowCount(page, 6);
          await addressIs(page, { app: "inbox", pane: null }, "the header's Back opens the list in the thread's place");
          assert.equal(await historyLength(page), entries, "the header's Back adds no entry");
          pass(11, "a cold address of a thread shows the thread, and the header's Back opens the list in its place, adding no entry");
        });

        // the classic app's More header is main's: the header itself scrolls, capped at six lines; the path is no scroller
        await withPage(browser, base, off, `/?pane=${encodeURIComponent(BLOCKED)}`, block("the classic app's More header as on main"), async (page) => {
          await openSheet(page, ".header-more-button");
          const roles = await page.locator(".row-sheet .header-more-crumb").evaluate((crumb) => { const path = crumb.querySelector(".header-more-path"); return { crumb: getComputedStyle(crumb).overflowY, cap: getComputedStyle(crumb).maxHeight, path: path ? getComputedStyle(path).overflowY : null, mode: crumb.classList.contains("is-inbox") }; });
          assert.ok(roles.crumb === "auto" && roles.cap !== "none" && roles.path !== "auto" && !roles.mode, `classic's More header scrolls as a whole, as on main: ${JSON.stringify(roles)}`);
          console.log("PASS the classic app's More header scrolls as a whole, capped at six lines, as on main");
        });
        await withPage(browser, base, off, `/?pane=${encodeURIComponent(BLOCKED)}`, block("the way out from a thread, and Back through the mode to where it was entered"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await enterFromMore(page);
          await rowCount(page, 6);
          await openThread(page, WORKING);
          // another agent waits, and this thread is not its: More counts it, and offers to open it
          assert.equal(await page.locator('.header-more-dot.is-waiting[data-count="1"]').count(), 1, "More counts the other agent that waits");
          assert.match(await page.locator(".header-more-button").getAttribute("aria-label") ?? "", /1 waiting for you/);
          await openSheet(page, ".header-more-button");
          const items = await page.locator(".row-sheet .row-sheet-item").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-item")));
          assert.deepEqual(items.slice(0, 2), ["exit-inbox", "palette"], `a thread's More begins with the way out and the palette: ${items.join()}`);
          // the sheet's header (the pane's title, place, path, the session's lines, the route) is no scroller of its own
          const header = await page.locator(".row-sheet .header-more-crumb").evaluate((node) => ({ content: node.scrollHeight, box: node.clientHeight, lines: node.childElementCount }));
          assert.ok(header.lines >= 3 && header.content <= header.box, `More's header holds its ${header.lines} lines without scrolling: ${header.content}px in ${header.box}px`);
          const roles = await page.locator(".row-sheet .header-more-crumb").evaluate((crumb) => { const path = crumb.querySelector(".header-more-path"); return { crumb: getComputedStyle(crumb).overflowY, path: path ? getComputedStyle(path).overflowY : null }; });
          assert.ok(roles.crumb === "visible" && (roles.path === null || roles.path === "auto"), `a thread's More header is no scroller, only its path is: ${JSON.stringify(roles)}`);
          assert.equal(items[2], "next-waiting", `then the next agent that waits: ${items.join()}`);
          assert.ok(!items.includes("open-drawer"), `the mode has no drawer to open: ${items.join()}`);
          assert.deepEqual(items.slice(-2), ["alerts", "settings"], `the app's items end a thread's More: ${items.join()}`);
          await shot(page, `inbox-mode-thread-more-390-${theme}.png`);
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator("#drawer-toggle").waitFor();
          await page.locator(".context-title-text").waitFor();
          await sheetClosed(page);
          await addressIs(page, { app: null, pane: WORKING }, "left from a thread, the classic app opens on that thread's pane");
          await page.goBack();
          await page.locator(".thread-title").waitFor();
          await addressIs(page, { app: "inbox", pane: WORKING }, "Back returns to the thread");
          await page.goBack();
          await listScreen(page);
          await page.goBack();
          await page.locator("#drawer-toggle").waitFor();
          await addressIs(page, { app: null, pane: BLOCKED }, "Back on the list returns to the pane the mode was entered from");
          pass(12, "over a thread More counts the other agent that waits and offers it after Back to Ovis; Back to Ovis from a thread opens that thread's pane in the classic app; Back then returns to the thread, to the list, and to the pane the mode was entered from");
        });

        await withPage(browser, base, off, "/", block("the entry at the drawer's foot, and no drawer in the mode"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator("#drawer-toggle").tap();
          const entry = page.locator(".sidebar.is-open .inbox-foot-entry");
          await entry.waitFor();
          assert.equal((await entry.textContent())?.trim(), "Open agent inbox");
          await shot(page, `inbox-mode-drawer-entry-390-${theme}.png`);
          await entry.tap();
          await listScreen(page);
          await rowCount(page, 6);
          // no drawer in the mode: a swipe in from the left edge opens nothing
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 4, y: 420 }] });
          for (let x = 24; x <= 304; x += 40) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 422 }] });
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await frames(page);
          assert.equal(await page.locator("#workspace-drawer, .scrim.is-open").count(), 0, "a swipe from the edge opens no drawer in the mode");
          await page.locator(".mode-inbox").waitFor();
          pass(13, "the drawer's foot has Open agent inbox, which opens the list; in the mode a swipe from the left edge opens no drawer");
        });

        await withPage(browser, base, off, "/?app=inbox", block("New workspace from the list"), async (page) => {
          await rowCount(page, 6);
          await page.locator(".inbox-add").tap();
          const dialog = page.getByRole("dialog").filter({ hasText: "New workspace" }).first();
          await dialog.waitFor();
          await page.goBack();
          await dialog.waitFor({ state: "detached" });
          await listScreen(page);
          await rowCount(page, 6);
          pass(14, "New workspace opens its dialog from the list, and the system Back closes it onto the list");
        });

        await withPage(browser, base, off, "/?demo_devices=watch&app=inbox", block("a watching device"), async (page) => {
          await rowCount(page, 6);
          assert.equal(await page.locator(".inbox-add").count(), 0);
          assert.equal(await page.locator(".mode-inbox .inbox-top button").count(), 1, "a watching device keeps More alone at the top");
          pass(15, "a device that only watches may use the mode and is offered no New workspace");
        });

        // ---- where a phone starts ----
        await withPage(browser, base, on, "/", block("a phone that starts in the inbox"), async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          assert.equal(await page.locator(".pane-slot").count(), 0);
          await page.goBack({ waitUntil: "commit" });
          await page.waitForURL("about:blank");
          pass(16, "with Start in the agent inbox on a phone on, a phone's cold start is the mode's list, and Back leaves the app");
        });

        await withPage(browser, base, on, `/?pane=${encodeURIComponent(BLOCKED)}`, block("a phone that starts in the inbox, on an address naming a pane"), async (page) => {
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          await addressIs(page, { app: "inbox", pane: BLOCKED }, "the pane's address opens its thread in the mode");
          await backToList(page);
          await rowCount(page, 6);
          pass(17, "with the setting on, an address naming a pane opens that pane's thread in the mode, the list behind its Back");
        });

        await withPage(browser, base, on, "/", block("the setting on a wide window"), async (page) => {
          await page.locator(".pane-slot").first().waitFor();
          await page.locator(".agents-sidebar .agent-item").first().waitFor();
          assert.equal(await page.locator(".mode-inbox").count(), 0);
          await addressIs(page, { app: null }, "a wide window with the setting on starts in the classic app");
          pass(18, "at 1280x900 with the setting on the app starts in the classic shell");
        }, { width: 1280, height: 900 });

        await withPage(browser, base, off, "/", block("the Settings row"), async (page) => {
          await page.locator(".context-title-text").waitFor();
          await page.locator("#drawer-toggle").tap();
          await page.locator(".sidebar").getByRole("button", { name: /^Settings/ }).first().tap();
          const settings = page.locator(".settings-dialog");
          await settings.waitFor();
          await settings.locator(".settings-search-input").first().fill("Agent inbox");
          const toggle = settings.getByRole("switch", { name: "Start in the agent inbox on a phone" });
          await toggle.tap();
          await page.waitForFunction(() => document.querySelector('.settings-dialog [role="switch"][aria-label="Start in the agent inbox on a phone"]')?.getAttribute("aria-checked") === "true");
          await page.getByRole("button", { name: "Close settings" }).tap();
          await settings.waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:phone-inbox") ?? "null")), true);
          assert.equal(await page.locator(".mode-inbox").count(), 0, "the setting says where the device starts: the page it was turned on in stays as it is");
          await page.goto(`${base}/`);
          await listScreen(page);
          await rowCount(page, 6);
          pass(19, "the Settings row stores the device's choice and leaves the page as it is; the next cold start is the mode's list");
        });

        // ---- what the shell withholds, and what it keeps ----
        await withPage(browser, base, { ...off, shortcutOverrides: { "close-pane": "ctrl+alt+x", "new-tab": "ctrl+alt+u" } }, "/?app=inbox", block("the keys the mode withholds"), async (page) => {
          await rowCount(page, 6);
          await openThread(page, WORKING);
          await page.locator(".pane-slot").first().waitFor();
          const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          const newTab = page.locator(".new-session-modal");
          const confirm = page.locator(".confirm-dialog");
          // the mode has no tab row and no pane menu: in a thread, as on the list, the keys ask for nothing
          await blur();
          await page.keyboard.press("Control+Alt+u");
          await page.keyboard.press("Control+Alt+x");
          await frames(page);
          assert.deepEqual([await newTab.count(), await confirm.count()], [0, 0], "in a thread the keys make no tab and ask to close no pane");
          await backToList(page);
          await blur();
          await page.keyboard.press("Control+Alt+u");
          await page.keyboard.press("Control+Alt+x");
          await frames(page);
          assert.deepEqual([await newTab.count(), await confirm.count()], [0, 0], "on the list the keys do nothing");
          assert.equal(await page.locator(`.mode-inbox .inbox-item[data-pane="${WORKING}"]`).count(), 1, "the pane under the list is still in the roster");
          // back in the classic app the same key asks to close the pane shown
          await openSheet(page, ".inbox-more");
          await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          await page.locator("#drawer-toggle").waitFor();
          await sheetClosed(page);
          await blur();
          await page.keyboard.press("Control+Alt+x");
          await confirm.waitFor();
          await page.keyboard.press("Escape");
          await confirm.waitFor({ state: "detached" });
          pass(20, "keys bound to Close pane and New tab do nothing in the mode, in a thread as on the list, and act again once the classic app is back");
        });

        await withPage(browser, base, { ...off, keepScreenOn: true }, "/?app=inbox", block("Keep screen on"), async (page) => {
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

        await withPage(browser, base, off, "/?app=inbox", block("finishes under the list"), async (page) => {
          await rowCount(page, 6);
          // the working agent's pane is opened, then covered by the list: it finishes there, unread
          await openThread(page, WORKING);
          await page.locator(".pane-slot").first().waitFor();
          await backToList(page);
          await page.evaluate((pane) => window.inboxFixture.set(pane, "done", 2), WORKING);
          await page.waitForFunction((pane) => document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"]`)?.getAttribute("data-state") === "done", WORKING);
          const seen = await page.evaluate(() => window.inboxFixture.rosters);
          await page.evaluate(() => window.inboxFixture.publish());
          await page.waitForFunction((count) => window.inboxFixture.rosters > count, seen);
          await frames(page);
          const after = await rows(page);
          for (const pane of [WORKING, DONE]) {
            const item = after.find((candidate) => candidate.pane === pane);
            assert.equal(item?.mark, "done", `${pane} still draws the done mark after the roster came again: ${JSON.stringify(item)}`);
          }
          pass(22, "a finish under the list, of the pane it covers and of one never opened, is still marked done after a roster republish");
        });

        await withPage(browser, base, off, "/?app=inbox", block("two PCs, and a list that scrolls"), async (page) => {
          await rowCount(page, 6);
          // the demo's second PC holds the same pane ids as the first
          await page.evaluate(() => (window as unknown as { __herdrDemoOrder: { addPc: () => string } }).__herdrDemoOrder.addPc());
          await rowCount(page, 12);
          const names: Record<string, string> = await page.evaluate(async () => Object.fromEntries((await (await fetch("/api/machines")).json()).machines.map((machine: Machine) => [machine.id, machine.name])));
          for (const item of await rows(page)) assert.ok((item.words ?? "").startsWith(`${names[item.machine!]} \u00b7 `), `a row of ${item.machine} leads its words with its PC: ${item.words}`);
          // twelve rows scroll: the four floating controls keep their place from the list's top to its end
          const places = () => page.evaluate(() => Object.fromEntries([".inbox-more", ".inbox-add", ".inbox-filter-toggle", ".inbox-search-input"].map((selector) => {
            const r = document.querySelector(selector)!.getBoundingClientRect();
            return [selector, [r.left, r.top, r.right, r.bottom]];
          })));
          const scroller = page.locator(".inbox-scroll");
          const atTop = await places();
          const range = await scroller.evaluate((node) => node.scrollHeight - node.clientHeight);
          assert.ok(range > 0, `twelve rows scroll: ${range}`);
          await scroller.evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await page.waitForFunction(() => { const node = document.querySelector(".inbox-scroll")!; return Math.abs(node.scrollTop - (node.scrollHeight - node.clientHeight)) <= 1; });
          await frames(page);
          assert.deepEqual(await places(), atTop, "the floating controls stay put while the list scrolls");
          const end = await page.evaluate(() => ({ row: [...document.querySelectorAll(".mode-inbox .inbox-item")].at(-1)!.getBoundingClientRect().bottom, foot: document.querySelector(".inbox-filter-toggle")!.getBoundingClientRect().top }));
          assert.ok(end.row <= end.foot, `at the list's end the last row ends above the foot's controls: row ${end.row}, foot ${end.foot}`);
          await scroller.evaluate((node) => { node.scrollTop = 0; });
          await openThread(page, WORKING, "laptop");
          await addressIs(page, { machine: "laptop", pane: WORKING, app: "inbox" }, "the other PC's row opens that PC's pane");
          assert.match(await page.locator(".thread-state").textContent() ?? "", new RegExp(`^${names["laptop"]} \u00b7 `), "with several PCs a thread says which PC before its state");
          pass(23, `with two PCs holding the same pane ids each row leads its words with its PC, and the other PC's row opens that PC's pane; over twelve rows (${Math.round(range)}px of scroll) the floating controls stay put and the last row ends ${Math.round(end.foot - end.row)}px above the foot`);
        });

        // ---- a wide window: the list beside the thread ----
        for (const viewport of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
          const at = `${viewport.width}`;
          await withPage(browser, base, off, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, block(`the list beside the thread at ${at}`), async (page) => {
            await page.locator(".app-header.is-zoned").waitFor();
            const classic = { sidebar: await box(page, "#workspace-drawer"), pane: await box(page, ".pane-column"), terminal: await terminalBox(page) };
            const entries = await historyLength(page);
            await page.locator(".header-more-button").click();
            const entry = page.locator('.row-menu [data-item="enter-inbox"]');
            await entry.waitFor();
            assert.equal((await entry.textContent())?.trim(), "Open agent inbox");
            await entry.click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            await page.locator(".app-header").waitFor({ state: "detached" });
            await rowCount(page, 6);
            await questionShown(page);
            await appFaces(page);
            await addressIs(page, { app: "inbox", pane: null }, "the wide list's address says the mode and names no pane");
            assert.equal(await historyLength(page), entries + 1, "entering is one entry");
            assert.equal(await page.locator(".inbox-unchosen").textContent(), "Choose one from the list to open its chat here.");
            assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0, "no row is open while no agent is chosen");
            for (const selector of [".tab-strip", ".view-switch", ".status-bar", "#drawer-toggle", "#workspace-drawer", ".sidebar-toggle", ".header-files-button", ".pane-split.is-split", ".mode-inbox time.inbox-time", ".header-more-dot"]) {
              assert.equal(await page.locator(selector).count(), 0, `the wide mode draws no ${selector}`);
            }
            const column = await box(page, ".inbox-column");
            const pane = await box(page, ".pane-column");
            assert.deepEqual([column.x, column.w], [classic.sidebar.x, classic.sidebar.w], "the column is as wide as classic's sidebar");
            assert.deepEqual([pane.x, pane.w], [classic.pane.x, classic.pane.w], "the pane is as wide as in classic");
            const [search, add, filter, more, exit] = await Promise.all([box(page, ".inbox-search-toggle"), box(page, ".inbox-add"), box(page, ".inbox-filter-toggle"), box(page, ".inbox-more"), box(page, ".inbox-exit")]);
            for (const control of [search, add, filter, more]) assert.deepEqual([control.w, control.h], [34, 34], "a round control is 34px under a fine pointer");
            near(add.x - search.right, 10, 2, "between the column's top controls"); near(column.right - add.right, 16, 1, "the top controls from the column's edge"); near(add.y, 12, 2, "from the top");
            near(viewport.height - filter.bottom, 12, 2, "under the column's foot"); near(column.right - more.right, 16, 1, "the foot's controls from the column's edge"); near(more.x - filter.right, 8, 2, "between the foot's controls");
            near(exit.x, 8, 2, "Back to Ovis at the foot's start");
            const wideRows = await page.locator(".mode-inbox .inbox-item").evaluateAll((items) => items.map((item) => {
              const r = item.querySelector(".inbox-row")!.getBoundingClientRect();
              const a = item.querySelector(".inbox-avatar")!.getBoundingClientRect();
              return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, radius: getComputedStyle(item.querySelector(".inbox-row")!).borderRadius, avatar: [a.width, a.height, a.left - r.left], nameSize: getComputedStyle(item.querySelector(".inbox-name")!).fontSize, wordsSize: getComputedStyle(item.querySelector(".inbox-words")!).fontSize };
            }));
            near(wideRows[0]!.top - add.bottom, 16, 2, "the first row under the top controls");
            wideRows.forEach((item, index) => {
              near(item.bottom - item.top, 56, 2, "a wide row's height");
              near(item.left - column.x, 12, 1, "a row's inset at the column's start"); near(column.right - item.right, 12, 1, "a row's inset at the column's end");
              assert.equal(item.radius, "12px");
              assert.deepEqual(item.avatar, [32, 32, 8], "the mark is 32px, 8px inside the row");
              assert.deepEqual([item.nameSize, item.wordsSize], ["14px", "13px"]);
              if (index > 0) near(item.top - wideRows[index - 1]!.bottom, 4, 1, "between two rows");
            });

            await row(page, BLOCKED).click();
            await page.locator(".thread-chip").waitFor();
            await page.locator(".prompt-card").first().waitFor();
            await appFaces(page);
            await addressIs(page, { app: "inbox", pane: BLOCKED }, "a row opens its thread beside the list");
            assert.deepEqual((await rows(page)).filter((item) => item.current === "true").map((item) => item.pane), [BLOCKED], "exactly the open thread's row is current");
            assert.equal(await page.locator(".mode-inbox .inbox-item.is-current .inbox-name").evaluate((node) => getComputedStyle(node).fontWeight), "600");
            assert.equal(await page.locator(".thread-chip-state").textContent(), "Needs you");
            const threadEntries = await historyLength(page);
            const [chip, lens, paneMore] = await Promise.all([box(page, ".thread-chip"), box(page, ".thread-top .lens-toggle"), box(page, ".thread-top .header-more-button")]);
            const middle = (control: Box): number => control.y + control.h / 2;
            for (const control of [add, chip, lens, paneMore]) near(middle(control), middle(search), 1, "the top controls and the chip on one centre line");
            near(chip.x + chip.w / 2, pane.x + pane.w / 2, 2, "the chip on the pane's middle");
            near(lens.y, 12, 2, "the pane's controls from its top"); near(pane.right - paneMore.right, 12, 2, "the pane's controls from its end");
            const lane = await page.evaluate(() => {
              const transcript = document.querySelector(".chat-transcript")!.getBoundingClientRect();
              const composer = document.querySelector(".composer-surface")!.getBoundingClientRect();
              const card = document.querySelector(".prompt-dock .prompt-card")!.getBoundingClientRect();
              return { left: transcript.left, right: transcript.right, composer: [composer.left, composer.right], card: [card.left, card.right], above: card.bottom <= composer.top + 1 };
            });
            near(lane.left - pane.x, pane.right - lane.right, 1, "the transcript's lane centred in the pane");
            near(lane.composer[0]!, lane.left, 1, "the composer on the transcript's column"); near(lane.composer[1]!, lane.right, 1, "the composer on the transcript's column");
            near(lane.card[0]!, lane.composer[0]!, 1, "the prompt card on the composer's column"); near(lane.card[1]!, lane.composer[1]!, 1, "the prompt card on the composer's column");
            assert.ok(lane.above, "the prompt card is docked above the composer");
            await shot(page, `inbox-mode-two-pane-${at}-${theme}.png`);

            // another row takes the thread's entry
            await row(page, WORKING).click();
            await page.waitForFunction((title) => (document.querySelector(".thread-chip-name")?.textContent ?? "").endsWith(title), WORKING_TITLE);
            await addressIs(page, { app: "inbox", pane: WORKING }, "another row opens in the thread's place");
            assert.equal(await historyLength(page), threadEntries, "a second row adds no entry");
            assert.deepEqual((await rows(page)).filter((item) => item.current === "true").map((item) => item.pane), [WORKING]);

            // the terminal behind the monitor button is the size classic's is
            const monitor = page.locator(".thread-top .lens-toggle");
            assert.equal(await monitor.getAttribute("aria-label"), "Show the terminal");
            await monitor.click();
            await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
            const terminal = await terminalBox(page);
            near(terminal.w, classic.terminal.w, 1, "the terminal's width against classic's"); near(terminal.h, classic.terminal.h, 1, "the terminal's height against classic's");
            await monitor.click();
            await page.locator('.thread-top .lens-toggle[data-view="chat"]').waitFor();

            // each side has a More of its own, and neither counts who waits: the list beside the thread shows it
            assert.equal(await page.locator(".header-more-dot").count(), 0, "beside the list More carries no count");
            assert.equal(await page.locator(".thread-top .header-more-button").getAttribute("aria-label"), "More");
            await page.locator(".thread-top .header-more-button").click();
            await page.locator(".row-menu").waitFor();
            const threadItems = await page.locator(".row-menu [data-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-item")));
            assert.ok(threadItems.includes("copy-link") && threadItems.includes("files"), `the pane's More holds the thread's items: ${threadItems.join()}`);
            for (const item of ["exit-inbox", "palette", "settings", "alerts", "next-waiting"]) assert.ok(!threadItems.includes(item), `the pane's More has no ${item}: ${threadItems.join()}`);
            await page.keyboard.press("Escape");
            await page.locator(".row-menu").waitFor({ state: "detached" });
            await page.locator(".inbox-column .inbox-more").click();
            await page.locator(".row-menu").waitFor();
            assert.deepEqual(await page.locator(".row-menu [data-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-item"))), ["palette", "alerts", "settings"], "the column's More holds the app's items, without the way out its foot holds");
            await page.keyboard.press("Escape");
            await page.locator(".row-menu").waitFor({ state: "detached" });

            // the search field opens on request, takes the focus, and Escape puts it away once it is empty
            await page.locator(".inbox-search-toggle").click();
            await page.waitForFunction(() => document.activeElement?.classList.contains("inbox-search-input") === true);
            await page.keyboard.type("export");
            await rowCount(page, 1);
            await page.keyboard.press("Escape");
            await rowCount(page, 6);
            await page.locator(".inbox-search-input").waitFor();
            await page.keyboard.press("Escape");
            await page.locator(".inbox-search-input").waitFor({ state: "detached" });
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("inbox-search-toggle") === true), true, "the search put away gives the focus to the button that opened it");

            // a narrowed window is the phone layout with the thread kept, and back: the column's list, drawn again for
            // the wider window, leaves the focus in the composer the reader is typing in
            await page.setViewportSize({ width: 600, height: viewport.height });
            await page.locator("#inbox-back").waitFor();
            assert.equal((await page.locator(".thread-name").textContent())?.replace(/^Claude Code: /, ""), WORKING_TITLE);
            assert.equal(await page.locator(".mode-inbox").count(), 0);
            await page.locator("textarea.composer-text").first().click();
            await page.waitForFunction(() => document.activeElement?.classList.contains("composer-text") === true);
            await page.setViewportSize(viewport);
            await page.locator(".thread-chip").waitFor();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("composer-text") === true), true, "a list drawn again for a wider window takes no focus from the composer");
            await addressIs(page, { app: "inbox", pane: WORKING }, "a window narrowed and widened keeps the thread");

            // Back from a thread is the list with no agent chosen; Back to Ovis at the foot opens the thread's pane in classic
            await page.goBack();
            await page.locator(".inbox-unchosen").waitFor();
            assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0);
            await page.goForward();
            await page.locator(".thread-chip").waitFor();
            assert.equal((await page.locator(".inbox-exit").textContent())?.trim(), "Back to Ovis");
            await page.locator(".inbox-exit").click();
            await page.locator(".app-header.is-zoned").waitFor();
            await page.locator("#workspace-drawer").waitFor();
            assert.equal(await page.locator(".mode-inbox").count(), 0);
            await addressIs(page, { app: null, pane: WORKING }, "Back to Ovis at the column's foot opens the thread's pane in the classic app");
            await page.locator("#workspace-drawer .inbox-foot-entry").click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
            pass(viewport.width === 1440 ? 24 : 25, `at ${at}: entered from More, the column is classic's sidebar (${column.w}px) and the pane classic's (${pane.w}px); 34px round controls on one centre line with the chip, 56px rows 4px apart with the open one current, the lane and the composer on one column; another row takes the thread's entry; the terminal is classic's size (${Math.round(terminal.w)} by ${Math.round(terminal.h)}); each side has its own More and neither counts who waits; a narrowed window keeps the thread; Back to Ovis at the foot and the sidebar's foot row lead out and in`);
          }, viewport);
        }

        if (errors.length > 0) {
          failures.push(block("page errors"));
          console.log(`FAIL ${block("page errors")}: ${errors.join("; ")}`);
          errors.length = 0;
        } else pass(26, "no page error");
      }
      // ---- no terminal is sized by the mode ----
      // A pane that shows its terminal is covered by the mode's list and shown again: nothing is sent to its pty and
      // its terminal keeps its box. On a wide window whose classic sidebar is collapsed the list's column would
      // narrow the pane, and on every one the list takes the shell's bars away.
      const terminalAt = `/?pane=${encodeURIComponent(BLOCKED)}&view=terminal`;
      for (const setup of [
        { name: "a phone", viewport: PHONE, path: terminalAt },
        { name: "a wide window", viewport: { width: 1440, height: 900 }, path: terminalAt },
        { name: "a wide window with the classic sidebar collapsed", viewport: { width: 1440, height: 900 }, path: `${terminalAt}&sidebar=hidden` },
      ]) {
        await withPage(browser, base, { language: "en", theme: "light" }, setup.path, `the mode sizes no terminal on ${setup.name}`, async (page) => {
          const wide = setup.viewport.width >= 769;
          const terminal = ".terminal-stack:not(.is-chat) .pane-terminal";
          const sized = (): Promise<Window["inboxFixture"]["resizes"]> => page.evaluate(() => window.inboxFixture.resizes.slice());
          await page.locator(".app-header.is-zoned").waitFor();
          const classic = await terminalBox(page);
          if (setup.path.endsWith("sidebar=hidden")) assert.equal(classic.x, 0, "the classic sidebar is collapsed: the pane begins at the window's edge");
          // fixed wait: the page's own first sizing of the pane has gone out
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          const before = (await sized()).length;

          // into the mode: its list covers the pane
          if (wide) {
            await page.locator(".header-more-button").click();
            await page.locator('.row-menu [data-item="enter-inbox"]').click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
          } else await enterFromMore(page);
          await rowCount(page, 6);
          await paneHiddenUnderList(page, "the pane is mounted under the list, hidden");
          // fixed wait: no size may be sent for the pane under the list
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          assert.deepEqual((await sized()).slice(before), [], "the list over the pane sends its pty no size");
          sameBox(await box(page, terminal), classic, "under the list the terminal keeps the box it had");

          // out again from the list: the pane is shown as it was
          if (wide) await page.locator(".inbox-exit").click();
          else {
            await openSheet(page, ".inbox-more");
            await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
          }
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator(".app-header.is-zoned").waitFor();
          if (!wide) await sheetClosed(page);
          // fixed wait: no size may be sent for the pane shown again in the box it had
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          assert.deepEqual((await sized()).slice(before), [], "leaving the mode sends the pane's pty no size");
          sameBox(await terminalBox(page), classic, "back in the classic app the terminal has the box it had");
          console.log(`PASS the mode sizes no terminal on ${setup.name}: entered and left with the pane showing its terminal (${Math.round(classic.w)} by ${Math.round(classic.h)}), its pty is sent no size and its box stays`);
        }, setup.viewport);
      }

      // ---- a split under the list: every pane stays where classic left it, attached, sizing nothing ----
      // A classic split's halves (restored from the session, each its own pane) and a tab herdr split (two panes in
      // one canvas) are covered by the list with each pane still mounted in the box it had: entering the mode and
      // leaving it from the list detach no terminal and attach none again, and send no size and no release, for any
      // pane, whether it held the pty's size or had let it go.
      for (const setup of [
        { name: "a classic split", path: `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, split: { other: { machineId: "local", paneId: BLOCKED }, bSide: "right", active: "a" }, panes: 2 },
        { name: "a tab herdr split", path: `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, split: null, panes: 2 },
      ]) {
        await withPage(browser, base, { language: "en", theme: "light" }, setup.path, `a split under the list: ${setup.name}`, async (page) => {
          const frames = (): Promise<Window["inboxFixture"]["frames"]> => page.evaluate(() => window.inboxFixture.frames.slice());
          /** each drawn pane's terminal screen, by pane: its box is its grid of cells */
          const screens = (): Promise<Record<string, Box>> => page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-layout-pane]")].flatMap((frame) => {
            const screen = frame.querySelector(".xterm-screen");
            if (!screen) return [];
            const box = screen.getBoundingClientRect();
            return box.width > 0 ? [[frame.getAttribute("data-layout-pane"), { x: box.x, y: box.y, w: box.width, h: box.height, right: box.right, bottom: box.bottom }]] : [];
          })));
          if (setup.split !== null) {
            // the split is the page's own, restored from the session: the reload reads it
            await page.evaluate((split) => sessionStorage.setItem("ovis:split", JSON.stringify(split)), setup.split);
            await page.reload();
          }
          await page.locator(".app-header.is-zoned").waitFor();
          if (setup.split === null) {
            await page.keyboard.press("Control+Shift+K");
            await page.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Split pane right");
            await page.getByRole("option", { name: "Split pane right", exact: true }).click();
          }
          await page.waitForFunction((count) => [...document.querySelectorAll("[data-layout-pane] .xterm-screen")].filter((screen) => screen.getBoundingClientRect().width > 0).length === count, setup.panes, { timeout: 15_000 });
          // fixed wait: the new pane's own attach and first sizing have gone out
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          const classic = await screens();
          const panes = Object.keys(classic);
          assert.equal(panes.length, setup.panes, `classic draws the split's ${setup.panes} terminals: ${panes.join(", ")}`);
          const before = (await frames()).length;

          await page.locator(".header-more-button").click();
          await page.locator('.row-menu [data-item="enter-inbox"]').click();
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await paneHiddenUnderList(page, "the split's panes are mounted under the list, hidden");
          assert.deepEqual(Object.keys(await screens()).sort(), [...panes].sort(), "every pane of the split is still mounted under the list");
          // fixed wait: nothing may be sent for a pane under the list
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          assert.deepEqual((await frames()).slice(before), [], "entering the mode detaches no terminal, attaches none and sends no size or release");

          await page.locator(".inbox-exit").click();
          await page.locator(".mode-inbox").waitFor({ state: "detached" });
          await page.locator(".app-header.is-zoned").waitFor();
          // fixed wait: nothing may be sent for a split shown again as it was
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          assert.deepEqual((await frames()).slice(before), [], "leaving the mode from the list detaches no terminal, attaches none and sends no size or release");
          const after = await screens();
          for (const pane of panes) sameBox(after[pane] ?? { x: -1, y: -1, w: -1, h: -1, right: -1, bottom: -1 }, classic[pane]!, `the split's pane ${pane} has the box, and the grid, it had`);
          console.log(`PASS ${setup.name} under the list: its ${panes.length} panes stay mounted, and entering the mode and leaving it from the list send no attach, detach, size or release; each pane keeps its grid`);
        }, { width: 1440, height: 900 });
      }

      // ---- a tab herdr split through a thread's terminal and back ----
      // The thread draws its pane alone and the tab's other pane, hidden, lets the pty's size go; Back puts the list over
      // both again, and Back to Ovis gives the other pane the hold it had before the mode: it asks once for the grid it
      // held, as leaving straight from the thread does.
      await withPage(browser, base, { language: "en", theme: "light" }, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, "a tab herdr split through a thread's terminal and back", async (page) => {
        await page.locator(".app-header.is-zoned").waitFor();
        await page.keyboard.press("Control+Shift+K");
        await page.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Split pane right");
        await page.getByRole("option", { name: "Split pane right", exact: true }).click();
        await page.waitForFunction(() => [...document.querySelectorAll("[data-layout-pane] .xterm-screen")].filter((screen) => screen.getBoundingClientRect().width > 0).length === 2, undefined, { timeout: 15_000 });
        // fixed wait: the new pane's own attach and first sizing have gone out
        await page.waitForTimeout(NO_RESIZE_WAIT_MS);
        const other = await page.evaluate((working) => [...document.querySelectorAll("[data-layout-pane]")].map((frame) => frame.getAttribute("data-layout-pane")).find((pane) => pane !== null && pane !== working) ?? "", WORKING);
        // the grid the other pane holds in classic: the last size it asked for, by its attach or a resize
        const held = (await page.evaluate(() => window.inboxFixture.frames.slice())).filter((frame) => frame.pane === other && (frame.type === "attach" || frame.type === "resize")).at(-1);
        assert.ok(other !== "" && held !== undefined, `the tab's other pane (${other}) holds the pty's size in classic`);
        await page.locator(".header-more-button").click();
        await page.locator('.row-menu [data-item="enter-inbox"]').click();
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await row(page, WORKING).click();
        await page.locator(".thread-chip").waitFor();
        await page.locator(".thread-top .lens-toggle").click();
        await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
        await page.goBack();
        await page.locator(".inbox-unchosen").waitFor();
        // fixed wait: what the thread and the list's return send has gone out
        await page.waitForTimeout(NO_RESIZE_WAIT_MS);
        const before = await page.evaluate(() => window.inboxFixture.frames.length);
        await page.locator(".inbox-exit").click();
        await page.locator(".mode-inbox").waitFor({ state: "detached" });
        await page.locator(".app-header.is-zoned").waitFor();
        // fixed wait: the panes shown again have asked for what they ask for
        await page.waitForTimeout(NO_RESIZE_WAIT_MS);
        const sent = (await page.evaluate((count) => window.inboxFixture.frames.slice(count), before)).filter((frame) => frame.pane === other);
        assert.deepEqual(sent, [{ type: "resize", pane: other, cols: held!.cols, rows: held!.rows }], `leaving, the tab's other pane asks once for the grid it held before the mode (${held!.cols} by ${held!.rows})`);
        console.log(`PASS a tab herdr split through a thread's terminal and Back: Back to Ovis gives the tab's other pane (${other}) its hold back at ${held!.cols} by ${held!.rows}, asked once`);
      }, { width: 1440, height: 900 });

      // ---- a classic split's thread is one pane at the pane area's width ----
      // Entered from a classic split, a row's thread is drawn at the whole pane area's width, not at the half's
      // rectangle the slot had in classic, and its terminal is sized to that box.
      await withPage(browser, base, { language: "en", theme: "light" }, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, "a classic split's thread at the pane area's width", async (page) => {
        await page.evaluate((other) => sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: other }, bSide: "right", active: "a" })), BLOCKED);
        await page.reload();
        await page.locator(".app-header.is-zoned").waitFor();
        await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, undefined, { timeout: 15_000 });
        // fixed wait: the halves' own attach and first sizing have gone out
        await page.waitForTimeout(NO_RESIZE_WAIT_MS);
        const half = await page.evaluate((pane) => window.inboxFixture.frames.filter((frame) => frame.pane === pane && (frame.type === "attach" || frame.type === "resize")).at(-1)!, WORKING);
        await page.locator(".header-more-button").click();
        await page.locator('.row-menu [data-item="enter-inbox"]').click();
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await rowCount(page, 6);
        await row(page, WORKING).click();
        await page.locator(".thread-chip").waitFor();
        await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1, undefined, { timeout: 5_000 });
        const [slot, area] = await Promise.all([box(page, ".pane-slot"), box(page, ".pane-split")]);
        sameBox(slot, area, "the thread's slot is the pane area's box");
        const before = (await page.evaluate(() => window.inboxFixture.frames.length));
        await page.locator(".thread-top .lens-toggle").click();
        await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
        const thread = await terminalBox(page);
        near(thread.w, area.w, 1, "the thread's terminal is as wide as the pane area");
        await page.waitForFunction((count) => window.inboxFixture.frames.slice(count).some((frame) => frame.type === "resize"), before, { timeout: 10_000 });
        const asked = await page.evaluate((count) => window.inboxFixture.frames.slice(count).filter((frame) => frame.type === "resize").at(-1)!, before);
        assert.equal(asked.pane, WORKING, "the thread's pane is the one sized");
        assert.ok(asked.cols! > half.cols! * 1.8, `the grid asked for is the whole area's: ${asked.cols} columns, the half had ${half.cols}`);
        console.log(`PASS a row's thread opened from a classic split is drawn at the pane area's width (${Math.round(area.w)}px) and its terminal sized to it (${asked.cols} by ${asked.rows})`);
      }, { width: 1440, height: 900 });

      // ---- a classic split through a thread and back ----
      // A row's thread takes the split's other half off the page; Back mounts it again under the list (it attaches once
      // more, keeping the pty's size) held at its classic box, and the mode left from there sends no size or release.
      // The app's own split, made as a user makes it (a sidebar row dropped on the pane area's right side, whose half is
      // then the active one), through the row of either half: the half that shows the row's pane takes the pick, so
      // each half shows its own pane at the end and none keeps another's mounted hidden.
      for (const opened of [WORKING, BLOCKED]) {
      await withPage(browser, base, { language: "en", theme: "light" }, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, `a classic split through a thread of ${opened} and back`, async (page) => {
        /** the pane frames each half of the split holds, by its slot */
        const halves = (): Promise<Record<string, string>> => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".pane-slot")].map((slot) => [slot.getAttribute("data-slot"), [...slot.querySelectorAll("[data-layout-pane]")].map((frame) => `${frame.getAttribute("data-layout-pane")}${frame.classList.contains("is-hidden") ? " (hidden)" : ""}`).join(" + ")])));
        await page.locator(".app-header.is-zoned").waitFor();
        const area = page.locator(".pane-split");
        const areaBox = (await area.boundingBox())!;
        const right = { clientX: areaBox.x + areaBox.width * 0.75, clientY: areaBox.y + areaBox.height / 2 };
        const data = await page.evaluateHandle(() => new DataTransfer());
        await page.locator(`.pane-select[title^="${BLOCKED} —"]`).dispatchEvent("dragstart", { dataTransfer: data });
        await page.locator(".split-drop.is-visible").waitFor({ state: "attached" });
        await area.dispatchEvent("dragover", { dataTransfer: data, ...right });
        await page.locator('.split-drop.is-visible[data-edge="right"]').waitFor({ state: "attached" });
        await area.dispatchEvent("drop", { dataTransfer: data, ...right });
        await data.dispose();
        await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, undefined, { timeout: 15_000 });
        // fixed wait: the halves' own attach and first sizing have gone out
        await page.waitForTimeout(NO_RESIZE_WAIT_MS);
        const classicBoxes = new Map<string, Box>();
        for (const slot of ["a", "b"]) classicBoxes.set(slot, await box(page, `.pane-slot[data-slot="${slot}"]`));
        const classicHalves = await halves();
        assert.deepEqual(classicHalves, { a: WORKING, b: BLOCKED }, "classic draws the split's two halves, each its own pane");
        assert.equal(await page.locator(".pane-slot.is-active").getAttribute("data-slot"), "b", "the dropped half is the active one");
        await page.locator(".header-more-button").click();
        await page.locator('.row-menu [data-item="enter-inbox"]').click();
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await rowCount(page, 6);
        await row(page, opened).click();
        await page.locator(".thread-chip").waitFor();
        const before = await page.evaluate(() => window.inboxFixture.frames.length);
        await page.goBack();
        await page.locator(".inbox-unchosen").waitFor();
        await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2, undefined, { timeout: 5_000 });
        await page.locator(".inbox-exit").click();
        await page.locator(".mode-inbox").waitFor({ state: "detached" });
        await page.locator(".app-header.is-zoned").waitFor();
        // fixed wait: no size or release may be sent for the split shown again
        await page.waitForTimeout(NO_RESIZE_WAIT_MS);
        const sent = (await page.evaluate((count) => window.inboxFixture.frames.slice(count), before)).filter((frame) => frame.type === "resize" || frame.type === "release-size");
        assert.deepEqual(sent, [], "after the Back, nothing sends a size or a release");
        assert.deepEqual(await halves(), classicHalves, "each half shows its own pane, as before the mode, and holds no other");
        for (const [slot, was] of classicBoxes) sameBox(await box(page, `.pane-slot[data-slot="${slot}"]`), was, `half ${slot} has the box it had before the mode`);
        console.log(`PASS a classic split through the thread of ${opened} and Back: each half shows its own pane after Back to Ovis, both halves keep their classic boxes, and nothing sends a size or release`);
      }, { width: 1440, height: 900 });
      }

      // ---- a thread that shows its terminal sizes its pty to the thread's box ----
      // Entering the mode, and leaving it from the list, size nothing (above), and a thread opens on its chat, which
      // sizes nothing either. Showing the terminal there sizes the pty to the thread's box, as showing it after the
      // chat or hiding the sidebar does in the classic app. With the classic sidebar collapsed the column stands
      // beside the thread, so that grid is narrower than classic's, and Back to Ovis from the thread asks for
      // classic's again: exactly those two sizes are sent, and none while the list covers the pane.
      await withPage(browser, base, { language: "en", theme: "light" }, `${terminalAt}&sidebar=hidden`, "a thread's terminal is sized to the thread's box", async (page) => {
        const sized = (): Promise<Window["inboxFixture"]["resizes"]> => page.evaluate(() => window.inboxFixture.resizes.slice());
        /** the sizes sent after the first `count`, once one has come */
        const sizedAfter = async (count: number, what: string): Promise<Window["inboxFixture"]["resizes"]> => {
          const came = await page.waitForFunction((sent) => window.inboxFixture.resizes.length > sent, count, { timeout: 10_000 }).then(() => true, () => false);
          assert.ok(came, `${what}: no size was sent to the pane's pty`);
          // fixed wait: no second size may follow the one that came
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          return (await sized()).slice(count);
        };
        /** how wide the shown terminal's screen is: as many cells as its grid has columns */
        const screenWidth = (): Promise<number> => page.locator(".terminal-stack:not(.is-chat) .pane-terminal .xterm-screen").evaluate((node) => node.getBoundingClientRect().width);
        await page.locator(".app-header.is-zoned").waitFor();
        const classic = await terminalBox(page);
        assert.equal(classic.x, 0, "the classic sidebar is collapsed: the pane begins at the window's edge");
        // fixed wait: the page's own first sizing of the pane has gone out
        await page.waitForTimeout(NO_RESIZE_WAIT_MS);
        const atLoad = await sized();
        // the grid the classic app sized the pane's pty to as the page loaded: the attach carries it, and a resize
        // follows only where the terminal was fitted after the attach went out
        const loaded = await page.evaluate((pane) => window.inboxFixture.frames.filter((frame) => frame.pane === pane && (frame.type === "attach" || frame.type === "resize")).at(-1) ?? null, BLOCKED);
        assert.ok(loaded?.cols !== undefined && loaded.rows !== undefined, "the classic app attached the pane with its grid as the page loaded");
        const grid = { pane: BLOCKED, cols: loaded.cols, rows: loaded.rows };
        const cell = await screenWidth() / grid.cols;
        const before = atLoad.length;

        // into the mode, and the pane's row: the list over the pane, then its thread on the chat, size nothing
        await page.locator(".header-more-button").click();
        await page.locator('.row-menu [data-item="enter-inbox"]').click();
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await rowCount(page, 6);
        await paneHiddenUnderList(page, "the pane is mounted under the list, hidden");
        // fixed wait: no size may be sent for the pane under the list
        await page.waitForTimeout(NO_RESIZE_WAIT_MS);
        assert.deepEqual((await sized()).slice(before), [], "the list over the pane sends its pty no size");
        await row(page, BLOCKED).click();
        await page.locator(".thread-chip").waitFor();
        // fixed wait: no size may be sent for a thread that shows its chat
        await page.waitForTimeout(NO_RESIZE_WAIT_MS);
        assert.deepEqual((await sized()).slice(before), [], "a thread opened on its chat sends its pty no size");

        // the monitor button shows the terminal beside the column: one size, the thread's
        await page.locator(".thread-top .lens-toggle").click();
        await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
        const thread = await terminalBox(page);
        const column = await box(page, ".inbox-column");
        near(thread.w, classic.w - column.w, 1, "the thread's terminal is narrower than classic's by the column");
        const shown = await sizedAfter(before, "the terminal shown in the thread");
        const threadGrid = { pane: BLOCKED, cols: Math.round(await screenWidth() / cell), rows: grid.rows };
        assert.ok(threadGrid.cols < grid.cols, `the thread's grid has fewer columns than classic's: ${threadGrid.cols}, classic ${grid.cols}`);
        assert.deepEqual(shown, [threadGrid], "showing the terminal in the thread asks once, for the grid the thread draws");

        // Back to Ovis from that thread: one size, classic's again
        await page.locator(".inbox-exit").click();
        await page.locator(".mode-inbox").waitFor({ state: "detached" });
        await page.locator(".app-header.is-zoned").waitFor();
        assert.deepEqual(await sizedAfter(before + 1, "the classic app after the thread"), [grid], "Back to Ovis from the thread asks once, for classic's grid");
        sameBox(await terminalBox(page), classic, "back in the classic app the terminal has the box it had");
        console.log(`PASS with the classic sidebar collapsed, a thread's terminal is sized to the thread's box (${threadGrid.cols} by ${threadGrid.rows}) when the monitor button shows it and to classic's (${grid.cols} by ${grid.rows}) on Back to Ovis; the list over the pane and the thread's chat send no size`);
      }, { width: 1440, height: 900 });

      // ---- where a phone that starts in the inbox stays ----
      const phoneOn: Settings = { language: "en", theme: "light", phoneInbox: true };
      await withPage(browser, base, phoneOn, "/", "a phone that starts in the inbox and went back to Ovis", async (page) => {
        await listScreen(page);
        await openSheet(page, ".inbox-more");
        await page.locator('.row-sheet [data-item="exit-inbox"]').tap();
        await page.locator(".mode-inbox").waitFor({ state: "detached" });
        await page.locator("#drawer-toggle").waitFor();
        await sheetClosed(page);
        await addressIs(page, { app: null }, "Back to Ovis leaves the mode's address");
        // the list's More went with the mode: the focus is on the classic header's drawer toggle, not nowhere
        await page.waitForFunction(() => document.activeElement?.id === "drawer-toggle", undefined, { timeout: 5_000 });
        await page.reload();
        await page.locator("#drawer-toggle").waitFor();
        await page.locator(".context-title-text").waitFor();
        assert.equal(await page.locator(".mode-inbox").count(), 0, "a reload of the classic app the phone went back to does not start the mode again");
        await addressIs(page, { app: null }, "the reloaded address is still the classic app's");
        console.log("PASS with Start in the agent inbox on a phone on, a phone that went Back to Ovis is still in the classic app after a reload");
      });

      // ---- the focus after Back to Ovis ----
      const light: Settings = { language: "en", theme: "light" };
      const desktop = { width: 1440, height: 900 };
      await withPage(browser, base, light, "/?app=inbox", "the focus after Back to Ovis on a wide window", async (page) => {
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await rowCount(page, 6);
        await row(page, WORKING).click();
        await page.locator(".thread-chip").waitFor();
        await page.locator(".inbox-exit").click();
        await page.locator(".mode-inbox").waitFor({ state: "detached" });
        await page.locator(".app-header.is-zoned").waitFor();
        // the foot's button went with the column: the focus is on the classic header's sidebar toggle
        await page.waitForFunction(() => document.activeElement?.classList.contains("sidebar-toggle") === true, undefined, { timeout: 5_000 });
        console.log("PASS Back to Ovis leaves the focus on the classic header's toggle: the drawer's on a phone, the sidebar's on a wide window");
      }, desktop);

      // ---- the focus when the keyboard opens a row on a phone's layout ----
      // The thread takes the list off the screen, and the row that had the focus with it. Under a coarse pointer the
      // focus goes to the thread's Back, which raises no keyboard; under a fine one (a narrow desktop window) the
      // pane the row picked takes the typing, as on a wide window.
      for (const [pointer, viewport, touch] of [["coarse", PHONE, true], ["coarse", { width: 430, height: 932 }, true], ["fine", { width: 430, height: 900 }, false]] as const) {
        await withPage(browser, base, light, "/?app=inbox", `the focus after Enter on a row, at ${viewport.width} under a ${pointer} pointer`, async (page) => {
          await listScreen(page);
          await rowCount(page, 6);
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), touch, `the pointer is ${pointer}`);
          await row(page, WORKING).focus();
          await page.keyboard.press("Enter");
          await page.locator("#inbox-back").waitFor();
          await page.locator(".thread-title").waitFor();
          const landed = await page.waitForFunction((coarse) => coarse ? document.activeElement?.id === "inbox-back" : document.activeElement?.classList.contains("composer-text") === true, touch, { timeout: 5_000 }).then(() => true, () => false);
          const at = await page.evaluate(() => `${document.activeElement?.tagName.toLowerCase()}${document.activeElement?.id ? `#${document.activeElement.id}` : ""}.${document.activeElement?.className}`);
          assert.ok(landed, `the focus is in the thread, on ${touch ? "its Back button" : "the composer"}: it is on ${at}`);
          console.log(`PASS at ${viewport.width} under a ${pointer} pointer, Enter on a row opens its thread with the focus on ${touch ? "the header's Back" : "the composer"}`);
        }, viewport, touch);
      }

      // the same rule where the mode was entered from the classic app and the row opened is the pane classic showed:
      // no new pick, the row leaves with the list, and the focus still goes to the composer or to Back by the pointer
      for (const [pointer, viewport, touch] of [["fine", { width: 480, height: 900 }, false], ["coarse", PHONE, true]] as const) {
        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat`, `the focus after Enter on the row of the pane classic showed, at ${viewport.width} under a ${pointer} pointer`, async (page) => {
          const press = (selector: string) => touch ? page.locator(selector).tap() : page.locator(selector).click();
          await page.locator(".app-header.is-zoned").waitFor();
          await press(".header-more-button");
          await press('.row-sheet [data-item="enter-inbox"]');
          await sheetClosed(page);
          await listScreen(page);
          await rowCount(page, 6);
          await row(page, WORKING).focus();
          await page.keyboard.press("Enter");
          await page.locator("#inbox-back").waitFor();
          const inThread = (coarse: boolean) => coarse ? document.activeElement?.id === "inbox-back" : document.activeElement?.classList.contains("composer-text") === true;
          const landed = await page.waitForFunction(inThread, touch, { timeout: 5_000 }).then(() => true, () => false);
          // fixed wait: nothing takes the focus away again
          await page.waitForTimeout(NO_RESIZE_WAIT_MS);
          const at = await page.evaluate(() => `${document.activeElement?.tagName.toLowerCase()}#${document.activeElement?.id}.${document.activeElement?.className}`);
          assert.ok(landed && await page.evaluate(inThread, touch), `the focus is on ${touch ? "the thread's Back" : "the composer"} and stays: it is on ${at}`);
          console.log(`PASS entered from the classic app at ${viewport.width} under a ${pointer} pointer, Enter on the row of the pane classic showed puts the focus on ${touch ? "the thread's Back" : "the composer"}`);
        }, viewport, touch);
      }

      // ---- a pane the list covered, opened by its own row ----
      // The pane the classic app showed stays mounted under the list, and its own row opens it with no new pick: it is
      // the selection already. It followed its transcript's end as the list covered it, so it stands at that end under
      // the list and, shown as a thread, at its end with no Jump to latest: by Enter as by a press, after another
      // agent's thread and Back, and again after Back and the same row.
      for (const lane of [
        { at: "390 under a coarse pointer", viewport: PHONE, touch: true, acts: ["Enter"] },
        { at: "390 under a coarse pointer", viewport: PHONE, touch: true, acts: ["press"] },
        { at: "390 under a coarse pointer", viewport: PHONE, touch: true, acts: ["another", "press"] },
        { at: "480 under a fine pointer", viewport: { width: 480, height: 900 }, touch: false, acts: ["Enter"] },
        { at: "480 under a fine pointer", viewport: { width: 480, height: 900 }, touch: false, acts: ["press"] },
        { at: "1440", viewport: desktop, touch: false, acts: ["press", "press"] },
      ] as const) {
        const wide = lane.viewport.width >= 769;
        const what = `the transcript's end as the pane classic showed is opened by its own row (${lane.acts.join(", Back, ")}), at ${lane.at}`;
        await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat`, what, async (page) => {
          const press = (target: ReturnType<typeof row>) => lane.touch ? target.tap() : target.click();
          const view = `[data-layout-pane="${WORKING}"] .chat-view`;
          /** how far short of its end the transcript stands, and how many of the chat's controls for its end are drawn */
          const transcript = () => page.evaluate((selector) => {
            const node = document.querySelector<HTMLElement>(selector);
            const drawn = [...document.querySelectorAll(".chat-new-messages")].filter((control) => control.getClientRects().length > 0 && getComputedStyle(control).visibility === "visible");
            return node === null ? null : { short: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop), controls: drawn.map((control) => control.getAttribute("aria-label") ?? control.textContent) };
          }, view);
          /** the transcript has its rows and stands at its end */
          const atEnd = () => page.waitForFunction((selector) => {
            const node = document.querySelector<HTMLElement>(selector);
            return node !== null && node.querySelector("[data-chat-row]") !== null && node.clientHeight > 0 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
          }, view, { timeout: 5_000 }).then(() => true, () => false);
          await page.locator(".app-header.is-zoned").waitFor();
          // the demo ends the agent's turn on its own a few seconds in (the fixture holds its state): its last words are in
          // the transcript before the list covers it, so nothing grows it while it is read
          await page.waitForFunction((selector) => document.querySelector(selector)?.textContent?.includes("6 tests pass") === true, view, { timeout: 15_000 });
          assert.ok(await atEnd(), "the classic app's chat follows its transcript's end");
          await press(page.locator(".header-more-button"));
          if (wide) {
            await page.locator('.row-menu [data-item="enter-inbox"]').click();
            await page.locator(".inbox-column .mode-inbox").waitFor();
          } else {
            await page.locator(".row-sheet").waitFor();
            await press(page.locator('.row-sheet [data-item="enter-inbox"]'));
            await sheetClosed(page);
            await listScreen(page);
          }
          await rowCount(page, 6);
          await frames(page);
          const covered = await transcript();
          assert.ok(covered !== null && covered.short <= 1, `under the list the transcript stands at its end: ${JSON.stringify(covered)}`);
          let opened = 0;
          for (const [index, act] of lane.acts.entries()) {
            if (index > 0) {
              await page.goBack();
              if (wide) await page.locator(".inbox-unchosen").waitFor(); else await listScreen(page);
              await rowCount(page, 6);
            }
            const pane = act === "another" ? BLOCKED : WORKING;
            if (act === "Enter") { await row(page, pane).focus(); await page.keyboard.press("Enter"); }
            else await press(row(page, pane));
            await page.locator(wide ? ".thread-chip" : "#inbox-back").waitFor();
            await addressIs(page, { app: "inbox", pane }, "the row's thread is drawn");
            if (pane !== WORKING) continue;
            opened += 1;
            const reached = await atEnd();
            // fixed wait: nothing moves the transcript or draws a control for its end later
            await page.waitForTimeout(NO_RESIZE_WAIT_MS);
            const shown = await transcript();
            assert.ok(reached && shown !== null && shown.short <= 1 && shown.controls.length === 0, `opened by ${act} (${opened}), the thread's transcript is at its end with no Jump to latest: ${JSON.stringify(shown)}`);
          }
          console.log(`PASS ${what}: under the list and in each thread at its end, with no Jump to latest`);
        }, lane.viewport, lane.touch);
      }

      // ---- the band over a shown terminal under a finger, on a wide window ----
      // Where classic has no status bar (a finger), the band over a thread's terminal is the classic header's height:
      // the thread's controls in it take the header's own touch size and sit on its middle, as classic's header
      // controls do in that band, rather than from the window's top edge down over the terminal.
      await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=terminal`, "the thread's controls in the band over its terminal under a coarse pointer at 1440", async (page) => {
        assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the pointer is coarse");
        await page.locator(".app-header.is-zoned").waitFor();
        await page.locator(".header-more-button").click();
        await page.locator('[data-item="enter-inbox"]').first().click();
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await row(page, WORKING).click();
        await page.locator(".thread-chip").waitFor();
        await page.locator(".thread-top .lens-toggle").click();
        await page.locator('.thread-top .lens-toggle[data-view="terminal"]').waitFor();
        const band = await box(page, ".thread-top");
        const [header, touch] = await page.evaluate(() => ["--header-h", "--touch-target-header"].map((name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)))) as [number, number];
        near(band.h, header, 0.5, "the band is the classic header's height");
        for (const control of [".thread-top .lens-toggle", ".thread-top .header-more-button", ".thread-chip"]) {
          const at = await box(page, control);
          near(at.h, touch, 0.5, `${control} takes the header's touch size`);
          near(at.y + at.h / 2, band.y + band.h / 2, 0.5, `${control} sits on the band's middle`);
        }
        console.log(`PASS under a coarse pointer at 1440 the thread's controls over its terminal are the header's touch size (${touch}px) on the middle of the ${band.h}px band`);
      }, { width: 1440, height: 900 }, true);

      // ---- the command palette from the mode's More ----
      await withPage(browser, base, light, "/?app=inbox", "the command palette from the list's More", async (page) => {
        await listScreen(page);
        await rowCount(page, 6);
        await openSheet(page, ".inbox-more");
        assert.equal((await page.locator('.row-sheet [data-item="palette"] .row-sheet-label').textContent())?.trim(), "Search panes and actions");
        await page.locator('.row-sheet [data-item="palette"]').tap();
        await page.locator(".command-palette").waitFor();
        await page.locator(".row-sheet").waitFor({ state: "detached" });
        assert.equal(await page.locator(".mode-inbox").count(), 1, "the palette opens over the list");
        // the system Back puts the palette away and the list is the screen again
        await page.goBack();
        await page.locator(".command-palette").waitFor({ state: "detached" });
        await listScreen(page);
        console.log("PASS Search panes and actions in the list's More opens the command palette over the list on a phone, and Back closes it");
      });

      // ---- the first paint of a cold load ----
      // The address says the mode at the first render: what the page draws before it has connected is the mode's
      // own shell, never the classic header or sidebar. Every shell the page commits is noted from the document's
      // start: a commit is all a frame can paint.
      for (const viewport of [PHONE, desktop]) {
        const at = viewport.width >= 769 ? "a wide window" : "a phone";
        await withPage(browser, base, light, "/?app=inbox", `the first paint of the mode's own address on ${at}`, async (page) => {
          await page.context().addInitScript(() => {
            const shells: string[] = [];
            window.inboxShells = shells;
            const note = (): void => {
              const root = document.getElementById("root");
              if (!root || root.childElementCount === 0) return;
              const has = (selector: string): boolean => root.querySelector(selector) !== null;
              const shell = has(".boot") ? "boot" : `${has(".app.is-inbox") ? "mode" : "classic"}${has(".app-header") ? " with a header" : ""}${has(".sidebar:not(.inbox-column)") ? " with the sidebar" : ""}`;
              if (shells.at(-1) !== shell) shells.push(shell);
            };
            new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
          });
          const cold = await page.context().newPage();
          cold.on("pageerror", (error) => errors.push(`the first paint on ${at}: ${error.message}`));
          try {
            await cold.goto(`${base}/?app=inbox`);
            await cold.locator(".mode-inbox .inbox-item").first().waitFor();
            const shells = await cold.evaluate(() => window.inboxShells);
            assert.deepEqual(shells.filter((shell) => shell !== "boot"), ["mode"], `every shell the page drew is the mode's own: ${shells.join(", then ")}`);
          } finally { await cold.close(); }
          console.log(`PASS a cold load of the mode's own address on ${at} draws the mode's shell from its first paint: no classic header or sidebar`);
        }, viewport);
      }

      // ---- a press is a step past hover on a wide window ----
      for (const theme of ["light", "dark"]) {
        await withPage(browser, base, { language: "en", theme }, "/?app=inbox", `${theme}: a press is a step past hover on a wide window`, async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await row(page, WORKING).click();
          await page.locator(".thread-chip").waitFor();
          /** a token's colour as the browser computes it, and a control's fill once it is that colour */
          const token = (value: string) => page.evaluate((css) => {
            const probe = document.createElement("span");
            probe.style.background = css;
            document.querySelector(".inbox-column")!.append(probe);
            const colour = getComputedStyle(probe).backgroundColor;
            probe.remove();
            return colour;
          }, value);
          const fills = (selector: string, colour: string, what: string) => page.waitForFunction(({ selector, colour }) =>
            getComputedStyle(document.querySelector(selector)!).backgroundColor === colour, { selector, colour }, { timeout: 5_000 }).catch(() => { throw new Error(`${what}: ${selector} is not ${colour}`); });
          const sideHover = await token("var(--side-hover)"), rowPress = await token("color-mix(in srgb, var(--side-selected), var(--border-strong))");
          const hover = await token("var(--bg-hover)"), strong = await token("var(--border-strong)");
          /** a computed colour's three channels, of 255: Chrome writes a mixed colour as color(srgb …), each of 1 */
          const channels = (colour: string): number[] => {
            const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(colour);
            return srgb ? srgb.slice(1, 4).map((value) => Number(value) * 255) : (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          };
          /** how far two colours stand apart: their largest difference in one channel, of 255 */
          const apart = (one: string, other: string): number => {
            const [a, b] = [channels(one), channels(other)];
            return Math.round(Math.max(...a.map((value, at) => Math.abs(value - b[at]!))));
          };
          // a press reads as a press: well past the 7 of 255 a row's press once stood from its hover in light
          for (const [press, over, what] of [[rowPress, sideHover, "a row's"], [strong, hover, "a round control's"]] as const) {
            assert.ok(apart(press, over) >= 15, `${what} press stands ${apart(press, over)} of 255 from its hover (${press} against ${over})`);
          }
          for (const [selector, over, pressed] of [
            [`.mode-inbox .inbox-item[data-pane="${BLOCKED}"] .inbox-row`, sideHover, rowPress],
            [".inbox-exit", sideHover, rowPress],
            [".inbox-column .inbox-search-toggle", hover, strong],
            [".thread-top .header-more-button", hover, strong],
          ] as const) {
            const at = await box(page, selector);
            await page.mouse.move(at.x + at.w / 2, at.y + at.h / 2);
            await fills(selector, over, "under the pointer");
            await page.mouse.down();
            await fills(selector, pressed, "under a press");
            // let go off it: no click lands
            await page.mouse.move(at.x + at.w / 2, 450);
            await page.mouse.up();
          }
          await addressIs(page, { app: "inbox", pane: WORKING }, "no press opened anything");
          console.log(`PASS ${theme}: on a wide window a row and Back to Ovis take the open row's press under a press (${apart(rowPress, sideHover)} of 255 past hover), a round control its strong edge's colour (${apart(strong, hover)} past hover)`);
        }, desktop);
      }

      // ---- a scrollbar that takes room ----
      // Playwright hides Chrome's scrollbars in headless, and overlay scrollbars take no room: this browser keeps
      // Chrome's own, as a mouse user's Chrome on Windows and Linux shows them.
      const withBars = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"], ignoreDefaultArgs: ["--hide-scrollbars"] });
      try {
        await withPage(withBars, base, light, "/?app=inbox", "the column's rows under a scrollbar that takes room", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          const measure = () => page.evaluate(() => {
            const column = document.querySelector(".inbox-column")!.getBoundingClientRect();
            const scroller = document.querySelector<HTMLElement>(".inbox-column .inbox-scroll")!;
            const rows = [...scroller.querySelectorAll(".inbox-row")].map((node) => node.getBoundingClientRect());
            return {
              bar: scroller.offsetWidth - scroller.clientWidth, scrolls: scroller.scrollHeight > scroller.clientHeight, sideways: scroller.scrollWidth - scroller.clientWidth,
              start: rows.map((rect) => rect.left - column.left), end: rows.map((rect) => column.right - rect.right), width: rows.map((rect) => rect.width),
            };
          });
          const tall = await measure();
          assert.deepEqual([tall.scrolls, tall.bar], [false, 0], "six rows do not scroll in a 900px window");
          await page.setViewportSize({ width: desktop.width, height: 400 });
          await page.waitForFunction(() => { const scroller = document.querySelector(".inbox-column .inbox-scroll")!; return scroller.scrollHeight > scroller.clientHeight; });
          const short = await measure();
          assert.ok(short.bar > 0, `this browser's scrollbar takes room: ${short.bar}px`);
          for (const [name, facts] of [["without a scrollbar", tall], ["under a scrollbar", short]] as const) {
            for (const inset of [...facts.start, ...facts.end]) near(inset, 12, 0.5, `a row's inset from the column's edge ${name}`);
          }
          assert.deepEqual(short.width, tall.width, "the rows are as wide under the scrollbar as without it");
          assert.equal(short.sideways, 0, "nothing scrolls sideways");
          console.log(`PASS under a scrollbar that takes room (${short.bar}px) the column's rows keep their 12px insets and their width (${Math.round(tall.width[0]!)}px): the scrollbar stands in the end inset`);
        }, desktop);

        // The column's resize grip is the sidebar's own (SidebarResizer), over the column's edge where its list's
        // scrollbar is drawn: a mouse resting on that scrollbar is let through to it, so a drag on the thumb scrolls the
        // list and leaves the column's width, and the strip beside it, over the pane's edge, still resizes the column.
        await withPage(withBars, base, light, "/?app=inbox", "the column's scrollbar under the resize grip", async (page) => {
          await page.locator(".inbox-column .mode-inbox").waitFor();
          await rowCount(page, 6);
          await page.setViewportSize({ width: desktop.width, height: 400 });
          await page.waitForFunction(() => { const list = document.querySelector<HTMLElement>(".inbox-column .inbox-scroll"); return list !== null && list.scrollHeight > list.clientHeight; });
          const edge = () => page.evaluate(() => {
            const list = document.querySelector<HTMLElement>(".inbox-column .inbox-scroll")!;
            const box = list.getBoundingClientRect();
            const border = parseFloat(getComputedStyle(list).borderRightWidth) || 0;
            const grip = document.querySelector(".inbox-column .sidebar-resizer")!.getBoundingClientRect();
            return {
              top: box.top, right: box.right - border, bar: list.offsetWidth - list.clientWidth - list.clientLeft - border, scrolled: list.scrollTop,
              column: Math.round(document.querySelector(".inbox-column")!.getBoundingClientRect().width), grip: { left: grip.left, right: grip.right },
            };
          });
          /** what a press at (x, y) lands on: the grip, the column's list, or something else */
          const landsOn = (x: number, y: number, want: "grip" | "list") => page.waitForFunction(([px, py, target]) => {
            const element = document.elementFromPoint(px as number, py as number);
            const on = element?.closest(".sidebar-resizer") ? "grip" : element?.closest(".inbox-column .inbox-scroll") ? "list" : "other";
            return on === target;
          }, [x, y, want] as const, { timeout: 5_000 }).then(() => true, () => false);
          const start = await edge();
          assert.ok(start.bar > 0 && start.grip.left < start.right - start.bar, `the grip's box reaches over the list's ${start.bar}px scrollbar (grip from ${start.grip.left}px, scrollbar ${start.right - start.bar}-${start.right}px)`);
          // the thumb, at the top of a list scrolled to its top: the mouse resting on it is let through, and a drag scrolls
          const barX = start.right - start.bar / 2;
          const barY = start.top + start.bar + 10;
          await page.mouse.move(barX - 60, barY);
          await page.mouse.move(barX, barY, { steps: 4 });
          assert.ok(await landsOn(barX, barY, "list"), "a mouse resting on the list's scrollbar under the grip reaches the list");
          await page.mouse.down();
          await page.mouse.move(barX, barY + 60, { steps: 6 });
          await page.mouse.up();
          await page.waitForFunction(() => document.querySelector<HTMLElement>(".inbox-column .inbox-scroll")!.scrollTop > 0, undefined, { timeout: 5_000 });
          const scrolled = await edge();
          assert.equal(scrolled.column, start.column, "dragging the scrollbar leaves the column's width");
          // the strip beside the scrollbar, over the pane's edge: a press there resizes the column
          const stripX = start.right + (start.grip.right - start.right) / 2;
          await page.mouse.move(stripX, barY, { steps: 3 });
          assert.ok(await landsOn(stripX, barY, "grip"), "the strip beside the scrollbar is the grip's");
          await page.mouse.down();
          await page.mouse.move(stripX + 30, barY, { steps: 3 });
          await page.mouse.up();
          await page.waitForFunction((was) => Math.round(document.querySelector(".inbox-column")!.getBoundingClientRect().width) !== was, start.column, { timeout: 5_000 });
          const resized = await edge();
          assert.equal(resized.column, start.column + 30, "the strip beside the scrollbar resizes the column");
          console.log(`PASS the column's list scrollbar (${start.bar}px) under the resize grip scrolls the list by a drag (column stays ${start.column}px), and the strip beside it resizes the column to ${resized.column}px`);
        }, desktop);
      } finally { await withBars.close(); }

      // ---- which waits a row can time ----
      // herdr tells no time of a state change: a wait is timed from when this device saw it begin (the stamps the
      // Agents list reads, lib/agentStateSince.ts), and one no page of the device saw begin from the agent's last
      // message (the summary's time of its last words). The agent that already waited when the page of a fresh device
      // opened draws its last message's time; one that begins to wait while the page is open, in the classic app
      // before the mode is entered, draws its wait's own.
      /** when an agent last spoke, as the summary the rows read says it */
      const lastMessageAt = (page: Page, pane: string): Promise<string | null> => page.evaluate(async (id) => {
        const answer = await (await fetch(`/api/pane/summary?pane_id=${encodeURIComponent(id)}`)).json() as { summaries: Record<string, { at: string | null } | null> };
        return answer.summaries[id]?.at ?? null;
      }, pane);
      /** a row's time is that message's: the list puts the summary's time on this device's clock (the server's offset, a
       *  few ms here, taken out), and a wait's own stamp would be minutes from it */
      const spokeThen = (drawn: string | null | undefined, spoke: string | null): boolean =>
        drawn !== null && drawn !== undefined && spoke !== null && Math.abs(Date.parse(drawn) - Date.parse(spoke)) <= 2_000;
      await withPage(browser, base, light, `/?pane=${encodeURIComponent(DONE)}&view=chat`, "the time of a wait the page saw begin", async (page) => {
        await page.locator(".context-title-text").waitFor();
        const seen = await page.evaluate(() => window.inboxFixture.rosters);
        const began = await page.evaluate(() => Date.now());
        await page.evaluate((pane) => window.inboxFixture.set(pane, "blocked"), WORKING);
        await page.waitForFunction((count) => window.inboxFixture.rosters > count, seen);
        await enterFromMore(page);
        await rowCount(page, 6);
        await page.waitForFunction((pane) => document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"]`)?.getAttribute("data-state") === "blocked", WORKING);
        const waiting = (await rows(page)).filter((item) => item.state === "blocked");
        assert.deepEqual(new Set(waiting.map((item) => item.pane)), new Set([BLOCKED, WORKING]), "two agents wait");
        const own = waiting.find((item) => item.pane === WORKING);
        assert.ok(own?.datetime !== null && own?.datetime !== undefined && Date.parse(own.datetime) >= began - 1_000, `the wait this page saw begin, in the classic app, is timed from its beginning: ${JSON.stringify(own)}`);
        await page.waitForFunction((pane) => document.querySelector(`.mode-inbox .inbox-item[data-pane="${pane}"] time.inbox-time`) !== null, BLOCKED, { timeout: 15_000 });
        const before = (await rows(page)).find((item) => item.pane === BLOCKED);
        const spoke = await lastMessageAt(page, BLOCKED);
        assert.ok(spokeThen(before?.datetime, spoke), `the wait that began before the page opened is timed from the agent's last message (${spoke}): ${JSON.stringify(before)}`);
        console.log(`PASS a row times the wait this page saw begin from its beginning (${own!.time}), and one that began before the page opened from the agent's last message (${before!.time})`);
      });

      // ---- every row has a time on a cold load ----
      // A fresh device opens the list while an agent already waits: no page of it saw the wait begin, so that row is
      // timed from the agent's last message, as a done or ready row is, and no row of the list is without a time.
      await withPage(browser, base, light, "/?app=inbox", "every row's time on a cold load", async (page) => {
        await listScreen(page);
        await rowCount(page, 6);
        const timed = await page.waitForFunction(() => [...document.querySelectorAll(".mode-inbox .inbox-item")].every((item) => item.querySelector("time.inbox-time") !== null), undefined, { timeout: 15_000 }).then(() => true, () => false);
        const drawn = await rows(page);
        assert.ok(timed, `every row draws a time: ${JSON.stringify(drawn.map((item) => [item.pane, item.time]))}`);
        const waiting = drawn.find((item) => item.pane === BLOCKED);
        const spoke = await lastMessageAt(page, BLOCKED);
        assert.ok(waiting?.state === "blocked" && spokeThen(waiting.datetime, spoke), `the waiting row is timed from its last message (${spoke}): ${JSON.stringify(waiting)}`);
        console.log(`PASS on a cold load every row draws a time, the waiting row its last message's (${waiting!.time})`);
      });

      // ---- the list says when the connection is lost ----
      // The line follows the stream that feeds the list's rows, whether or not a pane is mounted under it: entered
      // from a pane, and on a cold load of the mode's own address, where none is.
      for (const [route, path] of [["entered from a pane", `/?pane=${encodeURIComponent(WORKING)}&view=chat&demo_connection=switch`], ["opened cold, no pane mounted", "/?app=inbox&demo_connection=switch"]] as const)
      for (const viewport of [PHONE, desktop]) {
        const wide = viewport.width >= 769;
        const at = `${wide ? "a wide window" : "a phone"}, ${route}`;
        await withPage(browser, base, light, path, `the list while the connection is lost, on ${at}`, async (page) => {
          const line = page.locator(".mode-inbox .inbox-top .inbox-connection");
          if (route === "entered from a pane") {
            // the pane's own connection is up before the list covers it
            await page.locator(".conn-live").waitFor({ state: "attached" });
            if (wide) {
              await page.locator(".header-more-button").click();
              await page.locator('.row-menu [data-item="enter-inbox"]').click();
              await page.locator(".inbox-column .mode-inbox").waitFor();
            } else await enterFromMore(page);
          } else {
            await page.locator(".mode-inbox").waitFor();
            assert.deepEqual([await page.locator(".pane-slot").count(), await page.locator(".conn-live").count()], [0, 0], "a cold load of the list mounts no pane, and no pane's connection says anything");
          }
          await rowCount(page, 6);
          assert.equal(await line.count(), 0, "connected, the list draws no line");
          assert.equal(await page.locator('.mode-inbox .inbox-top [role="status"]').count() >= 1, true, "the status line is in the document before it has a word");
          // the stream that feeds the roster has opened (its first roster came): only a stream that was had can be lost;
          // a cold list draws its rows from the roster's first read, which can come before the stream opens
          await page.waitForFunction(() => window.inboxFixture.rosters > 0, undefined, { timeout: 15_000 });
          // the bridge's connection is lost: the page's sockets, and the stream that feeds the roster
          await page.evaluate(() => { window.herdrDemoLoseConnection(); window.inboxFixture.dropRoster(); });
          await line.waitFor();
          assert.equal(await line.getAttribute("role"), "status", "the line is a status");
          const drawn = await line.evaluate((node) => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            // the two tokens as the browser computes them where the line stands
            const probe = document.createElement("span");
            probe.style.cssText = "color: var(--text-dim); font-size: var(--fs-xs)";
            node.parentElement!.append(probe);
            const want = { color: getComputedStyle(probe).color, size: getComputedStyle(probe).fontSize };
            probe.remove();
            // a round control of the same top row: what the line is drawn like where it floats over the rows
            const control = document.querySelector(".mode-inbox .inbox-top .inbox-round");
            const disc = control?.getBoundingClientRect();
            const surface = (of: CSSStyleDeclaration) => ({ fill: of.backgroundColor, edge: `${of.borderTopWidth} ${of.borderTopStyle} ${of.borderTopColor}`, shadow: of.boxShadow });
            return {
              centre: box.left + box.width / 2, left: box.left, size: style.fontSize, color: style.color, want,
              middle: box.top + box.height / 2, height: box.height, radius: Number.parseFloat(style.borderTopLeftRadius),
              surface: surface(style), round: control ? surface(getComputedStyle(control)) : null, discMiddle: disc ? disc.top + disc.height / 2 : null,
            };
          });
          assert.deepEqual([drawn.color, drawn.size], [drawn.want.color, drawn.want.size], "the line is --text-dim at --fs-xs");
          if (wide) {
            // the column's top row floats over nothing: a plain line, with no surface of its own
            assert.deepEqual([drawn.surface.fill, drawn.surface.shadow], ["rgba(0, 0, 0, 0)", "none"], "in the column the line has no fill and no shadow");
            assert.match(drawn.surface.edge, /^0px /, "in the column the line has no edge");
          } else {
            // over the rows it is a small round pill on the round controls' raised surface, on their centre line
            assert.deepEqual(drawn.surface, drawn.round, "a phone's line is drawn on the round controls' surface: their fill, hairline edge and shadow");
            assert.notEqual(drawn.surface.shadow, "none", "the pill casts the controls' shadow");
            assert.ok(drawn.radius >= drawn.height / 2, `the pill is fully round: a radius of ${drawn.radius} for a height of ${drawn.height}`);
            assert.ok(drawn.discMiddle !== null, "a round control stands in a phone's top row");
            near(drawn.middle, drawn.discMiddle, 0.5, "the pill stands on the round controls' centre line");
          }
          if (wide) near(drawn.left, 16, 1, "the line leads the column's top row");
          else near(drawn.centre, viewport.width / 2, 1, "the line is centred between the two top controls");
          // Connected is said for two seconds: caught in the mutation that draws it, so a slow run cannot miss it. A
          // connection that never comes back fails the step by a deadline, and the page's observer goes either way
          const back = await page.evaluate(() => new Promise<string>((resolve, reject) => {
            const top = document.querySelector(".mode-inbox .inbox-top")!;
            const deadline = window.setTimeout(() => { observer.disconnect(); reject(new Error("the list never said Connected within 15 s")); }, 15_000);
            const observer = new MutationObserver(() => {
              const said = top.querySelector(".inbox-connection")?.textContent ?? "";
              if (said === "Connected") { observer.disconnect(); window.clearTimeout(deadline); resolve(said); }
            });
            observer.observe(top, { subtree: true, childList: true, characterData: true, attributes: true });
            window.herdrDemoRestoreConnection();
            window.inboxFixture.restoreRoster();
            window.dispatchEvent(new Event("online"));
          }));
          assert.equal(back, "Connected", "back, the line says so");
          await line.waitFor({ state: "detached" });
          console.log(`PASS on ${at} the list says Reconnecting… in one quiet line (${wide ? "a plain line leading the column's top row" : "a round pill on the round controls' surface and centre line"}) while the connection is lost, Connected when it is back, and then nothing`);
        }, viewport);
      }

      // ---- one word for a lost connection beside a wide thread ----
      await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat&demo_connection=switch`, "one word for a lost connection beside a wide thread", async (page) => {
        // the pane's own connection is up (the classic header's mark) before the mode is entered and its row opened
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".header-more-button").click();
        await page.locator('.row-menu [data-item="enter-inbox"]').click();
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await rowCount(page, 6);
        await row(page, WORKING).click();
        await page.locator(".thread-chip").waitFor();
        await page.waitForFunction(() => window.inboxFixture.rosters > 0, undefined, { timeout: 15_000 });
        await page.evaluate(() => { window.herdrDemoLoseConnection(); window.inboxFixture.dropRoster(); });
        await page.locator(".thread-chip-state.is-reconnecting").waitFor();
        assert.equal(await page.locator(".inbox-column .inbox-top .inbox-connection").count(), 0, "the column does not say what the thread's chip says");
        console.log("PASS on a wide window a lost connection is said once, by the thread's chip, while the column's word would say the same");
      }, desktop);

      // ---- a list whose load failed ----
      // A cold list whose roster could not be read says so in the app's words and the page's language, with the read's
      // own message smaller under it and a Retry, never Loading… for ever; Retry loads it again.
      for (const [viewport, language] of [[PHONE, "en"], [desktop, "en"], [desktop, "ko"]] as const) {
        const wide = viewport.width >= 769;
        const at = `${wide ? "a wide window" : "a phone"}${language === "en" ? "" : ` in ${language}`}`;
        await withPage(browser, base, { ...light, language }, "/?app=inbox&inbox_fail=roster", `the list whose load failed, on ${at}`, async (page) => {
          const failure = page.locator('.mode-inbox [role="alert"]');
          await failure.waitFor();
          assert.equal(await page.locator(".mode-inbox .inbox-empty").count(), 0, "a failed load is not said to be loading");
          const said = await failure.evaluate((alert) => [".inbox-failed-line", ".inbox-failed-cause"].map((selector) => {
            const line = alert.querySelector(selector);
            return { words: line?.textContent?.trim() ?? "", size: line ? parseFloat(getComputedStyle(line).fontSize) : 0 };
          }));
          const [line, own] = said as [{ words: string; size: number }, { words: string; size: number }];
          assert.equal(line.words, language === "ko" ? KO["Couldn't load the list."] : "Couldn't load the list.", "the failure says what happened in the app's words");
          assert.ok(own.words.length > 0 && own.size < line.size, `the read's own message is under it, smaller (${own.size}px under ${line.size}px)`);
          const cause = own.words;
          const retry = page.locator(".mode-inbox .inbox-failed").getByRole("button");
          assert.equal(await retry.count(), 1, "the failure has one button");
          const ready = await box(page, ".mode-inbox .inbox-retry");
          if (!wide) assert.ok(ready.h >= 44, "Retry is a touch target on a phone");
          // Retry pressed from the keyboard while the roster still fails, its read held on its way: Retry says so in the
          // box it had and keeps the focus through more presses, and the loading words stand where the failure was
          await page.evaluate(() => window.inboxFixture.holdRoster(true));
          await retry.focus();
          await page.keyboard.press("Enter");
          await page.locator('.mode-inbox .inbox-retry[aria-disabled="true"][aria-busy="true"]').waitFor();
          await page.keyboard.press("Enter");
          await retry.click({ force: true });
          const onItsWay = await page.evaluate(() => {
            const button = document.querySelector(".mode-inbox .inbox-retry")!;
            const words = document.querySelector(".mode-inbox .inbox-failed-words")!;
            return {
              focused: document.activeElement === button, busy: button.getAttribute("aria-disabled"),
              said: [...button.querySelectorAll(".inbox-retry-words > span")].filter((span) => getComputedStyle(span).visibility === "visible").map((span) => span.textContent),
              role: words.getAttribute("role"), line: words.querySelector(".inbox-failed-line")?.textContent, message: getComputedStyle(words.querySelector(".inbox-failed-cause")!).visibility,
              alerts: document.querySelectorAll('.mode-inbox [role="alert"]').length,
            };
          });
          assert.deepEqual(onItsWay, { focused: true, busy: "true", said: [language === "ko" ? KO["Retrying…"] : "Retrying…"], role: "status", line: language === "ko" ? KO["Loading…"] : "Loading…", message: "hidden", alerts: 0 },
            "on its way, Retry says so and keeps the focus, and the loading words stand where the failure was");
          sameBox(await box(page, ".mode-inbox .inbox-retry"), ready, "Retry keeps its box while its read is on its way");
          // the read ends with the roster still failing: the failure is said again, and Retry is ready where it was
          await page.evaluate(() => window.inboxFixture.holdRoster(false));
          await page.locator('.mode-inbox .inbox-retry:not([aria-disabled])').waitFor();
          await failure.waitFor();
          sameBox(await box(page, ".mode-inbox .inbox-retry"), ready, "Retry keeps its box once its read has failed");
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("inbox-retry")), true, "the focus is still on Retry");
          // the failure ends and Retry is pressed in one task: no background read can come between, and the read the
          // press makes is counted as it is made
          const asked = await page.evaluate(() => {
            window.inboxFixture.failRoster(false);
            const before = window.inboxFixture.rosterReads;
            document.querySelector<HTMLButtonElement>(".mode-inbox .inbox-retry")!.click();
            return window.inboxFixture.rosterReads - before;
          });
          assert.ok(asked > 0, `Retry asks for the roster (${asked} reads)`);
          await rowCount(page, 6);
          assert.equal(await failure.count(), 0, "loaded, the list has no failure to say");
          // Retry left the page with the focus on it: the list takes it, as when it opens, and the page's body does not
          const focusAt = await page.evaluate(() => { const at = document.activeElement; return at === null || at === document.body ? "the page's body" : `${at.tagName.toLowerCase()}.${String(at.className)}`; });
          assert.equal(await page.evaluate(() => document.activeElement === document.querySelector(".mode-inbox")), true, `the rows drawn, the focus is on the list: it is on ${focusAt}`);
          console.log(`PASS on ${at} a list whose load failed says so in the app's words, its read's message (${cause}) smaller under them, and one Retry, which says it is on its way in the box it had while its read is held, keeps the focus, and loads the rows with the focus on the list`);
          // the language is shared and the demo's follows the browser's: a Korean browser is what makes the page Korean
        }, viewport, viewport.width < 769, language === "ko" ? "ko-KR" : "en-US");
      }

      // ---- entering the mode with a file open over the pane ----
      await withPage(browser, base, light, `/?pane=${encodeURIComponent(WORKING)}&view=chat&file=README.md`, "entering the mode with a file open over the pane", async (page) => {
        await page.locator(".file-viewer").waitFor();
        // the viewer is modal: the palette, which opens over it, is the way in that still answers
        await page.keyboard.press("Control+Shift+K");
        await page.locator(".command-palette .palette-search input").fill(">open agent inbox");
        await page.locator(".command-palette .menu-item-main", { hasText: "Open agent inbox" }).waitFor();
        await page.keyboard.press("Enter");
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await page.locator(".file-viewer").waitFor({ state: "detached" });
        await page.locator(".inbox-unchosen").waitFor();
        assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("file")), null, "the list's address names no file");
        await addressIs(page, { app: "inbox", pane: null }, "the mode opens on its list");
        // the file's own entry is under the mode's: Back shows the pane with its file again
        await page.goBack();
        await page.locator(".file-viewer").waitFor();
        await page.locator(".mode-inbox").waitFor({ state: "detached" });
        assert.equal(await page.evaluate(() => new URLSearchParams(location.search).get("file")), "README.md");
        await addressIs(page, { app: null, pane: WORKING }, "Back returns to the pane the file is open on");
        console.log("PASS entering the mode with a file open over the pane closes the viewer and opens the list; Back shows the pane with its file again");
      }, desktop);

      // ---- the system Back with the pane's More open ----
      await withPage(browser, base, light, "/?app=inbox", "the system Back with the pane's More open in a wide thread", async (page) => {
        await page.locator(".inbox-column .mode-inbox").waitFor();
        await rowCount(page, 6);
        await row(page, WORKING).click();
        await page.locator(".thread-chip").waitFor();
        await page.locator(".thread-top .header-more-button").click();
        await page.locator(".row-menu").waitFor();
        await page.goBack();
        // the thread closed under its More: the list with no agent chosen, and no menu left over it
        await page.locator(".inbox-unchosen").waitFor();
        await page.locator(".row-menu").waitFor({ state: "detached" });
        assert.equal(await page.locator(".inbox-column .inbox-more").getAttribute("aria-expanded"), "false", "the column's More does not claim the menu the pane's More left");
        await addressIs(page, { app: "inbox", pane: null }, "Back from the thread is the list's address");
        console.log("PASS the system Back from a wide thread with the pane's More open closes the menu with its button, and shows the list with no agent chosen");
      }, desktop);

      // ---- an address of the mode whose pane is gone ----
      // A pane that closed in a workspace still open (the classic app opens that workspace's pane in its place), and
      // one whose workspace is gone too (the classic app opens its usual pane): the mode opens the list under the
      // note, never another agent's thread.
      for (const gone of [
        { what: "its workspace still open", path: `/?app=inbox&ws=w1C-checkout-api&pane=${encodeURIComponent("w1C:p9")}&view=chat`, note: "That link's chat is closed" },
        { what: "its workspace closed too", path: `/?app=inbox&pane=${encodeURIComponent("w9Z:p9")}&view=chat`, note: "That link's workspace is closed" },
        // a PC this app does not have: the pane's id means nothing on another PC, and the classic app opens the pane herdr has in front
        { what: "its PC not set up here", path: `/?app=inbox&machine=not-here&pane=${encodeURIComponent(WORKING)}&view=chat`, note: "That link's PC is not set up here" },
      ]) {
        for (const viewport of [PHONE, desktop]) {
          const at = viewport.width >= 769 ? "a wide window" : "a phone";
          await withPage(browser, base, light, gone.path, `a thread's address whose pane is gone, ${gone.what}, on ${at}`, async (page) => {
            await page.locator(".header-note").getByText(gone.note).waitFor();
            await page.locator(".mode-inbox").waitFor();
            await rowCount(page, 6);
            if (viewport.width >= 769) {
              await page.locator(".inbox-unchosen").waitFor();
              assert.equal(await page.locator('.mode-inbox .inbox-row[aria-current="true"]').count(), 0, "no row is the open one");
            } else assert.equal(await page.locator(".app-header").count(), 0, "the list is the screen: no thread's header");
            await addressIs(page, { app: "inbox", pane: null }, "the address is the list's");
            console.log(`PASS an address of the mode whose pane is gone (${gone.what}) opens the list on ${at}, under the note "${gone.note}"`);
          }, viewport);
        }
      }

      if (errors.length > 0) {
        failures.push("page errors after the themes");
        console.log(`FAIL page errors after the themes: ${errors.join("; ")}`);
      }
      assert.deepEqual(failures, [], "every block passes");
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
