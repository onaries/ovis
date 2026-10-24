import { describe, expect, test } from "bun:test";
import { appendQuote, formatReplyQuote, formatTerminalQuote, quoteHeading, quotedText } from "./terminalQuote.ts";

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

describe("reply quote", () => {
  test("reply quote uses selected visible text", () => {
    // the browser's selection text, as a copy carries it: indentation kept, no markdown rebuilt
    expect(formatReplyQuote("\n\nDone. Retries are now safe:\r\n\nconst cached = await lookup(key);\n  if (cached) return;\n"))
      .toBe("From your reply:\n```\nDone. Retries are now safe:\n\nconst cached = await lookup(key);\n  if (cached) return;\n```");
    // a plain label: no line numbers or range are made up for a reply
    expect(formatReplyQuote("one line")!.split("\n")[0]).toBe("From your reply:");
    expect(formatReplyQuote(" \n\t\r\n")).toBeNull();
  });

  test("fence survives nested backticks", () => {
    const block = formatReplyQuote("Use:\n```ts\nrun()\n```\nor `````raw`````")!;
    expect(block).toBe("From your reply:\n``````\nUse:\n```ts\nrun()\n```\nor `````raw`````\n``````");
    // inline backticks shorter than a fence leave the plain fence
    expect(formatReplyQuote("call `run` twice")).toBe("From your reply:\n```\ncall `run` twice\n```");
  });
});
