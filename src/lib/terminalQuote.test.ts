import { describe, expect, test } from "bun:test";
import { appendQuote, formatTerminalQuote, quoteHeading, quotedText } from "./terminalQuote.ts";

describe("terminal quote", () => {
  test("names the pane and counts lines from 1", () => {
    expect(quoteHeading("build", { start: 11, end: 14 })).toBe("build lines 12-15");
    expect(quoteHeading("build", { start: 3, end: 3 })).toBe("build line 4");
    expect(quoteHeading("build", null)).toBe("build");
  });

  test("an empty selection quotes nothing", () => {
    expect(quotedText("\n  \r\n")).toBeNull();
    expect(formatTerminalQuote({ label: "a", range: null, text: "\n\n" })).toBeNull();
  });

  test("formats a fenced block with normalized line breaks", () => {
    expect(formatTerminalQuote({ label: " my  pane ", range: { start: 0, end: 1 }, text: "\n\nerr\r\nat x\n" }))
      .toBe("my pane lines 1-2:\n```\nerr\nat x\n```");
  });

  test("a fence inside the text cannot close the quote", () => {
    const block = formatTerminalQuote({ label: "p", range: null, text: "a\n```\nb" })!;
    expect(block).toBe("p:\n````\na\n```\nb\n````");
  });

  test("appends after the draft with a blank line, and refuses past the limit", () => {
    expect(appendQuote("", "Q", 100)).toBe("Q\n");
    expect(appendQuote("why?", "Q", 100)).toBe("why?\n\nQ\n");
    expect(appendQuote("why?\n", "Q", 100)).toBe("why?\n\nQ\n");
    expect(appendQuote("why?\n\n", "Q", 100)).toBe("why?\n\nQ\n");
    expect(appendQuote("why?", "Q", 5)).toBeNull();
  });
});
