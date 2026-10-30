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
const patchFile = "/repo/app/(reactive)/(unauth)/parent-station/ParentStationClient.tsx";
const pathPatch = '*** Begin Patch\n*** Update File: ${f}\n@@\n+import { useRouter } from "next/navigation";\n+const router = useRouter();\n*** End Patch';
const pathPatchInput = "const f = " + JSON.stringify(patchFile) + ";const p = " + String.fromCharCode(96) + pathPatch + String.fromCharCode(96) + ";text(await tools.apply_patch(p));";
let failed = true;
let phase = 0;
const agentId = "11111111-1111-4111-8111-111111111111";
const assignment = "TASK: Inspect the parser\nFind why tool labels lose their names.";
const agentInput = `text(await tools.multi_agent_v1__spawn_agent({agent_type:"explorer",message:${JSON.stringify(assignment)}}));`;
const input = 'const results = await Promise.all([tools.exec_command({cmd:"git status --short"}), tools.exec_command({cmd:"bun test"})]);';
const imageInput = 'for (const name of ["phone.png", "desktop.png"]) { const r = await tools.view_image({path:"/repo/evidence/" + name}); image(r.image_url); } text(await tools.write_stdin({session_id:51623,chars:""}));';
const dynamicInput = 'let p="*** Begin Patch\\n"; for (const f of files) { const r=await tools.exec_command({cmd:`rg ${f}`}); p+=r.output; } text(await tools.apply_patch(p));';
const objectsInput = 'const cmds=[{cmd:"ssh example cat report.json",workdir:"/repo"}]; const rs=await Promise.allSettled(cmds.map(c=>tools.exec_command(c)));';
const stringsInput = 'const cmds=["ssh example mount", "ssh example stat"];const r=await Promise.all(cmds.map(cmd=>tools.exec_command({cmd,yield_time_ms:10000,max_output_tokens:1000})));for(const x of r) text(x);';
const mappedOptionsInput = 'const cwd="/repo";const queries=["rg -n refetchInterval app src","rg -n ParentStation app src"];const rs=await Promise.allSettled(queries.map(cmd=>tools.exec_command({cmd,workdir:cwd,yield_time_ms:10000,max_output_tokens:7000})));for(const r of rs) text(r.status==="fulfilled"?r.value.output:String(r.reason));';
const catalogInput = 'const matches = ALL_TOOLS.filter(x => /confluence|atlassian/i.test(x.name + " " + x.description));\ntext(matches);';
const directCatalogInput = 'text(ALL_TOOLS.filter(x => /browser|playwright|chrome|opencli/i.test(x.name + " " + x.description)).slice(0,80));';
const templateInput = 'const base = "/repo/kiosk/frontend";\nconst r = await tools.exec_command({cmd: `sed -n 68,82p ${base}/src/components/operator/OperatorDashboardPage.tsx`, yield_time_ms: 20000, max_output_tokens: 1200});\ntext(r.output);';
const boundInput = String.raw`const command="node -e '"+load("receipt")+"'\ndiff -u "+load("draft")+" "+summary.outputPath;text(await tools.exec_command({cmd:command,max_output_tokens:3500}));`;
const records = [
  { type: "event_msg", timestamp: "2026-10-24T13:00:00Z", payload: { type: "user_message", message: "Check the repository" } },
  { type: "response_item", timestamp: "2026-10-24T13:00:01Z", payload: { type: "custom_tool_call", call_id: "one", name: "exec", input } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "images", name: "exec", input: imageInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "dynamic", name: "exec", input: dynamicInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "objects", name: "exec", input: objectsInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "strings", name: "exec", input: stringsInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "mapped-options", name: "exec", input: mappedOptionsInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "bound", name: "exec", input: boundInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "catalog", name: "exec", input: catalogInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "direct-catalog", name: "exec", input: directCatalogInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "template", name: "exec", input: templateInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:02Z", payload: { type: "custom_tool_call", call_id: "path-patch", name: "exec", input: pathPatchInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:03Z", payload: { type: "custom_tool_call", call_id: "spawn", name: "exec", input: agentInput } },
  { type: "response_item", timestamp: "2026-10-24T13:00:04Z", payload: { type: "custom_tool_call_output", call_id: "spawn", output: `Script completed\nOutput:\n${JSON.stringify({ agent_id: agentId, nickname: "Parser Scout" })}` } },
];
const notice = (status: Record<string, string>) => `<subagent_notification>${JSON.stringify({ agent_path: agentId, status })}</subagent_notification>`;
function conversation() {
  const updates: unknown[] = [...records];
  if (phase >= 1) updates.push(
    { type: "response_item", timestamp: "2026-10-24T13:00:05Z", payload: { type: "function_call", call_id: "wait", name: "multi_agent_v1__wait_agent", arguments: JSON.stringify({ targets: [agentId] }) } },
    { type: "response_item", timestamp: "2026-10-24T13:00:06Z", payload: { type: "function_call_output", call_id: "wait", output: JSON.stringify({ status: { [agentId]: "running" }, timed_out: true }) } },
  );
  if (phase >= 2) updates.push(
    { type: "event_msg", timestamp: "2026-10-24T13:00:07Z", payload: { type: "user_message", message: notice({ completed: "The parser reports the nested tool names." }) } },
    { type: "response_item", timestamp: "2026-10-24T13:00:07Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: notice({ completed: "The parser reports the nested tool names." }) }] } },
  );
  if (phase >= 3) updates.push(
    { type: "response_item", timestamp: "2026-10-24T13:00:08Z", payload: { type: "function_call", call_id: "followup", name: "multi_agent_v1__followup_task", arguments: JSON.stringify({ agent_id: agentId, message: "TASK: Verify the second assignment" }) } },
    { type: "event_msg", timestamp: "2026-10-24T13:00:09Z", payload: { type: "user_message", message: notice({ errored: "The isolated fixture reports a failure." }) } },
  );
  return parseCodexTranscript(updates.map((entry) => JSON.stringify(entry)).join("\n"));
}
const build = await Bun.build({ entrypoints: ["scripts/codex-status-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
assert.ok(build.success, String(build.logs));
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
  if (url.pathname.endsWith("/prompt")) return Response.json({ prompt: null, ...(failed && url.searchParams.get("pane_id") === "capacity" ? { runtime_error: codexRuntimeError(screen) } : {}) });
  if (url.pathname.endsWith("/conversation")) return Response.json({ source: "codex-transcript", history_id: url.searchParams.get("pane_id"), cursor: null, turns: url.searchParams.get("pane_id") === "capacity" ? conversation() : [], activity: "working" });
  if (url.pathname.endsWith("/omo-tasks")) return Response.json({ tasks: [], runs: [] });
  if (url.pathname.endsWith("/commands")) return Response.json({ commands: [] });
  if (url.pathname.endsWith("/connection-diagnostics")) return new Response(null, { status: 204 });
  if (url.pathname === "/") return new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/codex-status-fixture.css"></head><body style="margin:0"><div id="root"></div><script type="module" src="/codex-status-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
  return new Response(Bun.file(join(root, url.pathname.slice(1))));
} });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    failed = true;
    phase = 0;
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: width === 390 ? "ko-KR" : "en-US", isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: width === 390 ? 3 : 1 });
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
      await page.locator(".work-row-head").filter({ hasText: "exec_command · apply_patch" }).waitFor();
      await page.locator(".work-row-head").filter({ hasText: "ssh example cat report.json" }).waitFor();
      await page.locator(".work-row-head").filter({ hasText: "ssh example mount · ssh example stat" }).waitFor();
      const mappedOptions = page.locator(".work-row-head").filter({ hasText: "rg -n refetchInterval app src · rg -n ParentStation app src" });
      assert.match(await mappedOptions.innerText(), /Ran|실행함/);
      await mappedOptions.click();
      assert.equal(await mappedOptions.locator("..").locator("..").locator(".chat-tool-io").first().textContent(), mappedOptionsInput);
      await mappedOptions.scrollIntoViewIfNeeded();
      if (process.env.UI_EVIDENCE_DIR) {
        mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `codex-mapped-options-${width}-${theme}.png`) });
      }
      await mappedOptions.click();
      const bound = page.locator(".work-row-head").filter({ hasText: "node -e …" });
      await bound.click();
      assert.equal(await bound.locator("..").locator("..").locator(".chat-tool-io").first().textContent(), boundInput);
      await bound.click();
      const images = page.locator(".work-row-head").filter({ hasText: "view_image · write_stdin" });
      const catalog = page.locator(".work-row-head").filter({ hasText: "Search tools: confluence|atlassian" });
      assert.equal((await catalog.innerText()).trim(), "Search tools: confluence|atlassian");
      await catalog.click();
      assert.equal(await catalog.locator("..").locator("..").locator(".chat-tool-io").first().textContent(), catalogInput);
      await catalog.click();
      await images.click();
      const directCatalog = page.locator(".work-row-head").filter({ hasText: "Search tools: browser|playwright|chrome|opencli" });
      assert.equal((await directCatalog.innerText()).trim(), "Search tools: browser|playwright|chrome|opencli");
      await directCatalog.click();
      assert.equal(await directCatalog.locator("..").locator("..").locator(".chat-tool-io").first().textContent(), directCatalogInput);
      await directCatalog.click();
      await images.scrollIntoViewIfNeeded();
      const template = page.locator(".work-row-head").filter({ hasText: "sed -n 68,82p /repo/kiosk/frontend" });
      assert.ok((await template.innerText()).includes("OperatorDashboardPage.tsx"));
      await template.click();
      assert.equal(await template.locator("..").locator("..").locator(".chat-tool-io").first().textContent(), templateInput);
      await template.click();
      await template.scrollIntoViewIfNeeded();
      const patchRow = page.locator(".work-row-head").filter({ hasText: patchFile });
      assert.match(await patchRow.innerText(), /Edited|편집함/);
      await patchRow.click();
      const patchDetails = patchRow.locator("..").locator("..").locator(".chat-tool-io").first();
      assert.ok((await patchDetails.innerText()).includes("next/navigation"));
      assert.ok((await patchDetails.innerText()).includes("const router = useRouter()"));
      assert.equal(await patchDetails.locator(".chat-diff-add").count(), 2);
      await patchRow.scrollIntoViewIfNeeded();
      const evidence = process.env.UI_EVIDENCE_DIR;
      if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `codex-operations-${width}-${theme}.png`) }); }
      assert.equal((await images.innerText()).trim(), "view_image · write_stdin", "non-shell operations name their nested tools, without an exec or Ran prefix");
      assert.equal(await images.locator("..").locator("..").locator(".chat-tool-io").first().textContent(), imageInput, "expanding keeps the original JavaScript");
      await patchRow.click();
      await images.click();
      assert.equal(await page.locator(".work-block.is-live:not(.is-waiting)").count(), 0, "a failed turn must not still say Working");
      assert.match(await page.locator(".work-block-head").innerText(), /Needs you|내 응답 필요/);
      await notice.scrollIntoViewIfNeeded();
      if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `codex-capacity-${width}-${theme}.png`) }); }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no page overflow on phones");
      await page.clock.install();
      const retry = page.getByRole("button", { name: /Retry every 30 seconds|30초마다 재시도/ });
      await retry.click();
      await page.clock.fastForward(30_000);
      await page.waitForFunction(() => document.querySelector("#capacity-retries")?.textContent === "1");
      await page.clock.fastForward(30_000);
      await page.waitForFunction(() => document.querySelector("#capacity-retries")?.textContent === "2");
      if (evidence) await page.screenshot({ path: join(evidence, `codex-capacity-retry-${width}-${theme}.png`) });
      await page.getByRole("button", { name: /Stop retrying|자동 재시도 중지/ }).click();
      await page.clock.fastForward(30_000);
      assert.equal(await page.locator("#capacity-retries").textContent(), "2", "Stop cancels future retries");
      await notice.getByRole("button").click();
      await page.getByText("Terminal opened", { exact: true }).waitFor();
      await retry.click();
      await page.getByRole("button", { name: "Switch pane" }).click();
      await notice.waitFor({ state: "hidden" });
      await page.clock.fastForward(30_000);
      assert.equal(await page.locator("#capacity-retries").textContent(), "2", "another pane does not inherit retries");
      assert.equal(await page.locator(".chat-task-call").count(), 0, "other panes do not inherit the child assignment");
      await page.getByRole("button", { name: "Switch pane" }).click();
      await notice.waitFor();
      assert.equal(await retry.getAttribute("aria-pressed"), "false");
      failed = false;
      await notice.waitFor({ state: "hidden" });
      const assigned = page.locator(".work-row-head").filter({ hasText: "Inspect the parser" });
      await assigned.focus();
      await page.keyboard.press("Enter");
      const card = assigned.locator("..").locator("..").locator(".chat-task-call");
      await card.waitFor();
      assert.match(await card.innerText(), /Parser Scout/);
      assert.match(await card.innerText(), /explorer/);
      assert.equal(await card.locator("pre").textContent(), assignment);
      assert.equal(await page.locator(".chat-task-result").count(), 0, "spawn returning an id is not child completion");
      const raw = assigned.locator("..").locator("..").locator(".chat-teammate-raw");
      await raw.locator("summary").click();
      assert.equal(await raw.locator("pre").textContent(), agentInput);
      await raw.locator("summary").click();
      await assigned.scrollIntoViewIfNeeded();
      if (evidence) await page.screenshot({ path: join(evidence, `codex-subagent-assignment-${width}-${theme}.png`) });
      await assigned.click();
      phase = 1;
      const waiting = page.locator(".work-row-head").filter({ hasText: /Wait for agent|에이전트 응답 대기/ });
      await waiting.waitFor();
      await waiting.click();
      const waitingCard = waiting.locator("..").locator("..").locator(".chat-task-call");
      assert.match(await waitingCard.innerText(), /Reported status: running|보고된 상태: 실행 중/);
      assert.equal(await page.locator(".chat-task-result").count(), 0);
      await waiting.scrollIntoViewIfNeeded();
      if (evidence) await page.screenshot({ path: join(evidence, `codex-subagent-wait-${width}-${theme}.png`) });
      phase = 2;
      const completed = page.locator(".chat-task-result.is-completed");
      await completed.waitFor();
      assert.equal(await page.locator(".chat-task-result").count(), 1, "paired native notification is shown once");
      assert.match(await completed.locator("summary").innerText(), /Inspect the parser/);
      await completed.locator("summary").click();
      await completed.locator(".chat-task-result-body").waitFor();
      assert.match(await completed.innerText(), /The parser reports the nested tool names/);
      await completed.scrollIntoViewIfNeeded();
      if (evidence) await page.screenshot({ path: join(evidence, `codex-subagent-completed-${width}-${theme}.png`) });
      phase = 3;
      const errored = page.locator(".chat-task-result.is-failed");
      await errored.waitFor();
      assert.equal(await page.locator(".chat-task-result").count(), 2, "a reused child has a separate result for each assignment");
      assert.match(await errored.locator("summary").innerText(), /Verify the second assignment/);
      await errored.locator("summary").click();
      await errored.locator(".chat-task-result-body").waitFor();
      assert.match(await errored.innerText(), /The isolated fixture reports a failure/);
      await errored.scrollIntoViewIfNeeded();
      if (evidence) await page.screenshot({ path: join(evidence, `codex-subagent-failed-${width}-${theme}.png`) });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no subagent page overflow on phones");
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px ${theme}: capacity notice, exec labels, subagent assignment, wait, completed and failed results, pane isolation`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); await server.stop(true); rmSync(root, { recursive: true, force: true }); }
