import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
    });

    test(`reads the goal dialog without a goal at ${width} columns`, () => {
      const prompt = parseInteractivePrompt("claude", fixture("none", width));
      expect(prompt?.title).toBe("Goal");
      expect(prompt?.question).toBe("No goal set");
      expect(prompt?.body).toBeNull();
      expect(prompt?.options.map((option) => option.label)).toEqual(["Close"]);
      expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["esc"] }]);
    });
  }

  test("a card for the same goal keeps its identity while the elapsed time ticks", () => {
    const shown = fixture("active", 120);
    const later = shown.replace(/running \d+s/, "running 4m 12s");
    expect(later).not.toBe(shown);
    expect(parseInteractivePrompt("claude", later)?.id).toBe(parseInteractivePrompt("claude", shown)?.id);
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
