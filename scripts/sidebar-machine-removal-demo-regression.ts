/**
 * Purpose: verify persistent danger styling and confirmed PC removal in the real demo client.
 * Tags: sidebar, machines, accessibility, browser, regression.
 * Usage: bun scripts/sidebar-machine-removal-demo-regression.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { prepareMachineControlsDemo } from "./sidebar-machine-controls-fixture.ts";
import { SUPPORTED_ENTRIES } from "../src/lib/themes.ts";

const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-machine-removal-"));
const evidenceDir = process.env.UI_EVIDENCE_DIR;
const REMOTE_NAME = "Demo remote PC";
const RENAME_LABEL = "Rename";
const REMOVE_LABEL = "Remove PC";
const CONFIRM_LABEL = "Confirm remove PC";
const REMOVE_EXPLANATION = "Removes this registration. Remote sessions keep running.";

interface Scenario { theme: "dark" | "light" }

const scenarios: Scenario[] = [{ theme: "dark" }, { theme: "light" }];
const machineGroup = (page: Page): Locator => page.locator(".machine-group").filter({ has: page.locator(".machine-name", { hasText: REMOTE_NAME }) });

async function fixtureValue(page: Page, key: string): Promise<unknown> {
  return page.evaluate((path) => {
    const fixture = (window as unknown as { machineControlsFixture: { calls: Record<string, unknown> } }).machineControlsFixture;
    let value: unknown = fixture;
    for (const part of path.split(".")) {
      if (typeof value !== "object" || value === null) return null;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }, key);
}

interface DangerStyle {
  textContrast: number;
  borderContrast: number;
  tintMatches: boolean;
  borderMatches: boolean;
  textMatches: boolean;
  opacity: number;
  focusVisible: boolean;
  borderColor: string;
  outlineStyle: string;
  outlineWidth: number;
  boxShadow: string;
}

async function dangerStyle(button: Locator): Promise<DangerStyle> {
  return button.evaluate((element) => {
    interface Color { r: number; g: number; b: number; a: number }
    const parseColor = (source: string): Color => {
      const value = source.trim();
      const hex = value.match(/^#([\da-f]{3,8})$/i)?.[1];
      if (hex) {
        const expanded = hex.length === 3 || hex.length === 4 ? [...hex].map((part) => `${part}${part}`).join("") : hex;
        return {
          r: Number.parseInt(expanded.slice(0, 2), 16),
          g: Number.parseInt(expanded.slice(2, 4), 16),
          b: Number.parseInt(expanded.slice(4, 6), 16),
          a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
        };
      }
      const numbers = value.match(/[\d.]+/g)?.map(Number);
      if (!numbers || numbers.length < 3) throw new Error(`Unsupported computed color: ${source}`);
      return { r: numbers[0]!, g: numbers[1]!, b: numbers[2]!, a: numbers.length > 3 ? numbers[3]! : 1 };
    };
    const composite = (front: Color, back: Color): Color => {
      const a = front.a + back.a * (1 - front.a);
      if (!a) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (front.r * front.a + back.r * back.a * (1 - front.a)) / a,
        g: (front.g * front.a + back.g * back.a * (1 - front.a)) / a,
        b: (front.b * front.a + back.b * back.a * (1 - front.a)) / a,
        a,
      };
    };
    const linear = (channel: number) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
    const luminance = (color: Color) => 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
    const contrast = (first: Color, second: Color) => {
      const a = luminance(first), b = luminance(second);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const same = (first: Color, second: Color) => Math.abs(first.r - second.r) < 1 && Math.abs(first.g - second.g) < 1 && Math.abs(first.b - second.b) < 1 && Math.abs(first.a - second.a) < 0.01;
    const style = getComputedStyle(element);
    const panel = element.closest(".machine-controls");
    if (!panel) throw new Error("danger button is outside .machine-controls");
    const panelBackground = parseColor(getComputedStyle(panel).backgroundColor);
    const buttonBackground = parseColor(style.backgroundColor);
    const text = parseColor(style.color);
    const border = parseColor(style.borderTopColor);
    const opacity = Number.parseFloat(style.opacity);
    const paintedBackground = composite(buttonBackground, panelBackground);
    const actualBackground = composite({ ...paintedBackground, a: paintedBackground.a * opacity }, panelBackground);
    const paintedText = composite(text, paintedBackground);
    const actualText = composite({ ...paintedText, a: paintedText.a * opacity }, panelBackground);
    const paintedBorder = composite(border, paintedBackground);
    const actualBorder = composite({ ...paintedBorder, a: paintedBorder.a * opacity }, panelBackground);
    const expectedTint = parseColor(getComputedStyle(document.documentElement).getPropertyValue("--danger-tint"));
    const expectedBorder = parseColor(getComputedStyle(document.documentElement).getPropertyValue("--status-blocked"));
    const expectedText = parseColor(getComputedStyle(document.documentElement).getPropertyValue("--danger-text"));
    const focus = getComputedStyle(element);
    return {
      textContrast: contrast(actualText, actualBackground),
      borderContrast: contrast(actualBorder, actualBackground),
      tintMatches: same(buttonBackground, expectedTint),
      borderMatches: same(border, expectedBorder),
      textMatches: same(text, expectedText),
      opacity,
      focusVisible: element.matches(":focus-visible"),
      borderColor: style.borderTopColor,
      outlineStyle: focus.outlineStyle,
      outlineWidth: Number.parseFloat(focus.outlineWidth) || 0,
      boxShadow: focus.boxShadow,
    };
  });
}

const opacityOf = (button: Locator): Promise<number> => button.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity));

async function settleButton(button: Locator): Promise<void> {
  await button.evaluate(async (element) => {
    // Flush the interaction's style change before discovering its CSS transitions.
    void getComputedStyle(element).backgroundColor;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

async function checkDangerPresentation(page: Page, theme: Scenario["theme"], stage: string, button: Locator): Promise<void> {
  await page.mouse.move(0, 0);
  await button.evaluate((element) => (element as HTMLElement).blur());
  await settleButton(button);
  const normal = await dangerStyle(button);
  await button.hover();
  await settleButton(button);
  const hover = await dangerStyle(button);
  await page.mouse.move(0, 0);
  await button.evaluate((element) => (element as HTMLElement).blur());
  await button.focus();
  await page.keyboard.press("Shift");
  await settleButton(button);
  const focus = await dangerStyle(button);

  for (const [state, style] of [["normal", normal], ["hover", hover], ["focus", focus]] as const) {
    assert.ok(style.tintMatches, `${theme} ${stage} ${state} keeps the danger tint token: ${JSON.stringify(style)}`);
    assert.ok(style.borderMatches, `${theme} ${stage} ${state} keeps the blocked border token: ${JSON.stringify(style)}`);
    assert.ok(style.textMatches, `${theme} ${stage} ${state} keeps the danger text token: ${JSON.stringify(style)}`);
    assert.ok(style.textContrast >= 4.5, `${theme} ${stage} ${state} text contrast is ${style.textContrast.toFixed(2)}:1`);
    assert.ok(style.borderContrast >= 3, `${theme} ${stage} ${state} border contrast is ${style.borderContrast.toFixed(2)}:1`);
    console.log(`CONTRAST ${theme} ${stage} ${state}: text ${style.textContrast.toFixed(2)}:1, border ${style.borderContrast.toFixed(2)}:1`);
  }
  assert.notEqual(hover.boxShadow, normal.boxShadow, `${theme} ${stage} hover shows on the danger button: ${JSON.stringify({ normal, hover })}`);
  assert.ok(hover.boxShadow.includes(hover.borderColor) && hover.boxShadow.includes("inset"), `${theme} ${stage} the hover ring is drawn inside, in the button's own border color: ${JSON.stringify(hover)}`);
  assert.ok(focus.focusVisible && (focus.outlineStyle !== "none" && focus.outlineWidth > 0 || focus.boxShadow !== "none"), `${theme} ${stage} danger button has a visible keyboard focus indicator: ${JSON.stringify(focus)}`);
}

async function checkDisabledDanger(button: Locator, neighbour: Locator, theme: Scenario["theme"]): Promise<void> {
  assert.equal(await button.isDisabled(), true, `${theme} confirmation stays disabled while DELETE is held`);
  assert.equal(await button.getAttribute("class"), "btn btn-danger", `${theme} disabled confirmation keeps its danger class`);
  assert.equal(await button.getAttribute("aria-busy"), "true", `${theme} the removal in flight is marked busy`);
  await settleButton(button);
  await settleButton(neighbour);
  const style = await dangerStyle(button);
  const neighbourOpacity = await opacityOf(neighbour);
  assert.ok(style.tintMatches, `${theme} disabled confirmation keeps the danger tint token: ${JSON.stringify(style)}`);
  assert.ok(style.borderMatches, `${theme} disabled confirmation keeps the blocked border token: ${JSON.stringify(style)}`);
  assert.ok(style.textMatches, `${theme} disabled confirmation keeps the danger text token: ${JSON.stringify(style)}`);
  assert.ok(style.opacity === 1 && neighbourOpacity < 1, `${theme} pending removal keeps its full strength while the disabled Rename beside it dims (${neighbourOpacity}): ${style.opacity}`);
  assert.ok(style.textContrast >= 4.5, `${theme} disabled confirmation text stays readable: ${style.textContrast.toFixed(2)}:1`);
  assert.ok(style.borderContrast >= 3, `${theme} disabled confirmation border stays visible: ${style.borderContrast.toFixed(2)}:1`);
  console.log(`CONTRAST ${theme} disabled (opacity ${style.opacity}, Rename ${neighbourOpacity}): actual text ${style.textContrast.toFixed(2)}:1, border ${style.borderContrast.toFixed(2)}:1`);
  // every theme block of this mode behind the pending removal: its warning stays readable in each
  const page = button.page();
  const shown = await page.evaluate(() => document.documentElement.dataset.palette);
  for (const { id: palette } of SUPPORTED_ENTRIES.filter((entry) => entry.mode === theme)) {
    await page.evaluate((palette) => { document.documentElement.dataset.palette = palette; }, palette);
    await settleButton(button);
    const themed = await dangerStyle(button);
    assert.ok(themed.tintMatches && themed.borderMatches && themed.textMatches, `${palette} ${theme} pending removal keeps its danger tokens: ${JSON.stringify(themed)}`);
    assert.ok(themed.textContrast >= 4.5, `${palette} ${theme} pending removal text stays readable: ${themed.textContrast.toFixed(2)}:1`);
    assert.ok(themed.borderContrast >= 3, `${palette} ${theme} pending removal border stays visible: ${themed.borderContrast.toFixed(2)}:1`);
    console.log(`CONTRAST ${palette} ${theme} pending removal: text ${themed.textContrast.toFixed(2)}:1, border ${themed.borderContrast.toFixed(2)}:1`);
  }
  await page.evaluate((palette) => { if (palette === undefined) delete document.documentElement.dataset.palette; else document.documentElement.dataset.palette = palette; }, shown);
}

/** Disabled only because a rename runs, Remove PC dims exactly like the Rename button that runs it. */
async function checkDimmedLikeNeighbour(remove: Locator, neighbour: Locator, theme: Scenario["theme"]): Promise<void> {
  assert.equal(await remove.isDisabled(), true, `${theme} Remove PC is disabled while a rename runs`);
  assert.notEqual(await remove.getAttribute("aria-busy"), "true", `${theme} a rename in flight does not mark Remove PC busy`);
  await settleButton(remove);
  await settleButton(neighbour);
  const removeOpacity = await opacityOf(remove);
  const neighbourOpacity = await opacityOf(neighbour);
  assert.ok(removeOpacity < 1, `${theme} Remove PC is dimmed while a rename runs: ${removeOpacity}`);
  assert.equal(removeOpacity, neighbourOpacity, `${theme} Remove PC dims like the Rename that runs: ${removeOpacity} vs ${neighbourOpacity}`);
  console.log(`DIM ${theme} rename in flight: Remove PC ${removeOpacity}, Rename ${neighbourOpacity}`);
}

async function capture(controls: Locator, scenario: Scenario, state: "initial" | "armed" | "disabled"): Promise<void> {
  if (!evidenceDir) return;
  await controls.screenshot({ path: join(evidenceDir, `sidebar-machine-removal-${scenario.theme}-${state}.png`) });
}

async function withScenario(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string, scenario: Scenario): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", deviceScaleFactor: 1 });
  const errors: string[] = [];
  try {
    await context.addInitScript((theme) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme, density: "comfortable", defaultView: "chat" }));
      localStorage.setItem("ovis:sidebar-width", "520");
    }, scenario.theme);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), scenario.theme, `${scenario.theme} theme is active`);

    const group = machineGroup(page);
    await group.waitFor({ state: "attached" });
    const manage = group.locator(".machine-manage");
    await group.locator(".machine-header").hover();
    await manage.click();
    const controls = group.locator(".machine-controls");
    await controls.waitFor({ state: "visible" });
    const remove = group.getByRole("button", { name: REMOVE_LABEL, exact: true });
    assert.equal(await remove.getAttribute("class"), "btn btn-danger", `${scenario.theme} Remove PC is danger styled before confirmation`);
    await capture(controls, scenario, "initial");
    await checkDangerPresentation(page, scenario.theme, "initial", remove);

    await remove.focus();
    await page.evaluate(() => { (window as unknown as { __sidebarRemoveFocus: Element | null }).__sidebarRemoveFocus = document.activeElement; });
    await page.keyboard.press("Enter");
    const confirm = group.getByRole("button", { name: CONFIRM_LABEL, exact: true });
    await confirm.waitFor();
    assert.equal(await fixtureValue(page, "calls.deleteCount"), 0, `${scenario.theme} first activation sends zero DELETEs`);
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 0, `${scenario.theme} first activation makes zero DELETE attempts`);
    assert.equal(await page.evaluate(() => document.activeElement === (window as unknown as { __sidebarRemoveFocus: Element }).__sidebarRemoveFocus), true, `${scenario.theme} arming preserves focus on the same button`);
    assert.ok((await controls.textContent() ?? "").includes(REMOVE_EXPLANATION), `${scenario.theme} arming explains what removal affects`);
    assert.equal(await confirm.getAttribute("class"), "btn btn-danger", `${scenario.theme} armed confirmation stays danger styled`);
    await capture(controls, scenario, "armed");
    await checkDangerPresentation(page, scenario.theme, "armed", confirm);

    await group.locator(".machine-header").hover();
    await manage.click();
    await controls.waitFor({ state: "detached" });
    await group.locator(".machine-header").hover();
    await manage.click();
    await controls.waitFor({ state: "visible" });
    assert.equal(await group.getByRole("button", { name: REMOVE_LABEL, exact: true }).count(), 1, `${scenario.theme} closing and reopening Manage resets confirmation`);
    assert.equal(await group.getByRole("button", { name: CONFIRM_LABEL, exact: true }).count(), 0, `${scenario.theme} reopened removal starts unarmed`);
    const reopenedRemove = group.getByRole("button", { name: REMOVE_LABEL, exact: true });
    const rename = controls.getByRole("button", { name: RENAME_LABEL, exact: true });
    await page.evaluate(() => (window as unknown as { machineControlsFixture: { holdNextMutation(): void } }).machineControlsFixture.holdNextMutation());
    await rename.click();
    await controls.locator("form button:disabled").waitFor();
    await page.waitForFunction(() => (window as unknown as { machineControlsFixture: { calls: { mutations: unknown[] } } }).machineControlsFixture.calls.mutations.length === 1);
    await checkDimmedLikeNeighbour(reopenedRemove, rename, scenario.theme);
    await page.evaluate(() => (window as unknown as { machineControlsFixture: { releaseMutation(success: boolean): void } }).machineControlsFixture.releaseMutation(true));
    await controls.locator("form button:enabled").waitFor();
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 0, `${scenario.theme} a rename sends no DELETE`);
    await reopenedRemove.focus();
    await page.keyboard.press("Enter");
    const destructive = group.getByRole("button", { name: CONFIRM_LABEL, exact: true });
    await destructive.waitFor();
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 0, `${scenario.theme} re-arming remains inert`);

    await page.evaluate(() => (window as unknown as { machineControlsFixture: { holdNextMutation(): void } }).machineControlsFixture.holdNextMutation());
    await destructive.click();
    await page.waitForFunction(() => (window as unknown as { machineControlsFixture: { calls: { deleteAttempts: number } } }).machineControlsFixture.calls.deleteAttempts === 1);
    await checkDisabledDanger(destructive, rename, scenario.theme);
    await capture(controls, scenario, "disabled");
    await destructive.evaluate((button) => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 1, `${scenario.theme} duplicate clicks while busy issue no additional DELETE`);

    await page.evaluate(() => (window as unknown as { machineControlsFixture: { releaseMutation(success: boolean): void } }).machineControlsFixture.releaseMutation(false));
    await group.getByRole("alert").waitFor();
    assert.match(await group.getByRole("alert").textContent() ?? "", /Fixture mutation rejected/);
    assert.equal(await group.count(), 1, `${scenario.theme} rejected removal retains the PC`);
    assert.equal(await fixtureValue(page, "calls.deleteCount"), 0, `${scenario.theme} rejected DELETE is not counted as a successful removal`);
    assert.equal(await destructive.isDisabled(), false, `${scenario.theme} failed removal clears busy state`);

    await destructive.click();
    await group.waitFor({ state: "detached" });
    assert.equal(await fixtureValue(page, "calls.deleteAttempts"), 2, `${scenario.theme} one retry sends one additional DELETE`);
    assert.equal(await fixtureValue(page, "calls.deleteCount"), 1, `${scenario.theme} successful retry removes exactly once`);
    console.log(`PASS ${scenario.theme} PC removal styling, confirmation, busy guard, failure recovery and one successful retry`);
    assert.deepEqual(errors, [], `${scenario.theme} has no uncaught browser errors`);
  } finally {
    await context.close();
  }
}

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
  await prepareMachineControlsDemo(app);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file: string;
    try { file = decodeURIComponent(new URL(request.url).pathname.slice(1)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const url = `http://127.0.0.1:${server.port}/`;
  for (const scenario of scenarios) await withScenario(browser, url, scenario);
  console.log("PASS sidebar machine removal visual and behavior regression");
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
