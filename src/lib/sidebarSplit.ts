/**
 * Where the sidebar's upper list ends and the lower one starts, once the user has dragged the line
 * between them (components/SidebarSplit.tsx): the upper section's height in px, per device, like the
 * sidebar's width (lib/sidebarWidth.ts). The PCs are on top, or Agents while Settings → Group agents by
 * state is on, and each order keeps a height of its own, so one list's height never sizes the other.
 * With none kept, Agents starts at half the shell and can use height a short PCs list leaves (Sidebar.css).
 */
const KEYS: Record<SplitOrder, string> = { pcs: "ovis:sidebar-split", agents: "ovis:sidebar-split-agents-first" };

/** the section on top: the PCs, or Agents while they are grouped by state */
export type SplitOrder = "pcs" | "agents";

/** the tallest upper section a stored value may ask for; a window clamps it far below that */
const MAX_STORED = 10_000;

/**
 * What the line may do in this sidebar, measured at the drag's start: `topHead` and `bottomHead` are
 * the upper and lower section's height folded (its head), `room` the height both sections share,
 * `topRow`/`bottomRow` their minimum list rows, and `row` the keyboard step and snap distance.
 */
export interface SplitRoom { topHead: number; bottomHead: number; room: number; row: number; topRow: number; bottomRow: number }

/** Each section keeps its head and a row when they fit; a short window shares what it has instead. */
export function splitBounds({ topHead, bottomHead, room, topRow, bottomRow }: SplitRoom): { min: number; max: number } {
  const available = Math.max(0, room);
  const heads = topHead + bottomHead;
  const scale = heads > 0 ? Math.min(1, available / heads) : 1;
  const rows = topRow + bottomRow;
  const rowScale = rows > 0 ? Math.min(1, Math.max(0, available - heads) / rows) : 0;
  return { min: topHead * scale + topRow * rowScale, max: available - bottomHead * scale - bottomRow * rowScale };
}

export function clampSplit(height: number, room: SplitRoom): number {
  const { min, max } = splitBounds(room);
  return Math.round(Math.max(min, Math.min(max, height)));
}

/** The upper section's share of the room for the separator's `aria-valuenow`, held to its 0-100 range. */
export function splitPercent(height: number, room: number): number {
  return room > 0 ? Math.round(Math.max(0, Math.min(100, height / room * 100))) : 0;
}

/** a section by name, for the folds its caret makes */
export type SplitFold = "pcs" | "agents";

/** a section by its place: the one above the line, or the one under it */
export type SplitSide = "top" | "bottom";

/** the section at `side` while `order` is on top */
export function sectionAt(side: SplitSide, order: SplitOrder): SplitFold {
  return (side === "top") === (order === "pcs") ? "pcs" : "agents";
}

/**
 * The side a drag folds when let go here: one dragged under about a row folds to its head, as
 * VS Code's views and a macOS split view's panes do past their minimum. Null keeps both open.
 */
export function splitSnap(height: number, { topHead, bottomHead, room, row }: SplitRoom): SplitSide | null {
  const slack = row * 0.6;
  const top = height < topHead + slack;
  const bottom = height > room - bottomHead - slack;
  if (top && bottom) return Math.abs(height - topHead) <= Math.abs(room - bottomHead - height) ? "top" : "bottom";
  return top ? "top" : bottom ? "bottom" : null;
}

/**
 * A drag released at `raw`: the side it folds, the height it saves, and the height to draw meanwhile, which
 * is the saved one (a snapping section is drawn at its head), so a release never jumps.
 */
export function splitDrag(raw: number, room: SplitRoom): { snap: SplitSide | null; height: number; shown: number } {
  const snap = splitSnap(raw, room);
  const height = clampSplit(raw, room);
  return { snap, height, shown: snap === "top" ? room.topHead : snap === "bottom" ? room.room - room.bottomHead : height };
}

/** What a key does on the focused line: move it a row, fold a section, or go back to the shared height. */
export type SplitKey = { split: number } | { fold: SplitSide } | { reset: true };

export function keyedSplit(current: number, key: string, room: SplitRoom): SplitKey | null {
  if (key === "ArrowUp") return { split: clampSplit(current - room.row, room) };
  if (key === "ArrowDown") return { split: clampSplit(current + room.row, room) };
  if (key === "Home") return { fold: "top" };
  if (key === "End") return { fold: "bottom" };
  if (key === "Enter") return { reset: true };
  return null;
}

/** The stored value as a height, or null when nothing usable is stored (the shared height applies). */
export function parseSidebarSplit(stored: string | null): number | null {
  if (stored === null || !/^\d+$/.test(stored)) return null;
  const height = Number(stored);
  return height > 0 && height <= MAX_STORED ? height : null;
}

export function storedSidebarSplit(order: SplitOrder): number | null {
  try {
    return parseSidebarSplit(window.localStorage.getItem(KEYS[order]));
  } catch {
    return null;
  }
}

/** null forgets the choice: the lists go back to their default allocation. */
export function storeSidebarSplit(order: SplitOrder, height: number | null): void {
  try {
    if (height === null) window.localStorage.removeItem(KEYS[order]);
    else window.localStorage.setItem(KEYS[order], String(Math.round(Math.max(1, Math.min(MAX_STORED, height)))));
  } catch {
    /* private mode: the split is not remembered */
  }
}
