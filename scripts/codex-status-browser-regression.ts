import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { codexRuntimeError } from "../server/dialogs/codex.ts";
import { parseCodexTranscript } from "../server/codex.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-codex-status-"));
const screen = "■ Selected model is at capacity. Please try a different model.\n\n› Ask Codex to do anything\n gpt-6.1-sol high · 38% context left";
let failed = true;
const input = 'const results = await Promise.all([tools.exec_command({cmd:"git status --short"}), tools.exec_command({cmd:"bun test"})]);';
const turns = parseCodexTranscript([
  { type: "event_msg", timestamp: "2026-10-24T13:00:00Z", payload: { type: "user_message", message: "Check the repository" } },
  { type: "response_item", timestamp: "2026-10-24T13:00:01Z", payload: { type: "custom_tool_call", call_id: "one", name: "exec", input } },
].map((entry) => JSON.stringify(entry)).join("\n"));
const build = await Bun.build({ entrypoints: ["scripts/codex-status-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
assert.ok(build.success, String(build.logs));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (url.pathname.endsWith("/prompt")) return Response.json({ prompt: null, ...(failed && url.searchParams.get("pane_id") === "capacity" ? { runtime_error: codexRuntimeError(screen) } : {}) });
  if (url.pathname.endsWith("/conversation")) return Response.json({ source: "codex-transcript", history_id: url.searchParams.get("pane_id"), cursor: null, turns, activity: "working" });
  if (url.pathname.endsWith("/omo-tasks")) return Response.json({ tasks: [], runs: [] });
  if (url.pathname.endsWith("/commands")) return Response.json({ commands: [] });
  if (url.pathname.endsWith("/connection-diagnostics")) return new Response(null, { status: 204 });
  if (url.pathname === "/") return new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/codex-status-fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/codex-status-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  return new Response(Bun.file(join(root, url.pathname.slice(1))));
} });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    failed = true;
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: width === 390 ? "ko-KR" : "en-US" });
    try {
      const page = await context.newPage();
      const errors: string[] = [], writes: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => { if (/\/api\/.*(?:submit|send|answer|keys)/.test(request.url())) writes.push(request.url()); });
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
      const notice = page.locator('[role="alert"]').filter({ hasText: /capacity|처리 용량/ });
      await notice.waitFor({ timeout: 7000 });
      await page.locator(".work-row-head").filter({ hasText: "git status --short · bun test" }).waitFor();
      assert.equal(await page.locator(".work-block.is-live:not(.is-waiting)").count(), 0, "a failed turn must not still say Working");
      assert.match(await page.locator(".work-block-head").innerText(), /Needs you|내 응답 필요/);
      await notice.scrollIntoViewIfNeeded();
      const evidence = process.env.UI_EVIDENCE_DIR;
      if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `codex-capacity-${width}-${theme}.png`) }); }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no page overflow on phones");
      await notice.getByRole("button").click();
      await page.getByText("Terminal opened", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Switch pane" }).click();
      await notice.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Switch pane" }).click();
      await notice.waitFor();
      failed = false;
      await notice.waitFor({ state: "hidden" });
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px ${theme}: capacity notice, exec command labels, terminal action, pane isolation and recovery`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); await server.stop(true); rmSync(root, { recursive: true, force: true }); }
