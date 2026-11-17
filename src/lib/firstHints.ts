/**
 * The three first-start hints (components/FirstStartHints.tsx): armed when the setup guide's first run starts an
 * agent, shown once the workspace is up, and done for good once closed or seen through. Kept in this browser.
 */
export const FIRST_HINTS_KEY = "ovis:first-hints";

type HintsStorage = Pick<Storage, "getItem" | "setItem">;

/** Whether the hints wait to be shown: armed and not yet done. */
export function hintsPending(storage: HintsStorage): boolean {
  try { return storage.getItem(FIRST_HINTS_KEY) === "pending"; } catch { return false; }
}

/** The guide's first run started an agent: the hints come next, unless this browser has had them. */
export function armHints(storage: HintsStorage): void {
  try { if (storage.getItem(FIRST_HINTS_KEY) === null) storage.setItem(FIRST_HINTS_KEY, "pending"); } catch { /* private mode: no hints */ }
}

/** Closed or seen through: never shown again here. */
export function finishHints(storage: HintsStorage): void {
  try { storage.setItem(FIRST_HINTS_KEY, "done"); } catch { /* private mode */ }
}

/**
 * The sidebar's Setup: N left in this browser: "on" once a guide that was begun (past its welcome) closes, "hidden"
 * for good by the row's own close button. Absent, as for a browser that only saw an older guide or chose I've used
 * Ovis before, it never shows.
 */
export const SETUP_ROW_KEY = "ovis:setup-row";

export function setupRowState(storage: Pick<Storage, "getItem">): "on" | "hidden" | null {
  try { const value = storage.getItem(SETUP_ROW_KEY); return value === "on" || value === "hidden" ? value : null; } catch { return null; }
}

/** A begun guide closed: the row may show from now on, unless it was hidden. */
export function setupRowOn(storage: HintsStorage): void {
  try { if (storage.getItem(SETUP_ROW_KEY) === null) storage.setItem(SETUP_ROW_KEY, "on"); } catch { /* private mode: no row */ }
}

export function hideSetupRow(storage: HintsStorage): void {
  try { storage.setItem(SETUP_ROW_KEY, "hidden"); } catch { /* private mode: hidden for this page */ }
}

/** This browser's storage, or null where it is blocked: reading `window.localStorage` itself throws there (Safari with cookies blocked, a sandboxed frame). */
export function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** This browser's user pressed Continue on the setup guide's agent step: only then may the guide read the plan usage. */
export const USAGE_ARMED_KEY = "ovis:setup-usage-armed";
