import type { PaneInfo } from "./herdr-api.generated.ts";

/** The two ways herdr splits a pane: a new pane to its right, or below it. */
export type SplitPaneDirection = "right" | "down";

/** A neighbour's side, for swapping and resizing: herdr's own left/right/up/down. */
export type PaneDirection = "left" | "right" | "up" | "down";

/** POST /api/pane/split: `focus` true moves herdr's focus to the new pane (its --focus); false, the default, leaves it. */
export interface SplitPaneRequest {
  pane_id: string;
  direction: SplitPaneDirection;
  focus?: boolean;
}

/** The pane herdr made, as its snapshot lists it (focused only when `focus` asked for it). */
export interface PaneSplit {
  ok: true;
  pane: PaneInfo;
}

/** POST /api/pane/zoom: a toggle by default; `on` and `off` set the state instead. */
export interface ZoomPaneRequest {
  pane_id: string;
  mode?: "toggle" | "on" | "off";
}

/** `zoomed` is the tab's state after the call; `reason` says why `changed` is false (single_pane, already_zoomed, already_unzoomed). */
export interface PaneZoomed {
  ok: true;
  zoomed: boolean;
  changed: boolean;
  reason: string | null;
}

/** POST /api/pane/focus: focus this exact pane in herdr, including its workspace and tab. */
export interface FocusPaneRequest { pane_id: string }

/** POST /api/pane/swap: exactly one of a neighbouring side or an explicit pane in the same tab. */
export type SwapPaneRequest = { pane_id: string } & (
  | { direction: PaneDirection; target_pane_id?: never }
  | { target_pane_id: string; direction?: never }
);

/** `target_pane_id` is the requested pane or neighbour; unchanged reasons include no_neighbor, same_pane, cross_tab and not_found. */
export interface PaneSwapped {
  ok: true;
  changed: boolean;
  reason: string | null;
  target_pane_id: string | null;
}

/** POST /api/pane/move: the pane leaves its place for `side` of another pane of its own tab, taking half of that pane's. */
export interface MovePaneRequest {
  pane_id: string;
  target_pane_id: string;
  side: PaneDirection;
}

/**
 * `changed` false names why nothing moved: same_pane, or cross_tab for a target in another tab.
 * `changed` true with a reason: the pane moved but stayed right of or below its target, herdr having
 * refused, or failed, the swap that puts it left or above. An error means the pane is not beside its
 * target: its message says it went back into its tab, or where it waits.
 */
export interface PaneMoved {
  ok: true;
  changed: boolean;
  reason: string | null;
}

/**
 * POST /api/pane/resize: the border the pane shares with a neighbour moves `direction`-wards by
 * `amount` of the split that border belongs to, which herdr measures on the split's own extent,
 * not the tab's (0.25 in a 60-column half of a 120-column tab moves the border 15 columns, not
 * 30). herdr caps the amount at 0.5 and holds a split's ratio to 0.1..0.9, so the server refuses
 * more than 0.5 (invalid_amount) rather than let herdr quietly take less; its own 0.05 when
 * absent. Measured on herdr 0.9.3.
 */
export interface ResizePaneRequest {
  pane_id: string;
  direction: PaneDirection;
  amount?: number;
}

/** `changed` false with reason unchanged: no border of the pane could move that way. */
export interface PaneResized {
  ok: true;
  changed: boolean;
  reason: string | null;
}

/** POST /api/layout/ratio: false takes the first branch, true the second; [] names the root split. */
export interface SetSplitRatioRequest {
  tab_id: string;
  path: boolean[];
  /** finite, inclusive 0.1..0.9, the bounds of herdr's split drag */
  ratio: number;
}
