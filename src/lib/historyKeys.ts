/**
 * Keys the app's history modules write into history entries' state, shared so one can tell the
 * other's entries without importing it (sheetHistory patches the history when it loads).
 */

/** a phone sheet's own entry (lib/sheetHistory.ts): a push made while it is current replaces it */
export const SHEET_HISTORY_KEY = "ovis:sheet";
/** the sheet's id on the entry it opened over, and on its own: one that takes the sheet's entry over can tell that entry */
export const SHEET_UNDER_KEY = "ovis:sheet-under";

/** a file's own entry (lib/useFileViewer.ts) and a repository diff's (lib/repoDiff.ts) */
export const FILE_PREVIEW_KEY = "ovis:file-preview";
export const REPO_DIFF_KEY = "ovis:repo-diff";

export const WEB_PANEL_KEY = "ovis:web-panel";
export const WEB_PANEL_DOCKED_KEY = "ovis:web-panel-docked";
/**
 * how many of the web panel's own entries lie right under this one (a page opened over a page from a
 * phone sheet); a docked file that takes over such a page's entry keeps it (lib/useFileViewer.ts). A
 * copy of a file's or a diff's entry (overCopiedEntry) counts the entries of theirs under it the same way
 */
export const WEB_PANEL_BELOW_KEY = "ovis:web-panel-below";

/** How many of the web panel's own entries lie right under the entry `state` is: closing what holds it goes back past them too. */
export function webPagesBelow(state: Record<string, unknown>): number {
  const below = state[WEB_PANEL_BELOW_KEY];
  return typeof below === "number" && Number.isInteger(below) && below > 0 ? below : 0;
}

/**
 * A phone sheet's entry copies the one it opened over, the web panel's marks included. Once it is an
 * ordinary entry (a reload, Forward onto it after Back closed the sheet), a copy of the panel's entry
 * is one more of the panel's entries over that one, which closing the panel goes back past too (#3058).
 * So is a copy of a docked file's entry that holds the panel's count: closing the file goes past it.
 * With `overlays`, a copy of a file's or a diff's own entry is one more of theirs: closing it goes past
 * the real one, which would show the file or the diff again (#3101). Only where the entry under the
 * copy is still the one it copied (a reload, an address changed on the sheet's entry): after Back off
 * the sheet, another pane may have taken that entry over, and closing must not go past it.
 */
export function overCopiedEntry(state: Record<string, unknown>, overlays: boolean): Record<string, unknown> {
  const owned = state[WEB_PANEL_KEY] !== undefined || state[WEB_PANEL_DOCKED_KEY] === true ||
    (overlays && (state[FILE_PREVIEW_KEY] !== undefined || state[REPO_DIFF_KEY] !== undefined));
  if (!owned && webPagesBelow(state) === 0) return state;
  return { ...state, [WEB_PANEL_BELOW_KEY]: webPagesBelow(state) + 1 };
}

/** A different panel's entry must not inherit the web panel's ownership marks. */
export function withoutWebPanel(state: Record<string, unknown>): Record<string, unknown> {
  const { [WEB_PANEL_KEY]: _page, [WEB_PANEL_DOCKED_KEY]: _docked, [WEB_PANEL_BELOW_KEY]: _below, ...rest } = state;
  return rest;
}

/**
 * Whether a popstate is a closed phone sheet stepping off its own entry, which the browser lands
 * later, and no Back of the user's. sheetHistory answers it and settingsHistory asks: the answer
 * holds whichever of the two hears the event first (in the app sheetHistory loads, and listens, first).
 */
export const sheetStep: {
  lands: (event: Event) => boolean;
  /**
   * Takes over the step back of a closed sheet whose entry `state` is, when that step has not run
   * yet: whoever goes back from there steps over the sheet's entry too. sheetHistory answers it.
   */
  takeLeaving: (state: unknown) => boolean;
} = { lands: () => false, takeLeaving: () => false };
