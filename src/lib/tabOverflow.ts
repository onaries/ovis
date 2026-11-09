/** The narrowest a tab in the header's row is drawn (styles.css .header-tabs .tab-strip-item): its name stays readable and its close a small part of it. */
export const TAB_MIN_WIDTH = 120;
/** The More button after the + (styles.css .tab-strip-more), with its gap before it. */
export const TAB_MORE_WIDTH = 56;

/**
 * Which of `count` tabs the header's row draws in `room` pixels, after the + takes `add`: all of
 * them while each fits at its narrowest (the open tab at `openWidth`, wider on a touch screen),
 * else as many as fit beside the More button. The open tab (`open`, its place) and one being
 * renamed (`keep`) are always among them, each in its own place among the others.
 */
export function tabsInRow(count: number, open: number, room: number, add: number, openWidth = TAB_MIN_WIDTH, keep = -1): number[] {
  const all = Array.from({ length: count }, (_, index) => index);
  if ((count - 1) * TAB_MIN_WIDTH + openWidth + add <= room) return all;
  const pinned = new Set(keep >= 0 && keep < count ? [open, keep] : [open]);
  const others = Math.max(0, Math.floor((room - add - TAB_MORE_WIDTH - openWidth) / TAB_MIN_WIDTH) - (pinned.size - 1));
  const first = new Set(all.filter((index) => !pinned.has(index)).slice(0, others));
  return all.filter((index) => pinned.has(index) || first.has(index));
}
