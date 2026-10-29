/** Real ChatView selection and browser clipboard over fictional conversation HTTP. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, webkit, type Page } from "playwright-core";
import { FOLD_CODE_AFTER_LINES, FOLDED_CODE_LINES } from "../shared/markdown.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-chat-selection-copy-"));
const longCode = Array.from({ length: FOLD_CODE_AFTER_LINES + 1 }, (_, index) => `line ${index + 1}`).join("\n");
const shownCode = longCode.split("\n").slice(0, FOLDED_CODE_LINES).join("\n");
const reply = "Outside **selection** and [docs](https://example.com).\n\n- First item\n- Second item\n- Third item\n\nKeep `src/main.ts` and `worker` here.\n\nNext paragraph.\n\n```sh\n  first\n\n  second  \n```\n\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n\n```\n" + longCode + "\n```\n\nOutside end.";
const safari = process.env.COPY_WEBKIT === "1";

async function readClipboard(page: Page): Promise<string> {
  const copied = safari ? null : await page.evaluate(() => navigator.clipboard.readText());
  // Read through native textarea paste too: WebKit has no clipboard-read permission.
  await page.evaluate(() => {
    const input = document.createElement("textarea");
    input.id = "clipboard-reader";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press("ControlOrMeta+v");
  const value = await page.locator("#clipboard-reader").inputValue();
  await page.locator("#clipboard-reader").evaluate((node) => node.remove());
  if (copied !== null) assert.equal(value, copied, "native paste preserves copied text/plain");
  return value;
}
try {
  const build = await Bun.build({ entrypoints: ["scripts/chat-virtual-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
    if (path.endsWith("/pane/conversation")) return Response.json({ source: "claude-transcript", history_id: "copy-fixture", cursor: null, turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: reply }] }] });
    if (path === "/") return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/chat-virtual-fixture.css"></head><body><p id="outside">Before the chat</p><div id="root"></div><script type="module" src="/chat-virtual-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, path.slice(1))));
  } });
  try {
    const browser = await (safari ? webkit : chromium).launch({ executablePath: safari ? undefined : process.env.CHROME_PATH, headless: true });
    try {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US", hasTouch: width === 390, isMobile: width === 390, permissions: safari ? [] : ["clipboard-read", "clipboard-write"] });
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        await page.goto(`http://127.0.0.1:${server.port}/`);
        await page.getByText("Outside end.", { exact: true }).waitFor();
        await page.locator(".markdown").evaluate((node) => {
          const range = document.createRange();
          range.setStart(node.querySelector("li span")!.firstChild!, 0);
          range.setEndAfter(node.querySelector(".markdown-code")!);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "First item\nSecond item\nThird item\nKeep src/main.ts and worker here.\n\nNext paragraph.\n\n  first\n\n  second  \n", "a drag from a list through a code block copies the text as shown, without the block's language label");
        assert.deepEqual(await page.locator(".markdown").evaluate((node) => ({
          item: getComputedStyle(node.querySelector("li")!).display,
          paragraph: getComputedStyle(node.querySelector("p")!).display,
          file: getComputedStyle(node.querySelector(".markdown-file")!).getPropertyValue("-webkit-user-select"),
          label: getComputedStyle(node.querySelector(".markdown-code-header span")!).getPropertyValue("-webkit-user-select"),
          toggle: getComputedStyle(node.querySelector(".markdown-code-more")!).getPropertyValue("-webkit-user-select"),
        })), { item: "list-item", paragraph: "block", file: "text", label: "none", toggle: "none" }, "touch/WebKit CSS keeps semantic blocks and selectable file code, and no selectable code-block chrome");
        await page.locator(".markdown").evaluate((node) => {
          const items = node.querySelectorAll("li span");
          const range = document.createRange();
          range.setStart(items[0]!.firstChild!, 2);
          range.setEnd(items[2]!.firstChild!, 3);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "rst item\nSecond item\nThi", "a partial list keeps the browser's rows and endpoints without synthesized markers");
        await page.locator(".markdown-file code").evaluate((node) => {
          const range = document.createRange();
          range.setStart(node.firstChild!, 4);
          range.setEnd(node.firstChild!, 8);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "main", "a selection inside a file-code button keeps only selected text");
        await page.locator(".markdown p code").filter({ hasText: "worker" }).evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "worker", "inline command code is copied without Markdown backticks");
        for (const [selector, expectedText] of [["strong", "selection"], ["a", "docs"]] as const) {
          await page.locator(`.markdown p ${selector}`).first().evaluate((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
          });
          await page.keyboard.press("ControlOrMeta+c");
          if (!safari) {
            const html = await page.evaluate(async () => {
              const items = await navigator.clipboard.read();
              return (await items[0]!.getType("text/html")).text();
            });
            assert.ok(html.includes(selector === "strong" ? "<strong>selection</strong>" : '<a href="https://example.com/">docs</a>'), `rich paste retains safe formatting: ${html}`);
          }
          assert.equal(await readClipboard(page), expectedText, "formatting and link destinations do not leak into plain text");
        }
        await page.locator(".markdown").evaluate((node) => {
          const paragraphs = node.querySelectorAll("p");
          const start = document.createTreeWalker(paragraphs[1]!, NodeFilter.SHOW_TEXT);
          let last = start.nextNode()!;
          while (start.nextNode()) last = start.currentNode;
          const end = document.createTreeWalker(paragraphs[2]!, NodeFilter.SHOW_TEXT).nextNode()!;
          const range = document.createRange();
          range.setStart(last, 1);
          range.setEnd(end, 4);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "here.\n\nNext", "prose-only partial endpoints retain the paragraph break");
        await page.locator(".markdown pre").first().evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), "  first\n\n  second  ", "code-only selection keeps spaces and empty lines without fences");
        await page.locator(".markdown table").evaluate((node) => {
          const cells = node.querySelectorAll("th, td");
          const first = document.createTreeWalker(cells[0]!, NodeFilter.SHOW_TEXT).nextNode()!;
          const last = document.createTreeWalker(cells[cells.length - 1]!, NodeFilter.SHOW_TEXT).nextNode()!;
          const range = document.createRange();
          range.setStart(first, 0);
          range.setEnd(last, last.textContent!.length);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        if (!safari) {
          const html = await page.evaluate(async () => (await (await navigator.clipboard.read())[0]!.getType("text/html")).text());
          assert.ok(html.includes("<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>alpha</td><td>1</td></tr><tr><td>beta</td><td>2</td></tr></tbody></table>"), `rich paste keeps the table's rows and cells: ${html}`);
        }
        assert.equal(await readClipboard(page), "Name\tValue\nalpha\t1\nbeta\t2", "a table copies as the browser's tab-separated rows, without Markdown delimiters");
        await page.locator(".markdown").evaluate((node) => {
          const folded = node.querySelectorAll(".markdown-code")[1]!;
          const paragraphs = node.querySelectorAll("p");
          const range = document.createRange();
          range.setStart(document.createTreeWalker(folded.querySelector("pre")!, NodeFilter.SHOW_TEXT).nextNode()!, 0);
          range.setEnd(document.createTreeWalker(paragraphs[paragraphs.length - 1]!, NodeFilter.SHOW_TEXT).nextNode()!, 7);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        assert.equal(await readClipboard(page), `${shownCode}\nOutside`, "a drag out of a folded code block copies its shown lines, not its \"Show all\" toggle");
        await page.locator(".markdown").evaluate((node) => {
          const range = document.createRange();
          range.setStart(document.querySelector("#outside")!.firstChild!, 0);
          range.setEnd(document.createTreeWalker(node.querySelector("p")!, NodeFilter.SHOW_TEXT).nextNode()!, 7);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(range);
        });
        await page.keyboard.press("ControlOrMeta+c");
        if (!safari) {
          const html = await page.evaluate(async () => (await (await navigator.clipboard.read())[0]!.getType("text/html")).text());
          assert.ok(html.includes('id="outside"'), `a selection that starts outside the chat is left to the browser's own copy: ${html}`);
        }
        assert.equal(await readClipboard(page), "Before the chat\n\nOutside", "a selection that starts outside the chat copies the browser's own text");
        for (const alt of ["diagram", ""]) {
          const imageCopy = await page.locator(".markdown").evaluate((node, alt) => {
            const image = document.createElement("img");
            image.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
            image.alt = alt;
            node.append(image);
            const range = document.createRange();
            range.selectNode(image);
            getSelection()!.removeAllRanges();
            getSelection()!.addRange(range);
            const nativeText = getSelection()!.toString();
            const data = new DataTransfer();
            const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data });
            image.dispatchEvent(event);
            const result = { nativeText, handled: event.defaultPrevented, text: data.getData("text/plain"), html: data.getData("text/html") };
            getSelection()!.removeAllRanges();
            image.remove();
            return result;
          }, alt);
          assert.deepEqual(imageCopy, { nativeText: "", handled: true, text: "", html: alt }, "image-only selection cannot fall through to resource-bearing native HTML, even with no alt text");
        }
        await page.evaluate(() => getSelection()!.removeAllRanges());
        await page.getByRole("button", { name: "Copy as markdown", exact: true }).click({ force: true });
        assert.equal(await readClipboard(page), reply, "per-message Markdown Copy is unchanged");
        await page.getByRole("button", { name: "Copy as plain text", exact: true }).click({ force: true });
        assert.equal(await readClipboard(page), "Outside selection and docs.\n\n- First item\n- Second item\n- Third item\n\nKeep src/main.ts and worker here.\n\nNext paragraph.\n\n  first\n\n  second  \n\n\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n\n" + longCode + "\n\n\nOutside end.", "per-message Plain text Copy keeps text and line breaks");
        await context.close();
        console.log(`PASS ${width}: selections copy as shown with safe rich HTML; explicit MD/TXT copy is unchanged`);
      }
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
} finally { rmSync(root, { recursive: true, force: true }); }
