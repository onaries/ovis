/**
 * A hidden recent tab's view, parsed on its return, is history: a query in it is not answered into
 * the pane and a copy request in it does not write the clipboard. Real client and xterm on the demo's
 * transport, which a fixture gives the `watch` feature and a view that only it feeds.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

interface Fixture {
  copies: string[];
  sent: Array<{ type: string; pane_id?: string; text?: string }>;
  sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }>;
}
declare global { interface Window { viewFixture: Fixture } }

/** Installed after the demo's transport: records what the client sends and copies, and keeps views open. */
function installViewFixture(): void {
  const state: Fixture = { copies: [], sent: [], sockets: [] };
  window.viewFixture = state;
  Object.defineProperty(navigator.clipboard, "writeText", {
    configurable: true, writable: true,
    value: (text: string) => { state.copies.push(String(text)); return Promise.resolve(); },
  });
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as Fixture["sockets"][number];
    state.sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      // the demo has no herdr to watch: the bridge offers views here, and the fixture feeds them
      if (frame.type === "snapshot" && Array.isArray(frame.features)) return push({ ...frame, features: [...frame.features, "watch"] });
      if (frame.type === "watch-end") return;
      return push(frame);
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      state.sent.push(JSON.parse(String(raw)));
      send(raw);
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const ESC = "\x1b", BEL = "\x07";
const MARK = "VIEW-REPLAY-MARK";
// a cursor-position query, a copy request ("history") and a line to see the view parsed by
const VIEW = `${ESC}[6n${ESC}]52;c;aGlzdG9yeQ==${BEL}${MARK}\r\n`;
const evidence = process.env["UI_EVIDENCE_DIR"];
const app = mkdtempSync(join(tmpdir(), "ovis-view-replay-demo-"));
let server: ReturnType<typeof Bun.serve> | null = null;
let browser: Browser | null = null;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n<script>(${installViewFixture.toString()})()</script>\n<script type="module"`));
  const prefix = "/herdr-web-ui/demo/app/";
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}${prefix}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const width of [1280, 390]) {
    const phone = width === 390;
    const context = await browser.newContext({ viewport: { width, height: phone ? 800 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: "dark" });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark", defaultView: "terminal", terminalInputMode: "direct", alertsOn: false, paneClipboard: true, releasePaneAway: false })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      // two tabs of one workspace on the demo's PC
      const pick = await page.evaluate(async () => {
        const roster = await (await fetch("/api/machines")).json() as { machines: Array<{ id: string; snapshot?: { panes: Array<{ pane_id: string; tab_id: string; workspace_id: string }> } }> };
        const panes = roster.machines.find((machine) => machine.id === "local")?.snapshot?.panes ?? [];
        for (const pane of panes) {
          const other = panes.find((item) => item.workspace_id === pane.workspace_id && item.tab_id !== pane.tab_id);
          if (other) return { a: pane.pane_id, b: other.pane_id, tabA: pane.tab_id, tabB: other.tab_id };
        }
        return null;
      });
      assert.ok(pick, "the demo has a workspace with two tabs");
      const { a, b, tabA, tabB } = pick;
      await page.goto(`${url}?pane=${encodeURIComponent(a)}`);
      const frame = (id: string) => page.locator(`[data-layout-pane="${id}"]`);
      await frame(a).locator("[data-pane-content]").waitFor();
      const sentSince = (start: number) => page.evaluate((start) => window.viewFixture.sent.slice(start), start);
      // left for the other tab, the first tab watches its pane
      await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabB}"]`).click();
      await frame(b).locator("[data-pane-content]").waitFor();
      await page.waitForFunction((pane) => window.viewFixture.sent.some((sent) => sent.type === "watch" && sent.pane_id === pane), a, { timeout: 10_000 });
      await page.evaluate(({ pane, data }) => {
        for (const socket of window.viewFixture.sockets) socket.push({ type: "watch-data", pane_id: pane, data });
      }, { pane: a, data: VIEW });
      assert.equal(await frame(a).locator(".xterm-rows", { hasText: MARK }).count(), 0, "a hidden tab keeps its view unparsed");
      // back on the first tab: the view is drawn, its query unanswered and its copy request not run
      const back = await page.evaluate(() => window.viewFixture.sent.length);
      await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabA}"]`).click();
      await frame(a).locator(".xterm-rows", { hasText: MARK }).waitFor({ state: "attached" });
      await page.waitForFunction(({ pane, start }) => window.viewFixture.sent.slice(start).some((sent) => sent.type === "attach" && sent.pane_id === pane), { pane: a, start: back }, { timeout: 10_000 });
      // the reply xterm would type is sent as the view parses: the attach's own output, parsed after it, settles that
      await frame(a).locator("[data-pane-content]").waitFor();
      const after = await sentSince(back);
      const replies = after.filter((sent) => (sent.type === "input" || sent.type === "keys") && /\x1b\[\d+;\d+R/.test(String(sent.text ?? "")));
      assert.deepEqual(replies, [], `${width}: a query in a hidden tab's view is not answered into the pane`);
      assert.deepEqual(await page.evaluate(() => window.viewFixture.copies), [], `${width}: a copy request in a hidden tab's view does not write the clipboard`);
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `view-replay-${width}.png`) });
      }
      assert.deepEqual(errors, [], "no browser errors");
      console.log(`PASS ${width}: a hidden tab's view is drawn on return without answering its queries or copying`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
