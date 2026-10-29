/**
 * Fullwidth punctuation keeps every later cell of its row in its column (#739). Chrome trims a
 * run of fullwidth punctuation (text-spacing-trim), and xterm's WidthCache measures a glyph as
 * a run of 32: it measured ，。（） at half width, gave each one half a glyph too much spacing,
 * and the rest of the row drew to the right. OmO's side panel, drawn beside the transcript, then
 * stood in a different column on every row and moved as the transcript scrolled.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

/** the column every row's marker is written to, whatever stands before it */
const MARK_COLUMN = 100;
const ROWS = [
  "plain ascii row",
  "Ask: skill 集整改并给证据。wanted: 每条判据可核验。For you 如下，Now / Next 无剩余任务。",
  "完成审计（全绿）「飞机师」、；：。，",
  "한국어，중국어 문장부호（괄호）와 함께。",
];

const state = mkdtempSync(join(tmpdir(), "terminal-cjk-punctuation-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

try {
  // Given: a pane whose rows hold fullwidth punctuation, each with a marker at one column.
  const program = join(state, "rows.mjs");
  const screen = ROWS.map((row, index) => `${row}\x1b[${MARK_COLUMN}G|MARK${index}`).join("\r\n");
  writeFileSync(program, `process.stdout.write(${JSON.stringify(`\x1b[2J\x1b[H${screen}\r\nROWS_READY\r\n`)});
setInterval(() => {}, 1 << 30);
`);
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-cjk-punctuation" });
  workspaces.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const ready = herdrRpc("pane.wait_for_output", {
    pane_id: pane, source: "visible", match: { type: "substring", value: "ROWS_READY" }, timeout_ms: 10000,
  }, undefined, 12000);
  await herdrRpc("pane.send_input", { pane_id: pane, text: `exec ${quote(process.execPath)} ${quote(program)}`, keys: ["enter"] });
  await ready;

  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(state, "server"),
    tailscaleOwner: null, usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  // a Chinese page, as the report's: under zh every fullwidth mark is trimmed, not only ，（）
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({
    language: "zh", defaultView: "terminal", alertsOn: false,
  })));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.locator(".pane-terminal .xterm-rows", { hasText: `MARK${ROWS.length - 1}` }).waitFor();
  // fonts settle and xterm measures again: read once the rows stop changing
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))));

  // When: the rows are drawn, each marker is found where the browser put it.
  const drawn = await page.evaluate((count) => {
    const rows = document.querySelector<HTMLElement>(".pane-terminal .xterm-rows")!;
    const left = rows.getBoundingClientRect().left;
    const marks: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const walker = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent!.indexOf(`|MARK${index}`);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 1);
        marks.push(range.getBoundingClientRect().left - left);
        break;
      }
    }
    const measure = document.querySelector<HTMLElement>(".pane-terminal .xterm-char-measure-element");
    // whether this browser trims fullwidth punctuation in the terminal's font at all (a CJK font with the features)
    const probe = document.createElement("span");
    probe.style.whiteSpace = "pre";
    probe.style.setProperty("text-spacing-trim", "normal");
    probe.textContent = "，".repeat(32);
    (measure?.parentElement ?? document.body).append(probe);
    const trimmed = probe.getBoundingClientRect().width;
    probe.style.setProperty("text-spacing-trim", "space-all");
    const full = probe.getBoundingClientRect().width;
    probe.remove();
    return { marks, trims: trimmed < full - 1, measureTrim: measure ? getComputedStyle(measure).getPropertyValue("text-spacing-trim") : null };
  }, ROWS.length);
  console.log(JSON.stringify(drawn));
  await page.screenshot({ path: join(evidence, "terminal-cjk-punctuation.png") });

  // Then: every marker stands where the plain row's does.
  assert.equal(drawn.marks.length, ROWS.length, "every row's marker is drawn");
  const [plain, ...others] = drawn.marks;
  others.forEach((x, index) => assert.ok(Math.abs(x - plain!) < 1,
    `row ${index + 1}'s marker is drawn ${(x - plain!).toFixed(1)}px from its column`));
  // xterm measures each glyph alone, as it is drawn, whether or not this browser's fonts trim
  assert.equal(drawn.measureTrim, "space-all");
  assert.deepEqual(errors, []);
  console.log(`PASS fullwidth punctuation keeps its row's later cells in their columns${drawn.trims ? "" : " (this browser does not trim punctuation)"}`);
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
