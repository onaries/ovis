/**
 * Keys typed right after a New tab choice (the +, the tab list's New terminal, the New tab dialog's Start) reach
 * the new tab, every one and in order, and none the old tab; a Space or Enter typed then opens no second tab.
 * What may not go by itself (a paste, keys typed before the user went elsewhere) is held for review instead.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page, Route } from "playwright-core";
import { paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

type Way = "plus" | "sheet" | "dialog";
type Sent = { type: string; pane_id: string; text?: string; keys?: string[] };
interface Case {
  name: string;
  way: Way;
  viewport: { width: number; height: number };
  touch?: boolean;
  /** the keys, typed right after the choice */
  type: (page: Page) => Promise<void>;
  /** the line the new tab's shell prints, or null when the keys must be held for review */
  ran: string | null;
  /** exactly what the new tab is sent, when it is known */
  sent?: string;
  /** herdr's answer waits until the keys are typed */
  holdCreate?: boolean;
  /** the keys typed on once the new tab takes input: the tab came while the user was still typing */
  typeOn?: (page: Page) => Promise<void>;
}

const desktop = { width: 1280, height: 800 };
const phone = { width: 390, height: 844 };
const MOUSE_REPORT = /^\x1b\[[<M]/;

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(25);
  }
}

function watch(page: Page): { sent: Sent[]; ready: Set<string> } {
  const sent: Sent[] = [];
  const ready = new Set<string>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input" || message.type === "keys") sent.push(message);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input-ready" && message.ready !== false) ready.add(message.pane_id);
    });
  });
  return { sent, ready };
}

const textOf = (sent: Sent[], paneId: string): string => sent.filter((message) => message.pane_id === paneId && !MOUSE_REPORT.test(message.text ?? ""))
  .map((message) => message.text ?? (message.keys ?? []).join("")).join("");
const screenOf = (page: Page, paneId: string) => page.locator(`[data-layout-pane=${JSON.stringify(paneId)}] .xterm-screen`);

async function choose(page: Page, first: string, item: Case, sent: Sent[]): Promise<void> {
  if (item.way === "sheet") {
    // the title's list stands in for the row on a narrow window
    if (item.touch) await page.locator(".app-header .context-tabs").tap(); else await page.locator(".app-header .context-tabs").click();
    sent.length = 0;
    const entry = page.locator(".row-sheet-item", { hasText: "New terminal" });
    if (item.touch) await entry.tap(); else await entry.click();
    return;
  }
  await screenOf(page, first).click();
  if (item.way === "plus") {
    sent.length = 0;
    await page.locator(".tab-strip-add").click();
    return;
  }
  await page.locator('.tab-strip-item.is-active [role="tab"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "New tab with agent…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^New tab/ });
  await dialog.waitFor();
  sent.length = 0;
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
}

async function typeAhead(browser: Browser, origin: string, item: Case): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-newtab-typeahead-")));
  const created = await workspaceCreate({ cwd: root, label: `ovis-test-newtab-${item.name}` });
  const workspaceId = created.workspace.workspace_id;
  const first = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: item.viewport, hasTouch: item.touch === true, isMobile: item.touch === true, locale: "en-US" });
  // the away case clicks the sidebar's Filter field, which is off until chosen (Settings → Sidebar filter)
  await context.addInitScript(() => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })); localStorage.setItem("ovis:sidebar-filter-shown", "true"); });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { sent, ready } = watch(page);
    let held: Route | null = null;
    if (item.holdCreate) await page.route("**/api/**tab/create", (route) => { held = route; });
    await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
    await page.locator(".conn-live").waitFor();
    await until(() => ready.has(first), "the first terminal accepts input");
    await choose(page, first, item, sent);
    await item.type(page);
    if (item.holdCreate) {
      await until(() => held !== null, "the page asked herdr for the tab");
      await held!.continue();
    }
    let second: string | undefined;
    await until(async () => (second = (await sessionSnapshot()).panes.find((pane) => pane.workspace_id === workspaceId && pane.pane_id !== first)?.pane_id) !== undefined, "herdr has the new tab");
    await until(() => ready.has(second!), "the new terminal accepts input");
    if (item.typeOn) await item.typeOn(page);
    const lines = async () => (await paneRead({ paneId: second!, source: "recent", lines: 30, stripAnsi: true })).text.split("\n").map((line) => line.trim());
    if (item.ran !== null) {
      const ran = item.ran;
      await until(async () => (await lines()).includes(ran), `${item.name}: the new tab ran the command typed ahead`).catch(async (error: unknown) => {
        // CI has seen this time out without saying why: what the page sent the new tab, and whether it held the keys
        const held = await page.getByRole("button", { name: "Discard held input", exact: true }).count();
        throw new Error(`${(error as Error).message}; sent to it: ${JSON.stringify(textOf(sent, second!))}, held for review: ${held > 0}, its last lines: ${JSON.stringify((await lines()).filter(Boolean).slice(-4))}`);
      });
      if (item.sent !== undefined) {
        // the shell's line is read through herdr, the page's frames through the browser's own events, which can come
        // later on a busy machine: what the page sent is read once it has sent as many keys as were typed
        const expected = item.sent;
        await until(() => textOf(sent, second!).length >= expected.length, `${item.name}: the page's frames for the new tab are all heard`).catch((error: unknown) => {
          throw new Error(`${(error as Error).message}; expected ${JSON.stringify(expected)}, heard ${JSON.stringify(textOf(sent, second!))}`);
        });
        assert.equal(textOf(sent, second!), expected, `${item.name}: every key reaches the new tab, in order`);
      }
    } else {
      // held for review as typing offline is: the new tab offers it with Send and Discard
      const frame = page.locator(`[data-layout-pane=${JSON.stringify(second!)}]`);
      await frame.getByRole("button", { name: "Discard held input", exact: true }).waitFor();
      assert.match(await frame.innerText(), /echo ahead-/, `${item.name}: what was typed is held for review`);
      if (item.name === "paste") assert.match(await frame.innerText(), /Not sent: the terminal is not ready for keys\./, "the refused paste is told");
      assert.equal(textOf(sent, second!), "", `${item.name}: nothing held is sent by itself`);
    }
    assert.equal(textOf(sent, first), "", `${item.name}: no key goes to the old tab`);
    const tabs = (await sessionSnapshot()).panes.filter((pane) => pane.workspace_id === workspaceId).length;
    assert.equal(tabs, 2, `${item.name}: a Space or Enter typed ahead opens no other tab`);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

const typed = (text: string, delay = 0) => async (page: Page): Promise<void> => {
  await page.keyboard.type(text, { delay });
  await page.keyboard.press("Enter");
};

const CASES: Case[] = [
  { name: "plus", way: "plus", viewport: desktop, type: typed("echo ahead-plus"), ran: "ahead-plus", sent: "echo ahead-plus\r" },
  { name: "sheet", way: "sheet", viewport: phone, type: typed("echo ahead-sheet"), ran: "ahead-sheet", sent: "echo ahead-sheet\r" },
  { name: "touch", way: "sheet", viewport: phone, touch: true, type: typed("echo ahead-touch"), ran: "ahead-touch", sent: "echo ahead-touch\r" },
  // a keyboard on a touch screen: the keys typed after the new tab came go on to it, not lost
  {
    name: "touch-midway", way: "sheet", viewport: phone, touch: true, holdCreate: true, ran: "ahead-midway", sent: "echo ahead-midway\r",
    type: async (page) => { await page.keyboard.type("echo ahead-"); },
    typeOn: typed("midway"),
  },
  // slower, so the keys go on while the dialog closes over the old tab
  { name: "dialog", way: "dialog", viewport: desktop, type: typed("echo ahead-dialog", 15), ran: "ahead-dialog", sent: "echo ahead-dialog\r" },
  {
    name: "edit", way: "plus", viewport: desktop, ran: "ahead-edit",
    type: async (page) => {
      await page.keyboard.type("echo ahead-edt");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.type("i");
      await page.keyboard.press("Enter");
    },
  },
  {
    // the dialog's focus trap leaves Tab to the keys typed ahead while it waits for herdr
    name: "dialog-tab", way: "dialog", viewport: desktop, ran: "ahead-tab", sent: "echo ahead-tab\t\r", holdCreate: true,
    type: async (page) => {
      await page.keyboard.type("echo ahead-tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
    },
  },
  {
    name: "word-erase", way: "plus", viewport: desktop, ran: "ahead-ok", holdCreate: true,
    type: async (page) => {
      await page.keyboard.type("echo ahead-bsx");
      await page.keyboard.press("Alt+Backspace");
      await page.keyboard.type("ok");
      await page.keyboard.press("Enter");
    },
  },
  {
    name: "paste", way: "plus", viewport: desktop, ran: null, holdCreate: true,
    type: async (page) => {
      const refused = await page.evaluate(() => !document.activeElement?.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true })));
      assert.equal(refused, true, "a paste typed ahead is refused, never sent around the terminal's bracketed paste");
      await page.keyboard.type("echo ahead-paste");
      await page.keyboard.press("Enter");
    },
  },
  {
    name: "away", way: "plus", viewport: desktop, ran: null, holdCreate: true,
    type: async (page) => {
      await page.keyboard.type("echo ahead-away");
      // the user goes elsewhere before herdr has made the tab
      await page.getByPlaceholder("Filter workspaces and agents").click();
    },
  },
];

/** A composition still open when the tab arrives keeps its field until it ends, then goes after what came before it. */
async function composingAcrossHandOver(browser: Browser, origin: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-newtab-typeahead-")));
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-newtab-ime" });
  const workspaceId = created.workspace.workspace_id;
  const first = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: desktop, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { sent, ready } = watch(page);
    let held: Route | null = null;
    await page.route("**/api/**tab/create", (route) => { held = route; });
    await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
    await page.locator(".conn-live").waitFor();
    await until(() => ready.has(first), "the first terminal accepts input");
    await choose(page, first, { name: "ime", way: "plus", viewport: desktop, type: async () => {}, ran: null }, sent);
    await page.keyboard.type("echo ");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "하", selectionStart: 1, selectionEnd: 1 });
    await until(() => held !== null, "the page asked herdr for the tab");
    await held!.continue();
    let second: string | undefined;
    await until(async () => (second = (await sessionSnapshot()).panes.find((pane) => pane.workspace_id === workspaceId && pane.pane_id !== first)?.pane_id) !== undefined, "herdr has the new tab");
    await until(() => ready.has(second!), "the new terminal accepts input");
    await until(() => textOf(sent, second!) === "echo ", "what came before the composition reaches the new tab");
    assert.equal(await page.evaluate(() => document.activeElement?.className), "type-ahead", "the composition keeps its field across the hand-over");
    await cdp.send("Input.insertText", { text: "한" });
    await page.keyboard.press("Enter");
    await until(() => textOf(sent, second!) === "echo 한\r", "the composed syllable, then Enter, follow in order");
    assert.equal(textOf(sent, first), "", "no key goes to the old tab");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

async function ownedPage(browser: Browser, origin: string, label: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-newtab-typeahead-")));
  const created = await workspaceCreate({ cwd: root, label });
  const context = await browser.newContext({ viewport: desktop, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { sent, ready } = watch(page);
  const held: Route[] = [];
  await page.route("**/api/**tab/create", (route) => { held.push(route); });
  const first = created.root_pane.pane_id;
  await page.goto(`${origin}/?pane=${encodeURIComponent(first)}`);
  await page.locator(".conn-live").waitFor();
  await until(() => ready.has(first), "the first terminal accepts input");
  const workspaceId = created.workspace.workspace_id;
  const added = async (known: string[]) => (await sessionSnapshot()).panes.find((pane) => pane.workspace_id === workspaceId && pane.pane_id !== first && !known.includes(pane.pane_id))?.pane_id;
  const close = async () => {
    await context.close();
    await workspaceClose(workspaceId).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  };
  return { page, context, errors, sent, ready, held, first, added, close };
}

/** A second New terminal before the first tab is made: each tab gets what was typed for it (the first's held, as the user moved on). */
async function twoCatches(browser: Browser, origin: string): Promise<void> {
  const owned = await ownedPage(browser, origin, "ovis-test-newtab-two");
  const { page, sent, ready, held, first, added, errors } = owned;
  try {
    await screenOf(page, first).click();
    sent.length = 0;
    await page.locator(".tab-strip-add").click();
    await page.keyboard.type("echo ahead-one");
    await page.locator(".tab-strip-add").click();
    await page.keyboard.type("echo ahead-two");
    await page.keyboard.press("Enter");
    await until(() => held.length === 2, "the page asked herdr for both tabs");
    // the second tab is made first: it is shown, and takes the keys typed for it
    await held[1]!.continue();
    let second: string | undefined;
    await until(async () => (second = await added([])) !== undefined, "herdr has the second tab");
    await until(() => ready.has(second!), "the second tab accepts input");
    await until(() => textOf(sent, second!) === "echo ahead-two\r", "the second tab gets what was typed for it");
    await held[0]!.continue();
    let other: string | undefined;
    await until(async () => (other = await added([second!])) !== undefined, "herdr has the first tab");
    assert.equal(textOf(sent, other!), "", "the first tab, not shown, is sent nothing");
    const tab = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === other)!.tab_id;
    await page.locator(`[data-tab-id=${JSON.stringify(tab)}]`).click();
    const frame = page.locator(`[data-layout-pane=${JSON.stringify(other!)}]`);
    await frame.getByRole("button", { name: "Discard held input", exact: true }).waitFor();
    assert.match(await frame.innerText(), /echo ahead-one/, "the first tab holds what was typed for it, for review");
    assert.equal(textOf(sent, other!), "", "held, never sent by itself");
    assert.equal(textOf(sent, first), "", "no key goes to the old tab");
    assert.deepEqual(errors, []);
  } finally { await owned.close(); }
}

/** What an open composition commits after the new tab shows a masked prompt goes as a secret: no receipt keeps it. */
async function secretAfterComposition(browser: Browser, origin: string): Promise<void> {
  const owned = await ownedPage(browser, origin, "ovis-test-newtab-secret");
  const { page, context, sent, ready, held, first, added, errors } = owned;
  try {
    await screenOf(page, first).click();
    sent.length = 0;
    await page.locator(".tab-strip-add").click();
    await page.keyboard.type("read -s -p 'Password:' pw");
    await page.keyboard.press("Enter");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "하", selectionStart: 1, selectionEnd: 1 });
    await until(() => held.length === 1, "the page asked herdr for the tab");
    await held[0]!.continue();
    let second: string | undefined;
    await until(async () => (second = await added([])) !== undefined, "herdr has the new tab");
    await until(() => ready.has(second!), "the new tab accepts input");
    await until(async () => /Password:\s*$/.test((await paneRead({ paneId: second!, source: "visible", stripAnsi: true })).text.trimEnd()), "the new tab shows the masked prompt");
    await page.locator(`[data-layout-pane=${JSON.stringify(second!)}] .secret-input`).waitFor();
    if (await page.evaluate(() => document.activeElement?.className) === "type-ahead") await cdp.send("Input.insertText", { text: "한" });
    let composed: Sent | undefined;
    await until(() => (composed = sent.find((message) => message.pane_id === second && /[하한]/.test(message.text ?? ""))) !== undefined, "the composed text reaches the prompt");
    assert.equal((composed as { id?: number }).id, undefined, "typed into a masked prompt, it is sent as a secret: no receipt keeps it");
    assert.equal(textOf(sent, first), "", "no key goes to the old tab");
    assert.deepEqual(errors, []);
  } finally { await owned.close(); }
}

export async function checkNewTabTypeAhead(browser: Browser, origin: string): Promise<void> {
  for (const item of CASES) await typeAhead(browser, origin, item);
  await composingAcrossHandOver(browser, origin);
  await twoCatches(browser, origin);
  await secretAfterComposition(browser, origin);
  console.log("PASS keys typed right after New terminal, the tab list's New terminal (mouse and touch) and the New tab dialog's Start reach the new tab in order (arrows, word erase, Tab in the dialog and an open composition too, a masked prompt's text as a secret), none the old, and open no other tab; a paste or keys left behind (a second New terminal's first tab too) are held for review");
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-newtab-typeahead-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try { await checkNewTabTypeAhead(browser, `http://127.0.0.1:${server.port}`); }
  finally { await browser.close(); server.stop(); rmSync(state, { recursive: true, force: true }); }
}
