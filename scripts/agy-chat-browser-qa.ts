/** Fictional Agy steps -> real reader/API -> desktop and mobile activity feedback. */
import "./test-herdr.ts";
import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";

if (process.platform !== "linux") { console.log("SKIP Agy process fixture requires Linux"); process.exit(0); }
const root = mkdtempSync(join(tmpdir(), "herdr-agy-activity-"));
const session = "00000000-0000-4000-8000-000000000021";
const dir = join(root, "brain", session, ".system_generated", "logs");
mkdirSync(dir, { recursive: true });
mkdirSync(join(root, "conversations")); mkdirSync(join(root, "presence"));
const path = join(dir, "transcript_full.jsonl");
const lock = join(root, "presence", `${session}.lock`);
writeFileSync(path, ""); writeFileSync(lock, "");
const db = new Database(join(root, "conversations", `${session}.db`));
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY)");
let index = 0;
const add = (type: string, content = "", extra = {}) => {
  const step_index = index++;
  db.query("INSERT INTO steps VALUES (?)").run(step_index);
  appendFileSync(path, JSON.stringify({ step_index, type, content, status: "DONE", ...extra }) + "\n");
};
const executable = join(root, "agy");
const runtime = Bun.which("node");
if (!runtime) throw new Error("the Agy stand-in needs Node");
copyFileSync(runtime, executable); chmodSync(executable, 0o755);
const standIn = join(root, "agy-fixture.cjs");
writeFileSync(standIn, `process.title = "agy"; require("node:fs").openSync(${JSON.stringify(lock)}, "r"); process.stdin.resume();`);
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-agy-activity" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: pane, text: `${executable} ${standIn}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    if ((await sessionSnapshot()).panes.find((p) => p.pane_id === pane)?.agent === "agy") break;
    if (Date.now() > deadline) throw new Error("fictional Agy process did not start");
    await Bun.sleep(50);
  }
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: "en-US" });
  page.setDefaultTimeout(12_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(id => {
    localStorage.setItem(`ovis:view:${id}`, "chat");
    localStorage.setItem("ovis:settings", JSON.stringify({ showThinking: true, theme: "system" }));
  }, pane);
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const log = page.locator(`.pane-frame[data-layout-pane="${pane}"]`).getByRole("log");
  const activity = log.locator(".chat-activity");
  const cases = [{ width: 1100, height: 800 }, { width: 390, height: 844 }]
    .flatMap(viewport => (["light", "dark"] as const).map(theme => ({ ...viewport, theme })));
  for (const [turn, viewport] of cases.entries()) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: viewport.theme });
    const label = `${viewport.width}-${viewport.theme}`;
    add("USER_INPUT", `Fictional task at ${label}`);
    add("EPHEMERAL_MESSAGE", "hidden context");
    await log.locator(".chat-activity", { hasText: "Working…" }).waitFor();
    assert.notEqual((await sessionSnapshot()).panes.find(p => p.pane_id === pane)?.agent_status, "working");
    const box = await activity.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, "activity is visible above the composer");
    const thoughtText = `Checking image names at ${label}`;
    add("PLANNER_RESPONSE", "", { thinking: thoughtText, tool_calls: [{ name: "view_file", args: { AbsolutePath: "/fiction.txt" } }] });
    await log.locator(".work-block.is-live .work-row-head").last().waitFor({ state: "visible" });
    const thought = log.locator(".work-block.is-live .work-row-thinking").last();
    const thoughtHead = thought.getByRole("button", { name: "thinking", exact: true });
    await thoughtHead.waitFor();
    assert.equal(await thoughtHead.getAttribute("aria-expanded"), "false");
    assert.equal(await thought.locator(".work-thinking-text").count(), 0);
    await thoughtHead.click();
    await thought.getByText(thoughtText, { exact: true }).waitFor();
    add("GENERIC", "Fictional tool result");
    // the open work block's head says Working now: the line under it goes
    await log.locator(".work-block.is-live .work-block-title", { hasText: "Working…" }).waitFor();
    await activity.waitFor({ state: "detached" });
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `agy-${label}-thinking.png`) });
    }
    add("PLANNER_RESPONSE", `Finished task at ${label}`);
    await log.getByText(`Finished task at ${label}`, { exact: true }).waitFor();
    await activity.waitFor({ state: "detached" });
    add("GENERIC", `Late result at ${label}`);
    await page.reload();
    await log.getByText(`Finished task at ${label}`, { exact: true }).waitFor();
    assert.equal(await activity.count(), 0, "a late tool result does not restart completed activity");
    for (const head of await log.locator(".work-block-head").all()) {
      if (await head.getAttribute("aria-expanded") === "false") await head.click();
    }
    assert.equal(await log.locator(".work-row-thinking").count(), turn + 1, "recorded thoughts survive a history reload");
    await log.evaluate(element => { element.scrollTop = element.scrollHeight; });
  }
  const rewind = index;
  add("USER_INPUT", "Remove this active prompt");
  await activity.waitFor();
  db.query("DELETE FROM steps WHERE idx >= ?").run(rewind);
  await activity.waitFor({ state: "detached" });
  assert.equal(await log.getByText("Remove this active prompt", { exact: true }).count(), 0);
  db.exec("DROP TABLE steps");
  await log.getByText("Antigravity chat is unavailable. Open Terminal to see activity and tool calls.", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS Agy desktop/mobile recorded thinking, native activity, live tools, completion, late results, rewind and unavailable-chat notice");
} finally {
  const errors: unknown[] = [];
  try { await browser?.close(); } catch (error) { errors.push(error); }
  try { server?.stop(); } catch (error) { errors.push(error); }
  try { db.close(); } catch (error) { errors.push(error); }
  try { if (workspace) await workspaceClose(workspace); } catch (error) { errors.push(error); }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length) { console.error(new AggregateError(errors, "Agy browser cleanup failed")); process.exitCode = 1; }
}
