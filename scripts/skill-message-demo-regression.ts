import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-skill-message-"));
const pane = "w1J:p1";
const text = "Please use $skill:patina to edit this";
try {
  await buildDemoApp(root);
  const index = join(root, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `<script src="./demo-transport.js"></script><script>
    (() => {
      let sent = null;
      const original = window.fetch;
      const Socket = window.WebSocket;
      window.WebSocket = class extends Socket {
        constructor(...args) {
          const socket = new Socket(...args);
          const send = socket.send.bind(socket);
          socket.send = raw => {
          const frame = JSON.parse(raw);
          if (frame.type === 'submit' && frame.pane_id === '${pane}') {
            sent = { text: frame.text, at: new Date().toISOString() };
            socket.push({ type: 'submit-result', id: frame.id, pane_id: frame.pane_id, ok: true });
            queueMicrotask(() => socket.push({ type: 'conversation-changed', pane_id: frame.pane_id, signature: sent.at }));
            return;
          }
          send(raw);
          };
          return socket;
        }
      };
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
        if (url.searchParams.get('pane_id') === '${pane}') {
          const outcome = sent && { id: 'skill-send', pane_id: '${pane}', text: sent.text, state: 'accepted', evidence: [], created_at: sent.at, updated_at: sent.at };
          if (url.pathname === '/api/pane/prompt') return new Response(JSON.stringify({ prompt: null, outcomes: outcome ? [outcome] : [] }));
          if (url.pathname === '/api/pane/conversation') return new Response(JSON.stringify({ source: 'omo-transcript', history_id: 'skill-message', cursor: null, turns: sent ? [{ role: 'user', ts: sent.at, parts: [{ kind: 'text', text: sent.text.replace('$skill:patina', '[skill: patina]') }, { kind: 'skill', skill: { name: 'patina', evidence: 'instructions', status: 'loaded' } }] }] : [] }));
        }
        return original(input, init);
      };
    })();</script><script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const file = new URL(request.url).pathname.slice(1) || "index.html";
    if (file.split("/").includes("..")) return new Response("bad path", { status: 400 });
    return new Response(Bun.file(join(root, file)));
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [390, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        try {
          await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, defaultView: "chat" })));
          const page = await context.newPage();
          page.setDefaultTimeout(15_000);
          page.on("pageerror", (error) => console.error(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
          const scope = page.locator(`[data-layout-pane="${pane}"].is-current`);
          const box = scope.locator(".composer-text");
          await box.fill(text);
          await box.press("Enter");
          console.log(`Sent skill request at ${width}px`);
          await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
          await scope.getByText("Please use", { exact: false }).first().waitFor();
          await page.waitForFunction(() => {
            const node = document.querySelector('[data-layout-pane="w1J:p1"].is-current');
            return node?.querySelector(".chat-turn-user .chat-outcome") !== null && node?.querySelectorAll(".chat-turn-user").length === 1;
          }, undefined, { timeout: 15_000 }).catch(async (error: unknown) => {
            console.log(await scope.innerText());
            console.log(await scope.locator(".chat-turn-user").count());
            throw error;
          });
          assert.equal(await scope.locator(".chat-turn-waiting").count(), 0);
          assert.equal(await scope.locator(".chat-turn-user").count(), 1);
          const evidence = process.env.UI_EVIDENCE_DIR;
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `skill-${width}.png`) }); }
          console.log(`PASS ${width}px: one skill request bubble after send, transcript and receipt`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
