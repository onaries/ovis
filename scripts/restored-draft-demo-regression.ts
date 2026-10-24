import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A cancelled send the agent put back in its input box (`restored` on GET /api/pane/prompt), on
// the unmodified app over the demo's fixture transport: the composer takes the text back without
// taking the focus, the chat keeps the turn that send made out of view while they match, and
// typing or editing over the fill is never replaced or cleared. All files and HTTP traffic stay
// in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-restored-draft-demo-"));

// playwright-core's bundle lazily requires packages the lockfile does not carry (chromium-bidi):
// fine at run time, unresolvable to `bun build` — so it is imported past the bundler's analysis
const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

/** what the transcript's trailing turn says — whitespace differs from the restored text on purpose */
const TURN_TEXT = "Rename the backup job\nand rerun it";
/** what the agent's input box holds again, as one line */
const RESTORED = "Rename the backup job and rerun it";

const extraTurn = (): unknown => ({ role: "user", ts: new Date().toISOString(), parts: [{ kind: "text", text: TURN_TEXT }] });

/** A transcript write, announced as a bridge with "conversation-watch" does: the chat reads on it. */
const announce = (page: Page): Promise<void> => page.evaluate(() => (window as unknown as { announceConversation: () => void }).announceConversation());

/** What the infra pane's prompt and conversation reads answer with from here on, announced as a transcript change. */
const feed = async (page: Page, restored: string | null, turn: unknown | null): Promise<void> => {
  await page.evaluate(([text, extra]) => {
    const view = window as unknown as { restoredText: string | null; extraTurn: unknown };
    view.restoredText = text;
    view.extraTurn = extra;
  }, [restored, turn] as const);
  await announce(page);
};

/** The composer box's value, waited for: the fills and clears under test are a poll away. */
const boxValue = (page: Page, expected: string): Promise<unknown> => page.waitForFunction(
  (value) => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === value,
  expected, { timeout: 10_000 },
);

/** How many prompt reads the page has asked for so far. */
const promptReads = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { promptReads: number }).promptReads);

/**
 * Waits until the page asked for a prompt read after read `n`: the reads go one after another, so
 * by then read `n`'s answer has been applied. Counted after a feed, read count + 1 is the first one
 * asked for after it.
 */
const promptReadsPast = (page: Page, n: number): Promise<unknown> => page.waitForFunction(
  (count) => (window as unknown as { promptReads: number }).promptReads > count, n, { timeout: 10_000 },
);

/** A rendered turn saying the send's words: the transcript's own answer, when it stands. */
const turnShown = (page: Page): Promise<unknown> => page.waitForFunction(
  () => [...document.querySelectorAll(".chat-turn")].some((turn) => turn.textContent?.includes("Rename the backup job")),
  undefined, { timeout: 10_000 },
);

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // Over the demo's own fetch: the infra pane's prompt read answers `restored` as
  // window.restoredText names it, and its conversation read appends window.extraTurn while set —
  // the send the restored text belongs to, which herdr's transcript still holds. window.extraServed
  // counts the reads that carried the turn and window.promptReads the prompt reads, so a check can
  // wait for an answer to have landed. Everything else is the demo's.
  const restoredRead = `<script>(() => {
    const demo = window.fetch;
    const infra = ${JSON.stringify(panes.omp)};
    window.restoredText = null;
    window.extraTurn = null;
    window.extraServed = 0;
    window.promptReads = 0;
    // the demo's sockets, so a transcript change can be announced on them as the bridge does
    const DemoSocket = window.WebSocket;
    const sockets = new Set();
    const Socket = function (...args) { const socket = new DemoSocket(...args); sockets.add(socket); return socket; };
    Socket.prototype = DemoSocket.prototype;
    Object.setPrototypeOf(Socket, DemoSocket);
    window.WebSocket = Socket;
    let signature = 0;
    window.announceConversation = () => {
      signature += 1;
      for (const socket of sockets) socket.push({ type: "conversation-changed", pane_id: infra, signature: "restored:" + signature });
    };
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
    window.imageUploads = 0;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/image") {
        window.imageUploads += 1;
        return json({ path: "/tmp/notes.txt" });
      }
      if (url.searchParams.get("pane_id") !== infra) return demo(input, init);
      if (url.pathname === "/api/pane/prompt") {
        window.promptReads += 1;
        return json({ prompt: null, suggestion: null, restored: window.restoredText });
      }
      if (url.pathname === "/api/pane/conversation" && window.extraTurn !== null && !url.searchParams.has("before") && !url.searchParams.has("from")) {
        return Promise.resolve(demo(input, init)).then(async (response) => {
          if (!response.ok) return response;
          const body = await response.json();
          if (Array.isArray(body.turns)) {
            body.turns.push(window.extraTurn);
            window.extraServed += 1;
          }
          return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        });
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${restoredRead}\n    <script type="module"`));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.omp)}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      try {
        await desktop.addInitScript((paneId) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          localStorage.setItem(`ovis:view:${paneId}`, "chat");
        }, panes.omp);
        const page = await desktop.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".terminal-stack.is-chat").waitFor();
        // the fixture's own two turns, before the send's turn joins them
        await page.waitForFunction(() => document.querySelectorAll(".chat-turn").length === 2, undefined, { timeout: 10_000 });
        await appFaces(page);
        const composer = page.getByRole("textbox", { name: "Message", exact: true });

        // a send the agent restored fills an empty composer — without the focus, which would raise
        // a phone's keyboard — and the chat keeps the turn that send made out of view while the
        // read still carries it (whitespace differs on purpose, as a terminal wrapped it). A desktop
        // composer takes the focus when the pane opens: put it away so the fill is what is checked
        await composer.evaluate((node) => (node as HTMLElement).blur());
        await feed(page, RESTORED, extraTurn());
        await boxValue(page, RESTORED);
        // the reads run one after another: a second read served means the first one's answer was drawn
        await page.waitForFunction(() => (window as unknown as { extraServed: number }).extraServed >= 1, undefined, { timeout: 10_000 });
        await announce(page);
        await page.waitForFunction(() => (window as unknown as { extraServed: number }).extraServed >= 2, undefined, { timeout: 10_000 });
        assert.equal(await page.locator(".chat-turn").count(), 2, "the transcript read carried the send's turn; it is not rendered");
        const shown = await page.locator(".chat-turn").allTextContents();
        assert.ok(shown.every((text) => !text.includes("Rename the backup job")), `no turn shows the restored send: ${JSON.stringify(shown)}`);
        assert.equal(await composer.evaluate((node) => document.activeElement === node), false, "a restored fill does not take the focus");
        console.log("PASS a send the agent restored fills an empty composer without focus, and the chat keeps that send's turn out");

        // gone from the agent's box: the untouched fill is cleared, never kept as a draft — and
        // the transcript settles back to what the reads answer
        await feed(page, null, null);
        await boxValue(page, "");
        await page.waitForFunction(() => document.querySelectorAll(".chat-turn").length === 2, undefined, { timeout: 10_000 });
        console.log("PASS the fill goes with the restored send once the agent's box no longer holds it");

        // the same send restored again, then edited: the fill became the user's words, so the
        // send going away leaves them alone (its turn stands again in the transcript, which is
        // how the poll's landing is seen)
        await feed(page, RESTORED, extraTurn());
        await boxValue(page, RESTORED);
        const edited = `${RESTORED} twice`;
        await composer.fill(edited);
        await boxValue(page, edited);
        await feed(page, null, extraTurn());
        const after = await promptReads(page);
        await turnShown(page);
        await promptReadsPast(page, after + 1);
        assert.equal(await composer.inputValue(), edited, "an edited fill is never cleared");
        console.log("PASS a fill the user edited is theirs and stays when the restored send goes away");

        // a box already holding the user's own words is never overwritten by a restored send
        const own = "my own words";
        await composer.fill(own);
        await boxValue(page, own);
        await feed(page, "something else restored", extraTurn());
        await promptReadsPast(page, await promptReads(page) + 1);
        assert.equal(await composer.inputValue(), own, "the user's own draft is never replaced");
        console.log("PASS a composer holding the user's own words is never overwritten by a restored send");

        // an upload that finished while the box held only a restored `/command` waits on it, and
        // its path goes in once the fill is cleared
        await composer.fill("");
        await boxValue(page, "");
        await feed(page, "/compact", null);
        await boxValue(page, "/compact");
        await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
        await page.waitForFunction(() => (window as unknown as { imageUploads: number }).imageUploads === 1, undefined, { timeout: 10_000 });
        await page.waitForTimeout(300); // fixed wait: the upload may not replace the restored /compact command
        assert.equal(await composer.inputValue(), "/compact", "the path waits on the restored command");
        await feed(page, null, null);
        await boxValue(page, "@/tmp/notes.txt ");
        console.log("PASS a path that waited on a restored /command goes in once the fill is cleared");

        assert.deepEqual(errors, []);
      } finally { await desktop.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
