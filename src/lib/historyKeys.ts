/**
 * Keys the app's history modules write into history entries' state, shared so one can tell the
 * other's entries without importing it (sheetHistory patches the history when it loads).
 */

/** a phone sheet's own entry (lib/sheetHistory.ts): a push made while it is current replaces it */
export const SHEET_HISTORY_KEY = "ovis:sheet";
/** the sheet's id on the entry it opened over, and on its own: one that takes the sheet's entry over can tell that entry */
export const SHEET_UNDER_KEY = "ovis:sheet-under";

/**
 * Whether a popstate is a closed phone sheet stepping off its own entry, which the browser lands
 * later, and no Back of the user's. sheetHistory answers it and settingsHistory asks: the answer
 * holds whichever of the two hears the event first (in the app sheetHistory loads, and listens, first).
 */
export const sheetStep: { lands: (event: Event) => boolean } = { lands: () => false };
