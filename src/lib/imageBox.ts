import type { InlineNode } from "../../shared/markdown.ts";

/**
 * An image's box before it decodes (components/Markdown.tsx `ReservedImage`). A bare <img> is zero
 * height until its bytes arrive, so the row around it moves when the picture lands and again if it
 * fails and its alt text takes its place. A standalone image holds a slot instead, sized here.
 * Adapted from t3code's ChatMarkdown.
 */

/** A picture in prose: as wide as the lane, up to this (t3code's bound), unless the author said narrower. */
const SLOT_MAX_REM = 30;

/**
 * Whether a line is one image and nothing else (a screenshot, a README's logo; alone or inside one
 * link, spaces aside): such an image holds a 16:9 slot while it decodes. A badge in a sentence does
 * not: a slot taller than the badge would move the page more than the badge does.
 */
export function standaloneImage(nodes: InlineNode[]): boolean {
  const shown = nodes.filter((node) => node.type !== "text" || node.value.trim() !== "");
  const node = shown.length === 1 ? shown[0]! : null;
  if (node === null) return false;
  return node.type === "image" || (node.type === "link" && standaloneImage(node.children));
}

/** The slot's width bound: the lane, `SLOT_MAX_REM`, and an authored `<img width>` when there is one. */
export function imageSlotStyle(width?: number): { maxWidth: string } {
  const bounds = ["100%", `${SLOT_MAX_REM}rem`];
  if (width !== undefined && Number.isFinite(width) && width > 0) bounds.push(`${Math.round(width)}px`);
  return { maxWidth: `min(${bounds.join(", ")})` };
}
