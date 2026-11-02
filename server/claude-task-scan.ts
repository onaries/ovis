import type { OmoTask } from "../shared/protocol.ts";
import type { ClaudeSubagentStatus } from "./claude-subagents.ts";
import { FileBusyError, fileTask } from "./file-pool.ts";

/** Only scans still under way are shared; the next request after one finishes reads again. */
const scans = new Map<string, Promise<OmoTask[]>>();

/**
 * The task-list route's filesystem work runs on a file thread, with the pool's bounded queue
 * and long-task deadline. Identical overlapping requests share that scan. Cancelling one
 * request stops only its wait, not another client's scan. No result enters the status tracker
 * or the queued-input path, whose file-version checks remain independent.
 */
export function scanClaudeTasks(session: NonNullable<ReturnType<ClaudeSubagentStatus["sessionOf"]>>, signal?: AbortSignal): Promise<OmoTask[]> {
  if (signal?.aborted) return Promise.reject(new FileBusyError("the request was cancelled"));
  const { path, live, startedAt: since, read } = session;
  // A replacement process can resume the same path with an unknown start: it cannot join an older read.
  const key = JSON.stringify([path, live, since, read]);
  let scan = scans.get(key);
  if (scan === undefined) {
    scan = fileTask<OmoTask[]>({ op: "claude-tasks", path, live, since });
    scans.set(key, scan);
    const started = scan;
    const done = () => { if (scans.get(key) === started) scans.delete(key); };
    void scan.then(done, done);
  }
  if (signal === undefined) return scan;
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new FileBusyError("the request was cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    void scan.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
