/**
 * The first-run setup guide as a dialog (components/SetupGuide.tsx), on the unmodified app over the demo's
 * fixture transport (no herdr), at 1920x1080, 1280x720 and 390x844, dark and light:
 *
 * - A fresh run's guide is a modal dialog named "Set up Ovis" over the app, not a page in the main area: at
 *   1920x1080 it is the 1200x675 16:9 card in the middle of the window, at 1280x720 the same card with no
 *   scroll, and at 390 the app's bottom sheet. It opens on the agent step, the keyboard on its title, Tab stays inside it,
 *   and its close button is named.
 * - The fast path is Continue three times, then Start on Done, which
 *   opens a new workspace with the agent picked for you (one more in the sidebar) and closes the guide.
 * - The full path: Continue leads to the theme step, whose cards are a radio group (an arrow picks the next
 *   theme and the whole app takes it at once, the side panel naming it), then to Done, whose Start opens the workspace with
 *   <agent> is the step's one primary button and whose list names the theme picked. Between the theme and Done,
 *   Phone and alerts: Settings' Alert me when chips with their defaults, Send test showing one alert on this
 *   computer at once (notifications recorded, none reach the desktop), the phone beside them; Done lists the
 *   alerts chosen and offers the phone left for later. The head lists the
 *   steps, the current one marked. Back returns to the theme, then to the agents, and Escape closes the guide and records it closed (a reload shows no guide).
 *
 * With UI_EVIDENCE_DIR, each state is captured under setup-dialog/.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openSettingsPage } from "./settings-page.ts";

const app = mkdtempSync(join(tmpdir(), "ovis-setup-dialog-"));
const evidence = process.env["UI_EVIDENCE_DIR"] ? join(process.env["UI_EVIDENCE_DIR"], "setup-dialog") : null;
if (evidence) mkdirSync(evidence, { recursive: true });
const DIALOG = "Set up Ovis";
const WELCOME = JSON.stringify({ status: "open", state: { step: "welcome" } });
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity)).map((animation) => animation.finished.catch(() => undefined))).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
/** the name of the element that has the keyboard: its aria-label, else its text */
const focusedName = (page: Page) => page.evaluate(() => {
  const active = document.activeElement as HTMLElement | null;
  return active === null ? "" : (active.getAttribute("aria-label") ?? active.innerText ?? "").replace(/\s+/g, " ").trim();
});


/**
 * A stand-in push service, put in after the demo transport as push-health-demo-regression.ts puts its own: Turn on
 * alerts makes a subscription the demo's server takes, unless `pushStandIn.fails` is set (Brave with push off).
 */
const PUSH_STAND_IN = `<script>(() => {
  const push = { fails: false };
  window.pushStandIn = push;
  let live = null;
  const pushManager = {
    getSubscription: async () => live,
    subscribe: async (options) => {
      if (push.fails) throw new DOMException("push service off", "NotAllowedError");
      const endpoint = "https://push.example.test/demo/setup-guide";
      live = { endpoint, options: { applicationServerKey: options.applicationServerKey }, unsubscribe: async () => { live = null; return true; }, toJSON: () => ({ endpoint, keys: { p256dh: "guide-p256dh", auth: "guide-auth" } }) };
      return live;
    },
  };
  if (!("serviceWorker" in navigator)) return;
  Object.defineProperty(globalThis, "PushManager", { value: class PushManager {}, configurable: true });
  const registration = { pushManager, showNotification: (title) => { (window.shownAlerts ?? []).push(title); return Promise.resolve(); } };
  Object.defineProperty(navigator.serviceWorker, "ready", { value: Promise.resolve(registration), configurable: true });
  Object.defineProperty(navigator.serviceWorker, "getRegistration", { value: async () => registration, configurable: true });
})();</script>`;

let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${PUSH_STAND_IN}\n    <script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    // the app's mark is addressed from the root, where a real server keeps it
    if (path.startsWith("/icons/")) { const icon = Bun.file(join(app, path)); return (await icon.exists()) ? new Response(icon) : new Response("not found", { status: 404 }); }
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const root = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const sizes = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 390, height: 844, phone: true },
  ] as const;
  for (const size of sizes) {
    for (const theme of ["dark", "light"] as const) {
      const at = `${size.width}x${size.height}-${theme}`;
      const phone = "phone" in size;
      const context = await browser.newContext(phone
        ? { viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "en-US", colorScheme: theme }
        : { viewport: { width: size.width, height: size.height }, locale: "en-US", colorScheme: theme });
      await context.addInitScript(([value, guide]) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
        // a fresh run's guide, once: a reload keeps what the page wrote since
        if (sessionStorage.getItem("seeded") === null) { localStorage.setItem("ovis:setup-guide", guide); sessionStorage.setItem("seeded", "1"); }
      }, [theme, WELCOME] as const);
      // notifications allowed, and every one shown is recorded instead of reaching the desktop
      await context.addInitScript(() => {
        const shown: string[] = [];
        (window as unknown as { shownAlerts: string[] }).shownAlerts = shown;
        // not yet asked: the guide asks only on Turn on alerts, and each ask is counted
        const asked = { count: 0 };
        (window as unknown as { permissionAsks: typeof asked }).permissionAsks = asked;
        class RecordedNotification { static permission: NotificationPermission = "default"; static requestPermission = () => { asked.count += 1; RecordedNotification.permission = "granted"; return Promise.resolve("granted" as NotificationPermission); }; constructor(title: string) { shown.push(title); } addEventListener() {} close() {} }
        Object.defineProperty(window, "Notification", { value: RecordedNotification, configurable: true });
        if (typeof ServiceWorkerRegistration !== "undefined") ServiceWorkerRegistration.prototype.showNotification = function (title: string) { shown.push(title); return Promise.resolve(); };
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (name: string) => { if (evidence) { await settled(page); await page.screenshot({ path: join(evidence, `${name}-${at}.png`) }); } };
      try {
        await page.goto(root);
        const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
        await dialog.waitFor();
        await settled(page);
        assert.equal(await dialog.getAttribute("aria-modal"), "true", `the guide is a modal dialog ${at}`);
        assert.equal(await page.getByRole("region", { name: "Setup guide", exact: true }).count(), 0, `no in-page guide ${at}`);
        const box = (await dialog.boundingBox())!;
        if (size.width === 1920) {
          assert.deepEqual([Math.round(box.width), Math.round(box.height) <= 675 && Math.round(box.height) >= 440], [1200, true], `a 1200-wide card no taller than 675 at 1920x1080 ${at}`);
          assert.ok(Math.abs(box.x + box.width / 2 - size.width / 2) <= 1 && Math.abs(box.y + box.height / 2 - size.height / 2) <= 1, `centred ${at}: ${JSON.stringify(box)}`);
        } else if (!phone) {
          assert.deepEqual([Math.round(box.width), Math.round(box.height) <= 675 && Math.round(box.height) >= 440], [1200, true], `the same card at 1280x720 ${at}`);
        } else {
          assert.ok(Math.abs(box.y + box.height - size.height) <= 1 && Math.round(box.width) === size.width, `a bottom sheet at 390 ${at}: ${JSON.stringify(box)}`);
        }
        // the keyboard starts on the first choice and Tab stays in the dialog
        // the first real choice opens: the agent step, its title with the keyboard, Tab inside the dialog
        const title = dialog.getByRole("heading", { name: "Pick an agent", exact: true });
        await title.waitFor();
        await dialog.locator(".setup-found .setup-tile").first().waitFor();
        await settled(page);
        assert.equal(await focusedName(page), "Pick an agent", `the step's title takes the keyboard ${at}`);
        const order: string[] = [];
        for (let step = 0; step < 14; step++) {
          await page.keyboard.press("Tab");
          order.push(await focusedName(page));
          assert.ok(await page.evaluate(() => document.activeElement?.closest(".setup-dialog") != null), `Tab stays in the dialog ${at}: ${order.join(" | ")}`);
        }
        assert.ok(order.includes("Set up later") && order.includes("Close setup"), `Tab reaches Set up later and Close setup ${at}: ${order.join(" | ")}`);
        await dialog.getByRole("heading", { name: "Pick an agent", exact: true }).focus();
        const footer = dialog.locator(".setup-foot");
        assert.deepEqual((await footer.getByRole("button").allInnerTexts()).map((text) => text.trim()), ["Set up later", "Continue"], `the agent step's footer ${at}`);
        assert.equal(await dialog.locator(".btn-primary").count(), 1, `one primary button on the agent step ${at}`);
        assert.ok(await dialog.locator(".setup-side").getByText("Claude Code", { exact: true }).count() > 0, `the side panel names the agent picked for you ${at}`);
        if (!phone) {
          const body = dialog.locator(".setup-body");
          assert.equal(await body.evaluate((node) => node.scrollHeight <= node.clientHeight + 1), true, `the agent step needs no scroll ${at}`);
        }
        await shot("2-agent");

        const steps = dialog.getByRole("list", { name: "Steps", exact: true });
        assert.equal((await steps.locator('[aria-current="step"]').textContent())?.replace(/\s+/g, ""), "Agent", `the head marks Agent as the current step ${at}`);

        // Continue: the theme step. Its cards are a radio group; an arrow picks the next card and the app takes it at once
        await footer.getByRole("button", { name: "Continue", exact: true }).click();
        const look = dialog.getByRole("heading", { name: "Pick a look", exact: true });
        await look.waitFor();
        await settled(page);
        assert.equal(await focusedName(page), "Pick a look", `the theme step's title takes the keyboard ${at}`);
        assert.equal((await steps.locator('[aria-current="step"]').textContent())?.replace(/\s+/g, ""), "Theme", `the head marks Theme as the current step ${at}`);
        const side = theme === "dark" ? "Dark theme" : "Light theme";
        const cards = dialog.getByRole("radiogroup", { name: side, exact: true });
        assert.equal(await cards.getByRole("radio", { checked: true }).count(), 1, `one theme checked ${at}`);
        assert.equal((await dialog.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { pressed: true }).innerText()).trim(), theme === "dark" ? "Dark" : "Light", `the mode shows ${at}`);
        const paletteBefore = await page.evaluate(() => document.documentElement.dataset["palette"]);
        await cards.getByRole("radio", { checked: true }).focus();
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction((before) => document.documentElement.dataset["palette"] !== before, paletteBefore);
        const picked = (await cards.getByRole("radio", { checked: true }).innerText()).trim();
        assert.equal(await focusedName(page), picked, `the arrow moves the keyboard with the pick ${at}`);
        assert.ok(await dialog.locator(".setup-side").getByText(picked).count() > 0, `the side panel names the theme picked ${at}`);
        await shot("3-theme");

        // Continue: phone and alerts. This computer's chips are Settings' own, and Send test shows one alert here at once
        await footer.getByRole("button", { name: "Continue", exact: true }).click();
        const touch = dialog.getByRole("heading", { name: "Stay in touch", exact: true });
        await touch.waitFor();
        await settled(page);
        assert.equal(await focusedName(page), "Stay in touch", `the phone and alerts step's title takes the keyboard ${at}`);
        assert.equal((await steps.locator('[aria-current="step"]').textContent())?.replace(/\s+/g, ""), "Phoneandalerts", `the head marks Phone and alerts as the current step ${at}`);
        // nothing asked the browser for permission on the way here; Turn on alerts asks it once
        const asks = () => page.evaluate(() => (window as unknown as { permissionAsks: { count: number } }).permissionAsks.count);
        assert.equal(await asks(), 0, `no permission asked before Turn on alerts ${at}`);
        await dialog.getByRole("button", { name: "Turn on alerts", exact: true }).click();
        await dialog.getByRole("button", { name: "Send test", exact: true }).waitFor();
        assert.equal(await asks(), 1, `Turn on alerts asks for permission once ${at}`);
        const chips = dialog.getByRole("group", { name: "Alert me when", exact: true });
        assert.deepEqual((await chips.getByRole("button", { pressed: true }).allInnerTexts()).map((text) => text.trim()), ["Needs input", "Needs permission", "Long turn finished"], `the default alerts ${at}`);
        await dialog.getByRole("button", { name: "Send test", exact: true }).click();
        await dialog.getByRole("status").filter({ hasText: "Sent. Check your screen." }).waitFor();
        assert.deepEqual(await page.evaluate(() => (window as unknown as { shownAlerts: string[] }).shownAlerts), ["Test alert"], `Send test shows one alert ${at}`);
        assert.ok(await dialog.locator(".setup-side").getByText("On your phone", { exact: true }).count() > 0, `the phone is beside the alerts ${at}`);
        await chips.getByRole("button", { name: "Any turn finished", exact: true }).click();
        await shot("4-phone-alerts");

        // Continue: Done, its Start the one primary, the choices made listed; Back returns to each step in turn
        await footer.getByRole("button", { name: "Continue", exact: true }).click();
        await dialog.getByRole("heading", { name: "Ovis is ready", exact: true }).waitFor();
        await settled(page);
        assert.equal(await focusedName(page), "Ovis is ready", `Done's title takes the keyboard ${at}`);
        const primary = dialog.locator(".btn-primary");
        assert.equal(await primary.count(), 1, `one primary button on Done ${at}`);
        assert.equal((await primary.innerText()).trim(), "Start", `Done's Start ${at}`);
        assert.ok(await dialog.locator(".setup-summary").getByText(picked, { exact: false }).count() > 0, `Done lists the theme picked ${at}`);
        assert.equal(await steps.locator("li.is-done").count(), 3, `every step is marked done on Done ${at}`);
        const summary = dialog.locator(".setup-summary");
        assert.ok(await summary.getByText("Needs input, Needs permission, Any turn finished", { exact: true }).count() > 0, `Done lists the alerts chosen ${at}`);
        assert.ok(await summary.getByRole("button", { name: "Connect now", exact: true }).count() > 0, `Done offers the phone left for later ${at}`);
        await shot("5-done");
        await dialog.locator(".setup-foot").getByRole("button", { name: "Back", exact: true }).click();
        await touch.waitFor();
        await dialog.locator(".setup-foot").getByRole("button", { name: "Back", exact: true }).click();
        await look.waitFor();
        await dialog.locator(".setup-foot").getByRole("button", { name: "Back", exact: true }).click();
        await title.waitFor();

        if (size.width === 1920) {
          // the fast path from a fresh first run: Continue three times and Start (four presses) open a workspace and close the guide
          await page.evaluate((guide) => localStorage.setItem("ovis:setup-guide", guide), WELCOME);
          await page.reload();
          await title.waitFor();
          const workspaces = page.locator(".workspace-group[data-workspace]");
          const before = await workspaces.count();
          // the fast path: Continue through theme and phone and alerts with nothing chosen, then Start (four presses)
          for (let press = 0; press < 3; press++) await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
          await dialog.getByRole("heading", { name: "Ovis is ready", exact: true }).waitFor();
          await dialog.locator(".setup-foot").getByRole("button", { name: "Start", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
          await page.waitForFunction((count) => document.querySelectorAll(".workspace-group[data-workspace]").length > count, before);
          assert.equal(JSON.parse((await page.evaluate(() => localStorage.getItem("ovis:setup-guide"))) ?? "{}").status, "closed", `the fast path closes the guide ${at}`);
          // a first run whose agent started: the first-start hints wait for its workspace, and the sidebar's setup row may show
          assert.deepEqual(await page.evaluate(() => [localStorage.getItem("ovis:first-hints"), localStorage.getItem("ovis:setup-row")]), ["pending", "on"], `the fast path arms the hints and the setup row ${at}`);
          await shot("6-started");
          console.log(`PASS the guide is a 1200x675 dialog, keyboard inside it, and the fast path opens the first workspace in four presses (${at})`);

          // stepped aside (a pane picked from the palette over it) the guide is no modal: the app's own check for one
          // (modalOpen: the terminal's focus, the drawer, Escape) finds nothing, and Back to setup brings it back
          await page.evaluate((guide) => localStorage.setItem("ovis:setup-guide", guide), WELCOME);
          await page.reload();
          await title.waitFor();
          await page.keyboard.press("Control+Shift+K");
          await page.getByRole("searchbox").fill("Guard the export button");
          await page.getByRole("option").filter({ hasText: "Guard the export button" }).first().click();
          await page.locator(".setup-scrim").waitFor({ state: "hidden" });
          assert.equal(await page.evaluate(() => document.querySelector("[aria-modal='true'], dialog[open]") === null), true, `a stepped-aside guide leaves no modal for the app's checks ${at}`);
          assert.equal(await page.locator(".setup-dialog[role='dialog']").count(), 0, `a stepped-aside guide is no dialog ${at}`);
          await page.getByRole("button", { name: "Back to setup", exact: true }).click();
          await dialog.waitFor();
          assert.equal(await dialog.getAttribute("aria-modal"), "true", `resumed, the guide is a modal dialog again ${at}`);
          console.log(`PASS a stepped-aside guide is no modal dialog, and Back to setup makes it one again (${at})`);

          if (theme === "dark") {
            // the theme step's keys and links: Home and End pick the first and last card, Show all themes reveals the
            // rest with the keyboard on the first revealed, a theme saved beyond the first six keeps its card after an
            // arrow moves off it, and the mode switch draws the other side's cards (#3885 review)
            await page.evaluate((guide) => localStorage.setItem("ovis:setup-guide", guide), WELCOME);
            await page.reload();
            await title.waitFor();
            await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
            await dialog.getByRole("heading", { name: "Pick a look", exact: true }).waitFor();
            const grid = dialog.getByRole("radiogroup", { name: "Dark theme", exact: true });
            const radios = grid.getByRole("radio");
            await grid.getByRole("radio", { checked: true }).focus();
            await page.keyboard.press("End");
            assert.equal(await grid.getByRole("radio", { checked: true }).innerText(), await radios.last().innerText(), `End picks the last card ${at}`);
            await page.keyboard.press("Home");
            assert.equal(await grid.getByRole("radio", { checked: true }).innerText(), await radios.first().innerText(), `Home picks the first card ${at}`);
            const six = await radios.count();
            await dialog.getByRole("button", { name: "Show all themes", exact: true }).click();
            await page.waitForFunction((count) => document.querySelectorAll(".setup-theme-cards [role='radio']").length > count, six);
            const firstSix = (await radios.allInnerTexts()).slice(0, six);
            assert.ok(!firstSix.includes(await focusedName(page)), `Show all themes puts the keyboard on the first theme it revealed ${at}`);
            await grid.locator("[data-theme-card='nord']").click();
            // back and on again: the grid is six again, with Nord kept as the saved one
            await dialog.locator(".setup-foot").getByRole("button", { name: "Back", exact: true }).click();
            await title.waitFor();
            await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
            await dialog.getByRole("heading", { name: "Pick a look", exact: true }).waitFor();
            const nord = grid.locator("[data-theme-card='nord']");
            assert.equal(await nord.getAttribute("aria-checked"), "true", `Nord is checked ${at}`);
            await nord.focus();
            await page.keyboard.press("ArrowRight");
            await page.waitForFunction(() => document.querySelector("[data-theme-card='nord']")?.getAttribute("aria-checked") === "false");
            assert.equal(await nord.count(), 1, `a saved theme beyond the first six keeps its card after an arrow moves off it ${at}`);
            // the mode switch draws the light side's cards, and back
            const mode = dialog.getByRole("group", { name: "Theme", exact: true });
            await mode.getByRole("button", { name: "Light", exact: true }).click();
            await dialog.getByRole("radiogroup", { name: "Light theme", exact: true }).waitFor();
            // Nord, kept on the dark side, is no stray card in the light list (#3894 review)
            assert.equal(await dialog.getByRole("radiogroup", { name: "Light theme", exact: true }).locator("[data-theme-card='nord']").count(), 0, `a theme kept on the dark side is not in the light list ${at}`);
            await mode.getByRole("button", { name: "Dark", exact: true }).click();
            await grid.waitFor();
            // on System, the computer turning light under a focused dark card: the keyboard goes to the light side's cards
            await mode.getByRole("button", { name: "System", exact: true }).click();
            // Black is drawn on the dark side only, so it is gone once the computer turns light
            await grid.locator("[data-theme-card='black']").click();
            await grid.locator("[data-theme-card='black']").focus();
            assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-theme-card")), "black", `Black has the keyboard ${at}`);
            await page.emulateMedia({ colorScheme: "light" });
            const lightGrid = dialog.getByRole("radiogroup", { name: "Light theme", exact: true });
            await lightGrid.waitFor();
            await page.waitForFunction(() => document.activeElement?.closest("[role='radiogroup']")?.getAttribute("aria-label") === "Light theme");
            await page.emulateMedia({ colorScheme: "dark" });
            await mode.getByRole("button", { name: "Dark", exact: true }).click();
            await grid.waitFor();
            console.log(`PASS the theme step's Home and End, Show all themes, a saved theme beyond the first six, the mode switch, and the keyboard kept when the computer turns light (${at})`);

            // push refused by the push service: Turn on alerts says why in Settings' words, stays to try again, and Done
            // does not list alerts as on (#3894 review)
            await page.evaluate((guide) => { localStorage.setItem("ovis:setup-guide", guide); (window as unknown as { pushStandIn: { fails: boolean } }).pushStandIn.fails = true; }, WELCOME);
            await page.reload();
            await page.evaluate(() => { (window as unknown as { pushStandIn: { fails: boolean } }).pushStandIn.fails = true; });
            await title.waitFor();
            for (const heading of ["Pick a look", "Stay in touch"]) {
              await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
              await dialog.getByRole("heading", { name: heading, exact: true }).waitFor();
            }
            await dialog.getByRole("button", { name: "Turn on alerts", exact: true }).click();
            await dialog.getByRole("status").filter({ hasText: "push subscription" }).waitFor();
            assert.equal(await dialog.getByRole("button", { name: "Turn on alerts", exact: true }).count(), 1, `Turn on alerts stays after push failed ${at}`);
            assert.equal(await dialog.getByRole("button", { name: "Send test", exact: true }).count(), 0, `no Send test while no alert can arrive ${at}`);
            await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
            await dialog.getByRole("heading", { name: "Ovis is ready", exact: true }).waitFor();
            const alertsRow = dialog.locator(".setup-summary li").filter({ hasText: "Alerts" });
            assert.equal(await alertsRow.evaluate((row) => row.classList.contains("is-done")), false, `Done does not count alerts that cannot arrive ${at}`);
            console.log(`PASS a refused push subscription is said, keeps Turn on alerts, and Done does not count alerts (${at})`);
          }

          // a device paired before the guide (the demo's list) is the phone: the step and Done name it. That this
          // browser alone is no phone is a unit test (setupGuideFlow.test.ts otherDevice)
          const other = await context.newPage();
          try {
            await other.goto(`${root}?demo_devices=list`);
            const guide = other.getByRole("dialog", { name: DIALOG, exact: true });
            await guide.getByRole("heading", { name: "Pick an agent", exact: true }).waitFor();
            await guide.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
            await guide.getByRole("heading", { name: "Pick a look", exact: true }).waitFor();
            await guide.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
            await guide.locator(".setup-side").getByText("Pixel 9 is connected.", { exact: true }).waitFor();
            await guide.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
            await guide.getByRole("heading", { name: "Ovis is ready", exact: true }).waitFor();
            const row = guide.locator(".setup-summary li").filter({ hasText: "Phone" });
            assert.equal((await row.locator(".setup-summary-row > span").nth(1).innerText()).trim(), "Pixel 9", `Done names the paired phone ${at}`);
          } finally {
            await other.close();
          }
          console.log(`PASS the phone counts as paired only when another device is listed (${at})`);
        } else {
          // Set up later closes it without starting an agent; the way back is in view: the sidebar's Setup: N left row
          await dialog.locator(".setup-foot").getByRole("button", { name: "Set up later", exact: true }).click();
          await dialog.waitFor({ state: "detached" });
          if (phone) {
            await page.locator(".drawer-toggle").click();
            await page.locator("#workspace-drawer.is-open").waitFor({ state: "visible" });
          }
          await page.locator(".setup-row").waitFor();
          assert.equal(await page.locator(".setup-row .setup-row-open").isVisible(), true, `Set up later leaves Setup: N left to come back by ${at}`);
          console.log(`PASS Set up later leaves the way back in view (${at})`);
          await page.evaluate((guide) => localStorage.setItem("ovis:setup-guide", guide), WELCOME);
          await page.reload();
          await dialog.waitFor();
          // Escape closes it and records it closed: a reload shows no guide
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
          assert.equal(JSON.parse((await page.evaluate(() => localStorage.getItem("ovis:setup-guide"))) ?? "{}").status, "closed", `Escape records the guide closed ${at}`);
          await page.reload();
          // the app is up again and connected, where a guide still open would show (a phone keeps the sidebar in a closed drawer)
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await settled(page);
          assert.equal(await page.getByRole("dialog", { name: DIALOG, exact: true }).count(), 0, `no guide after a reload once closed ${at}`);
          console.log(`PASS the guide is a dialog that fits ${at}, Done's Start is its one primary, and Escape closes it for good`);
        }
        assert.deepEqual(errors, [], `no page errors ${at}`);
      } finally {
        await context.close();
      }
    }
  }

  // The usage-counts notice in the guide is the consent counts wait for (components/TelemetryControls.tsx): it is
  // recorded only once its line is wholly in view and nothing covers it, and the page's own copy is not drawn under
  // the guide. The demo sends no counts, so this page's /api/telemetry is a recorder that says they are on and unseen.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 420 }, locale: "en-US", colorScheme: "dark" });
    await context.addInitScript((guide) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
      if (sessionStorage.getItem("seeded") === null) { localStorage.setItem("ovis:setup-guide", guide); sessionStorage.setItem("seeded", "1"); }
      const counts = { gets: 0, seen: [] as unknown[], on: true, snapshotsAfterOff: 0, failNext: 1, failed: 0 };
      (window as unknown as { counts: typeof counts }).counts = counts;
      const status = (seen: boolean) => new Response(JSON.stringify({ enabled: counts.on, blocked_by_env: false, notice_seen: seen, next: null,
        active: { event: "active", day: "2026-11-15", install_id: "demo", version: "0.0.0", os: "linux", arch: "x64", install_method: "source", harnesses: [], usage: {}, runtime: "herdr" } }), { headers: { "content-type": "application/json" } });
      const native = window.fetch.bind(window);
      let inner: typeof window.fetch = native;
      // the demo's transport puts its own fetch in place as it loads: it goes behind this one, which answers only /api/telemetry
      const recorder = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
        if (!url.pathname.startsWith("/api/")) return native(input, init);
        if (url.pathname !== "/api/telemetry") return inner(input, init);
        if ((init?.method ?? "GET").toUpperCase() === "GET") { counts.gets += 1; return Promise.resolve(status(counts.seen.length > 0)); }
        const body = JSON.parse(String(init?.body ?? "{}")) as { notice_seen?: boolean; enabled?: boolean; settings?: unknown };
        if (body.enabled === false) counts.on = false;
        else if (!counts.on && body.settings !== undefined) counts.snapshotsAfterOff += 1;
        // the first acknowledgement fails, as a dropped request would
        if (body.notice_seen === true && counts.failNext > 0) { counts.failNext -= 1; counts.failed += 1; return Promise.resolve(new Response("{}", { status: 500 })); }
        if (body.notice_seen === true) counts.seen.push(body);
        return Promise.resolve(status(counts.seen.length > 0));
      }) as typeof window.fetch;
      Object.defineProperty(window, "fetch", { configurable: true, get: () => recorder, set: (next: typeof window.fetch) => { inner = next; } });
    }, WELCOME);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const seen = () => page.evaluate(() => (window as unknown as { counts: { seen: unknown[] } }).counts.seen.length);
    const frames = (count: number) => page.evaluate((n) => new Promise<void>((done) => { const step = (left: number) => left === 0 ? done() : requestAnimationFrame(() => step(left - 1)); step(n); }), count);
    try {
      await page.goto(root);
      const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
      const line = dialog.locator(".setup-note-usage");
      // the guide opens on the agent step: its line is drawn again once the PC's agents arrive, so the case starts there
      await dialog.getByRole("heading", { name: "Pick an agent", exact: true }).waitFor();
      await line.waitFor({ state: "attached" });
      // a short window: the line is below the fold of the guide's scrolling body
      const below = await line.evaluate((node) => {
        const body = node.closest(".modal-body")!.getBoundingClientRect();
        return node.getBoundingClientRect().bottom > body.bottom;
      });
      assert.ok(below, "the usage-counts line starts below the guide body's fold at 1280x420");
      await frames(4);
      assert.equal(await seen(), 0, "a line below the fold is not recorded as seen");
      assert.equal(await page.locator(".update-notice.is-telemetry").count(), 0, "the page's own line is not drawn under the guide");
      // a native showModal() dialog over the guide (as Add PC opens) covers the line too, though it has no aria-modal (#3882)
      await page.evaluate(() => { const native = document.createElement("dialog"); native.id = "native-over"; native.textContent = "native"; document.body.append(native); native.showModal(); });
      await line.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
      await frames(4);
      assert.equal(await page.evaluate(() => (window as unknown as { counts: { seen: unknown[]; failed: number } }).counts.seen.length + (window as unknown as { counts: { failed: number } }).counts.failed), 0, "a line under a native modal dialog is not recorded");
      // put back as it was: the line below the fold again, the native dialog gone
      await line.evaluate((node) => { node.closest(".modal-body")!.scrollTop = 0; });
      await page.evaluate(() => { const native = document.getElementById("native-over") as HTMLDialogElement; native.close(); native.remove(); });
      await frames(4);
      // Settings over the guide, then the line scrolled into view under it: still not seen
      await page.keyboard.press("Control+Shift+Comma");
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      await settings.waitFor();
      await line.evaluate((node) => node.scrollIntoView({ block: "nearest" }));
      await frames(4);
      assert.equal(await seen(), 0, "a line under Settings is not recorded as seen");
      // not even tried: a covered line makes no acknowledgement attempt, failed or not (#3894 CodeRabbit)
      assert.equal(await page.evaluate(() => (window as unknown as { counts: { failed: number } }).counts.failed), 0, "no acknowledgement is attempted while Settings covers the line");
      // Settings closed: the line is in view and uncovered, and is recorded
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "detached" });
      // its first record fails, and the same line tries again on the next focus move rather than never (#3882)
      await page.waitForFunction(() => (window as unknown as { counts: { failed: number } }).counts.failed === 1);
      assert.equal(await seen(), 0, "a failed record is not counted");
      await page.keyboard.press("Tab");
      await page.waitForFunction(() => (window as unknown as { counts: { seen: unknown[] } }).counts.seen.length === 1);
      // recorded once, the line stays with its one-tap Turn off
      await dialog.locator(".setup-note-usage").getByRole("button", { name: "Turn off", exact: true }).waitFor({ state: "attached" });
      assert.equal(await seen(), 1, "the next step's copy does not record it again");
      // Turn off in the guide's copy is every copy's: the guide closed, the page's own line does not come back and
      // no settings snapshot is told while counts are off
      await dialog.locator(".setup-note-usage").getByRole("button", { name: "Turn off", exact: true }).click();
      await page.waitForFunction(() => !(window as unknown as { counts: { on: boolean } }).counts.on);
      await dialog.locator(".setup-note-usage").waitFor({ state: "detached" });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await frames(4);
      await page.evaluate(() => localStorage.setItem("ovis:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ovis:settings") ?? "{}"), theme: "light" })));
      await frames(4);
      assert.equal(await page.locator(".update-notice.is-telemetry").count(), 0, "the page's line stays gone after Turn off in the guide");
      assert.equal(await page.evaluate(() => (window as unknown as { counts: { snapshotsAfterOff: number } }).counts.snapshotsAfterOff), 0, "no settings snapshot while counts are off");
      assert.deepEqual(errors, [], "no page errors in the usage-counts case");
      console.log("PASS the guide's usage-counts line is recorded only in view and uncovered, once, stays with Turn off on the next step, and the page's copy is not drawn under it");
    } finally {
      await context.close();
    }
  }

  // The phone and alerts step: at both desktop sizes its body never scrolls, in every state (start, the QR code of each
  // way, the other ways, Tailscale's command or absence, the Wi-Fi line, each store's QR code, a connection that does not
  // turn on), and the dialog keeps its 16:9 size
  for (const size of [{ width: 1920, height: 1080 }, { width: 1280, height: 720 }] as const) {
    const at = `${size.width}x${size.height}`;
    const open = async (query: string) => {
      const context = await browser!.newContext({ viewport: size, locale: "en-US", colorScheme: "dark" });
      await context.addInitScript(([guide]) => {
        if (sessionStorage.getItem("seeded") !== null) return;
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
        localStorage.setItem("ovis:setup-guide", guide);
        sessionStorage.setItem("seeded", "1");
      }, [WELCOME] as const);
      const page = await context.newPage();
      await page.goto(`${root}?demo_devices=empty&demo_via=device${query}`);
      const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
      for (const heading of ["Pick an agent", "Pick a look"]) {
        await dialog.getByRole("heading", { name: heading, exact: true }).waitFor();
        await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
      }
      await dialog.getByRole("heading", { name: "Stay in touch", exact: true }).waitFor();
      return { context, page, side: dialog.locator(".setup-side-phone") };
    };
    const fits = async (page: Page, state: string) => {
      await settled(page);
      const body = await page.locator(".setup-dialog .setup-body").evaluate((node) => ({ scroll: node.scrollHeight, client: node.clientHeight }));
      assert.ok(body.scroll <= body.client + 1, `${at}: the step's body does not scroll (${state}): ${JSON.stringify(body)}`);
      const card = (await page.locator(".setup-dialog").boundingBox())!;
      assert.ok(Math.round(card.width) === 1200 && card.height <= 675.5, `${at}: the dialog stays within its 1200x675 frame (${state})`);
    };
    const tab = (side: ReturnType<Page["locator"]>, name: RegExp) => side.getByRole("tab", { name }).click();
    {
      const { context, page, side } = await open("");
      // step 3 is a heading of its own, whatever way is picked
      assert.equal(await side.locator(".setup-path-head").nth(2).textContent(), "3Scan with your phone", `${at}: step 3 names what to do`);
      await fits(page, "start");
      await side.getByRole("button", { name: "Turn on" }).click();
      await side.locator(".setup-relay-tight .qr").waitFor();
      await fits(page, "the QR code to connect from anywhere");
      await side.getByRole("button", { name: "Other ways" }).click();
      await side.getByRole("button", { name: "Show a code to type" }).waitFor();
      await fits(page, "the other ways");
      await side.getByRole("button", { name: "Back to QR" }).click();
      await tab(side, /Tailscale/);
      await side.locator(".setup-qr-panel:visible").waitFor();
      await fits(page, "Tailscale's QR code");
      await tab(side, /Same Wi-Fi/);
      await side.locator(".setup-method-area .setup-note:visible").waitFor();
      await fits(page, "the Wi-Fi line");
      for (const store of ["Download on the App Store", "Get it on Google Play"]) {
        await side.getByRole("button", { name: store }).click();
        await side.locator(".setup-qr-panel:visible").waitFor();
        await fits(page, store);
      }
      await context.close();
    }
    for (const [query, state] of [["&demo_tailscale=command", "Tailscale's command"], ["&demo_tailscale=missing", "Tailscale not installed"]] as const) {
      const { context, page, side } = await open(query);
      await tab(side, /Tailscale/);
      await side.locator(".setup-method-area .setup-method-step:visible, .setup-method-area .setup-note:visible").first().waitFor();
      await fits(page, state);
      await context.close();
    }
    {
      const { context, page, side } = await open("&demo_relay_fail=1");
      await side.getByRole("button", { name: "Turn on" }).click();
      await side.getByRole("alert").first().waitFor();
      await fits(page, "a connection that did not turn on");
      await context.close();
    }
    console.log(`PASS the phone and alerts step's body does not scroll in any state (${at})`);
  }
  // Opening the guide reads nothing, sends nothing and turns nothing on: open then Set up later leaves no usage read, no
  // shared-settings write, and this browser's settings byte for byte as they were. Only Continue on the agent step (the
  // user's own press) reads the plan usage
  {
    const context = await browser!.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US", colorScheme: "dark" });
    await context.addInitScript(([guide]) => {
      if (sessionStorage.getItem("seeded") === null) {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
        localStorage.setItem("ovis:setup-guide", guide);
        sessionStorage.setItem("seeded", "1");
      }
      // every request the page makes to the PC, in order, through whatever fetch the demo puts in place
      const sent: string[] = [];
      (window as unknown as { sent: string[] }).sent = sent;
      let inner = window.fetch.bind(window);
      const recorder = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.pathname.startsWith("/api/")) sent.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
        return inner(input, init);
      }) as typeof window.fetch;
      Object.defineProperty(window, "fetch", { configurable: true, get: () => recorder, set: (next: typeof window.fetch) => { inner = next; } });
    }, [WELCOME] as const);
    const page = await context.newPage();
    await page.goto(`${root}?demo_via=local`);
    const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
    await dialog.getByRole("heading", { name: "Pick an agent", exact: true }).waitFor();
    await dialog.locator(".setup-found .setup-tile").first().waitFor();
    const settingsBefore = await page.evaluate(() => localStorage.getItem("ovis:settings"));
    // the sign-ins are not known before the usage read: nothing is said about them
    assert.equal(await dialog.getByText(/needs a sign-in/).count(), 0, "no sign-in line while the sign-ins are unknown");
    await dialog.locator(".setup-foot").getByRole("button", { name: "Set up later", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await settled(page);
    const sent = await page.evaluate(() => (window as unknown as { sent: string[] }).sent);
    assert.deepEqual(sent.filter((request) => request === "GET /api/usage" || request.startsWith("PUT /api/preferences") || request.startsWith("POST /api/preferences")), [], `opening the guide and Set up later read no usage and write no shared setting: ${sent.join(", ")}`);
    assert.equal(await page.evaluate(() => localStorage.getItem("ovis:settings")), settingsBefore, "Set up later leaves this browser's settings byte for byte as they were");
    // reopened from Setup: N left without Continue ever pressed (it opens at a later step), and after a reload there:
    // still no usage read
    await page.locator(".setup-row .setup-row-open").click();
    await dialog.waitFor();
    await settled(page);
    assert.equal((await page.evaluate(() => (window as unknown as { sent: string[] }).sent)).includes("GET /api/usage"), false, "a guide reopened without Continue reads no usage");
    await page.reload();
    await dialog.waitFor();
    await settled(page);
    const reopened = await page.evaluate(() => (window as unknown as { sent: string[] }).sent);
    assert.equal(reopened.includes("GET /api/usage"), false, `a guide reopened without Continue reads no usage, nor after a reload: ${reopened.join(", ")}`);
    // the user's own press on the agent step: Continue reads the plan usage
    await page.evaluate((guide) => { localStorage.setItem("ovis:setup-guide", guide); (window as unknown as { sent: string[] }).sent.length = 0; }, WELCOME);
    await page.reload();
    await dialog.getByRole("heading", { name: "Pick an agent", exact: true }).waitFor();
    await dialog.locator(".setup-found .setup-tile").first().waitFor();
    await settled(page);
    assert.equal((await page.evaluate(() => (window as unknown as { sent: string[] }).sent)).includes("GET /api/usage"), false, "no usage read while the agent step only shows");
    await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as { sent: string[] }).sent.includes("GET /api/usage"));
    await context.close();
    console.log("PASS opening the guide and Set up later read no usage, write no shared setting and leave the settings as they were; Continue reads the usage");
  }

  // Anywhere's QR code, then Tailscale (a new pairing code: the PC keeps one), then Anywhere again: the relay asks for a
  // fresh offer carrying the PC's current code, never shows the old one. And plan usage turned off forgets the guide's
  // remembered Continue
  {
    const context = await browser!.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US", colorScheme: "dark" });
    await context.addInitScript(([guide]) => {
      if (sessionStorage.getItem("seeded") === null) {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
        localStorage.setItem("ovis:setup-guide", guide);
        sessionStorage.setItem("seeded", "1");
      }
      const sent: string[] = [];
      (window as unknown as { sent: string[] }).sent = sent;
      let inner = window.fetch.bind(window);
      const recorder = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.pathname.startsWith("/api/")) sent.push(`${(init?.method ?? "GET").toUpperCase()} ${url.pathname}`);
        return inner(input, init);
      }) as typeof window.fetch;
      Object.defineProperty(window, "fetch", { configurable: true, get: () => recorder, set: (next: typeof window.fetch) => { inner = next; } });
    }, [WELCOME] as const);
    const page = await context.newPage();
    await page.goto(`${root}?demo_devices=empty&demo_via=device`);
    const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
    for (const heading of ["Pick an agent", "Pick a look"]) {
      await dialog.getByRole("heading", { name: heading, exact: true }).waitFor();
      await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
    }
    const side = dialog.locator(".setup-side-phone");
    const offers = () => page.evaluate(() => (window as unknown as { sent: string[] }).sent.filter((request) => request === "POST /api/relay/offer").length);
    await side.getByRole("button", { name: "Turn on", exact: true }).click();
    await side.locator(".setup-relay-tight .qr").waitFor();
    await page.waitForFunction(() => (window as unknown as { sent: string[] }).sent.includes("POST /api/relay/offer"));
    const first = await offers();
    await side.getByRole("tab", { name: /Tailscale/ }).click();
    await side.getByRole("img", { name: /^QR code that pairs a phone with code/ }).waitFor();
    await side.getByRole("tab", { name: /^Anywhere/ }).click();
    await page.waitForFunction((count) => (window as unknown as { sent: string[] }).sent.filter((request) => request === "POST /api/relay/offer").length > count, first);
    await side.locator(".setup-relay-tight .qr").waitFor();
    // plan usage off: the remembered Continue goes
    assert.equal(await page.evaluate(() => localStorage.getItem("ovis:setup-usage-armed")), "1", "Continue on the agent step is remembered");
    await page.evaluate(() => localStorage.setItem("ovis:settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ovis:settings") ?? "{}"), showUsage: true })));
    await page.reload();
    await dialog.waitFor();
    await page.evaluate(() => localStorage.setItem("ovis:setup-usage-armed", "1"));
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await page.keyboard.press("Control+Shift+Comma");
    await openSettingsPage(page, "Agents");
    await page.locator(".settings-dialog").getByRole("group", { name: "Plan limits" }).getByRole("button", { name: "Off", exact: true }).click();
    await page.waitForFunction(() => localStorage.getItem("ovis:setup-usage-armed") === null);
    await context.close();
    console.log("PASS back to Anywhere after Tailscale asks for a fresh relay offer; turning plan usage off forgets the remembered Continue");
  }

  // While the relay starts (Turn on pressed, its answer not in), the other ways wait: picking one could let the start
  // close the device gate and spend that way's pairing code (#3962 CodeRabbit)
  {
    const context = await browser!.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US", colorScheme: "dark" });
    await context.addInitScript(([guide]) => {
      if (sessionStorage.getItem("seeded") !== null) return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
      localStorage.setItem("ovis:setup-guide", guide);
      sessionStorage.setItem("seeded", "1");
    }, [WELCOME] as const);
    const page = await context.newPage();
    await page.goto(`${root}?demo_devices=empty&demo_via=device&demo_relay_hold=1`);
    const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
    for (const heading of ["Pick an agent", "Pick a look"]) {
      await dialog.getByRole("heading", { name: heading, exact: true }).waitFor();
      await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
    }
    const side = dialog.locator(".setup-side-phone");
    const tailscale = side.getByRole("tab", { name: /Tailscale/ });
    await side.getByRole("button", { name: "Turn on", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#setup-path-tab-tailscale")?.getAttribute("aria-disabled") === "true");
    // a held tab is still pressable (aria-disabled): the click reaches the guide, which picks nothing
    await tailscale.click({ force: true });
    await page.keyboard.press("ArrowRight");
    assert.equal(await side.getByRole("tab", { name: /^Anywhere/ }).getAttribute("aria-selected"), "true", "no other way is picked while the relay starts");
    // the start answers
    await page.waitForFunction(() => typeof (globalThis as { releaseDemoRelayStart?: () => void }).releaseDemoRelayStart === "function");
    await page.evaluate(() => (globalThis as { releaseDemoRelayStart?: () => void }).releaseDemoRelayStart?.());
    await side.locator(".setup-relay-tight .qr").waitFor();
    await page.waitForFunction(() => document.querySelector("#setup-path-tab-tailscale")?.getAttribute("aria-disabled") === null);
    await tailscale.click();
    assert.equal(await tailscale.getAttribute("aria-selected"), "true", "the ways are free again once the relay is on");
    await context.close();
    console.log("PASS while the relay starts, the other ways wait, and are free once it is on (1920x1080)");
  }

  // On a phone, with the answer a browser on the PC itself gets (via local): the step opens at its top, and a tab's press brings
  // its panel into view; Tailscale shows its QR code and Same Wi-Fi its line
  {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "en-US", colorScheme: "dark" });
    await context.addInitScript(([guide]) => {
      if (sessionStorage.getItem("seeded") !== null) return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
      localStorage.setItem("ovis:setup-guide", guide);
      sessionStorage.setItem("seeded", "1");
    }, [WELCOME] as const);
    const page = await context.newPage();
    await page.goto(`${root}?demo_devices=empty&demo_via=local`);
    const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
    for (const heading of ["Pick an agent", "Pick a look"]) {
      await dialog.getByRole("heading", { name: heading, exact: true }).waitFor();
      await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
    }
    const title = dialog.getByRole("heading", { name: "Stay in touch", exact: true });
    await title.waitFor();
    await settled(page);
    const top = (await title.boundingBox())!;
    assert.ok(top.y >= 0 && top.y + top.height <= 844, `390: the phone step opens at its top: ${JSON.stringify(top)}`);
    const side = dialog.locator(".setup-side-phone");
    await side.getByRole("tab", { name: /Tailscale/ }).click();
    await side.locator(".setup-qr-panel:visible .qr").waitFor();
    // the sheet scrolls to it (smoothly): wait for the scroll to end with the QR code whole in the window
    const inView = await page.waitForFunction(() => {
      const qr = [...document.querySelectorAll(".setup-qr-panel .qr")].find((node) => node.getClientRects().length > 0);
      const rect = qr?.getBoundingClientRect();
      const body = document.querySelector(".setup-dialog .setup-body")?.getBoundingClientRect();
      return rect !== undefined && body !== undefined && rect.top >= body.top && rect.bottom <= body.bottom;
    }, undefined, { timeout: 5000 }).then(() => true, () => false);
    const qr = (await side.locator(".setup-qr-panel:visible .qr").boundingBox())!;
    assert.ok(inView, `390: Tailscale's QR code comes into view on its press: ${JSON.stringify(qr)}`);
    await side.getByRole("tab", { name: /Same Wi-Fi/ }).click();
    await side.locator(".setup-method-area .setup-note:visible, .setup-qr-panel:visible").first().waitFor();
    await context.close();
    console.log("PASS on a phone the phone step opens at its top, and Tailscale and Same Wi-Fi work for a browser on the PC (390x844)");
  }

  // A pairing code runs out: the QR code goes back to the plain address, and New code asks for another on a press
  {
    const context = await browser!.newContext({ viewport: { width: 1920, height: 1080 }, locale: "en-US", colorScheme: "dark" });
    await context.addInitScript(([guide]) => {
      if (sessionStorage.getItem("seeded") !== null) return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", palette: "codex", darkTheme: "codex", lightTheme: "codex" }));
      localStorage.setItem("ovis:setup-guide", guide);
      sessionStorage.setItem("seeded", "1");
    }, [WELCOME] as const);
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(`${root}?demo_devices=empty&demo_via=device`);
    const dialog = page.getByRole("dialog", { name: DIALOG, exact: true });
    for (const heading of ["Pick an agent", "Pick a look"]) {
      await dialog.getByRole("heading", { name: heading, exact: true }).waitFor();
      await dialog.locator(".setup-foot").getByRole("button", { name: "Continue", exact: true }).click();
    }
    const side = dialog.locator(".setup-side-phone");
    await side.getByRole("tab", { name: /Tailscale/ }).click();
    const coded = side.getByRole("img", { name: /^QR code that pairs a phone with code/ });
    await coded.waitFor();
    assert.equal(await side.getByRole("button", { name: "New code", exact: true }).count(), 0, "no New code while a code is live");
    await page.clock.fastForward("11:00");
    await side.getByRole("button", { name: "New code", exact: true }).waitFor();
    assert.equal(await coded.count(), 0, "a code that ran out leaves the QR code");
    await side.getByRole("button", { name: "New code", exact: true }).click();
    await coded.waitFor();
    // a store's QR code uses no pairing code: the way under it keeps its own
    await side.getByRole("button", { name: "Download on the App Store" }).click();
    await side.getByRole("img", { name: /^QR code that opens App Store/ }).waitFor();
    await side.getByRole("tab", { name: /Tailscale/ }).click();
    await coded.waitFor();
    assert.equal(await side.getByRole("button", { name: "New code", exact: true }).count(), 0, "a store badge leaves the way's code as it was");
    // the PC keeps one pairing code: another way's tab (here Anywhere's) may replace it, so a way left drops its code,
    // and back in view it shows New code, never a code the PC no longer takes
    await coded.waitFor();
    await side.getByRole("tab", { name: /^Anywhere/ }).click();
    await side.getByRole("tab", { name: /Tailscale/ }).click();
    await side.getByRole("button", { name: "New code", exact: true }).waitFor();
    assert.equal(await coded.count(), 0, "a way left and shown again keeps no code another way may have replaced");
    await side.getByRole("button", { name: "New code", exact: true }).click();
    await coded.waitFor();
    await context.close();
    console.log("PASS a pairing code that runs out, or a way left for another, is renewed only by New code (1920x1080)");
  }

} finally {
  await browser?.close();
  await server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
