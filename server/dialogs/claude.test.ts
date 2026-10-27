import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { answerKeys, claudeRewindOpen, parseInteractivePrompt } from "../prompt.ts";

const fixture = (state: string, width: number): string =>
  readFileSync(new URL(`../fixtures/claude-goal-2.1.304-${state}-${width}.txt`, import.meta.url), "utf8");

/** Claude Code 2.1.304's /rewind, recorded over a resumed apple/banana session (fixtures named by state and width) */
const rewind = (state: string, width: number): string =>
  readFileSync(new URL(`../fixtures/claude-rewind-2.1.304-${state}-${width}.txt`, import.meta.url), "utf8");

describe("Claude Code's terminal rewind", () => {
  test("does not block sends for a quoted panel above Claude's input box", () => {
    expect(claudeRewindOpen(`${rewind("confirm-apple-restore", 40)}\n${rewind("closed", 40)}`)).toBe(false);
  });

  test("holds sends when an earlier input box is above the live rewind panel", () => {
    expect(claudeRewindOpen(`${rewind("closed", 40)}\n${rewind("confirm-apple-summarize-from", 40)}`)).toBe(true);
  });

  for (const width of [40, 120]) {
    test(`protects terminal rewind fields without offering cards at ${width} columns`, () => {
      for (const state of ["confirm-apple-restore", "confirm-apple-summarize-from", "confirm-apple-summarize-up-to", "confirm-apple-never-mind", "confirm-apple-restore-esc", "confirm-apple-summarize-from-esc", "confirm-long-610"]) {
        const screen = rewind(state, width);
        expect(claudeRewindOpen(screen), state).toBe(true);
        expect(parseInteractivePrompt("claude", screen), state).toBeNull();
      }
      expect(claudeRewindOpen(rewind("confirm-apple-esc-esc", width))).toBe(false);
    });
  }

  test("protects the rewind's message list, the screen it opens on, without offering a card", () => {
    const screen = rewind("select-banana", 40);
    expect(claudeRewindOpen(screen)).toBe(true);
    expect(parseInteractivePrompt("claude", screen)).toBeNull();
  });
});

describe("Claude Code's bare /goal", () => {
  for (const width of [40, 120]) {
    test(`reads the goal dialog with a goal at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", fixture("active", width));
      expect(prompt?.title).toBe("Goal active");
      expect(prompt?.question).toBe("the file hello.txt exists in the project directory");
      expect(prompt?.body).toMatch(/^running \d+s · 0 tokens$/);
      expect(prompt?.options.map((option) => option.label)).toEqual(["Close"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
      // the bridge's own words go as keys the client translates (#1482); the goal and its status are Claude's
      expect(prompt?.own_text).toEqual({ title: { key: "Goal active" }, labels: { 0: { key: "Close" } } });
    });

    test(`reads the goal dialog without a goal at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", fixture("none", width));
      expect(prompt?.title).toBe("Goal");
      expect(prompt?.question).toBe("No goal set");
      expect(prompt?.body).toBeNull();
      expect(prompt?.options.map((option) => option.label)).toEqual(["Close"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
      expect(prompt?.own_text).toEqual({ title: { key: "Goal" }, question: { key: "No goal set" }, labels: { 0: { key: "Close" } } });
    });
  }

  test("a card for the same goal keeps its identity while the elapsed time ticks", () => {
    const shown = fixture("active", 120);
    const later = shown.replace(/running \d+s/, "running 4m 12s");
    expect(later).not.toBe(shown);
    expect(parseInteractivePrompt("claude", later)?.id).toBe(parseInteractivePrompt("claude", shown)?.id);
  });

  test("keeps the id an earlier bridge gave the card, so an answer to a card read before an update still lands (#1482)", () => {
    // the id main's bridge gave this card before its words went as keys (own_text is not part of it)
    expect(parseInteractivePrompt("claude", fixture("none", 120))?.id).toBe("d4c74b031221");
  });

  test("a different goal is a different card", () => {
    const shown = fixture("active", 120);
    expect(parseInteractivePrompt("claude", shown.replaceAll("hello.txt", "other.txt"))?.id).not.toBe(parseInteractivePrompt("claude", shown)?.id);
  });

  test("a running row that is not the recorded shape gets no card", () => {
    const shown = fixture("active", 120);
    for (const row of ["running a new unrecorded status", "running 25s", "running 25s · 0 tokens left", "running soon · 0 tokens"]) {
      expect(parseInteractivePrompt("claude", shown.replace(/running \d+s · 0 tokens/, row)), row).toBeNull();
    }
    expect(parseInteractivePrompt("claude", shown.replace(/running \d+s · 0 tokens/, "running 1h 2m 3s · 1,204 tokens"))?.title).toBe("Goal active");
  });

  test("a layout the dialog does not draw gets no card", () => {
    const shown = fixture("active", 120);
    expect(parseInteractivePrompt("claude", shown.replace("◎ Goal active", "◎ Goal achieved"))).toBeNull();
    expect(parseInteractivePrompt("claude", shown.replace("Esc to dismiss", "Esc to dismiss\n\n   Clear goal"))).toBeNull();
    expect(parseInteractivePrompt("claude", `${shown}\n❯ hello`)).toBeNull();
    expect(parseInteractivePrompt("claude", fixture("none", 120).replace("No goal set", "Goal paused"))).toBeNull();
  });
});

describe("Claude's question beside its fullscreen diff panel", () => {
  // live-captured from Claude Code 2.1.303 (`"tui": "fullscreen"`, /diff shown) in a 180x52 pane, the
  // session's text reworded: every row carries the panel's left edge in column 99 and the panel's own text after it
  const panel = (state: string) => readFileSync(new URL(`../fixtures/claude-diff-panel-2.1.303-${state}-180.txt`, import.meta.url), "utf8");
  const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);

  test("reads one question with long Korean descriptions, the panel's text left out", () => {
    const prompt = parseInteractivePrompt("claude", panel("one-korean"));
    expect(prompt).toMatchObject({
      kind: "question", title: "메뉴", question: "사이드바 메뉴를 어떻게 처리할까요?", custom_option_index: 3,
      options: [
        { label: "항상 펼쳐 두기", description: "사이드바를 화면 왼쪽에 고정해서 늘 펼쳐 둡니다. 메뉴 항목을 한눈에 볼 수 있어 찾기 쉽지만, 본문 영역이 그만큼 좁아집니다." },
        { label: "접이식으로 만들기" },
        { label: "상단 메뉴로 옮기기" },
      ],
    });
    expect(answerKeys(prompt!, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt!, { custom_text: "직접 입력" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { text: "직접 입력" }, { keys: ["enter"] },
    ]);
  });

  test("reads each of two questions and the review, with the panel's changes on screen", () => {
    const first = parseInteractivePrompt("claude", panel("two-first"));
    expect(first).toMatchObject({ kind: "question", title: "Scope · 1 of 2", question: "How far should the change go?", custom_option_index: 3 });
    expect(labels(first)).toEqual(["Only a.txt", "All modified files", "Whole repository"]);
    expect(answerKeys(first!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    const second = parseInteractivePrompt("claude", panel("two-second"));
    expect(second).toMatchObject({ kind: "question", title: "Tests · 2 of 2", question: "Add a regression test?", custom_option_index: 2 });
    expect(labels(second)).toEqual(["Add", "Skip"]);
    expect(answerKeys(second!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    const review = parseInteractivePrompt("claude", panel("two-review"));
    expect(review).toMatchObject({
      kind: "menu", title: "Review your answers", question: "Ready to submit your answers?",
      answers: [{ question: "How far should the change go?", answer: "Only a.txt" }, { question: "Add a regression test?", answer: "Skip" }],
    });
    expect(labels(review)).toEqual(["Submit answers", "Cancel"]);
  });

  test("reads short English options", () => {
    const prompt = parseInteractivePrompt("claude", panel("english"));
    expect(prompt).toMatchObject({ kind: "question", title: "Color", question: "Which color?", custom_option_index: 3 });
    expect(prompt?.options).toEqual([
      { label: "Red", description: "A warm, bold color." },
      { label: "Green", description: "A calm, natural color." },
      { label: "Blue", description: "A cool, steady color." },
    ]);
  });

  test("keeps a plan's table whole when no panel is beside it", () => {
    // a markdown table scrolled above the plan's top border: a `│` in one column on the first rows only
    const table = Array.from({ length: 8 }, (_, row) => `${`Task ${row}`.padEnd(40)}│ preserve requirement ${row}`);
    const screen = [
      ...table,
      "Claude has written up a plan and is ready to execute. Would you like to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "  3. Tell Claude what to change",
      "ctrl+g to edit",
    ].join("\n");
    const prompt = parseInteractivePrompt("claude", screen);
    expect(prompt).not.toBeNull();
    for (let row = 0; row < 8; row += 1) expect(JSON.stringify(prompt), `row ${row}`).toContain(`preserve requirement ${row}`);
  });

  test("finds the panel's edge past a table divider that stops above the question", () => {
    // a table scrolled to the top of the session, its divider left of the panel's edge in column 99
    const lines = panel("english").split("\n");
    for (let row = 0; row < 8; row += 1) lines[row] = `${`Task ${row}`.padEnd(40)}${"\u2502 preserve requirement".padEnd(59)}\u2502`;
    const prompt = parseInteractivePrompt("claude", lines.join("\n"));
    expect(prompt).toMatchObject({ kind: "question", title: "Color", question: "Which color?" });
    expect(labels(prompt)).toEqual(["Red", "Green", "Blue"]);
  });

  test("an answered question beside the panel is not read as open", () => {
    // later output in the hint's place, the panel's edge still beside it
    const hint = "Enter to select · ↑/↓ to navigate · Esc to cancel";
    expect(parseInteractivePrompt("claude", panel("english").replace(hint, "● Done.".padEnd(hint.length)))).toBeNull();
  });
});
