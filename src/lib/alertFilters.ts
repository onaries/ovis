/**
 * Settings → Alerts: the finer choices of one device, beside Needs input and Finished (lib/settings.ts):
 * whether a permission request and a turn stopped on an error alert it, and which PCs it hears
 * nothing of. They go with its push subscription (shared/notify-policy.ts AlertPrefs), so every PC it
 * subscribes to leaves out what it does not want, and they filter this page's own alerts the same way.
 *
 * Kept in a key of its own, as the hidden PCs are (lib/hiddenMachines.ts), never in ovis:settings: a
 * tab still on an older version rewrites that record whole and would erase a field it does not know.
 * A PC is named by its relay ID where it has one, else its name, never its roster id (shared/machines.ts
 * pcAlertKey): every PC calls itself `local`, and the phone app subscribes to each PC on its own, so
 * the key has to be one the PC's own server knows as well as every roster that lists it.
 */

import { useSyncExternalStore } from "react";
import { pcAlertKey, type Machine } from "../../shared/machines.ts";
import { parseAlertPcs, type AlertPrefs } from "../../shared/notify-policy.ts";

export const ALERT_FILTERS_KEY = "ovis:alert-filters";

export interface AlertFilters {
  /** absent: as Needs input says */
  permission?: boolean;
  /** absent: off */
  error?: boolean;
  /** the PCs this device hears nothing of, by relay ID or name (shared/machines.ts pcAlertKey) */
  pcsOff: string[];
}

/** A stored record: known fields of the right type only. Anything else is the defaults. */
export function parseAlertFilters(raw: string | null): AlertFilters {
  let value: unknown;
  try { value = raw === null ? {} : JSON.parse(raw); } catch { return { pcsOff: [] }; }
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    ...(typeof record["permission"] === "boolean" ? { permission: record["permission"] } : {}),
    ...(typeof record["error"] === "boolean" ? { error: record["error"] } : {}),
    pcsOff: parseAlertPcs(record["pcsOff"]),
  };
}

const listeners = new Set<() => void>();
let cache: { raw: string | null; filters: AlertFilters } = { raw: null, filters: { pcsOff: [] } };
// where storage refuses the write (a full or blocked one), the choice lasts for this page
let unsaved: AlertFilters | null = null;

export function readAlertFilters(): AlertFilters {
  if (unsaved !== null) return unsaved;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(ALERT_FILTERS_KEY); } catch { /* no storage: the defaults */ }
  if (raw !== cache.raw) cache = { raw, filters: parseAlertFilters(raw) };
  return cache.filters;
}

export function updateAlertFilters(patch: Partial<AlertFilters>): void {
  const next = { ...readAlertFilters(), ...patch };
  try {
    window.localStorage.setItem(ALERT_FILTERS_KEY, JSON.stringify(next));
    unsaved = null;
  } catch {
    unsaved = next;
  }
  for (const listener of listeners) listener();
}

function subscribeAlertFilters(listener: () => void): () => void {
  listeners.add(listener);
  // another tab of this browser changed them: this one follows
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== ALERT_FILTERS_KEY && event.key !== null) return;
    unsaved = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => { listeners.delete(listener); window.removeEventListener("storage", onStorage); };
}

/** This device's finer alert choices, kept current across its tabs. */
export function useAlertFilters(): AlertFilters {
  return useSyncExternalStore(subscribeAlertFilters, readAlertFilters, () => cache.filters);
}

/**
 * The PCs turned off, with the relay ID of each one turned off by name before its ID was known (an earlier
 * version, or a PC not yet heard from): its own server knows it by that ID, not by the name another roster
 * gives it. The same list where there is none to add.
 */
export function keyedAlertPcs(pcsOff: string[], machines: readonly Pick<Machine, "name" | "relay" | "server_id">[]): string[] {
  const added = machines.map(pcAlertKey).filter((key, index) => key !== machines[index]!.name && pcsOff.includes(machines[index]!.name) && !pcsOff.includes(key));
  return added.length > 0 ? [...pcsOff, ...new Set(added)] : pcsOff;
}

/** The device's alert choices with the finer ones: what its push subscription carries. */
export function withAlertFilters(prefs: AlertPrefs, filters: AlertFilters): AlertPrefs {
  return {
    ...prefs,
    ...(filters.permission === undefined ? {} : { permission: filters.permission }),
    ...(filters.error === undefined ? {} : { error: filters.error }),
    ...(filters.pcsOff.length > 0 ? { pcs_off: filters.pcsOff } : {}),
  };
}
