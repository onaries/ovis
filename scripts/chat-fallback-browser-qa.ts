/** Real ChatView with an unavailable conversation and a stalled optional terminal. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import { parseClaudeTranscript } from "../server/conversation.ts";
import type { ConversationTurn, InteractivePrompt } from "../shared/protocol.ts";
import type {} from "./chat-fallback-fixture.tsx";
import { parseInteractivePrompt } from "../server/prompt.ts";
import piNavigation from "../server/fixtures/pi-ask-navigation.json";
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-fallback-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/chat-fallback-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const terminalReads: string[] = [];
  let structured = false, resolveAgent!: () => void, agentReadArrived!: () => void;
  let lookupTimeout = false;
  let source = "codex-transcript";
  let prompt: InteractivePrompt | null = null;
  let turns: ConversationTurn[] = [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Structured conversation arrived" }] }];
  // resolved by the server's handler: a browser-side waitForRequest can win the race against it
  const agentRead = new Promise<void>((resolve) => { agentReadArrived = resolve; });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), pane = url.searchParams.get("pane_id");
    if (url.pathname === "/api/pane/prompt") return Response.json({ prompt, outcomes: [] });
    // the chat's skill matcher asks for the pane's commands
    if (url.pathname === "/api/pane/commands") return Response.json({ commands: [] });
    if (url.pathname === "/api/pane/conversation") {
      if (lookupTimeout && pane === "agent") return Response.json({ error: { code: "read_timeout", message: "Conversation read timed out." } }, { status: 504 });
      return Response.json({ source: (structured && pane === "agent") || pane === "empty" ? source : "scrollback", cursor: null, turns: structured && pane === "agent" ? turns : [] });
    }
    if (url.pathname === "/api/pane/read") {
      terminalReads.push(pane ?? "");
      if (pane === "error") return Response.json({ error: { code: "read_failed", message: "Terminal output unavailable" } }, { status: 500 });
      const response = () => Response.json({ read: { text: pane === "shell" ? "Shell inline output" : "OLD AGENT TERMINAL", truncated: false } });
      if (pane === "agent") return new Promise<Response>((resolve) => { resolveAgent = () => resolve(response()); agentReadArrived(); });
      return response();
    }
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": CONTENT_SECURITY_POLICY } });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage(); page.setDefaultTimeout(10_000);
  await page.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}`);
  const summary = page.locator(".chat-terminal-fallback summary");
  await summary.waitFor();
  await page.getByText("Loading conversation…", { exact: true }).waitFor({ state: "detached" });
  assert.equal(terminalReads.length, 0, "a hidden terminal read cannot hold the initial chat");
  assert.equal(await page.locator(".chat-empty").count(), 0, "an agent terminal fallback does not claim the conversation is empty");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-fallback-closed.png") });
  }
  await summary.click();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([agentRead, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("opening the disclosure never read the agent terminal")), 10_000); })]);
  clearTimeout(deadline);
  assert.ok(terminalReads.includes("agent"));
  structured = true;
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await page.getByText("Structured conversation arrived", { exact: true }).waitFor();
  lookupTimeout = true;
  const timedOut = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation" && response.status() === 504);
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await timedOut;
  await page.getByText("Waiting for the PC…", { exact: true }).waitFor();
  assert.equal(await page.getByText("Structured conversation arrived", { exact: true }).isVisible(), true, "a temporary SDK timeout keeps the already rendered conversation");
  assert.equal(await page.locator(".chat-terminal-fallback").count(), 0, "a timeout does not replace the conversation with terminal fallback");
  lookupTimeout = false;
  turns = [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Conversation recovered after SDK timeout" }] }];
  await page.evaluate(() => window.chatFallbackQA.refresh());
  await page.getByText("Conversation recovered after SDK timeout", { exact: true }).waitFor();
  await page.getByText("Waiting for the PC…", { exact: true }).waitFor({ state: "hidden" });
  const nextKindRead = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/pane/conversation", { timeout: 3_000 });
  await page.evaluate(() => window.chatFallbackQA.agent("claude"));
  await nextKindRead;
  resolveAgent();
  await page.locator(".chat-terminal-fallback").waitFor({ state: "detached" });
  assert.ok(!(await page.locator("body").innerText()).includes("OLD AGENT TERMINAL"));
  await page.evaluate(() => window.chatFallbackQA.pane("shell"));
  await page.getByText("Shell inline output", { exact: true }).waitFor();
  assert.ok(terminalReads.includes("shell"), "non-agent scrollback remains inline");
  await page.evaluate(() => window.chatFallbackQA.pane("error"));
  await summary.waitFor();
  await summary.click();
  // the failure is one line naming what failed, Try again beside it (no cause is known), and the
  // advice with the server's words folded behind Details (lib/userError.ts, ChatView FailureLine)
  const fallbackError = page.locator(".chat-terminal-fallback [role=\"alert\"]");
  await fallbackError.waitFor();
  assert.equal(await fallbackError.count(), 1, "terminal-read failures are announced as errors");
  assert.equal(await fallbackError.locator(".chat-failure-line").innerText(), "Couldn't load the terminal output", "the alert names what failed, nothing more on the line");
  assert.equal(await fallbackError.getByRole("button", { name: "Try again", exact: true }).count(), 1, "an unknown cause offers Try again");
  const fold = fallbackError.locator("details");
  assert.equal(await fold.locator("> summary").innerText(), "Details", "the rest is folded");
  assert.equal(await fold.evaluate((node: HTMLDetailsElement) => node.open), false, "and folded until asked");
  await fold.locator("> summary").click();
  assert.ok((await fold.innerText()).includes("Try again; if it keeps failing, restart Ovis on the PC."), "opened, Details holds the advice");
  assert.equal(await fold.locator("code").innerText(), "Terminal output unavailable", "and the server's words, selectable, beside it");
  assert.equal(await page.locator(".chat-empty").count(), 0, "a fallback failure is not an empty structured conversation");
  await page.evaluate(() => window.chatFallbackQA.pane("empty"));
  await page.getByText("No conversation yet — say something below", { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-terminal-fallback").count(), 0, "an empty structured conversation keeps its ordinary prompt");
  // Native parser output crosses HTTP into the real ChatView. Later activity must not
  // move a final reply into the fold or duplicate it. Only explicit commentary joins the tools there.
  const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");
  source = "claude-transcript";
  turns = parseClaudeTranscript(jsonl(
    { type: "assistant", timestamp: "2026-01-01T12:00:00Z", message: { content: [{ type: "text", text: "The catalog has three books." }], stop_reason: "end_turn" } },
    { type: "user", message: { content: "<task-notification><task-id>catalog</task-id><status>completed</status><summary>Catalog check finished.</summary></task-notification>" } },
    { type: "assistant", timestamp: "2026-01-01T12:01:00Z", message: { content: [{ type: "tool_use", id: "check", name: "Bash", input: { command: "true" } }], stop_reason: "tool_use" } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "check", content: "Two available" }] } },
    { type: "assistant", timestamp: "2026-01-01T12:02:00Z", message: { content: [{ type: "text", text: "Two books are available." }], stop_reason: "end_turn" } },
    { type: "user", isMeta: true, userType: "external", message: { content: "Background command catalog-check failed with exit code 124" } },
    { type: "assistant", timestamp: "2026-01-01T12:03:00Z", message: { content: [{ type: "text", text: "The background check timed out." }], stop_reason: "end_turn" } },
  ));
  await page.evaluate(() => { window.chatFallbackQA.agent("claude"); window.chatFallbackQA.pane("agent"); window.chatFallbackQA.refresh(); });
  await page.getByText("The background check timed out.", { exact: true }).waitFor();
  const replies = page.locator(".chat-turn-agent");
  console.log("Claude background reply rendering:", JSON.stringify(await replies.allTextContents()));
  assert.equal(await replies.count(), 3, "completed replies have separate message bubbles");
  for (const [index, text] of ["The catalog has three books.", "Two books are available.", "The background check timed out."].entries()) {
    assert.equal(await replies.nth(index).getByText(text, { exact: true }).isVisible(), true, "replies stay visible in transcript order");
    assert.equal(await replies.nth(index).locator("time").count(), 1, "each reply has its own time");
    assert.equal(await replies.nth(index).locator("time").getAttribute("datetime"), ["2026-01-01T12:00:00Z", "2026-01-01T12:01:00Z", "2026-01-01T12:03:00Z"][index], "each bubble keeps its own turn timestamp");
  }
  assert.equal(await replies.nth(0).locator(".work-block").count(), 0, "later tools do not move before the first reply");
  assert.equal(await replies.nth(1).locator(".work-block").count(), 1, "tools stay with the reply they produced");
  assert.equal(await replies.nth(2).locator(".work-block").count(), 0, "later reply does not inherit earlier tools");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "claude-separate-replies.png") });
  console.log("PASS Claude background continuations keep separate replies, times and intervening work");
  {
    const answer = "The fictional Claude catalog contains three books.";
    const narration = "Checking the Claude catalog.";
    turns = parseClaudeTranscript(jsonl(
      { type: "assistant", message: { content: [{ type: "text", text: answer }], stop_reason: "end_turn" } },
      { type: "user", isMeta: true, userType: "external", message: { role: "user", content: "Stop hook feedback: Verify the fictional catalog." } },
      { type: "system", subtype: "stop_hook_summary" },
      { type: "assistant", message: { content: [{ type: "text", text: narration }, { type: "tool_use", id: "cleanup", name: "Bash", input: { command: "true" } }], stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cleanup", content: "Verified" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Catalog verification complete." }], stop_reason: "end_turn" } },
    ));
    await page.evaluate(() => { window.chatFallbackQA.agent("claude"); window.chatFallbackQA.pane("agent"); window.chatFallbackQA.refresh(); });
    await page.getByText(answer, { exact: true }).waitFor();
    const continuation = page.locator(".chat-turn-agent").nth(1);
    const work = continuation.locator(".work-block");
    const head = work.locator(".work-block-head");
    await head.waitFor();
    if (await head.getAttribute("aria-expanded") === "true") await head.click();
    await work.locator(".work-block-rows").waitFor({ state: "hidden" });
    assert.equal(await work.getByText(answer, { exact: true }).count(), 0, "the reply is outside work");
    assert.equal(await page.getByText(answer, { exact: true }).count(), 1, "the reply appears once");
    assert.equal(await page.getByText(answer, { exact: true }).isVisible(), true, "folding work keeps the reply visible");
    assert.equal(await continuation.getByText(narration, { exact: true }).isVisible(), true, "unphased narration stays visible outside folded work");
    assert.equal(await work.getByText(narration, { exact: true }).count(), 0, "unphased narration is not part of work");
    assert.equal(await page.getByText(narration, { exact: true }).count(), 1, "unphased narration appears once");
    assert.equal(await page.getByText("Catalog verification complete.", { exact: true }).isVisible(), true, "the hook continuation's short reply is also visible");
    assert.equal(await page.locator(".chat-turn-agent").count(), 2, "hook continuation answers have separate bubbles");
    assert.equal(await page.getByText(/Stop hook feedback:/).count(), 0, "injected hook context is not a user message");
    await head.click();
    assert.equal(await work.locator(".work-row-head").count(), 1, "the tool stays inside work");
    await head.click();
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "claude-hook-separate-replies.png") });
    console.log("PASS Claude hook narration and replies stay visible outside folded work; the tool remains inside");
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    prompt = parseInteractivePrompt("pi", piNavigation["custom-empty"])!;
    const originalId = prompt.id;
    await page.evaluate(() => { window.chatFallbackQA.agent("pi"); window.chatFallbackQA.refresh(); });
    const card = page.locator(".prompt-card");
    await card.waitFor();
    const back = card.getByRole("button", { name: "Back", exact: true });
    const question = card.getByRole("button", { name: "单元格内容", exact: true });
    assert.equal(await back.count(), 0, "native custom editor owns navigation");
    assert.equal(await question.count(), 0);
    const input = card.locator("input.input");
    await input.fill("unsent browser draft");
    const mountedCard = await card.elementHandle();
    prompt = parseInteractivePrompt("pi", piNavigation["second-answered"])!;
    assert.equal(prompt.id, originalId, "leaving the editor does not change question identity");
    await page.evaluate(() => window.chatFallbackQA.refresh());
    await back.waitFor();
    await question.waitFor();
    assert.equal(await input.inputValue(), "unsent browser draft", "metadata refresh preserves web edits");
    assert.equal(await mountedCard!.evaluate(node => node.isConnected), true, "the card stays mounted");
    await input.fill("");
    assert.equal(await back.isEnabled(), true);
    assert.equal(await question.isEnabled(), true);
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `pi-navigation-${width}.png`) });
    // Start the next width with a new occurrence so its initial navigation state is observed.
    prompt = null;
    await page.evaluate(() => window.chatFallbackQA.refresh());
    await card.waitFor({ state: "detached" });
  }
  console.log("PASS same-id Pi navigation refresh restores Back/question buttons without losing web drafts at desktop and mobile widths");
  assert.deepEqual(errors, []);
  structured = false;
  const polling = await browser.newPage();
  let pollingReads = 0;
  polling.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/pane/conversation") pollingReads += 1;
  });
  await polling.clock.install();
  await polling.clock.pauseAt(new Date());
  await polling.addInitScript(() => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
  });
  await polling.goto(`http://127.0.0.1:${server.port}/?pushes`);
  await polling.locator(".chat-terminal-fallback summary").waitFor();
  const codexReads = pollingReads;
  await polling.clock.runFor(2000);
  assert.equal(pollingReads, codexReads, "Codex terminal fallback keeps its 10s backstop");
  const codexBackstop = polling.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation");
  await polling.clock.runFor(8000);
  await codexBackstop;
  assert.equal(pollingReads, codexReads + 1);
  const changedAgent = polling.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation");
  await polling.evaluate(() => window.chatFallbackQA.agent("copilot"));
  await changedAgent;
  const copilotReads = pollingReads;
  const copilotPoll = polling.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation");
  await polling.clock.runFor(2000);
  await copilotPoll;
  assert.equal(pollingReads, copilotReads + 1, "Copilot terminal fallback uses the 2s recovery poll");
  await polling.close();
  console.log("PASS fallback polling keeps 10s for Codex and 2s for Copilot under a controlled clock");
  for (const width of [390, 1440]) for (const theme of ["light", "dark"] as const) {
    structured = false;
    source = "agy-transcript";
    prompt = null;
    turns = [{ role: "assistant", ts: null, parts: [{ kind: "text", text: "Agy conversation recovered without a reload" }] }];
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390, locale: "en-US", colorScheme: theme });
    try {
      const recovery = await context.newPage();
      const recoveryErrors: string[] = [];
      recovery.on("pageerror", (error) => recoveryErrors.push(error.message));
      await recovery.clock.install();
      await recovery.clock.pauseAt(new Date());
      await recovery.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
      await recovery.goto(`http://127.0.0.1:${server.port}/?pushes`);
      const changed = recovery.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation");
      await recovery.evaluate(() => window.chatFallbackQA.agent("agy"));
      await changed;
      await recovery.getByText("Antigravity chat is unavailable. Open Terminal to see activity and tool calls.", { exact: true }).waitFor();
      await recovery.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      const evidence = process.env.UI_EVIDENCE_DIR;
      if (evidence) await recovery.screenshot({ path: join(evidence, `agy-unavailable-${width}-${theme}.png`) });
      structured = true;
      const recoveredRead = recovery.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/conversation", { timeout: 3000 });
      await recovery.clock.runFor(2000);
      await recoveredRead;
      await recovery.clock.resume();
      await recovery.getByText("Agy conversation recovered without a reload", { exact: true }).waitFor();
      assert.equal(await recovery.locator(".chat-terminal-fallback").count(), 0, "native history replaces fallback without a push, reload or pane switch");
      assert.equal(await recovery.getByText("Antigravity chat is unavailable. Open Terminal to see activity and tool calls.", { exact: true }).count(), 0);
      if (evidence) await recovery.screenshot({ path: join(evidence, `agy-recovered-${width}-${theme}.png`) });
      assert.deepEqual(recoveryErrors, []);
      console.log(`PASS agy fallback recovers in the normal poll at ${width}px ${theme} without a watcher push`);
    } finally { await context.close(); }
  }
  console.log("chat fallback: browser OK (no hidden terminal reads, opened stalled output cannot block structured refresh, late cleanup, non-agent inline output, fallback error announcement and accurate empty state)");

} finally {
  await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true });
}
