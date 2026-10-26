/** pi's pictures end to end in Chrome: parsed page -> prompt or work row -> <img> bytes. A prompt
 * that is only a picture is a turn of its own; a tool result's picture loads once its row opens. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { transcriptPage } from "../server/conversation.ts";
import type { ConversationResponse } from "../shared/protocol.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-image-browser-"));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
// real 1x1 files, so Chrome decodes them: a naturalWidth of 1 proves the bytes that arrived
// are a picture, not a broken-image placeholder
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
// pi's own record shapes: the picture sits in the tool result, beside the text it returns
const entries = [
  { type: "session", version: 3, id: "s", timestamp: "2026-09-30T00:00:00Z", cwd: root },
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00Z", provider: "test", modelId: "qwen-test" },
  // a picture sent with no words: pi keeps it in the prompt
  { type: "message", id: "u0", parentId: "m1", timestamp: "2026-09-30T00:00:00Z", message: { role: "user", content: [{ type: "image", mimeType: "image/gif", data: GIF }] } },
  { type: "message", id: "a0", parentId: "u0", timestamp: "2026-09-30T00:00:00Z", message: { role: "assistant", model: "qwen-test", provider: "test", stopReason: "stop", usage: { input: 4, output: 2 }, content: [{ type: "text", text: "A single pixel." }] } },
  { type: "message", id: "u1", parentId: "a0", timestamp: "2026-09-30T00:00:01Z", message: { role: "user", content: "what is in this screenshot?" } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02Z", message: {
    role: "assistant", model: "qwen-test", provider: "test", stopReason: "toolUse", usage: { input: 10, output: 4 },
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }],
  } },
  { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:03Z", message: {
    role: "toolResult", toolCallId: "call-1", toolName: "read", content: [
      { type: "text", text: "read 2 images" },
      { type: "image", mimeType: "image/png", data: PNG },
      { type: "image", mimeType: "image/gif", data: GIF },
    ],
  } },
];
let conversation: ConversationResponse;
const bytes = new Map<string, { data: Buffer; type: string }>();
try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pane/conversation/image") {
      // served for real rather than by page.route: a fulfilled binary body is the harness's
      // business, and the point here is that the browser decodes the bytes the endpoint gives
      const image = bytes.get(url.searchParams.get("ref") ?? "");
      served.push(url.searchParams.get("ref") ?? "");
      return image ? new Response(new Uint8Array(image.data), { headers: { "content-type": image.type } }) : new Response(JSON.stringify({ error: { code: "image_not_found" } }), { status: 404 });
    }
    const path = url.pathname;
    if (path.endsWith("/pane/prompt")) return Response.json({ prompt: null, outcomes: [] });
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    return path === "/" ? new Response('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } }) : new Response(Bun.file(join(root, path.slice(1))));
  } });
  const write = (rows: unknown[]) => {
    const path = join(root, "session.jsonl");
    writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const { source, turns, metadata } = transcriptPage("pi-transcript", path);
    conversation = { source, history_id: "fixture", cursor: null, turns, metadata, version: 1 };
  };
  write(entries);
  for (const part of conversation.turns.flatMap((turn) => turn.parts)) {
    const images = part.kind === "tool" ? part.images ?? [] : part.kind === "image" ? [part] : [];
    for (const image of images) bytes.set(image.ref, image.media_type === "image/png" ? { data: Buffer.from(PNG, "base64"), type: "image/png" } : { data: Buffer.from(GIF, "base64"), type: "image/gif" });
  }
  assert.deepEqual([...bytes.keys()].sort(), ["pi-prompt:u0:0", "pi:call-1:0", "pi:call-1:1"], "the page should address all three pictures");

  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors: string[] = [];
  const served: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/pane/conversation?*", (route) => route.fulfill({ json: conversation }));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByText("what is in this screenshot?").waitFor();

  // the prompt that is only a picture is a turn of its own: its thumbnail, decoded, and no empty bubble
  const sent = page.locator(".chat-turn-user").first();
  assert.equal(await sent.locator(".chat-user-images img").count(), 1);
  assert.equal(await sent.locator(".chat-bubble").count(), 0, "a picture alone draws no empty bubble");
  await page.waitForFunction(() => {
    const img = document.querySelector<HTMLImageElement>(".chat-turn-user .chat-user-images img");
    return img !== null && img.complete && img.naturalWidth === 1;
  });
  assert.deepEqual(served, ["pi-prompt:u0:0"], "the prompt's picture loads with the prompt");
  console.log("PASS a pi prompt that is only a picture is its own turn, its thumbnail decoded from the served bytes");

  // the row shows a picture only once opened: a base64 blob must not arrive on every poll
  assert.equal(await page.locator(".chat-tool-images img").count(), 0, "a closed row fetches nothing");
  assert.deepEqual(served.filter((ref) => ref.startsWith("pi:")), [], "a closed row fetches nothing");
  // a settled turn's work is folded: open the block, then the row
  assert.equal(await page.locator(".work-block-head").getAttribute("aria-expanded"), "false");
  await page.locator(".work-block-head").click();
  assert.equal(await page.locator(".chat-tool-images img").count(), 0, "an open block with a closed row fetches nothing");
  await page.locator(".work-row-head").first().click();
  assert.equal(await page.locator(".chat-tool-images img").count(), 2);
  // loading="lazy" means the fetch is deferred until the picture is near the viewport, and
  // naturalWidth only settles once Chrome has decoded what came back
  await page.locator(".chat-tool-images img").first().scrollIntoViewIfNeeded();
  for (let attempt = 0; attempt < 100; attempt++) {
    const loaded = await page.locator(".chat-tool-images img").evaluateAll((imgs) => imgs.every((img) => img.complete && img.naturalWidth > 0));
    if (loaded) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.deepEqual(served.filter((ref) => ref.startsWith("pi:")).sort(), ["pi:call-1:0", "pi:call-1:1"]);
  // the bytes round-tripped: Chrome decoded them, so they are the file and not a broken icon
  const sizes = await page.locator(".chat-tool-images img").evaluateAll((imgs) => imgs.map((img) => [img.naturalWidth, img.naturalHeight]));
  assert.deepEqual(sizes, [[1, 1], [1, 1]], "Chrome decoded both pictures from the served bytes");
  assert.equal(await page.locator(".chat-tool-output pre").textContent(), "read 2 images", "the text answer stays beside the pictures");
  assert.deepEqual(errors, []);

  // a result whose pictures vanish (the branch moved, the file changed) must not strand an <img>
  const kept = entries.filter((entry) => (entry as { id?: string }).id !== "r1");
  write(kept);
  await page.evaluate(() => window.qa.refresh());
  await page.locator(".work-block-head").click(); // fold, then unfold, so the row re-renders
  await page.locator(".work-block-head").click();
  assert.equal(await page.locator(".chat-tool-images").count(), 0, "no image, no container");
  console.log("PASS pi pictures: browser OK (a prompt's picture, 2 tool pictures served, none fetched while folded, text answer intact)");
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
