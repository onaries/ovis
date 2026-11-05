import { useEffect, useRef, useState } from "react";
import type { SystemReport } from "../../shared/system.ts";
import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { ApiError, fetchSystem } from "./api.ts";
import { usePageVisible } from "./visibility.ts";

/** the pause between one answer and the next ask for a PC that is on screen; the server shares one reading between asks closer than 1.5 s */
export const SYSTEM_POLL_MS = 5000;
/** an ask that has not come back by now is given up, so a stuck PC never has more than one open */
export const SYSTEM_ASK_TIMEOUT_MS = 4000;
/** a reading this old, with every ask since failing, is no longer shown as the PC's load */
export const SYSTEM_STALE_MS = 60_000;
/**
 * This PC cannot say, and asking again will not change that until its bridge does. A bridge from
 * before the route answers 404; one that has a browser token set refuses what its allowlist does
 * not know with 401 or 403. For the PC this browser talks to itself, 401 means signed out, which
 * is not a reason to stop asking.
 */
export function systemUnavailable(error: unknown, machineId: string): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404 || error.status === 405) return true;
  return machineId !== LOCAL_MACHINE && (error.status === 401 || error.status === 403);
}

export interface SystemState {
  report: SystemReport | null;
  /** the PC cannot say (a bridge from before this route): the sidebar shows nothing for it */
  unavailable: boolean;
}

/**
 * The load of one PC, while `enabled` (its line is on screen) and the page is visible. The next ask starts
 * SYSTEM_POLL_MS after the last one came back or timed out, so a stuck PC holds one request open,
 * never a queue of them. Nothing is
 * asked for a PC that is folded, offline or in a background tab. A PC whose bridge cannot answer
 * is not asked again until `retryKey` changes (its bridge was updated, or it reconnected). A reading
 * that no ask has renewed for SYSTEM_STALE_MS is dropped rather than shown as now.
 */
export function useSystemStats(machineId: string, enabled: boolean, retryKey: string): SystemState {
  const [state, setState] = useState<SystemState>({ report: null, unavailable: false });
  const visible = usePageVisible();
  const missing = useRef<string | null>(null);
  const answeredAt = useRef(0);

  useEffect(() => {
    if (!enabled || !visible || missing.current === retryKey) return;
    // back on screen after a while: a reading that has aged out is not shown again while the next ask is out
    if (Date.now() - answeredAt.current > SYSTEM_STALE_MS) setState((last) => last.report === null ? last : { report: null, unavailable: false });
    const abort = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const report = await fetchSystem(machineId, AbortSignal.any([abort.signal, AbortSignal.timeout(SYSTEM_ASK_TIMEOUT_MS)]));
        if (abort.signal.aborted) return;
        missing.current = null;
        answeredAt.current = Date.now();
        setState({ report, unavailable: false });
      } catch (error) {
        if (abort.signal.aborted) return;
        if (systemUnavailable(error, machineId)) {
          missing.current = retryKey;
          setState({ report: null, unavailable: true });
          return;
        }
        // anything else (offline, restarting, a timeout): the last reading stays until the next ask, while it is recent
        if (Date.now() - answeredAt.current > SYSTEM_STALE_MS) setState((last) => last.report === null ? last : { report: null, unavailable: false });
      }
      timer = window.setTimeout(() => void load(), SYSTEM_POLL_MS);
    };
    void load();
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [machineId, enabled, visible, retryKey]);

  return state;
}
