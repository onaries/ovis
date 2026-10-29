import { describe, expect, it } from "bun:test";

import { imageSlotStyle, standaloneImage } from "./imageBox.ts";
import { parseInline, parseMarkdown, type InlineNode } from "../../shared/markdown.ts";

function paragraphLines(source: string, html = false): InlineNode[][] {
  const block = parseMarkdown(source, 0, html)[0];
  if (block?.type !== "paragraph") throw new Error(`not a paragraph: ${JSON.stringify(block)}`);
  return block.lines;
}

describe("standaloneImage", () => {
  it("is an image alone on its line", () => {
    expect(standaloneImage(parseInline("![shot](shot.png)"))).toBe(true);
    expect(standaloneImage(parseInline("  ![shot](shot.png)  "))).toBe(true);
  });
  it("is not a badge in a sentence, two images, text, or a plain link", () => {
    expect(standaloneImage(parseInline("Build: ![ci](ci.svg) passing"))).toBe(false);
    expect(standaloneImage(parseInline("![a](a.png) ![b](b.png)"))).toBe(false);
    expect(standaloneImage(parseInline("just words"))).toBe(false);
    expect(standaloneImage(parseInline("[docs](https://example.dev)"))).toBe(false);
    expect(standaloneImage([])).toBe(false);
  });
  it("is the image inside an HTML paragraph's one link, the folded spaces aside", () => {
    const lines = paragraphLines('<p align="center">\n  <a href="https://example.dev"><img src="logo.png" width="200"></a>\n</p>', true);
    expect(lines).toHaveLength(1);
    expect(standaloneImage(lines[0]!)).toBe(true);
  });
  it("judges each line of a paragraph on its own", () => {
    const lines = paragraphLines("![a](a.png)\nthe caption");
    expect(lines.map(standaloneImage)).toEqual([true, false]);
  });
});

describe("imageSlotStyle", () => {
  it("bounds the slot by the lane and the prose width", () => {
    expect(imageSlotStyle()).toEqual({ maxWidth: "min(100%, 30rem)" });
  });
  it("narrows it to an authored width, never widens it", () => {
    expect(imageSlotStyle(200)).toEqual({ maxWidth: "min(100%, 30rem, 200px)" });
    expect(imageSlotStyle(1600.4)).toEqual({ maxWidth: "min(100%, 30rem, 1600px)" });
  });
  it("ignores a width that is not one", () => {
    expect(imageSlotStyle(0)).toEqual(imageSlotStyle());
    expect(imageSlotStyle(-3)).toEqual(imageSlotStyle());
    expect(imageSlotStyle(Number.NaN)).toEqual(imageSlotStyle());
  });
});
