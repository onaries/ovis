/**
 * Keys the app's history modules write into history entries' state, shared so one can tell the
 * other's entries without importing it (sheetHistory patches the history when it loads).
 */

/** a phone sheet's own entry (lib/sheetHistory.ts): a push made while it is current replaces it */
export const SHEET_HISTORY_KEY = "ovis:sheet";
/** the sheet's id on the entry it opened over, and on its own: one that takes the sheet's entry over can tell that entry */
export const SHEET_UNDER_KEY = "ovis:sheet-under";
