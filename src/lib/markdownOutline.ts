import type { InlineNode, MarkdownBlock } from "../../shared/markdown.ts";

type HeadingLevel = Extract<MarkdownBlock, { type: "heading" }>["level"];

/**
 * A heading of a Markdown Preview as its outline lists it. `at` is its place among the document's
 * own headings (the top-level heading blocks, which the Preview draws in this order as the
 * Markdown root's `h3` children), so a heading written twice is two entries with two places.
 */
export interface OutlineEntry {
  level: HeadingLevel;
  text: string;
  at: number;
}

/** The words `nodes` show, for a list entry: formatting dropped, math as written, a picture by its alt text. */
function headingText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": case "code": case "math": return node.value;
      case "image": return node.alt;
      case "strong": case "em": case "del": case "link": case "file": return headingText(node.children);
    }
  }).join("");
}

/** The document's own headings, in order; one with no words to list is left out. */
export function outlineOf(blocks: readonly MarkdownBlock[]): OutlineEntry[] {
  const entries: OutlineEntry[] = [];
  let at = 0;
  for (const block of blocks) {
    if (block.type !== "heading") continue;
    const text = headingText(block.content).replace(/\s+/g, " ").trim();
    if (text !== "") entries.push({ level: block.level, text, at });
    at += 1;
  }
  return entries;
}

/**
 * The heading being read: the last whose top (`tops`, ascending) is at or above `line`. Above the
 * first one the reader is in what leads to it, so it is the first; -1 only with no headings.
 */
export function currentHeading(tops: readonly number[], line: number): number {
  if (tops.length === 0) return -1;
  let current = 0;
  for (const [index, top] of tops.entries()) {
    if (top > line) break;
    current = index;
  }
  return current;
}
