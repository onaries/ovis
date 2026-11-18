/**
 * Kept for where the PC cannot say (the open LAN signs in as no device and gets no delivery record, an older server
 * has no record at all): the setup guide's rule then reads it (lib/setupGuideFlow.ts alertsHere).
 */
import { browserStorage } from "./firstHints.ts";

export const PUSH_CONFIRM_KEY = "ovis:push-confirmed";

type ConfirmStorage = Pick<Storage, "getItem" | "setItem">;

export function recordConfirmation(endpoint: string, sent: boolean, storage: ConfirmStorage | null = browserStorage()): void {
  try { storage?.setItem(PUSH_CONFIRM_KEY, JSON.stringify({ endpoint, sent })); } catch {}
}

export function confirmation(endpoint: string | null, storage: ConfirmStorage | null = browserStorage()): boolean | null {
  if (endpoint === null || storage === null) return null;
  try {
    const value: unknown = JSON.parse(storage.getItem(PUSH_CONFIRM_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return null;
    const { endpoint: kept, sent } = value as { endpoint?: unknown; sent?: unknown };
    return kept === endpoint && typeof sent === "boolean" ? sent : null;
  } catch { return null; }
}
