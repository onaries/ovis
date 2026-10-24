import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { formatReplyQuote } from "../src/lib/terminalQuote.ts";

// Quote in message for an assistant reply's selected text, on the unmodified app over the demo's
// fixture transport: the quote lands in the pane's editable draft and nothing goes out until the
// user presses Send. Every frame the client sends is recorded, so "nothing went out" is counted,
// not assumed. A selection that leaves one reply, an empty one and a watching connection are
// refused; a full draft keeps what it held; a dropped connection keeps the quote and sends nothing
// on its return. With UI_EVIDENCE_DIR set it also captures the states the change draws. All files
// and traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-reply-quote-demo-"));
const evidence = process.env["UI_EVIDENCE_DIR"];

// playwright-core's bundle lazily requires packages the lockfile does not carry (chromium-bidi):
// fine at run time, unresolvable to `bun build` — so it is imported past the bundler's analysis
const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const PANE = panes.flaky;
const LONG = `sha256:${"9f2c4e7a1b3d5f60".repeat(6)}`;
const at = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const tool = (name: string, summary: string, input: unknown, output: string) => ({ kind: "tool", name, summary, input: JSON.stringify(input, null, 2), output });
/** The flaky pane's conversation as this script serves it: prose, code, a long token and work. */
const TURNS = [
  { role: "user", ts: at(30), parts: [{ kind: "text", text: "Why does the retry test fail on CI?" }] },
  { role: "assistant", ts: at(29), end_ts: at(27), parts: [
    tool("Bash", "bun test retry", { command: "bun test retry" }, "retry.test.ts: expected 2 calls, got 1"),
    { kind: "text", text: "The retry test races the clock:\n\n- **`retry.test.ts`** waits a fixed `200 ms` before it checks.\n- On CI the first attempt takes longer, so the check runs too early.\n\n```ts\nawait retry(send, { attempts: 3 });\nexpect(calls).toBe(2);\n```\n\nWait for the second call instead of the clock." },
  ] },
  { role: "user", ts: at(20), parts: [{ kind: "text", text: "Pin the fixture it downloads." }] },
  { role: "assistant", ts: at(19), end_ts: at(18), parts: [{ kind: "text", text: `Pinned the fixture by its digest ${LONG} so every run reads the same bytes from the cache.` }] },
  { role: "user", ts: at(10), parts: [{ kind: "text", text: "Show me the final test." }] },
  { role: "assistant", ts: at(9), end_ts: at(8), parts: [{ kind: "text", text: "Here it is, waiting on the call count:\n\n```ts\nit(\"retries once\", async () => {\n  await retry(send, { attempts: 3 });\n  expect(calls).toBe(2);\n});\n```\n\nIt passed 200 runs in a row." }] },
];

/** frames the client sends that could deliver text or an answer to the agent */
const DELIVERY = ["input", "keys", "submit", "pending-action", "secret"];

/**
 * In front of the demo: every socket's sent frames are recorded (window.quoteSent), and the agent
 * statuses it receives (window.quoteStatus: each snapshot's and pane-status frame's); a submit
 * waits in window.heldSubmits while window.holdSubmits is set, so the demo's mock turn for it
 * starts only when the script lets it go; a socket can be refused while window.holdOffline is set
 * (the PC is away), the flaky pane's conversation is TURNS (held back while
 * window.holdConversation is a promise), and every prompt answer, rewind or other agent-facing POST
 * is counted (window.agentPosts).
 */
const harness = `<script>(() => {
  const DemoSocket = window.WebSocket;
  window.quoteSent = [];
  window.quoteSockets = [];
  window.quoteStatus = [];
  window.holdSubmits = false;
  window.heldSubmits = [];
  window.holdOffline = false;
  window.agentPosts = [];
  const Socket = function (...args) {
    const socket = new DemoSocket(...args);
    const index = window.quoteSockets.push(socket) - 1;
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      let frame = null;
      try { frame = JSON.parse(raw); window.quoteSent.push({ socket: index, type: frame.type, pane_id: frame.pane_id, text: frame.text }); } catch {}
      if (window.holdSubmits && frame && frame.type === "submit") { window.heldSubmits.push(() => send(raw)); return; }
      send(raw);
    };
    socket.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.type === "snapshot") for (const pane of frame.snapshot.panes) window.quoteStatus.push({ socket: index, pane_id: pane.pane_id, agent_status: pane.agent_status });
        if (frame.type === "pane-status") window.quoteStatus.push({ socket: index, pane_id: frame.pane_id, agent_status: frame.agent_status });
      } catch {}
    });
    if (window.holdOffline) queueMicrotask(() => socket.close(1006, "offline"));
    return socket;
  };
  Socket.prototype = DemoSocket.prototype;
  Object.setPrototypeOf(Socket, DemoSocket);
  window.WebSocket = Socket;
  const demo = window.fetch;
  const pane = ${JSON.stringify(PANE)};
  const turns = ${JSON.stringify(TURNS)};
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = (init && init.method) || (input instanceof Request ? input.method : "GET");
    if (method !== "GET" && /\\/api\\/pane\\/(prompt\\/answer|rewind|command)/.test(url.pathname)) window.agentPosts.push(url.pathname);
    if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === pane && !url.searchParams.has("before") && !url.searchParams.has("from")) {
      if (window.holdConversation) await window.holdConversation;
      const response = await demo(input, init);
      if (!response.ok) return response;
      const body = await response.json();
      body.turns = structuredClone(window.quoteTurns || turns);
      body.cursor = null;
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    return demo(input, init);
  };
})();</script>`;

type Kind = "prose-code" | "cross" | "work" | "user" | "long" | "end-code" | "none";

/** Sets the selection the way a drag would leave it, and answers its text. */
const select = (page: Page, kind: Kind): Promise<string> => page.evaluate((what) => {
  const selection = getSelection()!;
  selection.removeAllRanges();
  if (what === "none") return "";
  const reply = (needle: string): Element => {
    const found = [...document.querySelectorAll(".chat-reply")].find((node) => node.textContent?.includes(needle));
    if (!found) throw new Error(`no reply with "${needle}"`);
    return found;
  };
  const textIn = (root: Element, needle: string): Text => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if ((walker.currentNode as Text).data.includes(needle)) return walker.currentNode as Text;
    throw new Error(`no text "${needle}"`);
  };
  const range = document.createRange();
  if (what === "prose-code") {
    range.setStart(textIn(reply("retry test races"), "retry test races"), 4);
    const end = textIn(reply("retry test races").querySelector("pre")!, "attempts");
    range.setEnd(end, end.data.indexOf("attempts") + "attempts".length);
  } else if (what === "cross") {
    range.setStart(textIn(document.querySelector(".chat-turn-user")!, "retry test fail"), 4);
    range.setEnd(textIn(reply("retry test races"), "retry test races"), 10);
  } else if (what === "work") {
    range.selectNodeContents(document.querySelector(".work-block")!);
  } else if (what === "user") {
    range.selectNodeContents(textIn(document.querySelector(".chat-turn-user")!, "retry test fail"));
  } else if (what === "long") {
    const node = textIn(reply("sha256:"), "sha256:");
    const start = node.data.indexOf("sha256:");
    range.setStart(node, start);
    range.setEnd(node, node.data.indexOf(" ", start));
  } else {
    range.selectNodeContents(reply("It passed 200 runs").querySelector("pre")!);
  }
  selection.addRange(range);
  return selection.toString();
}, kind);

const delivered = (page: Page, from = 0): Promise<unknown[]> => page.evaluate(([types, start]) =>
  (window as unknown as { quoteSent: { socket: number; type: string }[] }).quoteSent.filter((frame) => frame.socket >= start && types.includes(frame.type)), [DELIVERY, from] as const);
const agentPosts = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { agentPosts: string[] }).agentPosts);
const boxValue = (page: Page, expected: string): Promise<unknown> => page.waitForFunction(
  (value) => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === value, expected, { timeout: 10_000 });
const pinned = (page: Page, count: string): Promise<unknown> => page.waitForFunction(
  (value) => document.querySelector(".chat-view-virtual")?.getAttribute("data-chat-pinned") === value, count, { timeout: 10_000 });
/** the status `paneId` last had on the newest socket, from its snapshot and pane-status frames */
const statusOf = (page: Page, paneId: string, from = 0): Promise<string[]> => page.evaluate(([pane, start]) =>
  (window as unknown as { quoteStatus: { pane_id: string; agent_status: string }[] }).quoteStatus.slice(start).filter((entry) => entry.pane_id === pane).map((entry) => entry.agent_status), [paneId, from] as const);
/**
 * The demo's own clock: the Claude pane opens mid-turn and ends it a few seconds in, on a timer
 * (site/demo/transport.ts). What a step checks or a capture shows waits until that turn has ended,
 * as the newest socket was told, so nothing it publishes lands in the middle.
 */
const demoSettled = (page: Page): Promise<unknown> => page.waitForFunction((pane) => {
  const fixture = window as unknown as { quoteStatus: { socket: number; pane_id: string; agent_status: string }[]; quoteSockets: unknown[] };
  const newest = fixture.quoteSockets.length - 1;
  const seen = fixture.quoteStatus.filter((entry) => entry.socket === newest && entry.pane_id === pane);
  return seen.length > 0 && seen.at(-1)!.agent_status !== "working";
}, panes.api, { timeout: 30_000 });
/** a press on `selector` that clears the page's selection on its way down, as a phone's can, held down: it resolves once the page has seen the selection go */
const holdPressClearing = (page: Page, selector: string): Promise<void> => page.evaluate((target) => new Promise<void>((resolve) => {
  document.addEventListener("selectionchange", () => requestAnimationFrame(() => resolve()), { once: true });
  document.addEventListener("pointerdown", () => getSelection()!.removeAllRanges(), { capture: true, once: true });
  document.querySelector(target)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", isPrimary: true }));
}), selector);
/** whether the action's box meets any selected glyph's or the transcript's own box */
const overlap = (page: Page): Promise<{ selection: boolean; transcript: boolean; button: unknown }> => page.evaluate(() => {
  const rect = document.querySelector(".chat-quote")!.getBoundingClientRect();
  const meets = (box: DOMRect) => box.width > 0 && box.height > 0 && box.right > rect.left && box.left < rect.right && box.bottom > rect.top && box.top < rect.bottom;
  return {
    selection: [...getSelection()!.getRangeAt(0).getClientRects()].some(meets),
    transcript: meets(document.querySelector(".chat-view-virtual")!.getBoundingClientRect()),
    button: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  };
});
/**
 * puts the selection's first line at the transcript's top edge, where a reader scrolled it, or as
 * near as the transcript scrolls; the virtual list re-measures rows as they come in, so each poll
 * corrects the scroll again until the line stays put
 */
const selectionToTop = async (page: Page): Promise<void> => {
  await page.waitForFunction(() => {
    const node = document.querySelector(".chat-view-virtual")!;
    const first = getSelection()!.getRangeAt(0).getClientRects()[0];
    if (first === undefined) return false;
    const gap = first.top - node.getBoundingClientRect().top;
    if (Math.abs(gap) <= 2) return true;
    const before = node.scrollTop;
    node.scrollTop += gap;
    // the end of the transcript: it scrolls no further, so this is the nearest the line comes
    return node.scrollTop === before && gap > 0;
  });
};
/** Pushes a server frame on the live socket, as the bridge would. */
const push = (page: Page, message: unknown): Promise<void> => page.evaluate((frame) => {
  const sockets = (window as unknown as { quoteSockets: { readyState: number; push(message: unknown): void }[] }).quoteSockets;
  sockets.filter((socket) => socket.readyState === 1).forEach((socket) => socket.push(frame));
}, message);

interface Viewport { name: string; width: number; height: number; phone: boolean }
const DESKTOP: Viewport = { name: "1440", width: 1440, height: 900, phone: false };
const PHONE: Viewport = { name: "390", width: 390, height: 664, phone: true };

async function open(browser: Browser, view: Viewport, settings: { language: string; theme?: string }, before?: (context: BrowserContext) => Promise<void>): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height }, locale: "en-US",
    ...(view.phone ? { screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}),
  });
  await context.addInitScript(([paneId, value]) => {
    localStorage.setItem("ovis:settings", JSON.stringify(value));
    localStorage.setItem(`ovis:view:${paneId}`, "chat");
  }, [PANE, settings] as const);
  await before?.(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator(".terminal-stack.is-chat").waitFor();
  return { context, page, errors };
}

const ready = async (page: Page): Promise<void> => {
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".chat-reply").filter({ hasText: "It passed 200 runs" }).waitFor();
  await page.locator(".composer-text").waitFor();
  await demoSettled(page);
};

let url = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${harness}\n    <script type="module"`));
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
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      // happy: quote, edit, then the one explicit Send
      {
        const { context, page, errors } = await open(browser, DESKTOP, { language: "en" });
        try {
          await ready(page);
          const composer = page.getByRole("textbox", { name: "Message", exact: true });
          const quoteButton = page.locator(".chat-quote");
          await composer.fill("Look at this:");
          await composer.evaluate((node) => (node as HTMLElement).blur());
          const selected = await select(page, "prose-code");
          assert.ok(selected.includes("races the clock") && selected.includes("attempts"), `prose and code are selected: ${JSON.stringify(selected)}`);
          await quoteButton.waitFor();
          assert.equal(await quoteButton.textContent(), "Quote in message");
          await quoteButton.click();
          const expected = `Look at this:\n\n${formatReplyQuote(selected)!}\n`;
          await boxValue(page, expected);
          assert.ok(expected.includes("From your reply:\n```\n"), "the quote is a plain fenced block");
          assert.equal(await composer.evaluate((node) => document.activeElement === node), true, "the editable composer takes the focus");
          assert.equal(await composer.evaluate((node) => (node as HTMLTextAreaElement).selectionStart === (node as HTMLTextAreaElement).value.length), true, "the caret lands after the quote");
          await quoteButton.waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => getSelection()!.isCollapsed), true, "the quoted selection is let go");
          await page.locator(".composer-notice").filter({ hasText: "Added to the message draft" }).waitFor();
          assert.deepEqual(await delivered(page), [], "quoting sends nothing: no input, keys, submit or pending frame");
          assert.deepEqual(await agentPosts(page), [], "quoting answers no prompt and runs no command");
          console.log("PASS a reply's selected prose and code land after the existing draft as an editable quote, and nothing is sent");

          await page.keyboard.type("Why 200?");
          const edited = `${expected}Why 200?`;
          await boxValue(page, edited);
          assert.deepEqual(await delivered(page), [], "editing sends nothing");
          // the demo answers a sent message with a mock turn that ends on its own timer: the submit is
          // held at the socket, so that turn starts only when it is let go below, and it has ended
          // before the refusals, the overflow and the reconnect are asked of the pane
          await page.evaluate(() => { (window as unknown as { holdSubmits: boolean }).holdSubmits = true; });
          const statusBefore = (await statusOf(page, PANE)).length;
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await page.waitForFunction(() => (window as unknown as { heldSubmits: unknown[] }).heldSubmits.length === 1);
          const sent = await delivered(page) as { type: string; pane_id: string; text: string }[];
          assert.equal(sent.length, 1, `one frame goes out, on Send: ${JSON.stringify(sent)}`);
          assert.equal(sent[0]!.type, "submit");
          assert.equal(sent[0]!.pane_id, PANE);
          assert.equal(sent[0]!.text, edited, "the ordinary message carries the edited draft");
          assert.deepEqual(await agentPosts(page), []);
          assert.equal((await statusOf(page, PANE, statusBefore)).includes("working"), false, "the held submit has started no turn");
          await page.evaluate(() => {
            const fixture = window as unknown as { holdSubmits: boolean; heldSubmits: (() => void)[] };
            fixture.holdSubmits = false;
            for (const release of fixture.heldSubmits.splice(0)) release();
          });
          await boxValue(page, "");
          // its mock turn runs and ends: working, then done
          await page.waitForFunction(([pane, from]) => {
            const seen = (window as unknown as { quoteStatus: { pane_id: string; agent_status: string }[] }).quoteStatus.slice(from).filter((entry) => entry.pane_id === pane).map((entry) => entry.agent_status);
            const working = seen.indexOf("working");
            return working >= 0 && seen.slice(working + 1).some((status) => status !== "working");
          }, [PANE, statusBefore] as const, { timeout: 30_000 });
          assert.equal((await delivered(page)).length, 1, "the turn's end sends nothing more");
          console.log("PASS Send is the one explicit action that sends, with the edited draft as its single ordinary message");

          // refusals: each starts from a selection the button is offered for, so its going away is seen
          for (const kind of ["cross", "work", "user", "none"] as const) {
            await select(page, "prose-code");
            await quoteButton.waitFor();
            await select(page, kind);
            await quoteButton.waitFor({ state: "detached" });
          }
          console.log("PASS a selection reaching a user message, work output only, a user message only, or nothing is not offered");

          // a full draft keeps what it held, and says so
          const full = "x".repeat(19_990);
          await composer.fill(full);
          await composer.evaluate((node) => (node as HTMLElement).blur());
          await select(page, "prose-code");
          await quoteButton.click();
          await page.locator(".composer-notice").filter({ hasText: "Too long for the message draft" }).waitFor();
          assert.equal(await composer.inputValue(), full, "an over-limit quote leaves the draft as it was");
          assert.equal((await delivered(page)).length, 1, "the refusal sends nothing");
          console.log("PASS an over-limit quote changes nothing in a nearly full draft and says it is too long");

          // a watching connection is offered no draft to change; once it may type again, it is
          await composer.fill("");
          await select(page, "none");
          await pinned(page, "0");
          await push(page, { type: "role-ack", mode: "observe" });
          await page.locator(".terminal-banner-observe").waitFor();
          await select(page, "prose-code");
          await pinned(page, "1");
          assert.equal(await quoteButton.count(), 0, "observe: no quote action");
          // typing again brings the composer back, and its focus takes the page's selection with it
          await push(page, { type: "role-ack", mode: "interact" });
          await composer.waitFor();
          await composer.evaluate((node) => (node as HTMLElement).blur());
          await select(page, "prose-code");
          await quoteButton.waitFor();
          console.log("PASS a watching connection is offered no quote; once it may type again a selection is offered");

          // a quote made, then the connection drops and returns: it waits in the draft, unsent
          await quoteButton.click();
          const kept = `${formatReplyQuote(selected)!}\n`;
          await boxValue(page, kept);
          const before = await page.evaluate(() => (window as unknown as { quoteSockets: unknown[] }).quoteSockets.length);
          await page.evaluate(() => new Promise<void>((resolve, reject) => {
            const fixture = window as unknown as { quoteSockets: WebSocket[] };
            const dropped = fixture.quoteSockets.at(-1)!;
            const offline = () => document.querySelector(".composer-status")?.hasAttribute("data-offline") === true;
            const deadline = performance.now() + 10_000;
            let sawOffline = false;
            const check = () => {
              sawOffline ||= offline();
              const live = fixture.quoteSockets.at(-1)!;
              if (sawOffline && !offline() && live !== dropped && live.readyState === WebSocket.OPEN) return resolve();
              if (performance.now() > deadline) return reject(new Error(`reconnect: sawOffline ${sawOffline}`));
              requestAnimationFrame(check);
            };
            dropped.close();
            check();
          }));
          // the new connection has attached the pane again: anything replayed would have gone with it
          await page.waitForFunction((from) => (window as unknown as { quoteSent: { socket: number; type: string }[] }).quoteSent.some((frame) => frame.socket >= from && frame.type === "conversation-watch"), before);
          assert.deepEqual(await delivered(page, before), [], "the reconnect sends nothing");
          assert.equal(await composer.inputValue(), kept, "the quote waits in the draft");
          assert.deepEqual(await agentPosts(page), []);
          console.log("PASS after a drop and reconnect the quote waits in the draft and nothing is replayed");
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }

      // a phone: the tap that clears the selection on its way down still quotes what was selected
      {
        const { context, page, errors } = await open(browser, PHONE, { language: "en" });
        try {
          await ready(page);
          const selected = await select(page, "prose-code");
          const quoteButton = page.locator(".chat-quote");
          await quoteButton.waitFor();
          const box = await quoteButton.boundingBox();
          assert.ok(box !== null && box.height >= 44 && box.width >= 44, `a 44 px target on touch: ${JSON.stringify(box)}`);
          await page.evaluate(() => document.addEventListener("pointerdown", () => getSelection()!.removeAllRanges(), { capture: true, once: true }));
          await quoteButton.tap();
          await boxValue(page, `${formatReplyQuote(selected)!}\n`);
          assert.deepEqual(await delivered(page), []);
          assert.deepEqual(errors, []);
          console.log("PASS a phone's tap quotes the selection even when the tap itself clears it");
        } finally { await context.close(); }
      }

      // a phone's press held down on the action: the selection it cleared keeps its row a real DOM
      // node, though the list has scrolled it out of its window, until the press resolves
      {
        // older turns ahead of TURNS, so the list has rows enough to window
        const older = Array.from({ length: 12 }, (_, index) => [
          { role: "user", ts: at(90 - index * 4), parts: [{ kind: "text", text: `Earlier question ${index + 1}: what does the flaky suite log?` }] },
          { role: "assistant", ts: at(89 - index * 4), end_ts: at(88 - index * 4), parts: [{ kind: "text", text: `Earlier answer ${index + 1}: the suite logs each attempt with its start time, the delay it waited and whether the call count matched, so a slow first attempt shows up as a long delay before the check.` }] },
        ]).flat();
        const { context, page, errors } = await open(browser, PHONE, { language: "en" }, (c) => c.addInitScript((turns) => { (window as unknown as { quoteTurns: unknown }).quoteTurns = turns; }, [...older, ...TURNS]));
        try {
          await ready(page);
          const quoteButton = page.locator(".chat-quote");
          // the list measures rows as they mount and its height moves under the scroll: each poll aims again
          const scrollTo = (end: boolean) => page.waitForFunction((bottom) => {
            const node = document.querySelector(".chat-view-virtual")!;
            if (bottom ? node.scrollHeight - node.clientHeight - node.scrollTop <= 1 : node.scrollTop === 0) return true;
            node.scrollTop = bottom ? node.scrollHeight : 0;
            return false;
          }, end);
          const lastReply = () => [...document.querySelectorAll(".chat-reply")].some((node) => node.textContent?.includes("It passed 200 runs"));
          const lastReplyMounted = () => page.evaluate(lastReply);
          // with nothing selected, the top of the chat has the last reply out of the list's window
          await scrollTo(false);
          await page.waitForFunction(() => ![...document.querySelectorAll(".chat-reply")].some((node) => node.textContent?.includes("It passed 200 runs")));
          for (const ending of ["click", "cancel"] as const) {
            await scrollTo(true);
            await page.waitForFunction(lastReply);
            const selected = await select(page, "end-code");
            await quoteButton.waitFor();
            await pinned(page, "1");
            await scrollTo(false);
            assert.equal(await lastReplyMounted(), true, "the selected row stays mounted out of the window");
            await holdPressClearing(page, ".chat-quote");
            assert.equal(await page.evaluate(() => getSelection()!.isCollapsed), true, "the press cleared the selection");
            assert.equal(await page.locator(".chat-view-virtual").getAttribute("data-chat-pinned"), "1", "held: the cleared selection's row stays pinned");
            assert.equal(await lastReplyMounted(), true, "held: the cleared selection's row stays a DOM node");
            assert.equal(await quoteButton.count(), 1, "held: the action stays");
            if (ending === "click") {
              await quoteButton.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true });
              await quoteButton.dispatchEvent("click");
              await boxValue(page, `${formatReplyQuote(selected)!}\n`);
              await page.locator(".composer-text").fill("");
            } else {
              await quoteButton.dispatchEvent("pointercancel", { pointerType: "touch", isPrimary: true });
              await quoteButton.waitFor({ state: "detached" });
              assert.equal(await page.locator(".composer-text").inputValue(), "", "a cancelled press quotes nothing");
            }
            // resolved: the selection as it is now (none) decides, so the row is no longer pinned (the
            // list may keep it mounted as a recycled row; only the pin is the app's promise)
            await pinned(page, "0");
          }
          assert.deepEqual(await delivered(page), []);
          assert.deepEqual(errors, []);
          console.log("PASS a held press keeps the cleared selection's row pinned and mounted until its click or cancel");
        } finally { await context.close(); }
      }

      // a selection scrolled to the transcript's top edge: the action stands outside the transcript
      for (const view of [DESKTOP, PHONE]) {
        const { context, page, errors } = await open(browser, view, { language: "en" });
        try {
          await ready(page);
          await page.locator(".composer-text").evaluate((node) => (node as HTMLElement).blur());
          for (const kind of ["prose-code", "long"] as const) {
            await select(page, kind);
            await page.locator(".chat-quote").waitFor();
            await selectionToTop(page);
            const met = await overlap(page);
            assert.equal(met.selection, false, `${view.name} ${kind}: the action covers no selected glyph at the top edge ${JSON.stringify(met)}`);
            assert.equal(met.transcript, false, `${view.name} ${kind}: the action stands outside the transcript ${JSON.stringify(met)}`);
          }
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
      console.log("PASS at 1440 and 390 a selection at the transcript's top edge is not covered: the action stands outside the transcript");

      if (evidence) await captureAll(browser, evidence);
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }

/** The states this change draws, at both widths and themes, and in Korean on a phone. */
async function captureAll(browser: Browser, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const measurements: Record<string, unknown>[] = [];
  const combos: { view: Viewport; theme: "light" | "dark"; language: "en" | "ko" }[] = [
    { view: DESKTOP, theme: "light", language: "en" }, { view: DESKTOP, theme: "dark", language: "en" },
    { view: PHONE, theme: "light", language: "en" }, { view: PHONE, theme: "dark", language: "en" },
    { view: PHONE, theme: "light", language: "ko" }, { view: PHONE, theme: "dark", language: "ko" },
  ];
  for (const { view, theme, language } of combos) {
    const name = (state: string) => join(dir, `reply-quote-${view.name}-${theme}${language === "ko" ? "-ko" : ""}-${state}.png`);
    // a state is shot once the quote's own notes from the state before have gone (they last 2.5 s),
    // unless the note is what the state shows
    const notes = ["Added to the message draft", "Too long for the message draft", "메시지 초안에 추가했습니다", "메시지 초안에 넣기에는 너무 깁니다"];
    const shot = async (page: Page, state: string, note = false) => {
      if (!note) await page.waitForFunction((texts) => ![...document.querySelectorAll(".composer-notice, .terminal-banner")].some((node) => texts.includes(node.textContent?.trim() ?? "")), notes, { timeout: 10_000 });
      await page.screenshot({ path: name(state) });
    };
    // another pane finishing on the demo's clock raises its droplet over the header: not this change's
    const quiet = (c: BrowserContext) => c.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = ".droplet { display: none !important; }";
      document.head.append(style);
    }));
    // loading: the transcript's read held back
    {
      const { context, page } = await open(browser, view, { language, theme }, async (c) => {
        await quiet(c);
        await c.addInitScript(() => {
          (window as unknown as { holdConversation: Promise<void> }).holdConversation = new Promise(() => {});
        });
      });
      await page.locator(".chat-inline-state").first().waitFor();
      await shot(page, "loading");
      await context.close();
    }
    const { context, page } = await open(browser, view, { language, theme }, quiet);
    await ready(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const quoteButton = page.locator(".chat-quote");
    const composer = page.locator(".composer-text");
    // the selection where a reader made it: in the middle of the view, not under the end the chat opened at
    // the virtual list re-measures rows as they come in, so each poll scrolls the selection in again
    const reveal = async () => {
      await page.waitForFunction(() => {
        const range = getSelection()!.getRangeAt(0);
        const box = range.getClientRects()[0];
        if (box !== undefined && box.top >= 0 && box.bottom <= window.innerHeight) return true;
        const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement!;
        start.scrollIntoView({ block: "center", behavior: "instant" });
        return false;
      });
    };
    const reset = async () => {
      await composer.fill("");
      await composer.evaluate((node) => (node as HTMLElement).blur());
      await select(page, "none");
      await quoteButton.waitFor({ state: "detached" });
    };
    await composer.evaluate((node) => (node as HTMLElement).blur());
    await shot(page, "empty");
    await select(page, "prose-code");
    await quoteButton.waitFor();
    await reveal();
    await shot(page, "selected");
    measurements.push({ view: view.name, theme, language, ...(await measure(page)) });
    // the same selection scrolled to the transcript's top edge, under where a floating action would be
    await selectionToTop(page);
    const top = await overlap(page);
    assert.equal(top.selection || top.transcript, false, `the action covers nothing at the top edge: ${JSON.stringify(top)}`);
    measurements.at(-1)!["topEdge"] = { coversSelection: top.selection, overTranscript: top.transcript, button: top.button };
    await shot(page, "selected-top");
    if (!view.phone) { await quoteButton.hover(); await shot(page, "hover"); await page.mouse.move(5, 5); }
    await page.keyboard.press("Shift");
    await quoteButton.focus();
    assert.equal(await quoteButton.evaluate((node) => node.matches(":focus-visible")), true, "the focused action shows its ring");
    measurements.at(-1)!["focusRing"] = await quoteButton.evaluate((node) => { const style = getComputedStyle(node); return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} offset ${style.outlineOffset}`; });
    await shot(page, "focus-visible");
    await quoteButton.hover();
    await page.mouse.down();
    // pressed, it stays whole: the touch dim would read as a disabled button
    const pressedOpacity = await quoteButton.evaluate((node) => getComputedStyle(node).opacity);
    assert.equal(pressedOpacity, "1", "a pressed quote action is not see-through");
    measurements.at(-1)!["pressedOpacity"] = pressedOpacity;
    await shot(page, "pressed");
    await page.mouse.up();
    await composer.waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")!.value.includes("From your reply:"));
    await shot(page, "composer", true);
    if (view.phone) {
      // the soft keyboard's room, as a phone leaves it with the box focused
      await composer.focus();
      await page.setViewportSize({ width: view.width, height: 380 });
      await page.waitForFunction(() => window.innerHeight === 380 && document.documentElement.hasAttribute("data-keyboard"));
      measurements.at(-1)!["keyboardOpen"] = await page.evaluate(() => {
        const box = (selector: string) => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect ? { top: Math.round(rect.top * 10) / 10, bottom: Math.round(rect.bottom * 10) / 10, height: Math.round(rect.height * 10) / 10 } : null; };
        const send = document.querySelector('button[aria-label="Send message"]')?.getBoundingClientRect();
        return {
          innerHeight: window.innerHeight, visualViewportHeight: window.visualViewport?.height ?? null,
          dataKeyboard: document.documentElement.hasAttribute("data-keyboard"),
          appHeight: document.documentElement.style.getPropertyValue("--app-height") || null,
          composer: box(".composer"), box: box(".composer-text"), send: send ? { top: send.top, bottom: send.bottom } : null,
          sendInside: send !== undefined && send.top >= 0 && send.bottom <= window.innerHeight,
          composerInside: (document.querySelector(".composer")?.getBoundingClientRect().bottom ?? Infinity) <= window.innerHeight,
          pageScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      });
      await shot(page, "keyboard-open", true);
      await page.setViewportSize({ width: view.width, height: view.height });
      await page.waitForFunction((height) => window.innerHeight === height, view.height);
    }
    await reset();
    await composer.fill("x".repeat(19_990));
    await composer.evaluate((node) => (node as HTMLElement).blur());
    await select(page, "prose-code");
    await reveal();
    await quoteButton.click();
    await page.locator(".composer-notice").last().waitFor();
    await shot(page, "overflow", true);
    await reset();
    await select(page, "long");
    await quoteButton.waitFor();
    await reveal();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no sideways page scroll with a long selection");
    await shot(page, "long");
    await select(page, "end-code");
    await page.evaluate(() => {
      const node = document.querySelector(".chat-view-virtual")!;
      node.scrollTop = node.scrollHeight;
    });
    await page.waitForFunction(() => {
      const node = document.querySelector(".chat-view-virtual")!;
      return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
    });
    await quoteButton.waitFor();
    await shot(page, "scrolled-end");
    await select(page, "none");
    await quoteButton.waitFor({ state: "detached" });
    await push(page, { type: "role-ack", mode: "observe" });
    await page.locator(".terminal-banner-observe").waitFor();
    await select(page, "prose-code");
    await pinned(page, "1");
    await reveal();
    await shot(page, "watch");
    await push(page, { type: "role-ack", mode: "interact" });
    await composer.waitFor();
    // the PC goes away: the socket drops and every new one is refused
    await page.evaluate(() => {
      const fixture = window as unknown as { holdOffline: boolean; quoteSockets: WebSocket[] };
      fixture.holdOffline = true;
      fixture.quoteSockets.at(-1)!.close();
    });
    await page.locator(".composer-status[data-offline]").waitFor();
    await select(page, "prose-code");
    await quoteButton.waitFor();
    await reveal();
    await shot(page, "offline");
    await context.close();
  }
  writeFileSync(join(dir, "measurements.json"), `${JSON.stringify(measurements, null, 2)}\n`);
}

/** What a PNG cannot show: the action's size, name, contrast, and whether it covers the selection. */
function measure(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const button = document.querySelector<HTMLElement>(".chat-quote")!;
    const rect = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const rgb = (value: string): number[] => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (value: string): number => {
      const [r, g, b] = rgb(value).map((channel) => { const c = channel / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const [light, dark] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
    const selection = [...getSelection()!.getRangeAt(0).getClientRects()];
    const meets = (box: DOMRect) => box.width > 0 && box.height > 0 && box.right > rect.left && box.left < rect.right && box.bottom > rect.top && box.top < rect.bottom;
    const covers = selection.some(meets);
    const transcript = document.querySelector(".chat-view-virtual")!.getBoundingClientRect();
    const label = button.querySelector("svg")!.getBoundingClientRect();
    return {
      width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10,
      accessibleName: button.textContent, fontSize: style.fontSize,
      color: style.color, background: style.backgroundColor,
      contrast: Math.round(((light! + 0.05) / (dark! + 0.05)) * 100) / 100,
      coversSelection: covers,
      overTranscript: meets(transcript),
      padding: style.padding, iconTop: Math.round((label.top - rect.top) * 10) / 10, iconBottom: Math.round((rect.bottom - label.bottom) * 10) / 10,
      pageScrollsSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      selectable: getComputedStyle(document.querySelector(".chat-reply .markdown")!).userSelect,
    };
  });
}
