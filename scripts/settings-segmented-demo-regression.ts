import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContextOptions, type Locator, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import { PAGES, SETTINGS, openSettings } from "./settings-pages-harness.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { JA } from "../src/lib/i18n.ja.ts";
import { ZH } from "../src/lib/i18n.zh.ts";

// Settings' segmented controls on the unmodified app over the demo's fixture transport, read by their boxes and
// never by their pixels or their words: what an option draws stays inside its track, a chosen option holds its own
// label, and no label leaves its option or lies on its neighbour. A phone drew a second outline around every chosen
// option (the option's finger-sized hit box wore the shadow meant for the pill inside it), and at 360px the four
// phrases of Agents order lay over each other. A read-only fact beside its label (Devices, Access) keeps its own width
// up to its cap: on a phone those shrank beside a long description until they broke one letter to a line. All files
// and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-settings-segmented-"));

type Language = "en" | "ko" | "ja" | "zh";
const WORDS: Record<Language, Record<string, string>> = { en: {}, ko: KO, ja: JA, zh: ZH };
const PHONE: BrowserContextOptions = { deviceScaleFactor: 3, isMobile: true, hasTouch: true };

/**
 * The segmented controls of the open dialog: how many are drawn, and what is wrong with them, one line each. A box
 * counts as drawn when its own style paints it: a fill, a shadow, an outline or a border.
 */
const segmented = (page: Page): Promise<{ seen: number; defects: string[] }> => page.locator(".settings-dialog").evaluate((dialog) => {
  interface Box { left: number; top: number; right: number; bottom: number }
  const SLACK = 0.5;
  const boxOf = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  const holds = (outer: Box, inner: Box): boolean => inner.left >= outer.left - SLACK && inner.top >= outer.top - SLACK && inner.right <= outer.right + SLACK && inner.bottom <= outer.bottom + SLACK;
  const spans = (outer: Box, inner: Box): boolean => inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK;
  const px = (value: number): string => `${Math.round(value * 10) / 10}px`;
  const size = (box: Box): string => `${px(box.right - box.left)} by ${px(box.bottom - box.top)}`;
  // rgba(0, 0, 0, 0) and color(srgb 0 0 0 / 0): a colour with no alpha paints nothing
  const clear = (color: string): boolean => color === "transparent" || /[,/]\s*0\)$/.test(color);
  const paints = (style: CSSStyleDeclaration): boolean => !clear(style.backgroundColor) || style.backgroundImage !== "none" || style.boxShadow !== "none"
    || (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 && !clear(style.outlineColor))
    || (["Top", "Right", "Bottom", "Left"] as const).some((side) => style[`border${side}Style`] !== "none" && parseFloat(style[`border${side}Width`]) > 0 && !clear(style[`border${side}Color`]));
  /** The boxes an option paints: its own, and its ::before's and ::after's (placed from the option's padding edge where absolute, else taken for the option's own). */
  const painted = (option: Element): Box[] => {
    const own = boxOf(option.getBoundingClientRect());
    const style = getComputedStyle(option);
    const boxes = paints(style) ? [own] : [];
    for (const part of ["::before", "::after"]) {
      const drawn = getComputedStyle(option, part);
      if (drawn.content === "none" || drawn.content === "normal" || drawn.display === "none" || !paints(drawn)) continue;
      if (drawn.position !== "absolute") { boxes.push(own); continue; }
      const left = own.left + parseFloat(style.borderLeftWidth) + parseFloat(drawn.left);
      const top = own.top + parseFloat(style.borderTopWidth) + parseFloat(drawn.top);
      boxes.push({ left, top, right: left + parseFloat(drawn.width), bottom: top + parseFloat(drawn.height) });
    }
    return boxes;
  };
  /** An option's label as drawn: the box around its lines of text. */
  const labelOf = (option: Element): Box | null => {
    const range = document.createRange();
    range.selectNodeContents(option);
    const lines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    if (lines.length === 0) return null;
    return { left: Math.min(...lines.map((line) => line.left)), top: Math.min(...lines.map((line) => line.top)), right: Math.max(...lines.map((line) => line.right)), bottom: Math.max(...lines.map((line) => line.bottom)) };
  };
  const defects: string[] = [];
  let seen = 0;
  for (const control of dialog.querySelectorAll(".segmented")) {
    const track = boxOf(control.getBoundingClientRect());
    if (track.right === track.left) continue;
    seen += 1;
    const named = control.getAttribute("aria-label") ?? "a segmented control";
    const options = [...control.querySelectorAll(":scope > button")].map((option, index) => ({
      chosen: option.getAttribute("aria-pressed") === "true", box: boxOf(option.getBoundingClientRect()), label: labelOf(option), pills: painted(option),
      name: `${named}, option ${index + 1} (${option.textContent?.trim() ?? ""})`,
    }));
    for (const { chosen, box, label, pills, name } of options) {
      if (!spans(track, box)) defects.push(`${name} reaches sideways out of its track`);
      for (const pill of pills) if (!holds(track, pill)) defects.push(`${name} draws a ${size(pill)} box that leaves its ${size(track)} track`);
      if (label === null) continue;
      if (!spans(box, label)) defects.push(`${name}: its ${px(label.right - label.left)} label does not fit its ${px(box.right - box.left)} option`);
      if (chosen && !pills.some((pill) => holds(pill, label))) defects.push(`${name} is chosen, and nothing it draws holds its label`);
    }
    const shared = (one: Box, other: Box): number => Math.min(Math.min(one.right, other.right) - Math.max(one.left, other.left), Math.min(one.bottom, other.bottom) - Math.max(one.top, other.top));
    for (const [index, one] of options.entries()) for (const other of options.slice(index + 1)) {
      // an option's box is what a tap on it hits: two of them never share a point, on one row or on two
      if (shared(one.box, other.box) > SLACK) defects.push(`${one.name} and ${other.name}: their boxes share ${px(shared(one.box, other.box))}`);
      if (one.label !== null && other.label !== null && shared(one.label, other.label) > SLACK) defects.push(`${one.name} and ${other.name}: the labels lie over each other by ${px(shared(one.label, other.label))}`);
    }
    // options that take more than one row go two to a row at most, and the ones sharing a row share it equally
    const rows = new Map<number, Box[]>();
    for (const { box } of options) rows.set(Math.round(box.top), [...(rows.get(Math.round(box.top)) ?? []), box]);
    if (rows.size < 2) continue;
    for (const row of rows.values()) {
      const widths = row.map((box) => box.right - box.left);
      if (row.length > 2) defects.push(`${named}: ${row.length} options on one of its ${rows.size} rows`);
      if (Math.max(...widths) - Math.min(...widths) > SLACK) defects.push(`${named}: options sharing a row are ${widths.map(px).join(" and ")} wide`);
    }
  }
  return { seen, defects };
});

/** The faces a page asks for have arrived, and the frames that lay the page out with them have been drawn. */
const settled = (page: Page): Promise<void> => page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));

async function settingsIn(browser: Browser, url: string, language: Language, width: number, options: BrowserContextOptions, settings: Record<string, unknown> = {}): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width, height: 800 }, locale: language, ...options });
  await context.addInitScript((stored) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", stored); }, JSON.stringify({ ...SETTINGS, language, ...settings }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await openSettings(page);
  return { page, errors, close: () => context.close() };
}

/**
 * On a phone (the stylesheet's 640px), the facts of the open dialog that are narrower than their own text on one line
 * while their cap (their max-width, of their row) has room for more: a fact squeezed by the text beside it. One line
 * each. A desktop's row has the room, and its facts keep the layout they had.
 */
const squeezedFacts = (page: Page): Promise<string[]> => page.locator(".settings-dialog").evaluate((dialog) => {
  const found: string[] = [];
  if (!matchMedia("(max-width: 640px)").matches) return found;
  for (const fact of dialog.querySelectorAll<HTMLElement>(".settings-fact")) {
    const drawn = fact.getBoundingClientRect().width;
    const row = fact.parentElement;
    if (drawn === 0 || row === null) continue;
    const rowStyle = getComputedStyle(row);
    const room = row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight);
    const max = getComputedStyle(fact).maxWidth;
    const cap = max === "none" ? room : max.endsWith("%") ? room * parseFloat(max) / 100 : parseFloat(max);
    // its width on one line, read with the row's limits lifted for one layout and put back at once
    const before = fact.getAttribute("style");
    fact.style.setProperty("flex", "none");
    fact.style.setProperty("max-width", "none");
    fact.style.setProperty("width", "max-content");
    const natural = fact.getBoundingClientRect().width;
    if (before === null) fact.removeAttribute("style"); else fact.setAttribute("style", before);
    if (drawn + 0.5 < Math.min(natural, cap)) found.push(`the fact "${fact.textContent?.trim() ?? ""}" is ${Math.round(drawn * 10) / 10}px wide, while its text takes ${Math.round(natural * 10) / 10}px and its cap is ${Math.round(cap * 10) / 10}px`);
  }
  return found;
});

/** Chooses an option with a finger and waits until it is the pressed one and the page is drawn with it. */
async function choose(page: Page, option: Locator): Promise<void> {
  await option.tap();
  await page.waitForFunction((node) => node?.getAttribute("aria-pressed") === "true", await option.elementHandle());
  await settled(page);
}

/** A control's track and options, each as left, top, width and height from the track's corner: equal lists are one shape. */
const shapeOf = (control: Locator): Promise<string[]> => control.evaluate((track) => {
  const origin = track.getBoundingClientRect();
  const part = (box: DOMRect): string => [box.left - origin.left, box.top - origin.top, box.width, box.height].map((value) => Math.round(value * 10) / 10).join(" ");
  return [`${Math.round(origin.width * 10) / 10} ${Math.round(origin.height * 10) / 10}`, ...[...track.querySelectorAll(":scope > button")].map((option) => part(option.getBoundingClientRect()))];
});

/** How many rows a control's options take. */
const rowsOf = (control: Locator): Promise<number> => control.evaluate((track) => new Set([...track.querySelectorAll(":scope > button")].map((option) => Math.round(option.getBoundingClientRect().top))).size);

/** Every page of Settings, its folded groups open and what it asks the server for arrived. Returns how many segmented controls it read, so a pass that read none is not taken for a sound one. */
async function everyPage(page: Page, language: Language, where: string): Promise<number> {
  const label = (name: string): string => WORDS[language][name] ?? name;
  let seen = 0;
  for (const name of PAGES) {
    await openSettingsPage(page, label(name), label("Back to settings"));
    await page.waitForFunction((loading) => ![...document.querySelectorAll(".settings-body [role='status']")].some((node) => loading.includes(node.textContent?.trim() ?? "")), [label("Loading…")]);
    if (name === "Agents") await page.locator(".settings-body:not([hidden]) .agents-item").first().waitFor();
    await settled(page);
    const read = await segmented(page);
    assert.deepEqual(read.defects, [], `${name} ${where}`);
    assert.deepEqual(await squeezedFacts(page), [], `${name}'s facts ${where}`);
    seen += read.seen;
  }
  return seen;
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}${prefix}`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      // a finger's phone at the three widths, in the four languages: the option is its hit box there, taller than the track
      for (const language of ["en", "ko", "ja", "zh"] as const) {
        const { page, errors, close } = await settingsIn(browser, url, language, 390, PHONE);
        try {
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the phone is a finger's device");
          let seen = 0;
          for (const width of [390, 360, 320]) {
            await page.setViewportSize({ width, height: 800 });
            seen += await everyPage(page, language, `on a ${width}px phone (${language})`);
          }
          assert.ok(seen > 0, `Settings draws segmented controls (${language})`);
          assert.deepEqual(errors, []);
        } finally {
          await close();
        }
      }
      console.log("PASS on a phone at 390, 360 and 320px, in English, Korean, Japanese and Chinese, every Settings page's segmented controls draw inside their tracks and hold their labels, and no fact is squeezed");

      // the owner's phone: every choice of the four-option control in turn holds its own label, on its own cell
      {
        const { page, errors, close } = await settingsIn(browser, url, "ko", 360, PHONE);
        try {
          await openSettingsPage(page, KO["Appearance"]!, KO["Back to settings"]!);
          const four = page.locator(".settings-body:not([hidden]) .segmented").filter({ has: page.locator(":scope > button:nth-child(4)") }).first();
          await four.scrollIntoViewIfNeeded();
          const shapes: string[][] = [];
          for (let index = 0; index < 4; index += 1) {
            await choose(page, four.locator(":scope > button").nth(index));
            assert.deepEqual((await segmented(page)).defects, [], `the four-option control with its option ${index + 1} chosen, on a 360px phone (ko)`);
            shapes.push(await shapeOf(four));
          }
          for (const shape of shapes) assert.deepEqual(shape, shapes[0], "the control keeps one shape whichever option is chosen");
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "settings-segmented-360-ko.png"), animations: "disabled" });
          assert.deepEqual(errors, []);
        } finally {
          await close();
        }
      }
      console.log("PASS at 360px in Korean each of the four-option control's choices holds its own label, in one shape");

      // a chosen label is drawn heavier, and in Latin text wider. At the narrowest width where a control's options
      // still share one line, choosing any of them must leave them on that line: a tap never moves the page
      {
        const { page, errors, close } = await settingsIn(browser, url, "en", 430, PHONE);
        try {
          await openSettingsPage(page, "Terminal");
          const control = page.locator(".settings-body:not([hidden]) .segmented").filter({ has: page.locator(":scope > button:nth-child(3)") }).first();
          await control.scrollIntoViewIfNeeded();
          assert.equal(await rowsOf(control), 1, "the three-option control is one line at 430px");
          let width = 430;
          while (width > 320 && await rowsOf(control) === 1) {
            width -= 1;
            await page.setViewportSize({ width, height: 800 });
            await settled(page);
          }
          assert.ok(width > 320, "the three-option control takes rows somewhere above 320px");
          await page.setViewportSize({ width: width + 1, height: 800 });
          await settled(page);
          const line = await shapeOf(control);
          for (let index = 0; index < 3; index += 1) {
            await choose(page, control.locator(":scope > button").nth(index));
            assert.deepEqual(await shapeOf(control), line, `at ${width + 1}px, the last width of one line, choosing option ${index + 1} keeps the line`);
          }
          assert.deepEqual(errors, []);
        } finally {
          await close();
        }
      }
      console.log("PASS at the narrowest width where three options share a line, choosing any of them keeps the line");

      // the longest labels at the largest interface text, and the same page compact
      for (const [language, settings] of [["ja", { uiFontSize: 20 }], ["ko", { uiFontSize: 20 }], ["ko", { density: "compact" }]] as const) {
        const { page, errors, close } = await settingsIn(browser, url, language, 320, PHONE, settings);
        try {
          assert.ok(await everyPage(page, language, `on a 320px phone with ${JSON.stringify(settings)} (${language})`) > 0);
          assert.deepEqual(errors, []);
        } finally {
          await close();
        }
      }
      console.log("PASS at 320px the largest interface text and the compact density keep every label in its option");

      // a device that asks for more contrast draws the chosen option by a rule of its own
      for (const options of [PHONE, {}]) {
        const { page, errors, close } = await settingsIn(browser, url, "en", options === PHONE ? 360 : 1440, { ...options, contrast: "more" });
        try {
          assert.equal(await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches), true, "the device asks for more contrast");
          assert.ok(await everyPage(page, "en", `with more contrast (${options === PHONE ? "a 360px phone" : "1440px"})`) > 0);
          assert.deepEqual(errors, []);
        } finally {
          await close();
        }
      }
      console.log("PASS with more contrast asked for, on a phone and at 1440px, the chosen option still draws inside its track");

      // a mouse's window: the option is the pill itself
      {
        const { page, errors, close } = await settingsIn(browser, url, "en", 1440, {});
        try {
          assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), false, "the window is a mouse's");
          assert.ok(await everyPage(page, "en", "at 1440px") > 0);
          assert.deepEqual(errors, []);
        } finally {
          await close();
        }
      }
      console.log("PASS at 1440px with a mouse every Settings page's segmented controls draw inside their tracks");
    } finally {
      await browser.close();
      console.log("CLEANUP browser closed");
    }
  } finally {
    server.stop(true);
    console.log("CLEANUP loopback demo server stopped");
  }
} finally {
  rmSync(app, { recursive: true, force: true });
  console.log("CLEANUP disposable demo app removed");
}
