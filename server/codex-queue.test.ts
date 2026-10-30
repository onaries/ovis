import { expect, it } from "bun:test";
import { codexQueueInputEmpty } from "./prompt.ts";
import { codexQueuedMessagePreviews } from "./codex-queue.ts";

const screen = (input: string) => `• Working (2s • esc to interrupt)\n${input}\n  GPT-6.1-Sol high · /workspace\n  ? for shortcuts\n`;

it("reads only visible Codex queue previews and clears them when the queue disappears", () => {
  const queued = "• Working (2s • esc to interrupt)\n• Queued follow-up inputs\n  ↳ first message\n    wrapped line\n  ↳ second message\n    ⇧← edit last queued message\n› Ask Codex to do anything\n  GPT-6.1 Terra high · main\n";
  expect(codexQueuedMessagePreviews(queued)).toEqual(["first message\nwrapped line", "second message"]);
  expect(codexQueuedMessagePreviews(queued.replace("  ↳ first message\n    wrapped line\n  ↳ second message\n    ⇧← edit last queued message\n", ""))).toEqual([]);
  expect(codexQueuedMessagePreviews(queued.replace("    ⇧← edit last queued message\n", ""))).toEqual([]);
  expect(codexQueuedMessagePreviews(queued.replace("› Ask Codex to do anything", "› 1. Yes"))).toEqual([]);
  expect(codexQueuedMessagePreviews(queued.replace("  GPT-6.1 Terra high · main", "  Approval required"))).toEqual([]);
  expect(codexQueuedMessagePreviews(queued.replace("    ⇧← edit last queued message", "  ? 1 question\n    alt+↑ to answer"))).toEqual(["first message\nwrapped line", "second message"]);
});

it("recognizes Ultra's main prompt while retaining placeholder and queued-question guards", () => {
  const live = screen("» Ask Codex to do anything").replace("Sol high", "Sol ultra");
  const colors = live.replace("Ask Codex to do anything", "\x1b[2mAsk Codex to do anything\x1b[0m");
  expect(codexQueueInputEmpty(live, colors)).toBe(true);
  expect(codexQueueInputEmpty(live.replace("» Ask Codex to do anything", "»"))).toBe(true);
  expect(codexQueueInputEmpty(live, live)).toBe(false);
  expect(codexQueueInputEmpty(live.replace("Ask Codex to do anything", "unsent draft"), colors)).toBe(false);
  const waiting = live.replace("»", "• Queued follow-up inputs\n? 1 question · 8s\nalt+↑ to answer\n»");
  expect(codexQueueInputEmpty(waiting, colors)).toBe(false);
});

it("requires the live bottom composer and distinguishes a placeholder from the same typed words", () => {
  expect(codexQueueInputEmpty(screen("›"))).toBe(true);
  const plain = screen("› Ask Codex to do anything");
  expect(codexQueueInputEmpty(plain)).toBe(false);
  expect(codexQueueInputEmpty(plain, screen("› \x1b[2mAsk Codex to do anything\x1b[0m"))).toBe(true);
  expect(codexQueueInputEmpty(plain, plain)).toBe(false);
  expect(codexQueueInputEmpty(plain, screen("› \x1b[38;2;90;90;90mAsk Codex to do anything\x1b[0m"))).toBe(false);
  for (const input of ["› existing draft", "› existing draft\n  ›", "›\n  continued draft", "›\nSelect model", "›\n1. Allow once"]) {
    expect(codexQueueInputEmpty(screen(input))).toBe(false);
  }
  expect(codexQueueInputEmpty(screen("›").replace("Working (2s • esc to interrupt)", "Done"))).toBe(false);
  expect(codexQueueInputEmpty("• Working (2s • esc to interrupt)\n›\n")).toBe(false);
  expect(codexQueueInputEmpty(screen("›") + "Update available\n")).toBe(false);
});

it("recognizes a clipped shortcuts footer and background-terminal status without accepting a draft", () => {
  for (const suffix of ["", " · 1 background terminal", " · 1 background termin…"]) {
    const live = screen("› Ask Codex to do anything")
      .replace("esc to interrupt)", `esc to interrupt)${suffix}`)
      .replace("? for shortcuts", "← for agents · ? for shor  ⚠ 3 warnings · f2 to view");
    const colors = live.replace("Ask Codex to do anything", "\x1b[2mAsk Codex to do anything\x1b[0m");
    expect(codexQueueInputEmpty(live, colors)).toBe(true);
    expect(codexQueueInputEmpty(live.replace("› Ask Codex to do anything", "›"))).toBe(true);
    expect(codexQueueInputEmpty(live, live)).toBe(false);
    expect(codexQueueInputEmpty(live.replace("Ask Codex to do anything", "unsent draft"), colors)).toBe(false);
    expect(codexQueueInputEmpty(live + "Select model\n", colors)).toBe(false);
    expect(codexQueueInputEmpty(live.replace("? for shor", "? for sharing"), colors)).toBe(false);
  }
});

it("recognizes a fast-tier model footer without treating typed placeholder words as empty", () => {
  for (const footer of ["GPT-6.1-Sol high fast · Context 59% left · 1M in · 12K out…", "GPT-6.1-Sol high fast · main · Context 41% left · 1M i…"]) {
    const live = screen("› Ask Codex to do anything").replace("GPT-6.1-Sol high · /workspace", footer);
    const colors = live.replace("Ask Codex to do anything", "\x1b[2mAsk Codex to do anything\x1b[0m");
    expect(codexQueueInputEmpty(live, colors)).toBe(true);
    expect(codexQueueInputEmpty(live.replace("› Ask Codex to do anything", "›"))).toBe(true);
    expect(codexQueueInputEmpty(live, live)).toBe(false);
    expect(codexQueueInputEmpty(live.replace("Ask Codex to do anything", "unsent draft"), colors)).toBe(false);
    expect(codexQueueInputEmpty(live.replace("high fast", "high faster"), colors.replace("high fast", "high faster"))).toBe(false);
    expect(codexQueueInputEmpty(live + "Select model\n", colors)).toBe(false);
  }
});

it("recognizes a two-word Codex model name without accepting typed placeholder words", () => {
  const live = screen("› Ask Codex to do anything")
    .replace("GPT-6.1-Sol high · /workspace", "GPT-6.1 Terra high · main · Context 65% left · 205M in · …");
  const colors = live.replace("Ask Codex to do anything", "\x1b[2mAsk Codex to do anything\x1b[0m");
  expect(codexQueueInputEmpty(live, colors)).toBe(true);
  expect(codexQueueInputEmpty(live, live)).toBe(false);
  expect(codexQueueInputEmpty(live.replace("Ask Codex to do anything", "unsent draft"), colors)).toBe(false);
});

it("queues while a background terminal waits or hooks run, but never over a draft", () => {
  for (const status of [
    "• Waiting for background terminal (9m 59s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    "• Working (1m 18s • esc to interrupt) · Running hooks",
  ]) {
    const live = screen("› Ask Codex to do anything").replace("• Working (2s • esc to interrupt)", status);
    const colors = live.replace("Ask Codex to do anything", "\x1b[2mAsk Codex to do anything\x1b[0m");
    expect(codexQueueInputEmpty(live, colors)).toBe(true);
    expect(codexQueueInputEmpty(live, live)).toBe(false);
    expect(codexQueueInputEmpty(live.replace("Ask Codex to do anything", "user draft"), colors)).toBe(false);
  }
});
