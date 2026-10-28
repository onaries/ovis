/** Real ChatView over controlled HTTP; no live panes or provider calls. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { ConversationTurn } from "../shared/protocol.ts";
import type {} from "./chat-virtual-fixture.tsx";

const root = mkdtempSync(join(tmpdir(), "herdr-chat-virtual-"));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let activePage: Page | undefined;
let revision = 0;
let epoch = 1;
let holdOlder = false;
let olderReads = 0;
let wholeReads = 0;
let newestStart = 0;
let beginsAtOrigin = false;
let slideReads = 0;
const WHOLE_OUTPUT = `FULL TOOL OUTPUT\n${"detail ".repeat(250)}\nFULL OUTPUT END`;
const olderEvents = new EventTarget();
const olderReleases: Array<() => void> = [];
function turn(index: number, machine: string): ConversationTurn {
  const text = `${machine} E${epoch} ROW-${index}\n\n${"Variable height paragraph. ".repeat(Math.abs(index) % 5 + 1)}${index === 999 ? `\n\nREVISION-${revision}` : ""}`;
  const parts: ConversationTurn["parts"] = [{ kind: "text", text }];
  if (index === 497) parts.unshift({ kind: "tool", name: "Read", summary: "fixture tool", input: "{}", output: "preview only", output_ref: "fixture-output", output_size: WHOLE_OUTPUT.length });
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    ts: index % 3 === 0 ? null : "2026-10-12T00:00:00.000Z",
    parts,
  };
}
async function metrics(page: Page) {
  return page.locator(".chat-view").evaluate((element) => {
    const root = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>("[data-chat-row]")];
    const visible = rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom > root.top && box.top < root.bottom;
    }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const first = visible[0];
    return {
      mounted: rows.length,
      keys: rows.map((row) => row.dataset.chatRow),
      bottom: element.scrollHeight - element.clientHeight - element.scrollTop,
      top: element.scrollTop,
      anchor: first ? { key: first.dataset.chatRow, y: first.getBoundingClientRect().top, text: first.textContent } : null,
    };
  });
}
async function settleBottom(page: Page) {
  await page.waitForFunction(() => {
    const node = document.querySelector(".chat-view");
    return node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
  });
}
async function update(page: Page) {
  const response = page.waitForResponse((response) => response.url().includes("/conversation?") && !new URL(response.url()).searchParams.has("before"));
  await page.evaluate(() => window.chatQa.refresh());
  await (await response).finished();
}
async function shot(page: Page, name: string) {
  if (evidence) await page.screenshot({ path: join(evidence, `chat-virtual-${name}.png`) });
}
async function visibleMessage(page: Page, text: string) {
  await page.waitForFunction((text) => {
    const root = document.querySelector(".chat-view")?.getBoundingClientRect();
    return root && [...document.querySelectorAll(".chat-view p")].some((node) => {
      const box = node.getBoundingClientRect();
      return node.textContent === text && box.top >= root.top - 1 && box.bottom <= root.bottom + 1;
    });
  }, text);
}
/** Scrolls the list until the row whose first line is `text` is mounted, then centers it; above the loaded rows it scrolls to the top, which loads an older page. */
async function reveal(page: Page, text: string) {
  const target = Number(/ROW-(-?\d+)$/.exec(text)?.[1]);
  const deadline = Date.now() + 15_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const found = await page.locator(".chat-view").evaluate((node, { text, target }) => {
      const hit = [...node.querySelectorAll("p")].find((p) => p.textContent === text);
      if (hit) { hit.scrollIntoView({ block: "center" }); return true; }
      // rows in view only: a pinned (selected or focused) row stays mounted anywhere in the list
      const view = node.getBoundingClientRect();
      const shown = [...node.querySelectorAll("p")].filter((p) => {
        const box = p.getBoundingClientRect();
        return box.bottom > view.top && box.top < view.bottom;
      }).map((p) => Number(/ROW-(-?\d+)$/.exec(p.textContent ?? "")?.[1])).filter(Number.isFinite);
      if (!shown.length) { node.scrollTop -= node.clientHeight / 2; return false; }
      const low = Math.min(...shown), high = Math.max(...shown);
      // step by rows, damped so it never jumps past the target
      const rowHeight = node.clientHeight / Math.max(1, high - low + 1);
      const rows = target < low ? target - low : target - high;
      node.scrollTop = Math.max(0, node.scrollTop + Math.sign(rows) * Math.max(rowHeight, Math.abs(rows) * rowHeight * 0.7));
      return { low, high, top: node.scrollTop };
    }, { text, target });
    if (found === true) return visibleMessage(page, text);
    last = found;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  throw new Error(`Row never mounted: ${text} ${JSON.stringify(last)}`);
}
async function selectionState(page: Page) {
  return page.evaluate(() => {
    const selection = getSelection();
    const row = (node: Node | null | undefined) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-chat-row]")?.dataset.chatRow;
    return {
      text: selection?.toString(),
      anchor: { row: row(selection?.anchorNode), text: selection?.anchorNode?.textContent?.slice(0, 80), offset: selection?.anchorOffset },
      focus: { row: row(selection?.focusNode), text: selection?.focusNode?.textContent?.slice(0, 80), offset: selection?.focusOffset },
    };
  });
}
try {
  const build = await Bun.build({
    entrypoints: ["scripts/chat-virtual-fixture.tsx"], outdir: root, target: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/pane/conversation/tool-output")) { wholeReads++; return new Response(WHOLE_OUTPUT); }
    // the chat asks for the pane's slash commands to mark skill names in an answer: this pane has none
    if (url.pathname.endsWith("/pane/commands")) return Response.json({ commands: [] });
    if (url.pathname.endsWith("/pane/conversation")) {
      const machine = url.pathname.includes("/machines/remote/") ? "remote" : "local";
      const older = url.searchParams.has("before");
      if (url.searchParams.get("before") === "window:2") {
        slideReads++;
        assert.equal(url.searchParams.get("since"), beginsAtOrigin ? null : "older:0");
        return Response.json({
          source: "omp-transcript", history_id: `${machine}:${epoch}`,
          cursor: beginsAtOrigin ? null : "older:0",
          turns: [turn(0, machine), turn(1, machine)],
        });
      }
      const page = Number(url.searchParams.get("before")?.split(":")[1] ?? 0);
      if (older) {
        olderReads++;
      }
      if (older && holdOlder) await new Promise<void>((resolve) => {
        olderReleases.push(resolve);
        olderEvents.dispatchEvent(new Event("requested"));
      });
      return Response.json({
        source: "omp-transcript", history_id: `${machine}:${epoch}`, cursor: older ? page === 0 ? "older:1" : null : newestStart ? "window:2" : beginsAtOrigin ? null : "older:0",
        turns: Array.from({ length: older ? 20 : 1000 }, (_, index) => turn(older ? index - (page + 1) * 20 : index + newestStart, machine)),
      });
    }
    if (url.pathname === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat virtualization QA</title><link rel="stylesheet" href="/chat-virtual-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-virtual-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, url.pathname.slice(1))));
  } });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const [width, theme] of [[1440, "dark"], [1440, "light"], [390, "dark"], [390, "light"]] as const) {
    revision = 0; epoch = 1; holdOlder = false; olderReads = 0; wholeReads = 0;
    newestStart = 0; beginsAtOrigin = false; slideReads = 0;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, locale: "en-US" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.addInitScript((theme) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })), theme);
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.getByText("REVISION-0", { exact: true }).waitFor();
    await settleBottom(page);
    const initial = await metrics(page);
    assert.ok(initial.mounted > 0 && initial.mounted < 80, JSON.stringify(initial));
    assert.equal(new Set(initial.keys).size, initial.keys.length, "duplicate/null timestamps do not collide");
    await shot(page, `latest-${width}-${theme}`);
    console.log(`PASS ${width} ${theme}: 1000 logical rows initially mount ${initial.mounted}, at latest`);

    // Given: a following transcript. A controlled 20 px upward correction stays inside the
    // layout allowance but outside endpoint rounding, distinguishing input from layout.
    for (const input of ["down-wheel", "horizontal-wheel", "click", "typing", "down-key", "body-composing-up-key", "body-composing-home", "body-229-up-key", "body-229-home", "scrollbar-released", "scrollbar-unseen-release", "scrollbar-held-still", "scrollbar-blurred", "up-wheel", "body-up-key", "body-page-up", "body-home", "body-shift-space", "drag", "scrollbar-held", "scrollbar-held-released-first"] as const) {
      const upward = ["up-wheel", "body-up-key", "body-page-up", "body-home", "body-shift-space", "drag", "scrollbar-held", "scrollbar-held-released-first"].includes(input);
      // When: input and the correction happen in one task, inside the input window, except that a
      // scrollbar press is followed by a correction past it: a thumb that rests, then is dragged
      // (let go away from its press) or only rested (let go where it went down).
      await page.locator(".chat-view").evaluate(async (node, input) => {
        if (!(node instanceof HTMLElement)) throw new Error("Missing chat scroller");
        const text = node.querySelector("p");
        if (!text) throw new Error("Missing transcript text");
        // a press on the scrollbar: the scroller itself, right of its content box
        const bar = node.getBoundingClientRect();
        const pressed = { clientX: bar.left + node.clientWidth, clientY: bar.bottom - 20 };
        const letGo = (dragged: boolean) => node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: pressed.clientX, clientY: pressed.clientY - (dragged ? 20 : 0) }));
        // The list hands a scroll to the chat at once only while it settles a data change (its anchor
        // lock lasts 300 ms), otherwise in an animation frame it asks for first: awaiting the next
        // frame awaits that delivery. A loaded runner gets here after the lock has lapsed.
        const delivered = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        // Deliver the preceding return-to-end scroll before testing a new upward move.
        node.dispatchEvent(new Event("scroll"));
        await delivered();
        if (input.endsWith("wheel")) text.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: input === "up-wheel" ? -20 : input === "down-wheel" ? 20 : 0, deltaX: input === "horizontal-wheel" ? 20 : 0 }));
        else if (input === "click" || input === "drag") {
          text.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1, clientY: 100 }));
          if (input === "drag") text.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 1, clientY: 110 }));
          if (input === "click") text.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        } else if (input.startsWith("scrollbar-")) {
          node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1, ...pressed }));
          if (input === "scrollbar-released") letGo(false);
          // released outside the window: no pointerup, and the next pointer event has no button down
          if (input === "scrollbar-unseen-release") document.body.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 0 }));
          // the window lost focus with the press held: whatever is let go later is not this press
          if (input === "scrollbar-blurred") window.dispatchEvent(new Event("blur"));
        } else {
          const key = input.endsWith("up-key") ? "ArrowUp" : input === "body-page-up" ? "PageUp" : input.endsWith("home") ? "Home" : input === "body-shift-space" ? " " : input === "down-key" ? "ArrowDown" : "a";
          const target = input.startsWith("body-") ? document.body : text;
          target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, shiftKey: input === "body-shift-space", isComposing: input.includes("composing"), keyCode: input.includes("229") ? 229 : 0 }));
        }
        // a dragged thumb sends no pointermove: the move comes after the 500 ms input window
        const now = performance.now.bind(performance);
        if (input.startsWith("scrollbar-")) Object.defineProperty(performance, "now", { configurable: true, value: () => now() + 600 });
        node.scrollTop -= 20;
        // the thumb let go before the browser delivered the scroll its drag made
        if (input === "scrollbar-held-released-first") letGo(true);
        node.dispatchEvent(new Event("scroll"));
        // the chat reads the clock when the scroll reaches it: the rest lasts until then
        await delivered();
        Reflect.deleteProperty(performance, "now");
        if (input === "drag") text.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        if (input === "scrollbar-held" || input === "scrollbar-blurred") letGo(true);
        if (input === "scrollbar-held-still") letGo(false);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }, input);
      // Then: only upward intent leaves follow mode; new output must otherwise reach the end.
      revision++;
      await update(page);
      await page.getByText(`REVISION-${revision}`, { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "New messages" }).count(), upward ? 1 : 0, `${input}: only upward input stops following`);
      if (upward) {
        assert.ok((await metrics(page)).bottom > 1, `${input}: output leaves the reader away from the end`);
        await page.getByRole("button", { name: "New messages" }).click();
      }
      await settleBottom(page);
    }
    console.log(`PASS ${width} ${theme}: upward wheel, document navigation and dragging stop follow; downward input and clicks do not`);

    for (revision = 1; revision <= 100; revision++) {
      await update(page);
      await page.getByText(`REVISION-${revision}`, { exact: true }).waitFor();
      await settleBottom(page);
    }
    console.log(`PASS ${width} ${theme}: 100 immutable streaming revisions retain bottom`);

    // #2042: the last row grows with no new data (output rewrapping), so the view glides to the end;
    // while it glides, a row above the view folds or grows. The list holds the rows on screen where
    // they were, a move up the reader did not make: following goes on to the end. So does a turn
    // settling at the end, its work and a block above folding at once. A real upward wheel once it
    // lands still stops following.
    for (const change of ["fold-above", "grow-above", "fold-together", "wheel-up"] as const) {
      const reading = change === "wheel-up";
      const landed = await page.locator(".chat-view").evaluate(async (node, change) => {
        if (!(node instanceof HTMLElement)) throw new Error("Missing chat scroller");
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const gap = () => node.scrollHeight - node.clientHeight - node.scrollTop;
        // the next scroll event, or false when none comes in two seconds
        const scrolled = () => new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { node.removeEventListener("scroll", seen); resolve(false); }, 2_000);
          const seen = () => { clearTimeout(timer); resolve(true); };
          node.addEventListener("scroll", seen, { once: true });
        });
        // the scroll events of this case, for a failure to say how the view moved
        const moves: string[] = [];
        const note = () => moves.push(`${Math.round(node.scrollTop)}/${Math.round(gap())}`);
        node.addEventListener("scroll", note);
        const fail = (what: string) => new Error(`${change}: ${what}: ${JSON.stringify({ gap: Math.round(gap()), moves: moves.slice(-12) })}`);
        const view = node.getBoundingClientRect();
        const rows = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const above = rows.filter((row) => row.getBoundingClientRect().bottom < view.top).at(-1);
        const last = rows.at(-1);
        if (!above || !last) throw fail("rows above the view and at the end are missing");
        const block = document.createElement("div");
        block.className = "qa-row-height";
        // only the folds need a block there before the glide
        const folds = change === "fold-above" || change === "fold-together";
        block.style.height = folds ? "400px" : "0px";
        if (folds) {
          // the block to fold, measured and held in place before the glide
          const moved = scrolled();
          above.append(block);
          if (!await moved) throw fail("the list did not hold the view for a taller row above");
        } else above.append(block);
        for (let i = 0; i < 120 && gap() > 1; i++) await frame();
        if (gap() > 1) throw fail("not at the end before the glide");
        if (change === "fold-together") {
          // A turn settles at the end: its own work folds in the last row while an earlier block folds
          // above it, in one layout. The list and the browser both move the view up for it.
          const work = document.createElement("div");
          work.className = "qa-row-height";
          work.style.height = "600px";
          last.append(work);
          for (let i = 0; i < 300 && (gap() > 1 || last.getBoundingClientRect().bottom > node.getBoundingClientRect().bottom + 1); i++) await frame();
          if (gap() > 1) throw fail("not at the end of the grown last row");
          block.style.height = "0px";
          work.style.height = "0px";
          for (let i = 0; i < 300 && gap() > 1 && !document.querySelector(".chat-new-messages"); i++) await frame();
          node.removeEventListener("scroll", note);
          return { during: Infinity, gap: Math.round(gap()), stopped: document.querySelector(".chat-new-messages") !== null, moves: moves.slice(-12) };
        }
        // The list's own follow from the last update can still be settling (it waits up to 800 ms)
        // and lands the view at the end at once; grow the row again until the view glides there.
        const deadline = performance.now() + 5_000;
        for (;;) {
          const growth = document.createElement("div");
          growth.className = "qa-row-height";
          growth.style.height = "600px";
          const moved = scrolled();
          last.append(growth);
          if (!await moved) throw fail("no scroll toward the grown last row");
          // the list hands a scroll to the chat in the next animation frame: the chat has seen the
          // glide under way before anything else moves the view, as it has when a reader's wheel lands
          await frame();
          if (gap() > 1) break;
          if (performance.now() > deadline) throw fail("the view never glided toward the grown last row");
        }
        const during = gap();
        // the wheel is real input, sent from outside the page: Chrome ends its own glide for it
        if (change === "wheel-up") {
          node.removeEventListener("scroll", note);
          return { during, gap: Math.round(gap()), stopped: false, moves: moves.slice(-12) };
        }
        block.style.height = change === "fold-above" ? "0px" : "400px";
        // the end reached, or following stopped
        for (let i = 0; i < 300 && gap() > 1 && !document.querySelector(".chat-new-messages"); i++) await frame();
        node.removeEventListener("scroll", note);
        return { during, gap: Math.round(gap()), stopped: document.querySelector(".chat-new-messages") !== null, moves: moves.slice(-12) };
      }, change);
      assert.ok(landed.during > 1, `${change}: the change came while the glide was short of the end: ${JSON.stringify(landed)}`);
      if (reading) {
        // the glide over, the reader wheels up: following stops, and the way back shows
        await settleBottom(page);
        const box = await page.locator(".chat-view").boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -300);
        await page.getByRole("button", { name: "Jump to latest" }).waitFor();
      } else {
        assert.equal(landed.stopped, false, `${change}: following goes on: ${JSON.stringify(landed)}`);
        assert.ok(landed.gap <= 1, `${change}: following reached the end: ${JSON.stringify(landed)}`);
      }
      revision++;
      await update(page);
      await page.getByText(`REVISION-${revision}`, { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "New messages" }).count(), reading ? 1 : 0, `${change}: the next output ${reading ? "leaves the reader where they went" : "is followed"}`);
      if (reading) assert.ok((await metrics(page)).bottom > 1, `${change}: output leaves the reader away from the end`);
      else await settleBottom(page);
      await page.evaluate(() => document.querySelectorAll(".qa-row-height").forEach((block) => block.remove()));
      if (reading) await page.getByRole("button", { name: "New messages" }).click();
      await settleBottom(page);
    }
    console.log(`PASS ${width} ${theme}: a row above folding or growing during the follow glide keeps following, as does a fold at the end; an upward wheel stops it`);

    // A scroll that sends no input this page sees (a screen reader's, a Firefox scrollbar's), in small
    // steps over a transcript that does not shrink: past the layout allowance from the end, following
    // stops however small each step was (#1902).
    await page.locator(".chat-view").evaluate(async (node) => {
      const delivered = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (const step of [30, 30]) {
        node.scrollTop -= step;
        node.dispatchEvent(new Event("scroll"));
        await delivered();
      }
    });
    revision++;
    await update(page);
    await page.getByText(`REVISION-${revision}`, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "New messages" }).count(), 1, "small steps without input past the allowance stop following");
    assert.ok((await metrics(page)).bottom > 48, "output leaves the reader where the steps took them");
    await page.getByRole("button", { name: "New messages" }).click();
    await settleBottom(page);
    console.log(`PASS ${width} ${theme}: small upward steps without input past the layout allowance stop following`);

    const height = width === 390 ? 844 : 900;
    await page.evaluate((height) => window.chatQa.resize(height - 180), height);
    await page.waitForFunction((height) => document.querySelector(".terminal-stack")?.getBoundingClientRect().height === height - 180, height);
    await settleBottom(page);
    await page.evaluate((height) => window.chatQa.resize(height), height);
    await settleBottom(page);
    // #1205: a composer that grows a line shrinks the view; the frame painted next is already at
    // the end. An observer made after ChatView's runs after it, before that paint.
    const painted = await page.evaluate(async (height) => {
      const node = document.querySelector(".chat-view")!;
      const offsets: number[] = [];
      const observer = new ResizeObserver(() => offsets.push(Math.round(node.scrollHeight - node.clientHeight - node.scrollTop)));
      observer.observe(node);
      // waits until the observer has delivered `count` sizes; its first is the size it started with
      const observed = async (count: number) => {
        const deadline = performance.now() + 5_000;
        while (offsets.length < count) {
          if (performance.now() > deadline) throw new Error(`no resize observed: ${JSON.stringify(offsets)}`);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      };
      await observed(1);
      const start = offsets.length;
      for (const line of [1, 2, 3]) {
        window.chatQa.resize(height - 22 * line);
        await observed(start + line);
      }
      observer.disconnect();
      return offsets.slice(start);
    }, height);
    assert.ok(painted.length === 3 && painted.every((offset) => offset <= 1), `a growing composer keeps the painted frame at the end: ${JSON.stringify(painted)}`);
    await page.evaluate((height) => window.chatQa.resize(height), height);
    await settleBottom(page);
    console.log(`PASS ${width} ${theme}: a composer growing a line paints no frame off the end`);
    assert.ok(await page.locator(".chat-view").evaluate((node) => node.scrollWidth <= node.clientWidth), "production terminal hierarchy has no horizontal overflow");

    await page.evaluate(() => window.chatQa.page(-1));
    const away = await metrics(page);
    assert.ok(away.bottom > 1 && away.anchor);
    revision = 101;
    await update(page);
    await page.getByRole("button", { name: "New messages" }).waitFor();
    const after = await metrics(page);
    const anchorY = await page.evaluate((key) => [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.dataset.chatRow === key)?.getBoundingClientRect().top, away.anchor.key);
    assert.ok(anchorY !== undefined && Math.abs(anchorY - away.anchor.y) <= 1, JSON.stringify({ away, after, anchorY }));
    await page.evaluate(() => window.chatQa.mount(false));
    await page.locator(".chat-frame").waitFor({ state: "detached" });
    await page.evaluate(() => window.chatQa.mount(true));
    await page.waitForFunction(({ text, y }) => {
      const view = document.querySelector(".chat-view");
      if (!view) return false;
      const top = view.getBoundingClientRect().top;
      const row = [...view.querySelectorAll<HTMLElement>("[data-chat-row]")]
        .filter((row) => row.getBoundingClientRect().bottom > top)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
      return row?.textContent === text && Math.abs(row.getBoundingClientRect().top - y) <= 1;
    }, away.anchor);
    console.log(`PASS ${width} ${theme}: remount restores the same reading turn and pixel offset`);
    const restored = await metrics(page);
    assert.ok(restored.anchor);
    await page.evaluate((height) => window.chatQa.resize(height - 180), height);
    await page.waitForFunction((height) => document.querySelector(".terminal-stack")?.getBoundingClientRect().height === height - 180, height);
    const resizedY = await page.evaluate((key) => [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.dataset.chatRow === key)?.getBoundingClientRect().top, restored.anchor.key);
    assert.ok(resizedY !== undefined && Math.abs(resizedY - away.anchor.y) <= 1, "composer-height change preserves the reading anchor");
    await page.evaluate((height) => window.chatQa.resize(height), height);
    await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
    await settleBottom(page);
    console.log(`PASS ${width} ${theme}: PageUp stays at its anchor through output and explicit latest rearms follow`);

    holdOlder = true;
    const requested = new Promise<void>((resolve, reject) => {
      const received = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { olderEvents.removeEventListener("requested", received); reject(new Error("Older request missing")); }, 10_000);
      olderEvents.addEventListener("requested", received, { once: true });
    });
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = 0; });
    await requested;
    await page.getByText("local E1 ROW-0", { exact: true }).waitFor();
    const beforePrepend = await metrics(page);
    assert.ok(beforePrepend.anchor);
    holdOlder = false;
    olderReleases.splice(0).forEach((release) => release());
    await page.getByRole("button", { name: "Earlier messages", exact: true }).waitFor();
    await page.waitForFunction(({ key, y }) => {
      const row = [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.dataset.chatRow === key);
      return row !== undefined && Math.abs(row.getBoundingClientRect().top - y) <= 1;
    }, beforePrepend.anchor, { timeout: 2000 });
    const prependY = await page.evaluate((key) => [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.dataset.chatRow === key)?.getBoundingClientRect().top, beforePrepend.anchor.key);
    assert.ok(prependY !== undefined && Math.abs(prependY - beforePrepend.anchor.y) <= 1, JSON.stringify({ beforePrepend, prependY, now: await metrics(page) }));
    console.log(`PASS ${width} ${theme}: an accepted older page retains the same row and pixel offset`);

    const points = await page.evaluate(() => {
      const paragraph = (text: string) => [...document.querySelectorAll(".chat-view p")].find((node) => node.textContent === text);
      const edge = (paragraph: Element | undefined, last: boolean) => {
        if (!paragraph) return null;
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        const nodes: Node[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.length) nodes.push(node);
        return last ? nodes.at(-1) ?? null : nodes[0] ?? null;
      };
      const start = edge(paragraph("local E1 ROW-0"), false);
      const end = edge(paragraph("local E1 ROW-1"), true);
      if (!start || !end) throw new Error("Selection paragraphs missing");
      const a = document.createRange(), b = document.createRange();
      a.setStart(start, 0); a.collapse(true);
      b.setStart(end, end.textContent?.length ?? 0); b.collapse(true);
      const first = a.getBoundingClientRect(), last = b.getBoundingClientRect();
      if (!first.height || !last.height) throw new Error(`Invisible drag endpoints: ${JSON.stringify({ first: first.toJSON(), last: last.toJSON(), start: start.textContent, end: end.textContent })}`);
      const points = { a: { x: first.left + 1, y: first.top + first.height / 2 }, b: { x: last.left + 1, y: last.top + last.height / 2 } };
      const hit = (point: { x: number; y: number }) => {
        const element = document.elementFromPoint(point.x, point.y);
        return { element: element?.outerHTML.slice(0, 300), userSelect: element ? getComputedStyle(element).userSelect : null };
      };
      return { ...points, from: hit(points.a), to: hit(points.b) };
    });
    await page.mouse.move(points.a.x, points.a.y);
    await page.mouse.down();
    const down = await selectionState(page);
    await page.mouse.move(points.b.x, points.b.y, { steps: 8 });
    const moved = await selectionState(page);
    await page.mouse.up();
    const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
    assert.ok(selected.includes("ROW-0") && selected.includes("ROW-1") && selected.includes("\n\n"), `native selection includes both rows and blank lines: ${JSON.stringify({ selected, points, down, moved, up: await selectionState(page) })}`);
    assert.deepEqual(selected.split(/\n+/).map((line) => line.trim()).filter(Boolean), ["local E1 ROW-0", "Variable height paragraph.", "local E1 ROW-1"], "the visual range contains exactly its logical rows, not pool-slot order");
    await page.waitForFunction(() => Number(document.querySelector(".chat-view")?.getAttribute("data-chat-pinned")) >= 2);
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.getByText("REVISION-101", { exact: true }).waitFor();
    await settleBottom(page);
    revision = 102;
    await update(page);
    await page.getByText("REVISION-102", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => getSelection()?.toString()), selected, "offscreen selected rows survive immutable output");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selected, "real copy preserves the native multi-row selection");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "0");
    assert.ok((await metrics(page)).mounted < 80);
    console.log(`PASS ${width} ${theme}: native drag selection and real copy survive eviction and streaming; pins release`);

    await reveal(page, "local E1 ROW-123");
    assert.ok((await metrics(page)).mounted < 80);
    await reveal(page, "local E1 ROW--40");
    await shot(page, `reveal-${width}-${theme}`);
    console.log(`PASS ${width} ${theme}: an offscreen row and an unloaded older page are reached by scrolling`);

    const boundarySelection = await page.evaluate(() => {
      const header = document.querySelector(".chat-virtual-header");
      const first = [...document.querySelectorAll(".chat-view p")].find((node) => node.textContent === "local E1 ROW--40");
      if (!header || !first) throw new Error("Boundary selection elements missing");
      const range = document.createRange();
      range.setStart(header, 0); range.setEnd(first, first.childNodes.length);
      getSelection()?.removeAllRanges(); getSelection()?.addRange(range);
      return getSelection()?.toString();
    });
    assert.ok(boundarySelection?.includes("ROW--40"));
    await page.waitForFunction(() => Number(document.querySelector(".chat-view")?.getAttribute("data-chat-pinned")) > 0);
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await settleBottom(page);
    assert.equal(await page.evaluate(() => getSelection()?.toString()), boundarySelection, "selection with an endpoint outside a row survives scrolling");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "0");

    await reveal(page, "local E1 ROW-497");
    const work = page.locator("[data-chat-row]").filter({ hasText: "local E1 ROW-497" });
    await work.locator(".work-block-head").click();
    await work.locator(".work-row-head").click();
    // A click first scrolls its target into view, and rows above measured late can leave this button
    // just below the fold: that scroll is the click's, not the output's.
    await work.locator(".chat-tool-more").scrollIntoViewIfNeeded();
    const beforeOutput = await work.evaluate((row) => row.getBoundingClientRect().top);
    await work.locator(".chat-tool-more").click();
    await work.locator(".chat-tool-io.is-whole").waitFor();
    assert.equal(await work.locator(".chat-tool-io.is-whole").textContent(), WHOLE_OUTPUT);
    assert.ok(Math.abs(await work.evaluate((row) => row.getBoundingClientRect().top) - beforeOutput) <= 1, "opening output does not skip past the expanded work");
    assert.equal(wholeReads, 1);
    const focusButton = work.locator(".work-row-head");
    await focusButton.focus();
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "1");
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await settleBottom(page);
    assert.ok(await focusButton.evaluate((button) => button === document.activeElement), "offscreen focused button stays focused");
    await focusButton.evaluate((button) => button.blur());
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "0");

    // Make the viewport need more containers than the spare pool, so this checks
    // restoration after actual eviction rather than a cached offscreen DOM node.
    await page.setViewportSize({ width, height: 5000 });
    await page.evaluate(() => window.chatQa.resize(5000));
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = 0; });
    await page.waitForFunction(() => ![...document.querySelectorAll("[data-chat-row]")].some((row) => row.textContent?.includes("local E1 ROW-497")));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate((height) => window.chatQa.resize(height), width === 390 ? 844 : 900);
    await reveal(page, "local E1 ROW-497");
    assert.equal(await work.locator(".work-block-head").getAttribute("aria-expanded"), "true");
    assert.equal(await work.locator(".work-row-head").getAttribute("aria-expanded"), "true");
    assert.equal(await work.locator(".chat-tool-io.is-whole").textContent(), WHOLE_OUTPUT);
    assert.equal(wholeReads, 1, "restored output is not fetched again");
    await shot(page, `restored-work-${width}-${theme}`);
    console.log(`PASS ${width} ${theme}: outside-row selection, focused row, disclosures and the whole output survive eviction`);

    await page.reload();
    await page.getByText("REVISION-102", { exact: true }).waitFor();
    await settleBottom(page);
    await page.evaluate(() => window.chatQa.machine("remote"));
    await page.getByText("remote E1 ROW-999", { exact: true }).waitFor();
    assert.ok((await metrics(page)).keys.every((key) => key?.includes('"remote"')), "same-pane remote rows have a separate identity scope");
    console.log(`PASS ${width} ${theme}: another PC does not inherit rows`);
    const remoteRow = page.locator("[data-chat-row]").filter({ hasText: "remote E1 ROW-999" });
    await remoteRow.evaluate((row) => {
      const range = document.createRange(); range.selectNodeContents(row);
      getSelection()?.removeAllRanges(); getSelection()?.addRange(range);
    });
    await page.waitForFunction(() => Number(document.querySelector(".chat-view")?.getAttribute("data-chat-pinned")) > 0);
    epoch = 2;
    await update(page);
    await page.getByText("remote E2 ROW-999", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "0");
    assert.equal(await page.getByText("remote E1 ROW-999", { exact: true }).count(), 0);
    console.log(`PASS ${width} ${theme}: history replacement releases selected old rows`);
    for (const origin of [false, true]) {
      newestStart = 0; beginsAtOrigin = origin; epoch = 1;
      await page.reload();
      await settleBottom(page);
      await reveal(page, "local E1 ROW-497");
      const retained = page.locator("[data-chat-row]").filter({ hasText: "local E1 ROW-497" });
      await retained.locator(".work-block-head").click();
      await retained.locator(".work-row-head").click();
      const identity = await retained.getAttribute("data-chat-row");
      const selectedText = await retained.evaluate((row) => {
        const paragraph = [...row.querySelectorAll("p")].find((p) => p.textContent === "local E1 ROW-497");
        if (!paragraph) throw new Error("Sliding-page selection target missing");
        const range = document.createRange(); range.selectNodeContents(paragraph);
        getSelection()?.removeAllRanges(); getSelection()?.addRange(range);
        return getSelection()?.toString();
      });
      await page.waitForFunction(() => Number(document.querySelector(".chat-view")?.getAttribute("data-chat-pinned")) > 0);
      const y = await retained.evaluate((row) => row.getBoundingClientRect().top);
      const beforeSlide = slideReads;
      newestStart = 2;
      await update(page);
      await page.getByRole("button", { name: "New messages" }).waitFor();
      assert.equal(slideReads, beforeSlide + 1, "a moving newest cursor fills the dropped prefix even before older history was requested");
      assert.equal(await retained.getAttribute("data-chat-row"), identity);
      assert.equal(await page.evaluate(() => getSelection()?.toString()), selectedText);
      assert.equal(await retained.locator(".work-block-head").getAttribute("aria-expanded"), "true");
      assert.equal(await retained.locator(".work-row-head").getAttribute("aria-expanded"), "true");
      assert.ok(Math.abs(await retained.evaluate((row) => row.getBoundingClientRect().top) - y) <= 1, "sliding latest page preserves the logical reading anchor");
      await page.evaluate(() => getSelection()?.removeAllRanges());
      console.log(`PASS ${width} ${theme}: unheld newest cursor slides from ${origin ? "origin" : "a page"} without moving row identity, selection, disclosure or reading anchor`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("chat virtual: initial, streaming, manual follow and row restoration OK");
} catch (error) {
  if (evidence && activePage && !activePage.isClosed()) {
    try { await activePage.screenshot({ path: join(evidence, "chat-virtual-failed.png") }); }
    catch (captureError) { console.error("Chat failure capture:", String(captureError)); }
  }
  throw error;
} finally {
  olderReleases.forEach((release) => release());
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
