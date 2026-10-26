import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { parsePiAsk } from "./pi-ask.ts";
import { piAskTabs } from "./pi-ask-tabs.ts";
import { ANSI_RE } from "./shared.ts";
import fixture from "../fixtures/pi-ask-system-theme.json";

// Actual rpiv 2.13.9 in Pi 1.4's system/dark theme. Synthetic data; unlike dark,
// active tabs use neutral/default text; inactive tabs are green (answered) or dim.
const ask = { id: "system-theme-fixture", questions: fixture.questions.map(q => ({ ...q, multiSelect: q.multiSelect ?? false })) };
const state = (name: string) => fixture.states.find(s => s.name === name)!.screen;

describe("Pi system theme and review recovery", () => {
  test.each(fixture.states)("binds the actual current tab, including returning: $name", ({ screen, index }) => {
    const prompt = parsePiAsk(screen, ask);
    expect(prompt).not.toBeNull();
    expect(prompt?.piAskForm?.index).toBe(index);
    expect(prompt?.steps?.findIndex(step => step.current)).toBe(index);
    expect(prompt?.title).toBe(index === 3 ? "Review your answers" : ask.questions[index]!.header);
  });

  test("retains the active marker after real Herdr Windows pane.read ANSI serialization", () => {
    const bar = readFileSync(new URL("../fixtures/pi-ask-system-tab.ansi", import.meta.url), "utf8").trimEnd();
    expect(piAskTabs(bar)?.index).toBe(0);
    expect(piAskTabs(bar.replace(ANSI_RE, ""))?.index).toBeNull();
  });

  test("does not authorize conflicting background and dim selections", () => {
    const bar = state("first").split("\n").find(line => line.includes("✓ Submit"))!;
    const conflicting = bar.replace("\u001b[2m □ 复选保留", "\u001b[48;5;20m\u001b[2m □ 复选保留");
    expect(piAskTabs(conflicting)?.index).toBeNull();
  });

  test.each(["review-empty", "review-incomplete"])("keeps an incomplete review recoverable, never generic keys or partial Submit: %s", name => {
    const parsed = parsePiAsk(state(name), ask)!;
    expect(parsed).not.toBeNull();
    const prompt = parseInteractivePrompt("pi", state(name))!;
    expect(prompt).not.toBeNull();
    expect(prompt.fallback).not.toBe(true);
    expect(prompt.options.map(option => option.label)).toEqual(["Cancel"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
    expect(prompt.steps?.[0]?.can_navigate).toBe(true);
    expect(prompt.answers?.[0]).toEqual({ question: "返回修改", answer: null });
    expect(prompt.body).toBeNull();
  });

  test("renders the full review as Ovis's semantic answer summary rather than terminal prose", () => {
    const prompt = parseInteractivePrompt("pi", state("review"))!;
    expect(prompt.answers).toEqual([
      { question: "返回修改", answer: "最终答案 B" },
      { question: "复选保留", answer: "读取文件, 运行测试" },
      { question: "自定义回改", answer: "中文测试 ✓" },
    ]);
    expect(prompt.body).toBeNull();
    expect(prompt.options.map(option => option.label)).toEqual(["Submit answers", "Cancel"]);
  });
});
