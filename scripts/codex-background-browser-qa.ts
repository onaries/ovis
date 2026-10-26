import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { CodexBackgroundTasks } from "../server/codex-background.ts";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import type {} from "./codex-background-fixture.tsx";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-codex-background-")));
const evidence = process.env.UI_EVIDENCE_DIR;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const agentId = "11111111-1111-4111-8111-111111111111";
const record = (payload: unknown, type = "response_item") => JSON.stringify({ type, timestamp: new Date().toISOString(), payload }) + "\n";
const parent = join(root, "parent.jsonl");
const started = record({ id: "parent-session" }, "session_meta")
  + record({ type: "function_call", name: "multi_agent_v1__spawn_agent", arguments: JSON.stringify({ agent_type: "explorer", message: "Inspect Codex lifecycle without changing files" }), call_id: "spawn" })
  + record({ type: "function_call_output", call_id: "spawn", output: JSON.stringify({ agent_id: agentId, nickname: "Explorer QA" }) });
const completed = record({ type: "user_message", message: `<subagent_notification>${JSON.stringify({ agent_path: agentId, status: { completed: "Lifecycle check completed" } })}</subagent_notification>` }, "event_msg");
const tracker = new CodexBackgroundTasks(() => {});
let activityReads = 0;
try {
  if (evidence) mkdirSync(evidence, { recursive: true });
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/codex-background-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), pane = url.searchParams.get("pane_id");
    assert.equal(request.method, "GET", "the UI must remain read-only");
    if (url.pathname === "/api/pane/omo-tasks") {
      activityReads += 1;
      tracker.poll("parent", parent);
      return Response.json({ tasks: pane === "parent" ? tracker.tasksOf("parent") : [], runs: [], server_time: new Date().toISOString() });
    }
    if (url.pathname === "/api/pane/background-agent") {
      tracker.poll("parent", parent);
      const found = tracker.detail("parent", url.searchParams.get("agent_id") ?? "");
      return "detail" in found ? Response.json({ ...found.detail, server_time: new Date().toISOString() }) : Response.json({ error: { code: "background_agent_not_found" } }, { status: 404 });
    }
    if (url.pathname === "/api/pane/commands") return Response.json({ commands: [] });
    if (url.pathname === "/api/pane/prompt") return Response.json({ prompt: null, outcomes: [] });
    if (url.pathname === "/api/voice") return Response.json({ configured: false, source: null, base_url: "", transcribe_model: "", polish_model: "" });
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    if (url.pathname.startsWith("/api/")) throw new Error(`Unexpected API read ${url.pathname}`);
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": CONTENT_SECURITY_POLICY } });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  let missing = 0;
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    writeFileSync(parent, started + completed); tracker.poll("parent", null); activityReads = 0;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ theme }) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })), { theme });
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.locator(".composer-pill").waitFor();
    const settled = () => page.evaluate(() => Promise.all(document.getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined))));
    const chip = page.locator(".bg-tasks-toggle");
    if (process.env.QA_BEFORE === "1") {
      await settled();
      if (evidence) await page.screenshot({ path: join(evidence, `codex-${width}-${theme}-before.png`) });
      if (await chip.count() === 0) missing += 1;
      await page.close(); continue;
    }
    await chip.waitFor();
    assert.ok(activityReads > 0, "a zero-count Codex pane discovers recently ended agents");
    await chip.click();
    await page.getByText("Nothing running right now", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    writeFileSync(parent, started); tracker.poll("parent", null);
    await page.evaluate(() => window.codexBackgroundQA.count(1));
    await chip.click();
    const row = page.locator(".bg-task-open");
    await row.waitFor();
    await settled();
    if (evidence) await page.screenshot({ path: join(evidence, `codex-${width}-${theme}-running.png`) });
    await row.click();
    const detail = page.locator(".bg-agent-detail");
    await detail.getByText("Inspect Codex lifecycle without changing files", { exact: true }).waitFor();
    await detail.getByText("Reported by the parent session; live child output is not read.", { exact: true }).waitFor();
    await settled();
    if (evidence) await page.screenshot({ path: join(evidence, `codex-${width}-${theme}-detail.png`) });
    await page.keyboard.press("Escape");
    assert.equal(await row.evaluate((element) => element === document.activeElement), true, "closing details restores keyboard focus");
    appendFileSync(parent, completed);
    await page.evaluate(() => window.codexBackgroundQA.count(0));
    await page.locator(".bg-task.is-running").waitFor({ state: "detached" });
    await page.locator(".bg-ended-toggle").click();
    await page.locator(".bg-task.is-completed .bg-task-open").click();
    await detail.getByText("Lifecycle check completed", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.codexBackgroundQA.pane("other"));
    await chip.waitFor({ state: "detached" });
    assert.equal(await page.locator(".bg-agent-detail").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log(`PASS Codex task discovery, running/detail/completion and pane isolation ${width}px ${theme}`);
    await page.close();
  }
  assert.equal(missing, 0, "Codex's composer must discover its parent-reported tasks");
} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
