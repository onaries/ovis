/**
 * What this browser's last Turn on alerts came to, for the subscription it made: whether its confirmation push got
 * through. Kept for where the PC cannot say (the open LAN signs in as no device and gets no delivery record, an older
 * server has no record at all): the setup guide's rule then reads it (lib/setupGuideFlow.ts alertsHere).
 */
import { browserStorage } from "./firstHints.ts";

export const PUSH_CONFIRM_KEY = "ovis:push-confirmed";

type ConfirmStorage = Pick<Storage, "getItem" | "setItem">;

/** Records whether the confirmation push to `endpoint` got through. */
export function recordConfirmation(endpoint: string, sent: boolean, storage: ConfirmStorage | null = browserStorage()): void {
  try { storage?.setItem(PUSH_CONFIRM_KEY, JSON.stringify({ endpoint, sent })); } catch { /* storage refused: nothing kept */ }
}

/** Whether the confirmation push to `endpoint` got through: null when none was recorded for it (made before this was kept, or elsewhere). */
export function confirmation(endpoint: string | null, storage: ConfirmStorage | null = browserStorage()): boolean | null {
  if (endpoint === null || storage === null) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(PUSH_CONFIRM_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { endpoint: kept, sent } = value as { endpoint?: unknown; sent?: unknown };
    return kept === endpoint && typeof sent === "boolean" ? sent : null;
  } catch { return null; }
}
