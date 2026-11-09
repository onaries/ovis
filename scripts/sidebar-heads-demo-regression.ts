/**
 * The sidebar's section heads and PC rows on the real demo client, never a live herdr session: the
 * PCs and Agents heads' counts and always-shown carets, open and folded, in both section orders; a
 * PC header's agent count traded for its actions on hover and focus (always actions under a finger,
 * also on a fine pointer with a touch screen beside it), and no count for a PC that is not connected;
 * folded PCs one row each; and each list's edge fades following its real overflow.
 * The roster is the demo's own, or that roster on two connected PCs (the Host "Laptop" and "Work PC").
 * UI_EVIDENCE_DIR saves synthetic screenshots at 390 and 1280, light and dark.
 * Usage: bun scripts/sidebar-heads-demo-regression.ts [--only=<words in a check's name>]
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// the demo's one PC as two, each with the demo's own roster: only this disposable fixture rewrites it (as
// scripts/sidebar-spacing-demo-regression.ts does)
const TWO_PCS = String.raw`(() => {
  if (localStorage.getItem("heads-fixture:two-pcs") !== "1") return;
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  let last = null;
  const roster = (original) => ["local", "work"].map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = id === "local" ? "Laptop" : "Work PC";
    machine.state = id === "work" && localStorage.getItem("heads-fixture:work-offline") === "1" ? "disconnected" : "connected";
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
    if (url.pathname.endsWith("/api/machines")) { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ ...value, machines: roster(last) }); }
    const match = url.pathname.match(/\/api\/machines\/([^/]+)(\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (match && path === "/api/session" && last) return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

interface Scene {
  width: number;
  mode: "light" | "dark";
  twoPcs?: boolean;
  /** Work PC is disconnected: its + is disabled */
  workOffline?: boolean;
  grouped?: boolean;
  height?: number;
  forcedColors?: boolean;
  /** a hybrid device: a fine primary pointer that hovers, with a touch screen beside it (any-pointer: coarse) */
  hybrid?: boolean;
  storage?: Record<string, string>;
}

/** Chromium's own pointer and hover media for a hybrid device, so its stylesheet answers as on one (Blink's
 *  pointer types: coarse 2, fine 4; hover types: none 1, hover 2). Playwright's hasTouch would make the primary
 *  pointer coarse instead. */
const HYBRID = "--blink-settings=primaryPointerType=4,availablePointerTypes=6,primaryHoverType=2,availableHoverTypes=3";

const app = mkdtempSync(join(tmpdir(), "ovis-sidebar-heads-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

/** What the section heads show: Agents' caret, count and fold, and that the PCs have none. */
const heads = (page: Page) => page.evaluate(() => {
  const shown = (element: Element | null) => element !== null && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" && Number(getComputedStyle(element).opacity) > 0.99;
  // the number in view, and the words a screen reader and the tooltip say for it (one and the same)
  const number = (count: Element | null) => shown(count) ? (count!.querySelector('[aria-hidden="true"]') ?? count)!.textContent!.trim() : null;
  const pcs = document.querySelector(".pcs-sidebar")!, agents = document.querySelector(".agents-sidebar")!;
  return {
    // the PCs list has no head: nothing above its PCs, so it starts right under the logo
    pcsHead: pcs.querySelectorAll(":scope > :not(.machine-list)").length,
    agentsFolded: agents.classList.contains("is-collapsed"),
    agentsCaret: shown(agents.querySelector(".agent-section-toggle .agent-section-caret")),
    agentsCount: number(agents.querySelector(".agent-section-toggle .agent-section-count")),
    machines: document.querySelectorAll(".machine-list .machine-group:not([hidden])").length,
    agentRows: document.querySelectorAll(".agents-sidebar .agent-item").length,
  };
});

/** One PC's header: whether its agent count or its actions are in view, where they sit, and its fold. */
const pcHeader = (page: Page, pc: string) => page.evaluate((pc) => {
  const group = document.querySelector<HTMLElement>(`section.machine-group[aria-label="PC ${pc}"]`)!;
  const header = group.querySelector(".machine-header")!;
  const painted = (element: Element | null) => element !== null && element.getClientRects().length > 0 && Number(getComputedStyle(element).opacity) > 0.99;
  const box = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height } : null; };
  const count = header.querySelector(".machine-agent-count");
  return {
    count: painted(count) ? (count!.querySelector('[aria-hidden="true"]') ?? count)!.textContent!.trim() : null,
    countWords: count?.querySelector(".visually-hidden")?.textContent ?? null,
    countTitle: count?.getAttribute("title") ?? null,
    countBox: box(count),
    toggle: painted(header.querySelector(".machine-toggle")),
    add: painted(header.querySelector(".machine-new")),
    toggleBox: box(header.querySelector(".machine-toggle")),
    addBox: box(header.querySelector(".machine-new")),
    name: box(header.querySelector(".machine-name")),
    expanded: header.querySelector(".machine-toggle")!.getAttribute("aria-expanded") === "true",
  };
}, pc);

/** How many agent rows the Agents list holds for one PC (each PC of the fixture runs the demo's agents). */
const agentRowsOn = (page: Page, machine: string) => page.locator(`.agents-sidebar .agent-item[data-machine="${machine}"]`).count();

/** A list's edge fades as painted: the mask's fade at each edge in px (0 is none), and how far it scrolls. */
const fades = (page: Page, list: string) => page.locator(list).evaluate((element) => {
  const style = getComputedStyle(element);
  const masked = style.maskImage !== "none" && style.maskImage !== "";
  return {
    top: masked ? parseFloat(style.getPropertyValue("--fade-top")) || 0 : 0,
    bottom: masked ? parseFloat(style.getPropertyValue("--fade-bottom")) || 0 : 0,
    scroll: element.scrollTop,
    max: element.scrollHeight - element.clientHeight,
  };
});

/** Scrolls a list to a share of its scroll, then waits (on the list's own state, no fixed sleep) for its fades. */
async function expectFades(page: Page, list: string, at: number | null, want: { top: boolean; bottom: boolean }, message: string): Promise<void> {
  if (at !== null) await page.locator(list).evaluate((element, at) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * at; }, at);
  try {
    await page.waitForFunction(({ list, want }) => {
      const element = document.querySelector(list)!;
      const style = getComputedStyle(element);
      const edge = (name: string) => style.maskImage !== "none" && (parseFloat(style.getPropertyValue(name)) || 0) > 0;
      return edge("--fade-top") === want.top && edge("--fade-bottom") === want.bottom;
    }, { list, want }, { timeout: 2_000 });
  } catch {
    assert.fail(`${message}: wanted ${JSON.stringify(want)}, painted ${JSON.stringify(await fades(page, list))}`);
  }
}

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "two-pcs.js"), TWO_PCS);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./two-pcs.js"></script><script type="module"'));
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
    let hybridBrowser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      /** Each check is a fresh device: its own preferences, nothing shared with the last. */
      const check = async (name: string, scene: Scene, run: (page: Page, label: string) => Promise<void>) => {
        if (only !== undefined && !name.includes(only)) return;
        const phone = scene.width <= 768;
        const label = `${name} ${scene.width}/${scene.mode}${scene.twoPcs ? "/two-pcs" : ""}${scene.grouped ? "/agents-first" : ""}${scene.forcedColors ? "/forced-colors" : ""}${scene.hybrid ? "/hybrid" : ""}`;
        if (scene.hybrid) hybridBrowser ??= await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", HYBRID] });
        const context = await (scene.hybrid ? hybridBrowser! : browser).newContext({ viewport: { width: scene.width, height: scene.height ?? 844 }, colorScheme: scene.mode, hasTouch: phone, isMobile: phone, deviceScaleFactor: 1, forcedColors: scene.forcedColors ? "active" : "none", locale: "en-US" });
        try {
          await context.addInitScript((scene) => {
            if (localStorage.getItem("heads-fixture:ready") === "1") return;
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: scene.mode, palette: "codex", defaultView: "chat" }));
            localStorage.setItem("ovis:agents-collapsed", "0");
            localStorage.setItem("ovis:agent-groups", String(scene.grouped === true));
            if (scene.twoPcs) localStorage.setItem("heads-fixture:two-pcs", "1");
            if (scene.workOffline) localStorage.setItem("heads-fixture:work-offline", "1");
            for (const [key, value] of Object.entries(scene.storage ?? {})) localStorage.setItem(key, value);
            localStorage.setItem("heads-fixture:ready", "1");
          }, scene);
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          if (phone) {
            await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
            // CDP touch dispatch has no actionability wait: wait for the drawer's slide to reach the screen
            await page.waitForFunction(() => (document.querySelector(".sidebar.is-open")?.getBoundingClientRect().left ?? -1) >= -0.5);
          }
          await page.locator(".agents-sidebar .agent-item").first().waitFor({ state: "attached" });
          if (scene.twoPcs) await page.waitForFunction((offline) => document.querySelectorAll(".machine-list .machine-group .machine-workspaces").length === 2 && document.querySelectorAll(".machine-list .machine-group.is-offline").length === offline, scene.workOffline ? 1 : 0);
          await page.evaluate(() => document.fonts.ready);
          await run(page, label);
          assert.deepEqual(errors, [], `${label}: no browser errors`);
          console.log(`PASS ${label}`);
        } finally { await context.close(); }
      };
      const shot = async (page: Page, name: string, scene: Scene) => {
        if (!evidence) return;
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `heads-${scene.width}-${scene.mode}-${name}.png`), animations: "disabled" });
      };

      for (const width of [1280, 390]) for (const mode of ["light", "dark"] as const) {
        for (const grouped of [false, true]) {
          const scene: Scene = { width, mode, twoPcs: true, grouped };
          await check("section heads show their carets, with no count", scene, async (page, label) => {
            // the drawer starts Agents folded on a phone; open both for the first look
            const agentsToggle = page.locator(".agent-section-toggle");
            if (await agentsToggle.getAttribute("aria-expanded") !== "true") await agentsToggle.click();
            const open = await heads(page);
            assert.ok(open.agentRows > 0 && open.machines === 2, `${label}: the fixture shows two PCs and agents`);
            assert.equal(open.pcsHead, 0, `${label}: the PCs have no head, no caret and no count`);
            assert.equal(open.agentsCaret, true, `${label}: the open Agents head shows its caret at rest`);
            // the compact list (the default) is herdr-app's: its head says no count, open or folded
            assert.equal(open.agentsCount, null, `${label}: the open Agents head says no count`);
            if (!grouped) await shot(page, "open", scene);
            await agentsToggle.click();
            const folded = await heads(page);
            assert.ok(folded.agentsFolded, `${label}: the Agents head folds`);
            assert.equal(folded.machines, 2, `${label}: the PCs stay listed`);
            assert.equal(folded.agentsCaret, true, `${label}: the folded Agents head shows its caret`);
            assert.equal(folded.agentsCount, null, `${label}: the folded Agents head says no count either`);
          });
        }
        await check("a PC header trades its agent count for its actions", { width, mode, twoPcs: true }, async (page, label) => {
          const phone = width <= 768;
          const agentsOnWork = await agentRowsOn(page, "work");
          assert.ok(agentsOnWork > 0, `${label}: Work PC runs agents`);
          // the header in view, and the pointer resting away from the sidebar
          await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-header').scrollIntoViewIfNeeded();
          if (!phone) await page.mouse.move(width - 8, 600);
          const rest = await pcHeader(page, "Work PC");
          // the words count the PC's agents whatever they are doing: a resting one is not "running"
          assert.equal(rest.countWords, `${agentsOnWork} agents`, `${label}: the count's words say what it counts`);
          // no tooltip: a pointer never reaches the count (it lets presses through to the + under it, and a hover hides it)
          assert.equal(rest.countTitle, null, `${label}: the count claims no tooltip a pointer cannot reach`);
          if (phone) {
            // under a finger nothing hovers: the actions always show, a finger's size, and the count stays out
            assert.equal(rest.count, null, `${label}: no count in view under a finger`);
            assert.ok(rest.toggle && rest.add, `${label}: the fold and + show under a finger`);
            assert.ok(rest.addBox!.width >= 44 && rest.addBox!.height >= 44, `${label}: the + is a finger's 44 px (${rest.addBox!.width}x${rest.addBox!.height})`);
          } else {
            assert.equal(rest.count, String(agentsOnWork), `${label}: at rest the header counts its PC's agents`);
            assert.ok(!rest.toggle && !rest.add, `${label}: at rest the fold and + are out of sight`);
            assert.ok(rest.toggleBox!.width > 0 && rest.addBox!.width > 0, `${label}: the unseen fold and + keep their cells`);
            assert.ok(Math.abs((rest.countBox!.left + rest.countBox!.width / 2) - (rest.addBox!.left + rest.addBox!.width / 2)) <= 1, `${label}: the count sits in the +'s cell`);
            const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".machine-new, .machine-agent-count")?.className ?? null, { x: rest.countBox!.left + rest.countBox!.width / 2, y: rest.countBox!.top + rest.countBox!.height / 2 });
            assert.match(hit ?? "", /\bmachine-new\b/, `${label}: a press on the count lands on the + under it (${hit})`);
            await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-name').hover();
            const hovered = await pcHeader(page, "Work PC");
            assert.equal(hovered.count, null, `${label}: a hover takes the count away`);
            assert.ok(hovered.toggle && hovered.add, `${label}: a hover shows the fold and +`);
            assert.deepEqual(hovered.name, rest.name, `${label}: the name never moves`);
            await page.mouse.move(width - 8, 600);
            assert.equal((await pcHeader(page, "Work PC")).count, String(agentsOnWork), `${label}: the count comes back when the pointer leaves`);
            // the keyboard: the focus coming into the first PC's header shows its actions
            await page.locator('section.machine-group[aria-label="PC Laptop"] .machine-header').locator(':is(button, [role="button"][tabindex="0"])').first().focus();
            assert.equal(await page.evaluate(() => document.activeElement?.closest("section.machine-group")?.getAttribute("aria-label")), "PC Laptop", `${label}: the focus is in the first PC's header`);
            const focused = await pcHeader(page, "Laptop");
            assert.equal(focused.count, null, `${label}: the focus in a header takes its count away`);
            assert.ok(focused.toggle && focused.add, `${label}: the focus in a header shows its fold and +`);
            await shot(page, "pc-header-focus", { width, mode });
            await page.keyboard.press("Shift+Tab");
            assert.equal((await pcHeader(page, "Laptop")).count, String(await agentRowsOn(page, "local")), `${label}: the count comes back when the focus leaves`);
          }
          // a pointer on the name folds the PC as its caret does
          await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-name').click();
          assert.equal((await pcHeader(page, "Work PC")).expanded, false, `${label}: a press on the name folds the PC`);
          await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-name').click();
          assert.equal((await pcHeader(page, "Work PC")).expanded, true, `${label}: a second press opens it again`);
        });
        await check("a folded PC is one row, an open one ends with a short gap", { width, mode, twoPcs: true }, async (page, label) => {
          const rows = () => page.evaluate(() => {
            const box = (element: Element) => element.getBoundingClientRect();
            const [laptop, work] = [...document.querySelectorAll(".machine-list section.machine-group")];
            const lastRow = laptop!.querySelector(".machine-workspaces");
            return {
              head: box(document.querySelector(".machine-list")!).top,
              first: box(laptop!).top,
              laptop: { top: box(laptop!).top, bottom: box(laptop!).bottom, header: box(laptop!.querySelector(".machine-header")!).height, lastRow: lastRow ? box(lastRow).bottom : null },
              work: { top: box(work!).top, bottom: box(work!).bottom, header: box(work!.querySelector(".machine-header")!).height },
              // a connected PC's state line is clipped: it keeps no height of its own to lengthen the scroll
              clippedState: Math.max(...[...document.querySelectorAll(".machine-list .machine-state.visually-hidden")].map((line) => box(line).height)),
            };
          });
          const open = await rows();
          assert.ok(Math.abs(open.first - open.head) <= 1, `${label}: the first PC starts the list, with no PCs head above it (${open.first - open.head}px)`);
          assert.ok(open.clippedState <= 1, `${label}: a clipped state line is ${open.clippedState}px tall`);
          assert.ok(open.laptop.lastRow !== null && Math.abs(open.work.top - open.laptop.lastRow - 8) <= 1, `${label}: an open PC ends a --space-2 gap before the next PC (${open.laptop.lastRow === null ? "no rows" : open.work.top - open.laptop.lastRow}px)`);
          for (const pc of ["Laptop", "Work PC"]) await page.getByRole("button", { name: `Collapse ${pc}`, exact: true }).click();
          await page.waitForFunction(() => !document.querySelector(".machine-list .machine-workspaces"));
          const folded = await rows();
          assert.ok(Math.abs(folded.laptop.bottom - folded.laptop.top - folded.laptop.header) <= 1, `${label}: a folded PC is one row (${folded.laptop.bottom - folded.laptop.top}px for a ${folded.laptop.header}px header)`);
          assert.ok(Math.abs(folded.work.top - folded.laptop.bottom) <= 1, `${label}: no gap between folded PCs (${folded.work.top - folded.laptop.bottom}px)`);
          await shot(page, "pcs-folded", { width, mode });
        });
        await check("each list fades only at an edge with rows past it", { width, mode, twoPcs: true, height: 640 }, async (page, label) => {
          const agentsToggle = page.locator(".agent-section-toggle");
          if (await agentsToggle.getAttribute("aria-expanded") !== "true") await agentsToggle.click();
          // Resting agents now start folded; this scenario needs their rows to exercise real overflow.
          await page.locator(".agent-resting-label button").click();
          assert.equal(await page.locator(".agent-resting-label button").getAttribute("aria-expanded"), "true");
          for (const list of [".machine-list", ".agent-list-contents"]) {
            const start = await fades(page, list);
            assert.ok(start.max > 40, `${label}: ${list} holds more rows than it shows (${start.max}px to scroll)`);
            await expectFades(page, list, 0, { top: false, bottom: true }, `${label}: ${list} at its top fades its foot alone`);
            await expectFades(page, list, 0.5, { top: true, bottom: true }, `${label}: ${list} in its middle fades both edges`);
            if (list === ".agent-list-contents") await shot(page, "fades-middle", { width, mode });
            await expectFades(page, list, 1, { top: true, bottom: false }, `${label}: ${list} at its end fades its head alone`);
          }
          // every PC folded, and the PC list holds all its rows: no fade
          await page.locator(".machine-list").evaluate((element) => { element.scrollTop = 0; });
          for (const pc of ["Laptop", "Work PC"]) await page.getByRole("button", { name: `Collapse ${pc}`, exact: true }).click();
          await page.waitForFunction(() => !document.querySelector(".machine-list .machine-workspaces"));
          // a window tall enough for both folded PCs beside the open Agents
          await page.setViewportSize({ width, height: 900 });
          await page.waitForFunction(() => { const list = document.querySelector(".machine-list")!; return list.scrollHeight - list.clientHeight <= 1; });
          await expectFades(page, ".machine-list", null, { top: false, bottom: false }, `${label}: a PC list that holds all its rows fades neither edge`);
        });
        await check("a short Agents list fades neither edge", { width, mode, height: 1000 }, async (page, label) => {
          const agentsToggle = page.locator(".agent-section-toggle");
          if (await agentsToggle.getAttribute("aria-expanded") !== "true") await agentsToggle.click();
          assert.ok((await fades(page, ".agent-list-contents")).max <= 1, `${label}: the demo's agents fit their list`);
          await expectFades(page, ".agent-list-contents", null, { top: false, bottom: false }, `${label}: an Agents list that holds all its rows fades neither edge`);
        });
        await check("a disconnected PC's disabled + stays dimmed when shown", { width, mode, twoPcs: true, workOffline: true }, async (page, label) => {
          const header = page.locator('section.machine-group[aria-label="PC Work PC"] .machine-header');
          const add = header.locator(".machine-new");
          await header.scrollIntoViewIfNeeded();
          assert.equal(await add.isDisabled(), true, `${label}: the offline PC's + is disabled`);
          // its snapshot is the last one seen: it counts no agents as running now
          assert.equal((await pcHeader(page, "Work PC")).countWords, null, `${label}: a disconnected PC says no agents running`);
          if (width > 768) {
            await page.mouse.move(width - 8, 600);
            assert.equal((await pcHeader(page, "Work PC")).count, null, `${label}: at rest a disconnected PC shows no agent count`);
            assert.equal(await add.evaluate((element) => getComputedStyle(element).opacity), "0", `${label}: at rest the + is out of sight`);
            await header.locator(".machine-name").hover();
          }
          const opacity = Number(await add.evaluate((element) => getComputedStyle(element).opacity));
          assert.ok(opacity > 0.3 && opacity < 0.9, `${label}: the shown disabled + keeps its dim (${opacity})`);
        });
        await check("a lone Host has no head at all", { width, mode }, async (page, label) => {
          const lone = await heads(page);
          assert.equal(await page.locator(".machine-group .machine-header").count(), 0, `${label}: the lone Host has no header`);
          assert.equal(lone.pcsHead, 0, `${label}: and no PCs head above it`);
        });
      }
      // a fine pointer with a touch screen beside it: a finger may come next, so the actions never hide
      for (const mode of ["light", "dark"] as const) await check("a hybrid device always shows a PC's actions", { width: 1280, mode, twoPcs: true, hybrid: true }, async (page, label) => {
        assert.deepEqual(await page.evaluate(() => [matchMedia("(hover: hover) and (pointer: fine)").matches, matchMedia("(any-pointer: coarse)").matches]), [true, true], `${label}: the browser answers as a hybrid device`);
        await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-header').scrollIntoViewIfNeeded();
        await page.mouse.move(1272, 600);
        const rest = await pcHeader(page, "Work PC");
        assert.ok(rest.toggle && rest.add, `${label}: at rest the fold and + show`);
        const manage = await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-manage').evaluate((button) => { const box = button.getBoundingClientRect(); return { width: box.width, opacity: getComputedStyle(button).opacity }; });
        assert.ok(manage.width > 0 && manage.opacity === "1", `${label}: at rest Manage shows too: ${JSON.stringify(manage)}`);
        assert.equal(rest.count, null, `${label}: no count in view over the actions`);
        assert.equal(rest.countWords, `${await agentRowsOn(page, "work")} agents`, `${label}: a screen reader still hears the count`);
      });
      // forced colors paint every edge in full: a fade there is only lost text
      await check("forced colors fade no edge", { width: 1280, mode: "dark", twoPcs: true, height: 640, forcedColors: true }, async (page, label) => {
        await page.locator(".machine-list").evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
        await page.waitForFunction(() => document.querySelector(".machine-list")!.scrollTop > 0);
        for (const list of [".machine-list", ".agent-list-contents"]) {
          assert.equal(await page.locator(list).evaluate((element) => getComputedStyle(element).maskImage), "none", `${label}: ${list} has no mask`);
        }
      });
    } finally { await browser.close(); await hybridBrowser?.close(); }
  } finally { server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
