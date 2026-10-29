/**
 * New tab with an agent's model, effort, Ultracode, skills and first message (#774, #1311, #2232) on the
 * unmodified app over the demo's fixture transport: the composer's button, absent until this device turns it
 * on in Settings (Chat, Composer, New tab button), then opens the dialog on the pane's workspace;
 * Codex shows its `$` skills before any process exists (GET /api/agent/commands), a chip
 * puts its token in the message, and Start sends exactly one tab/create with the agent's own
 * arguments however often it is pressed while the first is in flight (the prompt is Codex's
 * positional argument behind `--`, never queued as well); Claude Code, whose parser would run a
 * message named like a subcommand, starts bare and the message rides on the request as
 * `first_message`: the bridge's own pending message, shown in the new pane's chat until the agent is
 * first ready, then typed once through this page's own connection, with this page never sending it
 * itself; Claude Code's effort lists its five levels, and Ultracode is a switch of its own after it,
 * on Claude Code alone, that adds one `--settings` object when it is on and is off at each opening;
 * when that connection drops before the agent is ready, the message is held, never typed on its own,
 * and goes once on Send now; a choice the launch does not take disables Start and is dropped with the
 * agent; the keyboard reaches every control; a skill list the PC answers busy (503 file_busy, #2254) is asked for
 * again and shows its chips, never the error.
 * Captures at 390 (true mobile emulation) and 1280, dark and light. All files and HTTP traffic
 * stay in this disposable, loopback-only app; no herdr session is opened.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-new-session-skills-"));
const evidence = join(process.env["UI_EVIDENCE_DIR"] || join(repo, "evidence"), "new-session-skills");
mkdirSync(evidence, { recursive: true });

interface Recorded { url: string; body: Record<string, unknown> }
interface QaWindow { qaRequests: Recorded[]; qaHold: boolean; qaRelease: () => void; qaSubmits: string[]; qaDrop: () => void; qaOldBridge: boolean; qaSkillsBusy: Record<string, number>; qaSkillsBusyServed: number }

const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
const recorded = (page: Page) => page.evaluate(() => (window as unknown as QaWindow).qaRequests);
const submits = (page: Page) => page.evaluate(() => (window as unknown as QaWindow).qaSubmits);

/** The chat lens of the demo's Claude pane, where the composer's button is. */
async function openChat(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await page.locator(".pane-frame.is-current .terminal-stack.is-chat").waitFor();
}

/** The New tab dialog on the pane's workspace: the composer's button with a mouse; on a phone, whose card has no row to spare for it, the tab's own menu. */
async function openDialog(page: Page, via: "composer" | "tab-menu" = "composer") {
  if (via === "composer") await page.locator(".pane-frame.is-current .composer-new-session").click();
  else {
    assert.equal(await page.locator(".pane-frame.is-current .composer-new-session").count(), 0, "a phone's card carries no new-tab button, even with the setting on");
    await page.locator(".tab-strip-menu").tap();
    // the menu is a sheet on a phone (RowMenu): its items are buttons there
    await page.getByRole("button", { name: "New tab with agent…", exact: true }).tap();
  }
  const dialog = page.getByRole("dialog", { name: /^New tab · checkout-api/ });
  await dialog.waitFor();
  return dialog;
}

/**
 * Claude Code's launch choices as drawn: Model and Effort share one row, and Ultracode is one line under them (the
 * switch, its name and a short note, no taller than the switch), its whole sentence, version included, read with the
 * switch and shown as the line's tooltip.
 */
async function assertUltracodeLine(dialog: ReturnType<Page["getByRole"]>, width: number): Promise<void> {
  const drawn = await dialog.evaluate((node) => {
    const box = (element: Element | null | undefined) => { const rect = element!.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height }; };
    const toggle = node.querySelector("#new-session-ultracode")!;
    const line = node.querySelector(".new-session-ultracode")!;
    const lineHeight = (element: Element) => parseFloat(getComputedStyle(element).lineHeight) || parseFloat(getComputedStyle(element).fontSize) * 1.5;
    const label = node.querySelector("label[for='new-session-ultracode']")!;
    const note = node.querySelector(".new-session-ultracode-note");
    return {
      model: box(node.querySelector("#new-session-model")!.closest(".field")), effort: box(node.querySelector("#new-session-effort")!.closest(".field")),
      line: box(line), toggle: box(toggle), label: box(label), labelLine: lineHeight(label),
      note: note ? { ...box(note), text: note.textContent ?? "", lineHeight: lineHeight(note) } : null,
      described: node.querySelector(`#${toggle.getAttribute("aria-describedby")}`)?.textContent ?? "",
      title: line.getAttribute("title") ?? "",
    };
  });
  const at = `at ${width}: ${JSON.stringify(drawn)}`;
  assert.ok(Math.abs(drawn.model.top - drawn.effort.top) < 1 && drawn.effort.left > drawn.model.right, `Model and Effort share one row ${at}`);
  assert.ok(drawn.line.top >= Math.max(drawn.model.bottom, drawn.effort.bottom) - 1, `Ultracode is under Model and Effort, not beside them ${at}`);
  assert.ok(drawn.line.height <= drawn.toggle.height + 1, `Ultracode's line is no taller than its switch ${at}`);
  assert.ok(drawn.label.height < drawn.labelLine * 1.5 && drawn.label.top >= drawn.line.top - 1 && drawn.label.bottom <= drawn.line.bottom + 1, `its name is one line, on the switch's line ${at}`);
  assert.ok(drawn.note !== null && drawn.note.height < drawn.note.lineHeight * 1.5 && drawn.note.right <= drawn.line.right + 1, `its note is one line on the same line ${at}`);
  for (const [where, text] of [["note", drawn.note?.text ?? ""], ["description", drawn.described], ["tooltip", drawn.title]] as const) assert.match(text, /2\.1\.284/, `the version Ultracode needs is in its ${where} ${at}`);
  assert.match(drawn.described, /Dynamic workflows/, `the switch's description says what it does ${at}`);
}

/** An agent by its label: a row's name starts with its mark's word ("omp Oh My Pi"), and one whose launch takes a model and an effort says so after the label ("Codex: model, effort"). */
async function pickAgent(page: Page, dialog: ReturnType<Page["getByRole"]>, label: string): Promise<void> {
  await dialog.locator(".agent-picker-trigger").click();
  await page.getByRole("option", { name: new RegExp(`(^|\\s)${label}(: |$)`) }).click();
}

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // After the demo's transport: every tab/create body the page sends is recorded as it is sent, and
  // held unanswered while qaHold is on, as a slow PC would; every submit frame on the socket is counted.
  const record = `<script>(() => {
    const demoFetch = window.fetch;
    window.qaRequests = [];
    window.qaHold = false;
    window.qaOldBridge = false;
    // an agent's skill list answered 503 file_busy this many more times, as a PC still reading slow skill folders would (#2254)
    window.qaSkillsBusy = {};
    window.qaSkillsBusyServed = 0;
    let release = null;
    window.qaRelease = () => { if (release) release(); release = null; };
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const busyAgent = url.includes("/agent/commands") ? new URL(url, location.href).searchParams.get("agent") : null;
      if (busyAgent && (window.qaSkillsBusy[busyAgent] ?? 0) > 0) {
        window.qaSkillsBusy[busyAgent] -= 1;
        window.qaSkillsBusyServed += 1;
        return new Response(JSON.stringify({ error: { code: "file_busy", message: "the skill folders did not answer in time" } }), { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } });
      }
      if ((init?.method ?? "GET") === "POST" && (url.includes("/api/tab/create") || url.includes("/api/workspace/create"))) {
        window.qaRequests.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
        if (window.qaHold) await new Promise((resolve) => { release = resolve; });
        // a bridge from before first_message: it starts the agent and answers without the field
        if (window.qaOldBridge) {
          const answer = await demoFetch(input, init);
          const { first_message: _, ...made } = await answer.json();
          return new Response(JSON.stringify(made), { status: answer.status, headers: { "content-type": "application/json" } });
        }
      }
      return demoFetch(input, init);
    };
    const Demo = window.WebSocket;
    window.qaSubmits = [];
    window.qaSockets = [];
    window.qaDrop = () => { for (const socket of window.qaSockets.splice(0)) socket.close(); };
    const Counted = function (url, protocols) {
      const socket = new Demo(url, protocols);
      window.qaSockets.push(socket);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") { const frame = JSON.parse(data); if (frame.type === "submit") window.qaSubmits.push(frame.text); }
        send(data);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Counted, name, { value: Demo[name] });
    window.WebSocket = Counted;
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${record}\n    <script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`;
  // the composer's button is off by default (the composer stays minimal): every context but the first turns it on as stored
  const settings = (theme: string): void => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme, composerNewTabButton: true })); };
  const defaults = (theme: string): void => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })); };
  const phone = (browser: Browser, theme: "dark" | "light") => browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "en-US", colorScheme: theme });
  const desktop = (browser: Browser, theme: "dark" | "light") => browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", colorScheme: theme });
  const log: string[] = [];
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      // a desk with nothing chosen: the composer carries no New tab button; Settings' Chat page offers the toggle in
      // its Composer group, and once it is on the button is there and opens the dialog on the pane's workspace
      const optIn = await desktop(browser, "dark");
      try {
        await optIn.addInitScript(defaults, "dark");
        const page = await optIn.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
        await openChat(page, url);
        await page.locator(".pane-frame.is-current .composer-attach").waitFor();
        assert.equal(await page.locator(".pane-frame.is-current .composer-new-session").count(), 0, "the composer has no New tab button until this device turns it on");
        await settled(page);
        await page.screenshot({ path: join(evidence, "desktop-dark-composer-default.png") });
        await page.goto(`${url}&settings=chat&section=composer`);
        const toggle = page.getByRole("switch", { name: "New tab button", exact: true });
        assert.equal(await toggle.getAttribute("aria-checked"), "false", "the toggle starts off");
        await settled(page);
        await page.screenshot({ path: join(evidence, "desktop-dark-settings-composer.png") });
        await toggle.setChecked(true);
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "detached" });
        await page.locator(".pane-frame.is-current .terminal-stack.is-chat").waitFor();
        const button = page.locator(".pane-frame.is-current .composer-new-session");
        await button.waitFor();
        assert.equal(await button.getAttribute("aria-label"), "New tab with an agent\u2026");
        await settled(page);
        await page.screenshot({ path: join(evidence, "desktop-dark-composer-opted-in.png") });
        const dialog = await openDialog(page);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        assert.equal((await recorded(page)).length, 0, "opening and closing the dialog starts nothing");
        assert.deepEqual(errors, []);
        console.log("PASS the composer's New tab button is off by default, and Settings' Composer group turns it on for this device");
      } finally { await optIn.close(); }

      // the plan's scenario: a phone, Codex, its $ skills, a prompt, Start; a double tap sends one create
      const dark = await phone(browser, "dark");
      try {
        await dark.addInitScript(settings, "dark");
        const page = await dark.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
        await openChat(page, url);
        const dialog = await openDialog(page, "tab-menu");
        // the PC is still reading Codex's skill folders: its first answer is a busy 503, and the dialog asks again
        await page.evaluate(() => { (window as unknown as QaWindow).qaSkillsBusy = { codex: 1 }; });
        await pickAgent(page, dialog, "Codex");
        const chips = dialog.locator(".new-session-skill-chip");
        await chips.first().waitFor();
        assert.equal(await page.evaluate(() => (window as unknown as QaWindow).qaSkillsBusyServed), 1, "Codex's skill list was answered busy once first");
        assert.equal(await dialog.locator(".new-session-skills-field .field-hint").count(), 0, "a busy answer shows no error once the list comes");
        assert.deepEqual(await chips.allTextContents(), ["$review-pr", "$release-notes", "$flaky-tests"], "Codex's skills in the folder, typed with $");
        assert.equal(await dialog.getByLabel("Model").count(), 1);
        assert.equal(await dialog.getByLabel("Effort").count(), 1);
        assert.equal(await dialog.getByRole("switch", { name: "Ultracode" }).count(), 0, "Ultracode is Claude Code's alone");
        await chips.first().click();
        const message = dialog.getByLabel("First message");
        assert.equal(await message.inputValue(), "$review-pr ", "the chip's token, spaced, in the message");
        assert.equal(await message.evaluate((node) => document.activeElement === node && (node as HTMLTextAreaElement).selectionStart), "$review-pr ".length, "the caret after the token");
        await message.pressSequentially("the export branch");
        await dialog.getByLabel("Effort").selectOption("high");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "no horizontal scroll at 390");
        await settled(page);
        await page.screenshot({ path: join(evidence, "phone-dark-filled.png") });
        await page.evaluate(() => { (window as unknown as QaWindow).qaHold = true; });
        const start = dialog.getByRole("button", { name: "Start", exact: true });
        await start.dblclick();
        await dialog.getByRole("status").filter({ hasText: "Starting Codex" }).waitFor();
        await dialog.getByRole("button", { name: "Starting…" }).click({ force: true }).catch(() => undefined);
        await settled(page);
        await page.screenshot({ path: join(evidence, "phone-dark-pending.png") });
        const held = await recorded(page);
        assert.equal(held.length, 1, `a double tap on Start sends one tab/create, not ${held.length}`);
        assert.deepEqual(held[0]!.body, { workspace_id: "w1C", cwd: "/home/demo/checkout-api", label: null, agent: { kind: "codex", args: ["-c", "model_reasoning_effort=high", "--", "$review-pr the export branch"] } }, "the prompt is Codex's own argument behind the end-of-options separator, and no first_message rides along");
        await page.evaluate(() => (window as unknown as QaWindow).qaRelease());
        await dialog.waitFor({ state: "detached" });
        await page.locator(".pane-frame.is-current .terminal-stack.is-chat").waitFor();
        await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "", "a positional prompt is not put in the new pane's box as well");
        assert.equal(await page.locator(".pane-frame.is-current .pending-message-bubble").count(), 0, "nor queued as a pending message");
        await page.locator(".pane-frame.is-current .composer-status:is([data-status=\"idle\"], [data-status=\"done\"])").waitFor({ timeout: 8_000 });
        assert.deepEqual(await submits(page), [], "nothing is sent over the socket for a prompt the agent took on its command line");
        assert.equal((await recorded(page)).length, 1, "nothing more was sent once the first answer came");
        await settled(page);
        await page.screenshot({ path: join(evidence, "phone-dark-started.png") });
        log.push("POST /api/tab/create bodies, phone, Codex with $review-pr and effort high, Start double-tapped while the create was held:");
        log.push(...held.map((request, index) => `${index + 1}. ${JSON.stringify(request.body)}`));
        log.push(`submit frames after the pane opened: ${JSON.stringify(await submits(page))}`);
        assert.deepEqual(errors, []);
        console.log("PASS phone: Codex's $ skills before any process, the chip in the message, one tab/create with the prompt behind -- on a double tap, nothing queued twice");
      } finally { await dark.close(); }

      // Claude Code, whose command line never takes the message: it starts with its model, effort and Ultracode
      // alone, the message rides on the request, the chat shows it pending, the bridge sends it once the agent
      // rests, and this page sends nothing over the socket at any point
      const pendingPath = await desktop(browser, "dark");
      try {
        await pendingPath.addInitScript(settings, "dark");
        const page = await pendingPath.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
        await openChat(page, url);
        const dialog = await openDialog(page);
        await pickAgent(page, dialog, "Claude Code");
        await dialog.locator(".new-session-skill-chip").first().waitFor();
        assert.deepEqual(await dialog.locator(".new-session-skill-chip").allTextContents(), ["/review-pr", "/changelog"], "a / skill for an agent that types them so");
        await dialog.getByLabel("Model").fill("opus");
        // the five levels Claude Code's --effort lists; Ultracode is no level but the switch after them
        assert.deepEqual(await dialog.getByLabel("Effort").locator("option").allTextContents(), ["Agent default", "low", "medium", "high", "xhigh", "max"]);
        await dialog.getByLabel("Effort").selectOption("high");
        const ultracode = dialog.getByRole("switch", { name: "Ultracode", exact: true });
        assert.equal(await ultracode.getAttribute("aria-checked"), "false", "Ultracode starts off: Claude Code's own setting");
        // its hint is read with it, as Model's and Effort's are, and its visible label is a label: a click on it flips the switch
        assert.equal(await ultracode.getAttribute("aria-describedby"), "new-session-ultracode-hint");
        await assertUltracodeLine(dialog, 1280);
        await dialog.locator("label[for='new-session-ultracode']").click();
        assert.equal(await ultracode.getAttribute("aria-checked"), "true");
        await dialog.getByLabel("First message").fill("Plan the config file");
        assert.match(await dialog.locator("#new-session-prompt-hint").innerText(), /Queued for Claude Code's first turn/);
        await settled(page);
        await page.screenshot({ path: join(evidence, "desktop-dark-claude-pending.png") });
        await dialog.getByRole("button", { name: "Start", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        const sent = await recorded(page);
        assert.match(String(sent[0]?.body["first_message_connection"]), /^demo-connection-\d+$/, "the request names this page's connection as the one that types the message");
        assert.deepEqual(sent.map(({ body: { first_message_connection: _, ...body } }) => body), [{ workspace_id: "w1C", cwd: "/home/demo/checkout-api", label: null, agent: { kind: "claude", args: ["--model", "opus", "--effort", "high", "--settings", "{\"ultracode\":true}"] }, first_message: "Plan the config file" }], "Ultracode is one --settings object after the effort it keeps; the message is the request's first_message, never an argument of Claude Code's");
        // the new pane opens on its chat, where the bridge's pending message shows until the agent rests
        const bubble = page.locator(".pane-frame.is-current .pending-message-bubble", { hasText: "Plan the config file" });
        await bubble.waitFor();
        // shot at once: the demo's agent rests 1.5 s after the start, and the bubble goes with it
        await page.screenshot({ path: join(evidence, "desktop-dark-claude-pending-bubble.png") });
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "", "nothing is put in the box");
        const turn = page.locator(".pane-frame.is-current .chat-turn", { hasText: "Plan the config file" });
        await turn.first().waitFor({ timeout: 8_000 });
        await bubble.waitFor({ state: "detached" });
        await page.locator(".pane-frame.is-current .composer-status:is([data-status=\"idle\"], [data-status=\"done\"])").waitFor({ timeout: 8_000 });
        assert.equal(await turn.count(), 1, "the message is in the conversation exactly once");
        assert.deepEqual(await submits(page), [], "this page sent nothing over the socket: the bridge typed it");
        await settled(page);
        await page.screenshot({ path: join(evidence, "desktop-dark-claude-pending-sent.png") });
        log.push("", "POST /api/tab/create bodies, desktop, Claude Code with model, effort, Ultracode on and a first message:");
        log.push(...sent.map((request, index) => `${index + 1}. ${JSON.stringify(request.body)}`));
        log.push(`submit frames from the page: ${JSON.stringify(await submits(page))}`);
        // the switch is one opening's choice: the next New tab opens on Claude Code, the agent last started, with
        // it off again, and so does the one after a dialog closed with Escape while it was on
        const next = await openDialog(page);
        await next.locator(".agent-picker-trigger", { hasText: "Claude Code" }).waitFor();
        const nextSwitch = next.getByRole("switch", { name: "Ultracode", exact: true });
        assert.equal(await nextSwitch.getAttribute("aria-checked"), "false", "Ultracode is off again after a Start with it on");
        await nextSwitch.click();
        assert.equal(await nextSwitch.getAttribute("aria-checked"), "true");
        await page.keyboard.press("Escape");
        await next.waitFor({ state: "detached" });
        const reopened = await openDialog(page);
        await reopened.locator(".agent-picker-trigger", { hasText: "Claude Code" }).waitFor();
        assert.equal(await reopened.getByRole("switch", { name: "Ultracode", exact: true }).getAttribute("aria-checked"), "false", "Ultracode is off again after Escape closed the dialog with it on");
        await page.keyboard.press("Escape");
        await reopened.waitFor({ state: "detached" });
        assert.equal((await recorded(page)).length, 1, "closing the dialog starts nothing");
        assert.deepEqual(errors, []);
        console.log("PASS Claude Code offers five effort levels and the Ultracode switch, and starts bare with its model, effort and --settings {\"ultracode\":true}; the first message is the bridge's pending message, shown in the chat and sent once when the agent rests, with no send from the page; the switch is off again at the next opening, after a Start or an Escape");
      } finally { await pendingPath.close(); }

      // the connection drops right after Start and comes back before the agent is ready: nothing the user typed goes
      // on its own after a disconnect, so the message is held for the new connection's Send now, and goes once then
      const reconnect = await desktop(browser, "dark");
      try {
        await reconnect.addInitScript(settings, "dark");
        const page = await reconnect.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
        await openChat(page, url);
        const dialog = await openDialog(page);
        await pickAgent(page, dialog, "Oh My Pi");
        assert.equal(await dialog.getByLabel("Model").count(), 0, "no model field for an agent whose launch takes none");
        await dialog.getByLabel("First message").fill("Reconnect me");
        await dialog.getByRole("button", { name: "Start", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        await page.locator(".pane-frame.is-current .pending-message-bubble", { hasText: "Reconnect me" }).waitFor();
        await page.evaluate(() => (window as unknown as QaWindow).qaDrop());
        await page.locator(".conn-live").waitFor({ state: "detached" });
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const turn = page.locator(".pane-frame.is-current .chat-turn", { hasText: "Reconnect me" });
        // the agent rests with the message held, not typed: the note says why, and Send now and Discard are offered
        await page.locator(".pane-frame.is-current .composer-status:is([data-status=\"idle\"], [data-status=\"done\"])").waitFor({ timeout: 8_000 });
        const held = page.locator(".pane-frame.is-current .pending-message", { hasText: "Reconnect me" });
        await held.locator(".pending-message-note", { hasText: "the page that started this agent left before it was ready" }).waitFor();
        assert.equal(await turn.count(), 0, "not typed on its own after the drop");
        assert.equal(await held.getByRole("button", { name: "Discard", exact: true }).count(), 1, "Discard is offered");
        await settled(page);
        await page.screenshot({ path: join(evidence, "desktop-dark-omp-reconnect-held.png") });
        await held.getByRole("button", { name: "Send now: Reconnect me", exact: true }).click();
        await turn.first().waitFor({ timeout: 8_000 });
        await page.locator(".pane-frame.is-current .composer-status:is([data-status=\"idle\"], [data-status=\"done\"])").waitFor({ timeout: 8_000 });
        assert.equal(await turn.count(), 1, "sent once, on Send now");
        assert.equal(await page.locator(".pane-frame.is-current .pending-message-bubble").count(), 0, "and no copy stays pending");
        assert.deepEqual(await submits(page), [], "the page sent no submit on either connection: Send now is the bridge's pending action");
        assert.deepEqual((await recorded(page)).map(({ body: { first_message_connection: _, ...body } }) => body), [{ workspace_id: "w1C", cwd: "/home/demo/checkout-api", label: null, agent: { kind: "omp" }, first_message: "Reconnect me" }]);
        await settled(page);
        await page.screenshot({ path: join(evidence, "desktop-dark-omp-reconnect-sent.png") });
        log.push("", "POST /api/tab/create bodies, desktop, Oh My Pi with a first message, the socket dropped right after Start (held, then Send now):");
        log.push(...(await recorded(page)).map((request, index) => `${index + 1}. ${JSON.stringify(request.body)}`));
        log.push(`submit frames from the page: ${JSON.stringify(await submits(page))}`);
        assert.deepEqual(errors, []);
        console.log("PASS a connection that drops before the agent is ready gets the first message held, not typed, and sent exactly once on Send now");
      } finally { await reconnect.close(); }

      // a bridge that ignores first_message: the agent starts without it, so the dialog stays open and says so,
      // and Open shows the new tab with the text in its message box, not lost
      const oldBridge = await desktop(browser, "dark");
      try {
        await oldBridge.addInitScript(settings, "dark");
        const page = await oldBridge.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
        await openChat(page, url);
        const dialog = await openDialog(page);
        await pickAgent(page, dialog, "Oh My Pi");
        await dialog.getByLabel("First message").fill("Keep me");
        await page.evaluate(() => { (window as unknown as QaWindow).qaOldBridge = true; });
        await dialog.getByRole("button", { name: "Start", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "does not take a first message yet" }).waitFor();
        assert.equal(await dialog.isVisible(), true, "the dialog stays open");
        await settled(page);
        await page.screenshot({ path: join(evidence, "desktop-dark-old-bridge-kept.png") });
        await dialog.getByRole("button", { name: "Open", exact: true }).click();
        await dialog.waitFor({ state: "detached" });
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.waitFor();
        assert.equal(await box.inputValue(), "Keep me", "the text waits in the new tab's message box");
        assert.deepEqual(await submits(page), [], "nothing is sent on its own");
        assert.deepEqual(errors, []);
        console.log("PASS a bridge that ignores first_message: the dialog stays open, says so, and Open shows the text in the new tab's message box");
      } finally { await oldBridge.close(); }

      // validation and the keyboard: a model that is not one word disables Start and is said; another
      // agent drops the choices its launch does not take, Ultracode included; Tab reaches every control;
      // Escape closes
      const validation = await desktop(browser, "light");
      try {
        await validation.addInitScript(settings, "light");
        const page = await validation.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
        await openChat(page, url);
        const dialog = await openDialog(page);
        await pickAgent(page, dialog, "Claude Code");
        await dialog.locator(".new-session-skill-chip").first().waitFor();
        assert.deepEqual(await dialog.locator(".new-session-skill-chip").allTextContents(), ["/review-pr", "/changelog"]);
        const model = dialog.getByLabel("Model");
        assert.equal(await model.getAttribute("list"), "new-session-models", "Claude Code's documented aliases are offered");
        await model.fill("two words");
        const start = dialog.getByRole("button", { name: "Start", exact: true });
        await page.waitForFunction(() => (document.querySelector<HTMLButtonElement>(".new-session-modal .btn-primary")?.disabled ?? false));
        assert.equal(await model.getAttribute("aria-invalid"), "true");
        assert.equal(await dialog.getByRole("alert").count(), 1, "the refusal is said under the field");
        await dialog.getByLabel("Effort").selectOption("max");
        await dialog.getByRole("switch", { name: "Ultracode", exact: true }).click();
        await settled(page);
        await page.screenshot({ path: join(evidence, "desktop-light-invalid-model.png") });
        await pickAgent(page, dialog, "Oh My Pi");
        await page.waitForFunction(() => !(document.querySelector<HTMLButtonElement>(".new-session-modal .btn-primary")?.disabled ?? true));
        assert.equal(await dialog.getByLabel("Model").count(), 0, "the choices the next agent's launch does not take are dropped with it");
        assert.equal(await dialog.getByRole("switch", { name: "Ultracode" }).count(), 0);
        await pickAgent(page, dialog, "Claude Code");
        assert.equal(await dialog.getByLabel("Model").inputValue(), "", "dropped, not kept for later");
        assert.equal(await dialog.getByLabel("Effort").inputValue(), "");
        assert.equal(await dialog.getByRole("switch", { name: "Ultracode", exact: true }).getAttribute("aria-checked"), "false", "Ultracode too");
        assert.equal(await start.isEnabled(), true);
        // Tab from the agent picker reaches the name, the model, the effort, Ultracode, the message, each chip
        // (once the agent's skills are listed again), Cancel, Start and the X, and stays inside the dialog
        await dialog.locator(".new-session-skill-chip").first().waitFor();
        await dialog.locator(".agent-picker-trigger").focus();
        const order: string[] = [];
        for (let step = 0; step < 11; step += 1) {
          await page.keyboard.press("Tab");
          order.push(await page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            return active?.getAttribute("aria-label") || active?.id || active?.textContent?.trim() || "";
          }));
        }
        assert.deepEqual(order, ["", "new-session-model", "new-session-effort", "Ultracode", "new-session-prompt", "Add /review-pr to the message", "Add /changelog to the message", "Cancel", "Start", "Close dialog", "Claude Code"], `the tab order: ${JSON.stringify(order)}`);
        // a model names one agent's models: Claude Code's is not carried to Codex, which also offers the field
        await dialog.getByLabel("Model").fill("opus");
        await pickAgent(page, dialog, "Codex");
        assert.equal(await dialog.getByLabel("Model").inputValue(), "", "a Claude Code model is dropped on a switch to Codex");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        assert.equal((await recorded(page)).length, 0, "Escape starts nothing");
        assert.deepEqual(errors, []);
        console.log("PASS a model that is not one word disables Start with a reason, another agent drops it and Ultracode, Codex does not take Claude Code's model, Tab reaches every control, Escape closes");
      } finally { await validation.close(); }

      // the other theme at each width, with Codex's skills and a message, then Claude Code with Ultracode on,
      // for the evidence set
      for (const [name, make, theme] of [["phone-light", phone, "light"], ["desktop-light", desktop, "light"], ["desktop-dark", desktop, "dark"]] as const) {
        const context = await make(browser, theme);
        try {
          await context.addInitScript(settings, theme);
          const page = await context.newPage();
          page.setDefaultTimeout(10_000);
          await openChat(page, url);
          const dialog = await openDialog(page, make === phone ? "tab-menu" : "composer");
          await pickAgent(page, dialog, "Codex");
          await dialog.locator(".new-session-skill-chip").first().click();
          await dialog.getByLabel("First message").pressSequentially("the export branch");
          await dialog.getByLabel("Effort").selectOption("high");
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll (${name})`);
          await settled(page);
          await page.screenshot({ path: join(evidence, `${name}-filled.png`) });
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "detached" });
          const claude = await openDialog(page, make === phone ? "tab-menu" : "composer");
          await pickAgent(page, claude, "Claude Code");
          await claude.getByLabel("Effort").selectOption("medium");
          const ultracode = claude.getByRole("switch", { name: "Ultracode", exact: true });
          await ultracode.click();
          assert.equal(await ultracode.getAttribute("aria-checked"), "true");
          // the switch, its name and its note stay inside the dialog's width, on one line under Model and Effort,
          // which share a row at a desk and on a phone alike
          const [field, frame] = await Promise.all([claude.locator(".new-session-ultracode").boundingBox(), claude.boundingBox()]);
          assert.ok(field !== null && frame !== null, `the Ultracode line is laid out (${name})`);
          assert.ok(field.x >= frame.x && field.x + field.width <= frame.x + frame.width, `Ultracode inside the dialog (${name})`);
          await assertUltracodeLine(claude, make === phone ? 390 : 1280);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll with Claude Code (${name})`);
          if (make === phone) {
            // the narrowest phone too: two shrunk columns rather than a stack, and the note gives way, never the line
            await page.setViewportSize({ width: 320, height: 844 });
            await assertUltracodeLine(claude, 320);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal scroll at 320 (${name})`);
            await page.setViewportSize({ width: 390, height: 844 });
          }
          await settled(page);
          await page.screenshot({ path: join(evidence, `${name}-claude-ultracode.png`) });
        } finally { await context.close(); }
      }
      console.log("PASS captured the dialog at 390 and 1280 in light and dark, with Codex and with Claude Code's Ultracode on");
    } finally { await browser.close(); }
  } finally { server.stop(true); }
  writeFileSync(join(evidence, "request-log.txt"), log.join("\n") + "\n");
} finally {
  rmSync(app, { recursive: true, force: true });
}
