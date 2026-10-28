/** Real React + browser regressions with controlled HTTP timing. No herdr panes are touched. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { VOICE_DEFAULTS, type VoiceStatus } from "../shared/voice.ts";
import type { HerdrUiConfig } from "../shared/protocol.ts";
import type {} from "./chat-history-fixture.tsx";
import { parseAgyTranscript } from "../server/agy.ts";
import { buildXtermSource } from "./build-xterm.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-history-browser-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const releases: Array<() => void> = [];
const routeEvents = new EventTarget();
function nextRoute(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const arrived = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      routeEvents.removeEventListener(name, arrived);
      reject(new Error(`No fixture request for ${name}`));
    }, 10_000);
    routeEvents.addEventListener(name, arrived, { once: true });
  });
}
try {
  // the app's own xterm, as Vite aliases it: the patched source, not the package's minified build
  const xterm = buildXtermSource(join(import.meta.dir, ".."));
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' }, plugins: [{
    name: "xterm-source-aliases",
    setup(build) {
      build.onResolve({ filter: /^@xterm\/xterm$/ }, () => ({ path: join(xterm, "browser/public/Terminal.js") }));
      build.onResolve({ filter: /^(browser|common)\// }, ({ path }) => ({ path: join(xterm, path + ".js") }));
    },
  }] });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/ws") return new Response(null, { status: 404 });
    // Product connection failures report only metadata; this fictional server consumes it locally.
    if (path === "/api/connection-diagnostics") return new Response(null, { status: 204 });
    // the terminal reads herdr's copy_on_select as it mounts
    if (path === "/api/herdr-ui") return Response.json({ copy_on_select: true } satisfies HerdrUiConfig, { headers: { "cache-control": "no-store" } });
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    if (path.endsWith("/pane/omo-tasks")) return Response.json({ tasks: [], runs: [] });
    // a desktop's composer asks whether dictation can work here before it shows the mic
    if (path === "/api/voice") return Response.json({ configured: false, source: null, ...VOICE_DEFAULTS } satisfies VoiceStatus);
    return path === "/" ? new Response('<html><head><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  // The fixture follows the browser's language; its text assertions below use English.
  const page = await browser.newPage({ locale: "en-US" });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  let epoch = "one", newest = "old newest", before: string | null = null;
  let holdOlder = false;
  let product = false;
  let compacting = false;
  await page.route("**/api/**/prompt?*", route => route.fulfill({ json: { prompt: null, suggestion: null, compacting } }));
  let unavailable = false, terminalFails = false;
  let readPending = false, gapPending = false;
  let holdTerminal = false;
  let terminalText = "Fictional terminal fallback";
  /** product panes ("machine/pane") whose conversation requests wait for the script, and those that fail */
  const held = new Set<string>(), failing = new Set<string>();
  const pending: Array<{ key: string; answer: (status: number) => Promise<void> }> = [];
  const user = (text: string) => ({ role: "user", ts: text, parts: [{ kind: "text", text }] });
  await page.route("**/api/**/read?*", async (route) => {
    routeEvents.dispatchEvent(new Event("terminal"));
    if (holdTerminal) await new Promise<void>((resolve) => releases.push(resolve));
    await (terminalFails
      ? route.fulfill({ status: 503, json: { error: { code: "timeout", message: "fictional terminal read failed" } } })
      : route.fulfill({ json: { read: { text: terminalText, truncated: false } } }));
  });
  await page.route("**/api/**/conversation?*", async (route) => {
    const url = new URL(route.request().url());
    if (product) {
      const pane = url.searchParams.get("pane_id") ?? url.searchParams.get("pane") ?? "";
      const key = `${/\/api\/machines\/([^/]+)\//.exec(url.pathname)?.[1] ?? "local"}/${pane}`;
      const answer = (status: number) => status === 200
        ? route.fulfill({ json: key === "local/agy" ? { source: "agy-transcript", history_id: "synthetic-agy-session", cursor: null, turns: parseAgyTranscript([
          { step_index: 0, type: "USER_INPUT", status: "DONE", content: "Summarize the last three fictional commits." },
          { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command", args: { CommandLine: "git log -3 --oneline" } }] },
          { step_index: 2, type: "GENERIC", status: "DONE", content: "Fictional commit log" },
          { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "Synthetic Agy answer" },
        ].map((row) => JSON.stringify(row)).join("\n")) } : key === "local/devin" ? { source: "devin-transcript", history_id: "synthetic-devin-session", cursor: null, turns: [
          user("Synthetic Devin prompt"),
          { role: "assistant", ts: null, parts: [
            { kind: "tool", name: "synthetic_tool", summary: "synthetic_tool", input: "{}", output: "synthetic result" },
            { kind: "text", text: "Synthetic Devin answer" },
          ] },
        ] } : { source: key === "local/claude" ? "claude-transcript" : "omp-transcript", history_id: key, cursor: null, turns: [user(key === "local/claude" ? "Synthetic Claude prompt" : `history ${key}`)] } })
        : route.fulfill({ status, json: { error: { code: "unavailable", message: "conversation unavailable" } } });
      // answered as it arrives unless its pane is held: a poll an abandoned mount left
      // behind can then never stand in for the request an assertion waits on
      if (held.has(key)) await new Promise<void>((resolve) => {
        pending.push({ key, answer: (status) => answer(status).finally(resolve) });
        routeEvents.dispatchEvent(new Event(key));
      });
      else await answer(failing.has(key) ? 503 : 200);
      return;
    }
    if (unavailable) {
      await route.fulfill({ json: { source: "scrollback", turns: [] } });
      return;
    }
    if (readPending || (gapPending && url.searchParams.has("before"))) {
      const displayed = url.searchParams.get("history_id");
      if (displayed !== null && displayed !== epoch) {
        await route.fulfill({ status: 409, json: { error: { code: "history_changed", message: "reload history" } } });
        return;
      }
      if (displayed === null && !url.searchParams.has("before") && !url.searchParams.has("from")) {
        await route.fulfill({ json: { source: "scrollback", turns: [] } });
        return;
      }
      await route.fulfill({ status: 503, json: { error: { code: "conversation_read_pending", message: "The conversation could not be read; try again shortly." } } });
      return;
    }
    const captured = epoch;
    const cursor = url.searchParams.get("before") ?? url.searchParams.get("from");
    if (cursor && !cursor.startsWith(`${epoch}:`)) {
      await route.fulfill({ status: 409, json: { error: { code: "history_changed", message: "reload history" } } });
      return;
    }
    if (url.searchParams.has("before")) {
      routeEvents.dispatchEvent(new Event("older"));
      if (holdOlder) await new Promise<void>((resolve) => releases.push(resolve));
      await route.fulfill({ json: { source: "omp-transcript", history_id: captured, cursor: url.searchParams.get("since"), turns: [user("old earlier")] } });
    } else {
      const tool = { role: "assistant", ts: "reused", parts: [{ kind: "tool", name: "Read", summary: "same", input: "{}", output: "preview", output_ref: "reused", output_size: 9000 }] };
      await route.fulfill({ json: { source: "omp-transcript", history_id: epoch, cursor: before, turns: newest ? [user(newest), tool] : [] } });
    }
  });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByText("old newest", { exact: true }).waitFor();
  compacting = true;
  const compactionLine = page.locator('.chat-inline-state[role="status"]').filter({ hasText: "Compacting conversation" });
  await compactionLine.waitFor();
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await compactionLine.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/herdr-compaction-${theme}-${width}.png` });
    }
  }
  compacting = false;
  await compactionLine.waitFor({ state: "detached" });
  console.log("PASS live compaction appears and clears without a new transcript turn");
  const refresh = () => page.evaluate(() => window.qa.refresh());
  await page.locator(".work-block-head").click();
  await page.locator(".work-row-head").click();
  const retainedTurn = await page.getByText("old newest", { exact: true }).elementHandle();
  for (const gap of [false, true]) {
    readPending = !gap; gapPending = gap;
    if (gap) before = "one:200";
    const failed = page.waitForResponse((response) => response.url().includes("/conversation?") && response.status() === 503);
    await refresh();
    await failed;
    await page.getByText("Couldn't load the conversation", { exact: true }).waitFor();
    assert.equal(await retainedTurn!.evaluate((node) => node.isConnected), true, "failed newest/gap reads keep the same mounted turn");
    assert.equal(await page.locator(".work-block-head").getAttribute("aria-expanded"), "true", "failed reads keep opened work");
    assert.equal(await page.locator(".work-row-head").getAttribute("aria-expanded"), "true", "failed reads keep opened tool details");
    assert.equal(await page.locator(".chat-terminal-fallback").count(), 0, "a retryable read does not replace the conversation");
    readPending = false; gapPending = false;
    await refresh();
    await page.getByText("Couldn't load the conversation", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByText("old newest", { exact: true }).isVisible(), true);
  }
  // A session switched before an unpaged read fails: retrying it must not retain the old session.
  await page.evaluate(() => window.qa.chat("switched-before-read"));
  await page.waitForFunction(() => window.qa.answered.includes("local/switched-before-read"));
  await page.getByText("old newest", { exact: true }).waitFor();
  const switchedTurn = await page.getByText("old newest", { exact: true }).elementHandle();
  epoch = "different-session"; before = null; readPending = true;
  const rejectedHistory = page.waitForResponse((response) => response.url().includes("/conversation?") && response.status() === 409);
  const freshFallback = page.waitForResponse((response) => response.url().includes("/conversation?") && !new URL(response.url()).searchParams.has("history_id") && response.status() === 200);
  await refresh();
  await rejectedHistory; await freshFallback;
  await page.getByText("old newest", { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await switchedTurn!.evaluate((node) => node.isConnected), false, "an unpaged history mismatch clears old turns even when its fresh retry fails");
  assert.equal(await page.getByText("old newest", { exact: true }).count(), 0);
  readPending = false;
  // Restore the original single-page fixture before the existing history-change cases.
  epoch = "one-reset"; before = "one-reset:100";
  await refresh();
  await page.getByText("old newest", { exact: true }).waitFor();
  console.log("PASS newest and gap read failures retain mounted messages, opened work and tool details, then recover");
  // A newly exposed older page belongs to a new fixture history, not a sliding newest cursor.
  await page.setViewportSize({ width: 1280, height: 800 });
  epoch = "one-paged"; before = "one-paged:100";
  await refresh();
  await page.locator(".chat-older").waitFor();
  const output = page.locator("#output");
  await page.locator("#fetch-output").click();
  assert.equal(await page.evaluate(() => window.qa.requests.length), 1, "duplicate load deduplicated");
  await page.evaluate(() => window.qa.target("/qa-output?pane=b&ref=x", "one"));
  await page.waitForFunction(() => window.qa.requests[0].signal.aborted);
  await page.evaluate(() => window.qa.requests[0].resolve("STALE A"));
  assert.equal(await output.textContent(), "idle:");
  await page.locator("#fetch-output").click();
  await page.evaluate(() => window.qa.requests[1].resolve("B result"));
  await page.waitForFunction(() => document.querySelector("#output")?.textContent === "idle:B result");
  await page.evaluate(() => window.qa.target("/qa-output?pane=b&ref=y", "one"));
  await page.waitForFunction(() => document.querySelector("#output")?.textContent === "idle:");
  await page.locator("#fetch-output").click();
  await page.evaluate(() => window.qa.target("/qa-output?pane=b&ref=y", "two"));
  await page.waitForFunction(() => window.qa.requests[2].signal.aborted);
  await page.evaluate(() => window.qa.requests[2].reject());
  assert.equal(await output.textContent(), "idle:");
  console.log("PASS duplicate requests, pane/ref/history changes, abort, late success and late failure");

  // Start an older-page request, then observe clear before it completes.
  holdOlder = true;
  const olderStarted = nextRoute("older");
  await page.locator(".chat-older").click();
  await olderStarted;
  epoch = "two"; newest = ""; before = null;
  await refresh();
  await page.getByText("No conversation yet — say something below", { exact: true }).waitFor();
  const olderAnswered = page.waitForResponse((response) => new URL(response.url()).searchParams.has("before"));
  releases.splice(0).forEach((release) => release());
  await (await olderAnswered).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.locator(".chat-turn").count(), 0, "late older page cannot revive cleared history");
  assert.equal(await page.locator(".chat-older").count(), 0);
  console.log("PASS clear while earlier page is in flight and empty history before a new prompt");

  newest = "new newest";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  // a settled turn's work is folded: open the block, then its row
  await page.locator(".work-block-head").click();
  await page.locator(".work-row-head").click();
  await page.locator(".chat-tool-more").click();
  const requestIndex = await page.evaluate(() => window.qa.requests.length - 1);
  epoch = "three"; newest = "newest after another clear";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  await page.waitForFunction((i) => window.qa.requests[i].signal.aborted, requestIndex);
  await page.evaluate((i) => window.qa.requests[i].resolve("STALE TOOL OUTPUT"), requestIndex);
  // the cleared history brought a new turn, folded like any settled one
  assert.equal(await page.locator(".work-block-head").getAttribute("aria-expanded"), "false");
  await page.locator(".work-block-head").click();
  await page.locator(".work-row-head").click();
  assert.equal(await page.getByText("STALE TOOL OUTPUT", { exact: true }).count(), 0);
  assert.equal(await page.locator(".chat-tool-more").count(), 1);
  // A remote PC with the same pane/tool id is a distinct target too.
  await page.locator(".chat-tool-more").click();
  const remoteIndex = await page.evaluate(() => window.qa.requests.length - 1);
  await page.evaluate(() => window.qa.chat("a", "remote-pc"));
  await page.waitForFunction((i) => window.qa.requests[i].signal.aborted, remoteIndex);
  await page.evaluate((i) => window.qa.requests[i].reject(), remoteIndex);
  await page.getByText(newest, { exact: true }).waitFor();
  assert.equal(await page.getByText("Couldn't load the whole output — retry", { exact: true }).count(), 0);
  // Already loaded older history must be discarded when a held cursor gets 409.
  epoch = "four"; newest = "loaded history newest"; before = "four:100"; holdOlder = false;
  await page.evaluate(() => window.qa.chat("b"));
  await page.getByText(newest, { exact: true }).waitFor();
  await page.locator(".chat-older").click();
  await page.getByText("old earlier", { exact: true }).waitFor();
  epoch = "five"; newest = "after held cursor reset"; before = null;
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  assert.equal(await page.getByText("old earlier", { exact: true }).count(), 0);
  assert.equal(await page.locator(".chat-older").count(), 0);

  // A stale cursor discovered by the Earlier button also triggers a fresh poll.
  epoch = "six"; newest = "before older cursor reset"; before = "six:100";
  await refresh();
  await page.getByText(newest, { exact: true }).waitFor();
  epoch = "seven"; newest = "after older cursor reset"; before = null;
  await page.locator(".chat-older").click();
  await page.getByText(newest, { exact: true }).waitFor();
  assert.equal(await page.locator(".chat-older").count(), 0);
  console.log("PASS held-cursor and older-page 409 recovery discard history and immediately reload");
  assert.deepEqual(errors, []);
  console.log("PASS reused tool ids after clear, machine switch and unmount cancellation; no browser errors");

  // An authoritative refusal must hide stale history even if the second, terminal read fails.
  // This is the DB/export mismatch path: the reader returns scrollback, not a transport error.
  for (const terminalFailure of [false, true]) {
    epoch = `refusal-${terminalFailure}`; newest = `discarded newest ${terminalFailure}`; before = `${epoch}:100`;
    await refresh();
    await page.getByText(newest, { exact: true }).waitFor();
    await page.locator(".chat-older").click();
    await page.getByText("old earlier", { exact: true }).waitFor();
    await page.locator(".work-block-head").click();
    await page.locator(".work-row-head").click();
    await page.locator(".chat-tool-more").click();
    const lateOutput = await page.evaluate(() => window.qa.requests.length - 1);
    terminalFails = terminalFailure; unavailable = true; holdTerminal = true;
    const terminalStarted = nextRoute("terminal");
    await page.evaluate(() => window.qa.agent(null));
    await refresh();
    await terminalStarted;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.getByText(newest, { exact: true }).count(), 0, "refused history must disappear while terminal fallback is still pending");
    holdTerminal = false;
    releases.splice(0).forEach((release) => release());
    if (terminalFailure) await page.locator(".chat-inline-error").filter({ hasText: "fictional terminal read failed" }).waitFor();
    else await page.getByText("Fictional terminal fallback", { exact: true }).waitFor();
    assert.equal(await page.getByText(newest, { exact: true }).count(), 0, "refused latest history must disappear even when terminal fallback fails");
    assert.equal(await page.getByText("old earlier", { exact: true }).count(), 0, "refused older pages must disappear");
    await page.waitForFunction((i) => window.qa.requests[i].signal.aborted, lateOutput);
    await page.evaluate((i) => window.qa.requests[i].resolve("REFUSED TOOL OUTPUT"), lateOutput);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.getByText("REFUSED TOOL OUTPUT", { exact: true }).count(), 0);
    unavailable = false; terminalFails = false; before = null;
    await refresh();
    await page.getByText(newest, { exact: true }).waitFor();
    assert.equal(await page.getByText("old earlier", { exact: true }).count(), 0);
  }
  console.log("PASS refusal clears latest/older history and late whole output, including failed terminal fallback; recovery reloads");

  // Keep the existing scrollback change detector: clearing the signature on every fallback
  // poll would suppress the New messages chip while the reader is scrolled up.
  unavailable = true;
  terminalText = Array.from({ length: 100 }, (_, i) => `Fictional terminal line ${i}`).join("\n");
  await refresh();
  await page.getByText(/Fictional terminal line 99/).waitFor();
  await page.getByRole("log").evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")); });
  terminalText += "\nFictional terminal appended line";
  await refresh();
  await page.getByText(/Fictional terminal appended line/).waitFor();
  await page.locator(".chat-new-messages").waitFor();
  unavailable = false;
  console.log("PASS changing terminal fallback retains the New messages indicator while scrolled up");

  // Exercise the actual product owner. A profiler observes every committed DOM, not just the final frame.
  const select = async (pane: string, machine: string, agent?: string) => {
    product = true;
    // the log is cleared in the task that switches: no commit of the pane being left slips in between
    await page.evaluate(([p, m, a]) => { window.qa.commits.length = 0; window.qa.select(p!, m!, a); }, [pane, machine, agent]);
  };
  /** The expected chat is up, and no commit since the switch showed the other pane's. */
  const shows = async (expected: string, forbidden: string) => {
    await page.getByText(`history ${expected}`, { exact: true }).waitFor();
    const commits = await page.evaluate(() => window.qa.commits);
    assert.ok(commits.length > 0, "profiler recorded product commits");
    assert.ok(commits.every((turns) => !turns.some((turn) => turn.includes(`history ${forbidden}`))), `stale ${forbidden} in intermediate commits: ${JSON.stringify(commits)}`);
  };
  await select("a", "local");
  await page.getByText("history local/a", { exact: true }).waitFor();
  await select("b", "local");
  await shows("local/b", "local/a");
  await select("a", "local");
  await shows("local/a", "local/b");
  await select("a", "remote-pc");
  await shows("remote-pc/a", "local/a");
  await page.evaluate(() => window.qa.view(false));
  await page.locator(".chat-frame").waitFor({ state: "detached" });
  const reread = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/pane/conversation"));
  await page.evaluate(() => window.qa.view(true));
  await (await reread).finished();
  await shows("remote-pc/a", "local/a");
  console.log("PASS terminal/chat toggles release chat DOM and reload the correct conversation");
  // A late success and a late error from B must neither replace nor erase A's chat.
  for (const status of [200, 503]) {
    held.add("remote-pc/b");
    const ended = await page.evaluate(() => window.qa.answered.filter((key) => key === "remote-pc/b").length);
    const remoteStarted = nextRoute("remote-pc/b");
    await select("b", "remote-pc");
    await remoteStarted;
    await select("a", "remote-pc");
    await page.getByText("history remote-pc/a", { exact: true }).waitFor();
    held.delete("remote-pc/b");
    for (const request of pending.splice(0)) await request.answer(status);
    // B's request has ended in the page (answered, or cancelled when B left) and two frames
    // have passed: whatever it could change is committed
    await page.waitForFunction((count) => window.qa.answered.filter((key) => key === "remote-pc/b").length > count, ended);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await shows("remote-pc/a", "remote-pc/b");
    assert.equal(await page.getByText("history remote-pc/a", { exact: true }).count(), 1, "late response preserves active chat");
    assert.equal(await page.locator(".chat-inline-error").count(), 0, "late error belongs to the abandoned pane");
  }
  failing.add("remote-pc/b");
  await select("b", "remote-pc");
  await page.locator(".chat-inline-error").waitFor();
  assert.equal(await page.getByText("history remote-pc/a", { exact: true }).count(), 0, "unavailable chat cannot show another pane's history");
  assert.ok((await page.evaluate(() => window.qa.commits)).every((turns) => !turns.some((turn) => turn.includes("history remote-pc/a"))), "no commit of the unavailable chat showed another pane's history");
  await select("devin", "local", "devin");
  await page.getByText("Synthetic Devin prompt", { exact: true }).waitFor();
  await page.getByText("Synthetic Devin answer", { exact: true }).waitFor();
  await page.locator(".work-block-head").click();
  assert.equal(await page.locator(".work-row-name").filter({ hasText: "synthetic_tool" }).count(), 1);
  await page.locator(".work-row-head").click();
  await page.getByText("synthetic result", { exact: true }).waitFor();
  const claudeTasks = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith("/pane/omo-tasks") && url.searchParams.get("pane_id") === "claude";
  });
  await select("claude", "local", "claude");
  await page.getByText("Synthetic Claude prompt", { exact: true }).waitFor();
  const activity = await claudeTasks;
  assert.equal(activity.status(), 200, "Claude task discovery is answered by the fixture");
  assert.deepEqual(await activity.json(), { tasks: [], runs: [] });
  assert.equal(await page.getByText("Synthetic Devin answer", { exact: true }).count(), 0);
  assert.ok((await page.evaluate(() => window.qa.commits)).every((turns) => !turns.some((turn) => turn.includes("Synthetic Devin"))), "switch to Claude cannot commit Devin history");
  await select("agy", "local", "agy");
  await page.getByText("Summarize the last three fictional commits.", { exact: true }).waitFor();
  await page.getByText("Synthetic Agy answer", { exact: true }).waitFor();
  await page.locator(".work-block-head").click();
  assert.equal(await page.locator(".work-row-head").count(), 2, "Agy planner call and independent result remain separate");
  await page.locator(".work-row-head").last().click();
  await page.getByText("Fictional commit log", { exact: true }).waitFor();
  assert.equal(await page.getByText("Synthetic Claude prompt", { exact: true }).count(), 0);
  console.log("PASS Agy native parser output renders user/assistant text and independent expandable tool results");
  assert.deepEqual(errors, []);
  console.log("PASS synthetic Devin bubbles and tools render; switching to Claude clears Devin history");
  console.log("PASS product pane commits across A→B→A, another PC, and late or failed answers");
} finally {
  releases.forEach((release) => release());
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
