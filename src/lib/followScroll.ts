import type { LegendListRef } from "@legendapp/list/react";

/**
 * Whether a follow-the-end scroll glides. Streamed output lands a paragraph at a time; while a
 * turn works, each landing glides to the end instead of snapping. A reader who prefers reduced
 * motion, a settled conversation, and a layout the reader changed by hand (a block opened) all
 * keep the instant scroll so nothing visibly travels.
 */
export function followGlides(input: { working: boolean; reducedMotion: boolean; manualLayout?: boolean }): boolean {
  return input.working && !input.reducedMotion && input.manualLayout !== true;
}

// No row is this object, so the list finds nothing to scroll to.
const NO_ROW = Object.freeze({});
/**
 * The list's scrollToEnd does not scroll at once: it waits for the list's next commit, and then
 * for the layout to settle after a data change (up to 800 ms). A follow asked for while the reader
 * was at the end can so land after the reader paged or scrolled away, and pull them back. Any newer
 * scroll request supersedes a waiting one; a request for no row supersedes it without moving.
 */
export function dropPendingListScroll(list: LegendListRef | null): void {
  void list?.scrollToItem({ item: NO_ROW, animated: false });
}
