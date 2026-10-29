import type { InlineNode, MarkdownBlock } from "../../shared/markdown.ts";

/** How the viewer shows a text file: chosen in its header, Preview unless the user asked for the source. */
export type TextViewMode = "preview" | "code";

/** Whether a file in `language` has a rendered Preview besides its source: Markdown does. */
export function hasPreview(language: string | null): boolean {
  return language === "markdown";
}

/**
 * How many elements a Preview may draw. Its parse runs in a worker, but drawing is on the page: in
 * Chromium a list of 65 536 items (about 131 000 elements) held it for 1.6 s, about 12 µs an
 * element. It bounds the whole Preview's memory and work; no single task draws it all, since the
 * viewer adds it a chunk at a time (PREVIEW_CHUNK_ELEMENTS). A file past it opens as its source, "Too
 * long to preview".
 */
export const PREVIEW_ELEMENT_LIMIT = 60_000;

/**
 * The elements a math expression draws: KaTeX lays out a few spans for each character of its source
 * (about 4 in its markup), however short the formula reads.
 */
const MATH_ELEMENTS_PER_CHAR = 5;

/**
 * How many elements inline nodes draw, never fewer than `Markdown.tsx` draws: plain text is a span
 * with a button for each path in it (a path has a `/`, so its slashes bound them), code a `<code>`
 * that may be a path's button, and math its KaTeX.
 */
function inlineElements(nodes: readonly InlineNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === "text") count += 1 + node.value.split("/").length - 1;
    else if (node.type === "code") count += 2;
    else if (node.type === "math") count += 1 + node.value.length * MATH_ELEMENTS_PER_CHAR;
    else if (node.type === "image") count += 2 + inlineElements(node.fallback);
    else count += 1 + inlineElements(node.children);
  }
  return count;
}

/**
 * At least how many elements `blocks` draw as a Preview: each block, line, list item (a task's box
 * and its tick too) and table row and cell with its inline elements, a code block as the lines it
 * shows folded (at most 30), and a math block as its KaTeX.
 */
export function previewElements(blocks: readonly MarkdownBlock[]): number {
  // the Preview's own `.markdown` box
  return 1 + blockElements(blocks);
}

/**
 * How many elements a Preview draws in one task. The whole Preview at once is one task proportional
 * to the file: 256 KB of ordinary notes (about 30 000 elements) held a CI runner's page past a
 * second. A chunk this size is about 25 ms on a desktop, and the Preview fills in one per task.
 */
export const PREVIEW_CHUNK_ELEMENTS = 2_000;

/**
 * `blocks` in runs of whole top-level blocks of at most `limit` elements each (a block larger than
 * the limit is a run of its own), in order; nothing is dropped and no block is split.
 */
export function previewChunks(blocks: readonly MarkdownBlock[], limit = PREVIEW_CHUNK_ELEMENTS): MarkdownBlock[][] {
  const chunks: MarkdownBlock[][] = [];
  let chunk: MarkdownBlock[] = [];
  let size = 0;
  for (const block of blocks) {
    const elements = blockElements([block]);
    if (chunk.length > 0 && size + elements > limit) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(block);
    size += elements;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function blockElements(blocks: readonly MarkdownBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    count += 1;
    if (block.type === "heading") count += inlineElements(block.content);
    else if (block.type === "paragraph") for (const line of block.lines) count += 2 + inlineElements(line);
    else if (block.type === "list") for (const item of block.items) count += 1 + (item.checked === undefined ? 0 : 4) + inlineElements(item.content) + blockElements(item.blocks ?? []);
    else if (block.type === "blockquote") count += blockElements(block.blocks);
    else if (block.type === "table") {
      count += 3;
      for (const row of [block.header, ...block.rows]) { count += 1; for (const cell of row) count += 1 + inlineElements(cell); }
    }
    else if (block.type === "code") count += Math.min(30, block.value.split("\n").length);
    else if (block.type === "math") count += block.value.length * MATH_ELEMENTS_PER_CHAR;
  }
  return count;
}
