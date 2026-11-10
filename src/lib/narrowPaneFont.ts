/** The width full-screen programs expect at least (btop refuses to draw under it). */
export const NARROW_PANE_COLS = 80;

/**
 * The font a split pane draws at: the user's chosen size, never shrunk automatically when a
 * split narrows below 80 columns (the pane's zoom action widens it when a program needs 80 columns).
 */
export function narrowPaneFontSize(base: number, _colsAt?: (size: number) => number | null): number {
  return base;
}
