/**
 * What the desktop app reads to keep its computer awake while an agent works (app/electron/src/awake.ts).
 * A server the app runs keeps `desktop-activity.json` in its state folder: `{ "working": n }`, how many of
 * this PC's panes have an agent at work (`busyPanes`), as clients are shown it. It is read again shortly
 * after a status change and every minute, one read at a time, rewritten only when the count changes, and
 * removed when the server starts and stops. A read that fails counts as none working: the app must never
 * hold the computer awake on a count nobody can confirm.
 */
import { renameSync, rmSync, writeFileSync } from "node:fs";
import type { HerdrPane } from "../shared/protocol.ts";

export const DESKTOP_ACTIVITY_FILE = "desktop-activity.json";

/** a burst of status changes is read once, this long after its first */
const SETTLE_MS = 1_000;
/** a change the status frames missed (a resync, a pane gone quietly) is caught this often */
const REFRESH_MS = 60_000;

/** panes whose agent works: in a turn, or at rest while its turn's background work still runs */
export function busyPanes(panes: readonly Pick<HerdrPane, "agent_status" | "background_tasks" | "background_wait">[]): number {
  return panes.filter((pane) => pane.agent_status === "working" || pane.background_wait === true || (pane.background_tasks ?? 0) > 0).length;
}

export interface DesktopActivity {
  /** a pane's status may have changed: read again soon */
  changed(): void;
  /** reads the count and writes it when it changed; a call during a read is answered by one more read after it */
  refresh(): Promise<void>;
  stop(): void;
}

export function trackDesktopActivity({ path, working }: { path: string; working: () => Promise<number> }): DesktopActivity {
  let written: number | null = null;
  let soon: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let reading: Promise<void> | null = null;
  let again = false;
  const remove = (): void => {
    try { rmSync(path, { force: true }); }
    catch (error) { console.warn(`desktop activity: ${path} could not be removed (${error instanceof Error ? error.message : String(error)})`); }
  };
  // a file a server before this one left behind (killed before it could remove it) says nothing of now
  remove();
  const readOnce = async (): Promise<void> => {
    let count: number;
    try { count = await working(); }
    catch (error) {
      console.warn(`desktop activity: the panes could not be read (${error instanceof Error ? error.message : String(error)})`);
      count = 0;
    }
    if (stopped || count === written) return;
    try {
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ working: count }));
      renameSync(temporary, path);
      written = count;
    } catch (error) {
      console.warn(`desktop activity: ${path} could not be written (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  const refresh = (): Promise<void> => {
    if (reading !== null) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        await readOnce();
      } while (again && !stopped);
    })().finally(() => { reading = null; });
    return reading;
  };
  const every = setInterval(() => void refresh(), REFRESH_MS);
  every.unref?.();
  const changed = (): void => {
    if (soon !== null || stopped) return;
    soon = setTimeout(() => { soon = null; void refresh(); }, SETTLE_MS);
    soon.unref?.();
  };
  changed();
  return {
    changed,
    refresh,
    stop() {
      stopped = true;
      clearInterval(every);
      if (soon !== null) clearTimeout(soon);
      remove();
    },
  };
}
