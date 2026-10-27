/** Bridge-held message -> native queue action -> owned raw PTY. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import type { ServerMessage } from "../shared/protocol.ts";

const agent = process.argv[2] === "codex" ? "codex" : "omo";
const queueKey = agent === "codex" ? "\t" : "\u0011";
const screen = agent === "codex" ? "• Working (2s • esc to interrupt) · 1 background termin…\n• Queued follow-up inputs\n  ↳ First queued preview\n    wrapped detail\n  ↳ Second queued preview\n    ⇧← edit last queued message\n› \x1b[2mAsk Codex to do anything\x1b[0m\n  GPT-6.1-Sol high fast · /tmp/work\n  ← for agents · ? for shor  ⚠ 3 warnings · f2 to view\n" : "Message OmO\n";
const root = mkdtempSync(join(tmpdir(), `herdr-${agent}-queue-`));
const evidence = process.env.UI_EVIDENCE_DIR || join(root, "evidence");
mkdirSync(evidence, { recursive: true });
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;
const seen: string[] = [];
const subscribers = new Set<(event: string) => void>();
function waitFor(predicate: (event: string) => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { subscribers.delete(receive); reject(new Error("PTY event deadline exceeded")); }, 15_000);
    const receive = (event: string) => {
      if (!predicate(event)) return;
      clearTimeout(timer); subscribers.delete(receive); resolve(event);
    };
    subscribers.add(receive);
  });
}
const recorder = Bun.listen<{ buffer: string }>({
  hostname: "127.0.0.1", port: 0,
  socket: {
    open(socket) { socket.data = { buffer: "" }; },
    data(socket, bytes) {
      socket.data.buffer += bytes.toString();
      let newline: number;
      while ((newline = socket.data.buffer.indexOf("\n")) >= 0) {
        const event: string = JSON.parse(socket.data.buffer.slice(0, newline));
        socket.data.buffer = socket.data.buffer.slice(newline + 1);
        seen.push(event); for (const receive of subscribers) receive(event);
      }
    },
  },
});
try {
  const binary = join(root, agent);
  copyFileSync(process.execPath, binary); chmodSync(binary, 0o755);
  const script = join(root, "recorder.cjs");
  writeFileSync(script, `const net=require("node:net");const s=net.connect(${recorder.port},"127.0.0.1");process.stdin.setRawMode(true);process.stdin.resume();s.on("connect",()=>{process.stdout.write("\\x1b[?2004h\\r\\n"+${JSON.stringify(screen.replace(/\n/g, "\r\n"))});s.write(JSON.stringify("READY")+"\\n")});process.stdin.on("data",d=>s.write(JSON.stringify(d.toString("utf8"))+"\\n"));`);
  const created = await workspaceCreate({ cwd: root, label: `herdr-web-ui-test-${agent}-queue`, focus: false });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  const ready = waitFor((event) => event === "READY");
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${binary}' '${script}'\n` });
  await ready;
  await herdrRpc("pane.report_agent", { pane_id: pane, agent, state: "working", source: "manual" });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
  browser = process.env.CHROME_CDP ? await chromium.connectOverCDP(process.env.CHROME_CDP)
    : await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: "en-US", isMobile: width === 390, hasTouch: width === 390 });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false, autoSendQueued: false })));
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      // Keep the raw recorder's lack of a real question separate from server input authority.
      if (agent !== "codex") await page.route("**/api/pane/prompt?*", (route) => route.fulfill({ json: { prompt: null } }));
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const frames: ServerMessage[] = [];
      const listeners = new Set<(frame: ServerMessage) => void>();
      const receipt = (predicate: (frame: ServerMessage) => boolean): Promise<ServerMessage> => {
        const found = frames.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { listeners.delete(receive); reject(new Error("WS receipt deadline exceeded")); }, 15_000);
          const receive = (frame: ServerMessage) => { if (predicate(frame)) { clearTimeout(timer); listeners.delete(receive); resolve(frame); } };
          listeners.add(receive);
        });
      };
      page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
        const frame: ServerMessage = JSON.parse(String(payload));
        frames.push(frame); for (const receive of listeners) receive(frame);
      }));
      const inputReady = receipt((frame) => frame.type === "input-ready" && frame.pane_id === pane && frame.ready !== false);
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
      await inputReady;
      const card = page.locator(`[data-layout-pane="${pane}"]`);
      const box = card.getByRole("textbox", { name: "Message", exact: true });
      const send = card.getByRole("button", { name: "Send message", exact: true });
      await box.waitFor();
      if (agent === "codex") {
        const previews = card.locator(".chat-codex-queue");
        await previews.waitFor();
        assert.deepEqual(await previews.locator("li").allTextContents(), ["First queued preview\nwrapped detail", "Second queued preview"]);
        assert.match(await previews.innerText(), /Queued messages · Codex · Preview/);
        const watcher = await page.evaluate(async (paneId) => (await fetch(`/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}&plan=0`)).json(), pane);
        assert.equal(watcher.codex_queue_preview, undefined, "a watching device receives no queued text");
      }
      assert.equal(await card.locator(".composer-agent-queue").count(), 0, "composer keeps one primary action");
      await box.fill(`native follow-up ${width}\nsecond line`);
      await send.waitFor();
      const heldMark = frames.length;
      const heldReceipt = receipt((frame) => frames.indexOf(frame) >= heldMark && frame.type === "submit-result" && frame.pane_id === pane);
      const heldBefore = seen.length;
      await send.click();
      const heldAnswer = await heldReceipt;
      assert.ok(heldAnswer.type === "submit-result" && heldAnswer.ok && heldAnswer.pending?.state === "held");
      const pendingId = heldAnswer.pending.id;
      assert.equal(seen.length, heldBefore, "bridge hold does not type into the agent");
      const row = card.locator(".pending-message").filter({ hasText: `native follow-up ${width}` });
      const queue = row.getByRole("button", { name: /^Send to agent queue:/ });
      await queue.waitFor();
      assert.equal(await queue.getAttribute("title"), `Send to agent queue (${agent === "codex" ? "Tab" : "Ctrl+Q"})`);
      assert.equal(await queue.isEnabled(), true);
      for (const theme of ["dark", "light"]) {
        await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
        await page.screenshot({ path: join(evidence, `queue-${width}-${theme}.png`) });
        assert.equal(await queue.evaluate((node) => {
          const button = node.getBoundingClientRect();
          const siblings = Array.from(node.parentElement?.querySelectorAll("button") ?? [], (item) => item.getBoundingClientRect());
          return button.width > 0 && button.left >= 0 && button.right <= innerWidth
            && siblings.every((item, index) => index === 0 || siblings[index - 1].right <= item.left);
        }), true, "pending-row actions fit without overlap");
      }
      const mark = frames.length;
      const delivered = waitFor((event) => event.includes(queueKey));
      const accepted = receipt((frame) => frames.indexOf(frame) >= mark && frame.type === "pending-result" && frame.pane_id === pane && frame.pending_id === pendingId);
      const before = seen.length;
      await queue.click();
      const answer = await accepted;
      assert.ok(answer.type === "pending-result" && answer.ok);
      await delivered;
      assert.equal(seen.slice(before).join(""), `\u001b[200~native follow-up ${width}\nsecond line\u001b[201~${queueKey}`);
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".is-current .composer-text")?.value === "");
      assert.equal(await box.inputValue(), "", "only the acknowledged draft clears");
      await row.waitFor({ state: "detached" });
      assert.equal(await card.locator(".pending-message").count(), 0, "transfer removes the same bridge item");
      await box.fill("normal Send now still works");
      const normalMark = frames.length;
      const normalHeld = receipt((frame) => frames.indexOf(frame) >= normalMark && frame.type === "submit-result" && frame.pane_id === pane);
      await send.click();
      const normalAnswer = await normalHeld;
      assert.ok(normalAnswer.type === "submit-result" && normalAnswer.ok && normalAnswer.pending);
      const normalRow = card.locator(".pending-message").filter({ hasText: "normal Send now still works" });
      await normalRow.waitFor();
      const normalStart = seen.length;
      const normalDelivered = waitFor((event) => event.includes("\r"));
      await normalRow.getByRole("button", { name: /^Send now:/ }).click();
      await normalDelivered;
      await normalRow.waitFor({ state: "detached" });
      assert.equal(seen.slice(normalStart).join(""), "\u001b[200~normal Send now still works\u001b[201~\r", "Send now delivers only pasted text and Enter without Escape or a queue key");
      await box.fill("keep this blocked message");
      const secondMark = frames.length;
      const secondHeld = receipt((frame) => frames.indexOf(frame) >= secondMark && frame.type === "submit-result" && frame.pane_id === pane);
      await send.click();
      const secondAnswer = await secondHeld;
      assert.ok(secondAnswer.type === "submit-result" && secondAnswer.ok && secondAnswer.pending);
      const secondId = secondAnswer.pending.id;
      const blockedRow = card.locator(".pending-message").filter({ hasText: "keep this blocked message" });
      const blockedQueue = blockedRow.getByRole("button", { name: /^Send to agent queue:/ });
      await blockedQueue.waitFor();
      const blocked = receipt((frame) => frame.type === "pane-status" && frame.pane_id === pane && frame.agent_status === "blocked");
      await herdrRpc("pane.report_agent", { pane_id: pane, agent, state: "blocked", source: "manual" });
      await blocked;
      if (agent === "codex") {
        await blockedQueue.waitFor({ state: "detached" });
        await card.locator(".chat-codex-queue").waitFor({ state: "detached" });
      } else {
      const blockedMark = frames.length;
      const refusal = receipt((frame) => frames.indexOf(frame) >= blockedMark && frame.type === "pending-result" && frame.pane_id === pane && frame.pending_id === secondId);
      // Status alone is not a prompt card; the server remains the input-state authority.
      await blockedQueue.click();
      const denied = await refusal;
      assert.ok(denied.type === "pending-result" && !denied.ok && denied.code === "agent_blocked");
      }
      assert.equal(await blockedRow.locator(".pending-message-bubble").textContent(), "keep this blocked message");
      assert.deepEqual(errors, []);
      await box.fill("");
      await blockedRow.getByRole("button", { name: "Discard", exact: true }).click();
      await blockedRow.waitFor({ state: "detached" });
      await herdrRpc("pane.report_agent", { pane_id: pane, agent, state: "working", source: "manual" });
      console.log(`PASS ${agent} bridge queue transfer at ${width}px: hold without typing, native key, same-ID removal, blocked retention, light/dark layout`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  server?.stop();
  if (workspace !== undefined) await workspaceClose(workspace);
  recorder.stop(true);
  rmSync(root, { recursive: true, force: true });
}
