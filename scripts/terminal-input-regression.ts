/** Input lifecycle adversarial cases, using an owned pane and intercepted submits. */
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";

export async function checkTerminalInput(browser: Browser, origin: string, pane: string, otherPane: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await context.addInitScript(() => {
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
  });
  const sent: any[] = [];
  const resizes: any[] = [];
  let acknowledge: (() => void) | undefined;
  let refuse: (() => void) | undefined;
  let ready: (() => void) | undefined;
  let delayReady = false;
  let refuseConnections = false;
  let currentSocket: { close: () => Promise<void> } | undefined;
  // the page's latest connection, to play output the pane did not write (a keyboard mode it asks for)
  let toPage: ((frame: unknown) => void) | undefined;
  // liveness pings held back from the server, so a probe stays in flight until they are let through
  let holdPings = false;
  const heldPings: string[] = [];
  let toServer: ((raw: string) => void) | undefined;
  // the snapshot names what the bridge answers, pings among it; it can follow input-ready by a few ms
  let snapshotSent = false;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    if (refuseConnections) { void socket.close(); return; }
    currentSocket = socket;
    toPage = (frame) => socket.send(JSON.stringify(frame));
    const server = socket.connectToServer();
    toServer = (raw) => server.send(raw);
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (delayReady && frame.type === "input-ready") ready = () => socket.send(raw);
      else socket.send(raw);
      if (frame.type === "snapshot") snapshotSent = true;
    });
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "submit") {
        sent.push(frame);
        acknowledge = () => socket.send(JSON.stringify({ type: "submit-result", id: frame.id, pane_id: frame.pane_id, ok: true }));
        refuse = () => socket.send(JSON.stringify({ type: "submit-result", id: frame.id, pane_id: frame.pane_id, ok: false, code: "agent_blocked", message: "" }));
      } else if (frame.type === "input") sent.push(frame);
      else if (frame.type === "ping" && holdPings) heldPings.push(String(raw));
      else {
        if (frame.type === "resize") resizes.push(frame);
        server.send(raw);
      }
    });
  });
  const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
  // A desktop has no key bar: the input mode is a Settings choice there.
  const setMode = async (mode: "line" | "direct") => {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Terminal");
    await page.getByRole("combobox", { name: "Terminal input mode", exact: true }).selectOption(mode);
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  const remountLine = async () => { await setMode("direct"); await setMode("line"); };
  const until = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) { assert(Date.now() < deadline, "input regression timed out"); await new Promise((r) => setTimeout(r, 25)); }
  };
  try {
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    assert.equal(await page.locator(".key-bar").isVisible(), false, "a desktop shows no key bar under the terminal");
    // a phone keyboard's autocorrect would swap a flag or path for a dictionary word before Send
    assert.deepEqual(await line.evaluate((box) => [box.getAttribute("autocorrect"), box.getAttribute("spellcheck"), box.getAttribute("autocapitalize")]), ["off", "false", "off"]);
    assert.equal(await page.getByRole("button", { name: "Input line", exact: true }).count(), 0);
    await page.locator(".pane-frame.is-current").focus();
    const beforeFocus = sent.length;
    await page.keyboard.press("ControlOrMeta+Shift+E");
    assert.equal(await line.evaluate(node => node === document.activeElement), true, "the input shortcut focuses the terminal line");
    assert.equal(sent.length, beforeFocus, "focus does not submit or send terminal input");

    // A liveness probe refuses input without a frame to say so: on a quiet pane the 1 s poll reads
    // it, so the terminal shows it waits instead of looking ready while typing goes to the draft.
    const waiting = page.locator(".terminal-banner", { hasText: "Waiting for terminal input…" });
    // the banner is drawn only on a connected pane: before the socket opens it is absent too, and
    // a wake then finds nothing to probe
    await page.locator(".conn-live").waitFor();
    await waiting.waitFor({ state: "hidden" });
    // nor does a wake probe before the snapshot has said the bridge answers pings
    await until(() => snapshotSent);
    holdPings = true;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(() => heldPings.length > 0);
    const probeAt = Date.now();
    await waiting.waitFor({ timeout: 2_000 });
    assert(Date.now() - probeAt < 1_800, "the poll reads the refused input within about a second");
    // the pong ends the probe: input reads ready again
    holdPings = false;
    for (const raw of heldPings.splice(0)) toServer!(raw);
    await waiting.waitFor({ state: "hidden", timeout: 2_000 });

    // The line grows over the grid's last rows: neither its growth nor its collapse after Send
    // changes the grid's height, which is the shared pty's size.
    await line.waitFor();
    const gridHeight = () => page.locator(".pane-terminal").evaluate((element) => element.getBoundingClientRect().height);
    const height = (selector: string) => page.locator(selector).evaluate((element) => element.getBoundingClientRect().height);
    const frame = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.evaluate(() => {
      const grid = document.querySelector(".pane-terminal")!;
      (window as any).gridResized = 0;
      let first = true;
      new ResizeObserver(() => { if (first) first = false; else (window as any).gridResized += 1; }).observe(grid);
    });
    await frame();
    const restingGrid = await gridHeight();
    const resizesBefore = resizes.length;
    const restingLine = await height(".terminal-input");
    await line.click();
    await page.keyboard.type("first line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("third line");
    await until(async () => (await line.getAttribute("rows")) === "3");
    await frame();
    assert(await height(".terminal-input") > restingLine + 20, "three lines grow the line");
    if (process.env.UI_EVIDENCE_DIR) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-input-grown.png` });
    }
    assert.equal(await gridHeight(), restingGrid, "a growing input line keeps the grid's height");
    const submitsBefore = sent.length;
    await page.getByRole("button", { name: "Send to the terminal", exact: true }).click();
    await until(() => sent.length > submitsBefore && !!acknowledge);
    assert.equal(sent.at(-1).text, "first line\nsecond line\nthird line");
    const sentPane = sent.at(-1).pane_id;
    acknowledge!();
    await until(async () => (await line.inputValue()) === "" && (await line.getAttribute("rows")) === "1");
    await frame();
    assert.equal(await gridHeight(), restingGrid, "the line's collapse after Send keeps the grid's height");
    assert.equal(await page.evaluate(() => (window as any).gridResized), 0, "the grid's observer never fired");
    assert(Math.abs(await height(".terminal-input") - await height(".terminal-input-slot")) < 1, "a one-row line covers no grid row");
    // what PaneTerminal's observer would have sent comes 120 ms after a change, and none happened
    assert.equal(resizes.length, resizesBefore, "typing three lines and Send send no resize");
    sent.length = 0;
    acknowledge = undefined;

    // a note under the one-row line (a refused send) floats too, and so does its going
    await line.fill("refused");
    await page.getByRole("button", { name: "Send to the terminal", exact: true }).click();
    await until(() => !!refuse);
    refuse!();
    const note = page.locator(".terminal-input-note");
    await note.waitFor();
    await frame();
    assert.equal(await gridHeight(), restingGrid, "a note under the line keeps the grid's height");
    await line.fill("");
    await note.waitFor({ state: "detached" });
    await frame();
    assert.equal(await gridHeight(), restingGrid, "the note's going keeps the grid's height");
    assert.equal(await page.evaluate(() => (window as any).gridResized), 0, "the grid's observer never fired for the note");
    sent.length = 0;
    acknowledge = refuse = undefined;

    // the slot's row is a hand-made calc of the line's metrics: it must match at either density
    const density = await page.evaluate(() => document.documentElement.getAttribute("data-density"));
    await page.evaluate(() => document.documentElement.setAttribute("data-density", "compact"));
    await frame();
    assert(Math.abs(await height(".terminal-input") - await height(".terminal-input-slot")) < 1, "a one-row line covers no grid row at the compact density");
    await page.evaluate((density) => { if (density === null) document.documentElement.removeAttribute("data-density"); else document.documentElement.setAttribute("data-density", density); }, density);

    // a short pane: the grown line reaches the grid's top at most, and its text scrolls past that
    await page.setViewportSize({ width: 1280, height: 160 });
    await frame();
    const surfaceTop = () => page.locator(".terminal-surface").evaluate((element) => element.getBoundingClientRect().top);
    const shortSurface = await height(".terminal-surface");
    assert(shortSurface < 100, `the pane is shorter than a grown line (${shortSurface}px)`);
    await line.fill("one\ntwo\nthree\nfour");
    await until(async () => (await line.getAttribute("rows")) === "4");
    await frame();
    const lineTop = await page.locator(".terminal-input").evaluate((element) => element.getBoundingClientRect().top);
    assert(lineTop >= await surfaceTop() - 1, `the grown line stays under the grid's top (${lineTop} < ${await surfaceTop()})`);
    assert(await line.evaluate((element) => element.scrollHeight > element.clientHeight), "the capped line scrolls its text");
    // the banners stay over the capped line, where it reaches the grid's top: their buttons take the tap
    toPage!({ type: "error", code: "input_failed", pane_id: sentPane, message: "Not sent: test banner" });
    const dismiss = page.locator(".terminal-banners").getByRole("button", { name: "Dismiss", exact: true });
    await dismiss.waitFor();
    const box = (await dismiss.boundingBox())!;
    const lineBox = (await page.locator(".terminal-input").boundingBox())!;
    assert(box.y + box.height / 2 > lineBox.y, "the banner lies within the grown line's box");
    assert(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".terminal-banners"), [box.x + box.width / 2, box.y + box.height / 2]),
      "a banner's button stays above the grown input line");
    await dismiss.click();
    await dismiss.waitFor({ state: "detached" });
    await line.fill("");
    await page.setViewportSize({ width: 1280, height: 800 });
    await until(async () => (await line.getAttribute("rows")) === "1");

    await line.fill("draft 한글 😀");
    await remountLine();
    assert.equal(await line.inputValue(), "draft 한글 😀");
    await page.reload();
    await line.waitFor();
    assert.equal(await line.inputValue(), "draft 한글 😀");
    await page.goto(`${origin}/?pane=${encodeURIComponent(otherPane)}`);
    if (!(await line.isVisible())) await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    assert.equal(await line.inputValue(), "");
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await line.waitFor();
    assert.equal(await line.inputValue(), "draft 한글 😀");

    // `note` is the input line's note locator declared above
    // one read: a note that goes between a count and a textContent would wait out the timeout
    const noteText = () => note.evaluateAll((elements) => elements[0]?.textContent ?? null);
    const sendButton = page.getByRole("button", { name: "Send to the terminal", exact: true });
    // A real composition (Chrome's IME path, as Gboard composes every word): the Send keeps focus,
    // so the tap itself must finish the word, and it sends the committed line at once.
    await line.fill("real 한");
    await line.focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "글", selectionStart: 1, selectionEnd: 1 });
    await until(async () => (await line.inputValue()) === "real 한글");
    // a word committed inside the tap sends with no "Finishing the word…" alert ever mounted
    await page.evaluate(() => {
      (window as any).noteAdded = 0;
      (window as any).noteObserver = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(".terminal-input-note") || node.querySelector(".terminal-input-note"))) (window as any).noteAdded += 1;
        }
      });
      (window as any).noteObserver.observe(document.body, { childList: true, subtree: true });
    });
    await sendButton.click();
    await until(async () => sent.length === 1 || (await noteText()) === "Finish the word, then send.");
    assert.equal(sent.length, 1, "a Send during a real composition finishes the word and sends");
    assert.equal(sent[0].text, "real 한글");
    assert.equal(await line.evaluate((element) => element === document.activeElement), true, "the line keeps focus, so the keyboard stays up");
    await page.waitForTimeout(50); // fixed wait: a committed word may add no note
    assert.equal(await page.evaluate(() => { (window as any).noteObserver.disconnect(); return (window as any).noteAdded; }), 0, "a word committed inside the tap mounts no note");
    await cdp.detach();
    acknowledge!();
    await until(async () => (await line.inputValue()) === "");
    acknowledge = undefined;
    // A keyboard that commits on its own within the wait: the line as committed is sent, once,
    // even when the committing input lands in the same task as compositionend.
    await line.fill("commit 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await note.textContent()) === "Finishing the word…");
    assert.equal(sent.length, 1, "unfinished composition must not submit via button");
    await line.evaluate((element: HTMLTextAreaElement) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "글" }));
      setValue.call(element, "commit 한글");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "글", inputType: "insertFromComposition" }));
    });
    await until(() => sent.length === 2);
    assert.equal(sent[1].text, "commit 한글", "the Send tapped during composition sends the committed line");
    acknowledge!();
    await until(async () => (await line.inputValue()) === "");
    acknowledge = undefined;
    // The preedit is deleted (or the keyboard cancels it) before it commits: the text Send sends
    // nothing, and above all no bare Enter that could accept a prompt's default.
    await line.fill("한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await noteText()) === "Finishing the word…");
    await line.evaluate((element: HTMLTextAreaElement) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      setValue.call(element, "");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteCompositionText" }));
    });
    await page.waitForTimeout(400); // fixed wait: an empty commit may send no Enter
    assert.equal(sent.length, 2, "an empty commit after a text Send sends no Enter");
    assert.equal(await line.inputValue(), "");
    // Compositions that keep chaining after the tap cannot stretch its wait past the deadline.
    await line.fill("chain 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await noteText()) === "Finishing the word…");
    const chainStart = Date.now();
    while (Date.now() - chainStart < 450) {
      await line.evaluate((element: HTMLTextAreaElement) => {
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      });
      await page.waitForTimeout(40);
    }
    // already withdrawn when the chain ends: a wait re-armed per composition would still be open
    assert.equal(await noteText(), "Finish the word, then send.", "the tap's deadline holds through a chain of compositions");
    await line.dispatchEvent("compositionend", { data: "한" });
    await page.waitForTimeout(100); // fixed wait: a chain of compositions past the deadline may send nothing
    assert.equal(sent.length, 2, "a chain of compositions past the deadline sends nothing");
    assert.equal(await noteText(), "Finish the word, then send.");
    // A drop and a quick reconnect while the word is still open withdraw the tap: the later
    // commit sends nothing and the note says why.
    await line.fill("drop 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await noteText()) === "Finishing the word…");
    refuseConnections = true;
    await currentSocket!.close();
    await until(() => sendButton.isDisabled());
    // the withdrawal runs in an effect after the disabled button paints
    await until(async () => (await noteText()) === "Not sent: the terminal is disconnected.");
    refuseConnections = false;
    await until(async () => !(await sendButton.isDisabled()));
    await line.dispatchEvent("compositionend", { data: "한" });
    await page.waitForTimeout(100); // fixed wait: a commit after reconnect may not send the withdrawn tap
    assert.equal(sent.length, 2, "a commit after a drop and reconnect does not send the withdrawn tap");
    assert.equal(await noteText(), "Not sent: the terminal is disconnected.");
    // The terminal drops while the word is still being finished: the commit says so instead of
    // leaving "Finishing the word…" up for good.
    await line.fill("offline 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await note.textContent()) === "Finishing the word…");
    refuseConnections = true;
    await currentSocket!.close();
    await until(() => sendButton.isDisabled());
    await line.dispatchEvent("compositionend", { data: "한" });
    await until(async () => (await noteText()) !== "Finishing the word…");
    assert.equal(await note.textContent(), "Not sent: the terminal is disconnected.");
    assert.equal(sent.length, 2);
    refuseConnections = false;
    await until(async () => !(await sendButton.isDisabled()));
    // No commit within the wait: the tap is withdrawn with a note, and a later commit sends nothing.
    await line.fill("draft 한글 😀");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await note.textContent()) === "Finish the word, then send.");
    await line.dispatchEvent("compositionend", { data: "😀" });
    // past a deferred send's tick and a whole commit window
    await page.waitForTimeout(400);
    assert.equal(sent.length, 2, "a commit after the withdrawn tap does not send");
    assert.equal(await note.textContent(), "Finish the word, then send.");
    await line.dispatchEvent("compositionstart", { data: "" });
    // Leaving during composition must not leave the composition guard stuck.
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await remountLine();
    await line.waitFor();
    await page.getByRole("button", { name: "Send to the terminal", exact: true }).click();
    await until(() => !!acknowledge);
    await remountLine();
    assert.equal(await page.getByRole("button", { name: "Send to the terminal", exact: true }).isDisabled(), true, "pending send survives remount");
    await line.fill("");
    await line.fill("draft 한글 😀");
    acknowledge!();
    await until(async () => !(await page.getByRole("button", { name: "Send to the terminal", exact: true }).isDisabled()));
    assert.equal(await line.inputValue(), "draft 한글 😀", "late ack cannot erase replacement text");
    assert.equal(sent.length, 3);

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    const shortcut = page.getByRole("combobox", { name: "Command palette", exact: true });
    await shortcut.selectOption("p");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    await shortcut.selectOption("off");
    await page.getByRole("combobox", { name: "Next pane", exact: true }).selectOption("p");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await line.focus();
    const selectionBefore = await page.evaluate(() => localStorage.getItem("ovis:selection"));
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await until(async () => (await page.evaluate(() => localStorage.getItem("ovis:selection"))) !== selectionBefore);
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await line.waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    await page.getByRole("button", { name: "Reset shortcuts", exact: true }).click();
    if (process.env.UI_EVIDENCE_DIR) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await shortcut.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-input-settings-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-input-settings-phone.png` });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "settings must fit phone width");
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
    await page.keyboard.press("Escape");

    // A screen can arrive before attachment readiness; do not send or auto-replay typing.
    delayReady = true;
    await setMode("direct");
    await page.reload();
    await page.locator(".xterm-helper-textarea").waitFor();
    await until(() => !!ready);
    const before = sent.length;
    await page.locator(".pane-frame.is-current").focus();
    await page.keyboard.press("ControlOrMeta+Shift+E");
    assert.equal(await page.locator(".xterm-helper-textarea").evaluate(node => node === document.activeElement), true, "the input shortcut also focuses direct terminal input before readiness");
    assert.equal(sent.length, before, "focus sends no input before readiness");
    // the held-input row: the command and its two controls, no sentence (todo 27)
    const heldNotice = page.locator(".pane-frame.is-current .terminal-banner-draft");
    const leftOut = page.getByText("An Enter or line break was left out: Send never presses Enter.", { exact: true });
    // Enter on a terminal that is not ready, with nothing held, separates nothing: no notice.
    // The "a" landing after it proves the Enter was handled first.
    await page.locator(".xterm-helper-textarea").press("Enter");
    await page.locator(".xterm-helper-textarea").press("a");
    await until(async () => (await page.locator(".draft-text").textContent()) === "a");
    assert.equal(await leftOut.count(), 0);
    // Backspace edits what is held; an Enter is never held, but it is told
    await page.locator(".xterm-helper-textarea").press("b");
    await until(async () => (await page.locator(".draft-text").textContent()) === "ab");
    await page.locator(".xterm-helper-textarea").press("Backspace");
    await until(async () => (await page.locator(".draft-text").textContent()) === "a");
    assert.equal(await leftOut.count(), 0);
    await page.locator(".xterm-helper-textarea").press("Enter");
    await leftOut.waitFor();
    await until(async () => (await page.locator(".draft-text").textContent()) === "a ");
    assert.equal(sent.length, before);
    // Exactly the held text must survive reload, not merely later edits, and so must the left-out notice.
    ready = undefined;
    await page.reload();
    await page.locator(".draft-text").waitFor();
    assert.equal(await page.locator(".draft-text").textContent(), "a ");
    await leftOut.waitFor();
    assert.equal(await heldNotice.count(), 1);
    await until(() => !!ready);
    ready!();
    await page.waitForTimeout(150); // fixed wait: ready may not replay the draft
    assert.equal(sent.length, before, "ready does not replay the draft");
    // Held input keeps later typing until Send or Discard, on a ready terminal too: a key sent beside
    // it would reach the pty without the held start, and an Enter would run that partial line. The
    // "b" landing after the Enter proves the Enter was handled first (the Enter folds into the held space).
    await page.locator(".xterm-helper-textarea").press("Enter");
    await page.locator(".xterm-helper-textarea").press("b");
    await until(async () => (await page.locator(".draft-text").textContent()) === "a b");
    assert.equal(sent.length, before, "typing beside a held draft reaches nothing");
    // an interrupt is not typing: it still reaches the program while the draft waits
    await page.locator(".xterm-helper-textarea").press("Escape");
    await until(() => sent.length > before);
    assert.equal(sent.at(-1).text, "\x1b");
    assert.equal(await page.locator(".draft-text").textContent(), "a b");
    const heldNote = "Not sent: send or discard the held input first.";
    const banner = page.locator(".terminal-banner", { hasText: heldNote });
    const dismissBanner = async () => { await banner.getByRole("button", { name: "Dismiss", exact: true }).click(); await banner.waitFor({ state: "hidden" }); };
    const afterEscape = sent.length;
    // Ctrl+Enter under modifyOtherKeys (Claude Code's "send now") carries no line break once encoded:
    // it must still be refused, not run the pty's partial line
    toPage!({ type: "pty-data", pane_id: pane, data: "\x1b[>4;1m" });
    await page.waitForTimeout(100);
    await page.locator(".xterm-helper-textarea").press("Control+Enter");
    await banner.waitFor();
    assert.equal(sent.length, afterEscape, "Ctrl+Enter beside a held draft reaches nothing");
    await dismissBanner();
    toPage!({ type: "pty-data", pane_id: pane, data: "\x1b[>4;0m" });
    // a paste beside a held draft is never sent ahead of the held start: one the draft cannot take is
    // refused with the note, a bracketed one (the shell asks for it) holds its tab as a space
    const pasteIntoTerminal = (text: string) => page.locator(".xterm-helper-textarea").evaluate((element, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    const draftText = () => page.locator(".draft-text").textContent();
    await pasteIntoTerminal("a\tb");
    await until(async () => (await banner.isVisible()) || (await draftText()) === "a ba b");
    assert.equal(sent.length, afterEscape, "a paste with a tab beside a held draft reaches nothing");
    if (await banner.isVisible()) {
      assert.equal(await draftText(), "a b");
      await dismissBanner();
    }
    const beforeMultiLine = await draftText();
    await pasteIntoTerminal("x\ny");
    await until(async () => (await banner.isVisible()) || (await draftText()) !== beforeMultiLine);
    assert.equal(sent.length, afterEscape, "a multi-line paste beside a held draft reaches nothing");
    // never a silent drop: refused with the note, or taken into the draft (a draft that folds line breaks)
    const multiLineNoted = await banner.isVisible();
    assert(multiLineNoted || (await draftText()) !== beforeMultiLine, "a multi-line paste is told or held, never dropped in silence");
    if (multiLineNoted) await dismissBanner();
    // the input line is refused beside a held draft too, with the held-input reason, not "disconnected"
    await setMode("line");
    const lineNote = page.locator(".terminal-input-note");
    await line.fill("");
    await line.press("Enter");
    await until(async () => (await lineNote.textContent()) === heldNote);
    await line.fill("ls");
    await line.press("Enter");
    await until(async () => (await lineNote.textContent()) === heldNote);
    assert.equal(await line.inputValue(), "ls", "a refused line keeps its text");
    assert.equal(sent.length, afterEscape, "the input line beside a held draft reaches nothing");
    await line.fill("");
    await setMode("direct");
    // a draft that takes pastes holds more than "a b" by now: Send types what it holds
    const heldText = await page.locator(".draft-text").textContent();
    await page.getByRole("button", { name: "Send held input", exact: true }).click();
    await until(() => sent.length > before + 1);
    assert.equal(sent.at(-1).text, heldText);
    assert.equal(sent.length, before + 2, "Send types the held text once, with no Enter");
    // Real xterm handling: an IME's provisional syllable stays local until commit.
    const imeBefore = sent.length;
    const input = page.locator(".xterm-helper-textarea");
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      box.value = "한";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
    });
    await page.waitForTimeout(50); // fixed wait: nothing may be sent mid-composition
    assert.equal(sent.length, imeBefore);
    await input.dispatchEvent("compositionend", { data: "한" });
    await until(() => sent.length > imeBefore);
    assert.equal(sent.slice(imeBefore).map((frame) => frame.text).join(""), "한");
    // Native Gboard emits Backspace while xterm retains the previous DOM text. The
    // next IME session must start with a fresh scratch editor, not that stale context.
    await input.evaluate((element) => { const box = element as HTMLTextAreaElement; box.value = "가나다 "; box.setSelectionRange(4, 4); });
    const deletionBefore = sent.length;
    await input.press("Backspace");
    assert.equal(await input.inputValue(), "", "non-composing Backspace resets stale IME context");
    assert.equal(sent.slice(deletionBefore).map((frame) => frame.text).join(""), "\x7f");
    const burstBefore = sent.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "니";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "니" }));
    });
    await page.waitForTimeout(25);
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "니" }));
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "니다";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "다" }));
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "다" }));
      box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ".", code: "Period", keyCode: 190, which: 190 }));
    });
    await page.waitForTimeout(75);
    assert.equal(sent.slice(burstBefore).map((frame) => frame.text).join(""), "니다.", "queued compositions must drain before punctuation (#6089)");

    const movedBefore = sent.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "핫";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "핫" }));
    });
    await page.waitForTimeout(25);
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      // The IME's event can report 핫 even though its final consonant moved to 세.
      box.value = "하";
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "핫" }));
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "하세";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "세" }));
    });
    await page.waitForTimeout(25);
    await input.dispatchEvent("compositionend", { data: "세" });
    await page.waitForTimeout(75);
    assert.equal(sent.slice(movedBefore).map((frame) => frame.text).join(""), "하세", "read corrected DOM text, not stale compositionend.data");
    const switchBefore = sent.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "한";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
    });
    await page.waitForTimeout(25);
    await page.evaluate((target) => {
      const box = document.querySelector(".xterm-helper-textarea")!;
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
      const row = [...document.querySelectorAll<HTMLElement>(".pane-select")].find((row) => row.title.startsWith(target + " —"));
      if (!row) throw new Error("owned destination pane missing");
      row.click();
    }, otherPane);
    await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:selection")!).pane_id)) === otherPane);
    await page.waitForTimeout(75); // fixed wait: the old composition may not send across a pane reset
    assert.equal(sent.length, switchBefore, "old composition cannot cross a pane reset");
    assert.equal(await page.locator(".draft-text").count(), 0, "old commit cannot enter the new pane's held draft");
    // A late end after reset is stale, not a second attempt to send the abandoned input.
    await page.locator(".pane-frame.is-current .xterm-helper-textarea").dispatchEvent("compositionend", { data: "한" });
    await page.waitForTimeout(75); // fixed wait: a late compositionend after the reset may send nothing
    assert.equal(sent.length, switchBefore);
    console.log("PASS xterm composition: local preedit, delayed multi-commit burst, punctuation order, Korean final-consonant movement, pane-reset cancellation");
    assert.deepEqual(errors, []);
    console.log("PASS terminal input: desktop mode, owner drafts, reload, IME button, late ack, shortcuts, readiness, explicit send");
  } finally { await context.close(); }
  await checkKeyBarWhileLineComposes(browser, origin, pane);
}

/** A composition in the input line must not grey out the phone key bar: Esc and ^C go to the pane at once. */
async function checkKeyBarWhileLineComposes(browser: Browser, origin: string, pane: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await context.addInitScript((pane) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
  }, pane);
  const frames: any[] = [];
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => socket.send(raw));
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      // intercepted: the assertions are about what the browser sends, not the PTY
      if (frame.type === "input" || frame.type === "keys" || frame.type === "submit") frames.push(frame);
      else server.send(raw);
    });
  });
  const until = async (check: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) { assert(Date.now() < deadline, `timed out: ${label}`); await new Promise((r) => setTimeout(r, 25)); }
  };
  try {
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    const line = page.locator(".terminal-input-text");
    const esc = page.locator('.key-bar [data-key="Escape"]');
    const interrupt = page.locator('.key-bar [data-key="ctrl-c"]');
    await line.waitFor();
    await until(async () => !(await esc.isDisabled()), "key bar ready");
    await line.fill("fix the");
    await line.dispatchEvent("compositionstart", { data: "" });
    await line.dispatchEvent("compositionupdate", { data: "the" });
    // let React commit any state the composition would set before reading the bar
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await esc.isDisabled(), false, "Esc stays live while the input line composes");
    assert.equal(await interrupt.isDisabled(), false, "^C stays live while the input line composes");
    assert.equal(await page.locator('.key-bar [data-key="Control"]').isDisabled(), false, "Ctrl stays live while the input line composes");
    const before = frames.length;
    await esc.tap();
    await until(() => frames.length > before, "Esc frame");
    await interrupt.tap();
    await until(() => frames.length > before + 1, "^C frame");
    assert.deepEqual(frames.slice(before).map((frame) => [frame.type, frame.text ?? frame.keys]), [["input", "\x1b"], ["input", "\x03"]]);
    assert.equal(await line.inputValue(), "fix the", "the composing line keeps its text");
    // the switch to direct typing would unmount the line mid-composition: it waits
    const direct = page.locator('.key-bar [data-key="direct"]');
    assert.equal(await direct.isDisabled(), true, "the direct-typing toggle waits for the line's composition");
    const sent = frames.length;
    await direct.tap({ force: true });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await line.isVisible(), true, "the input line stays while it composes");
    assert.equal(await line.inputValue(), "fix the", "the composing line keeps its text after the direct tap");
    assert.equal(frames.length, sent, "nothing reaches the pane from the direct tap");
    await line.dispatchEvent("compositionend", { data: "the" });
    await until(async () => !(await direct.isDisabled()), "direct toggle live after the composition");
    assert.deepEqual(errors, []);
    console.log("PASS key bar while the input line composes: Esc and ^C sent, direct toggle waits, line text kept");
  } finally { await context.close(); }
}


if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { chromium } = await import("playwright-core");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "herdr-input-qa-"));
  const owned: string[] = [];
  const server = createServer({ port: 0, stateDir: root, token: "" });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const panes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const made = await workspaceCreate({ cwd: root, label: "ovis-test-input" });
      owned.push(made.workspace.workspace_id); panes.push(made.root_pane.pane_id);
    }
    await checkTerminalInput(browser, `http://127.0.0.1:${server.port}`, panes[0]!, panes[1]!);
  } finally {
    await browser.close(); server.stop();
    for (const id of owned) await workspaceClose(id);
    rmSync(root, { recursive: true, force: true });
  }
}
