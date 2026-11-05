import { createContext, useMemo } from "react";

import { LOCAL_MACHINE } from "../../shared/machines.ts";
import { ApiError } from "./api.ts";
import { fileLineTarget } from "./filePaths.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";

/**
 * A bare name in a code span (`README.md`) looks like a file by its shape alone, and so do a
 * systemd unit (`user-1000.slice`), a host or a config key: no list of names tells them apart, and
 * a list of suffixes would hide real files of that kind. The chat asks the pane's PC as the viewer
 * asks it on a click (GET /api/fs/stat, then the folder of that name on a 404), and a name nothing
 * has reads as code, not a link that can only fail. Found, several files of that name, or any other
 * failure keeps the link. A path with a folder in it is not asked: it stays a link.
 */
export interface FileNameLookup {
  /** the answer already kept for `name`, so a row drawn again shows it from its first frame */
  known(name: string): boolean | undefined;
  /** whether the viewer would open anything for `name`: false only when it would find nothing */
  ask(name: string): Promise<boolean>;
}

/** Where a name in a code span is looked up; null keeps every one a link (a file's own preview). */
export const FileNameLookupContext = createContext<FileNameLookup | null>(null);

/** an answer is kept this long: a file written or removed since is seen at a later ask */
const KEPT_MS = 60_000;
const KEPT = 500;
/** names asked at once, so an answer full of them does not hold every file thread of the PC */
const RUNNING = 4;
/** a name not answered by then, waiting included, keeps its link; its request keeps its slot until it ends, so a PC that stopped answering is never asked more */
const ANSWER_MS = 10_000;

interface Kept { at: number; turn: unknown; found: Promise<boolean>; answer?: boolean }
const answers = new Map<string, Kept>();
let running = 0;
const waiting: Array<() => void> = [];

/**
 * `work` once one of the RUNNING slots is free, or `late` once ANSWER_MS have passed since the ask.
 * A slot is freed only when its work ends, and goes straight to the next in line; one whose answer
 * is no longer waited for by then is skipped.
 */
async function inSlot<T>(work: () => Promise<T>, late: T): Promise<T> {
  let expired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const run = (async () => {
    if (running < RUNNING) running++;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return expired ? late : await work();
    } finally {
      const next = waiting.shift();
      if (next) next(); else running--;
    }
  })();
  try {
    return await Promise.race([run, new Promise<T>((resolve) => { deadline = setTimeout(() => { expired = true; resolve(late); }, ANSWER_MS); })]);
  } finally {
    clearTimeout(deadline);
  }
}

async function opens(name: string, stat: (name: string) => Promise<unknown>, folder: ((name: string) => Promise<unknown>) | null): Promise<boolean> {
  try {
    await stat(name);
    return true;
  } catch (error) {
    // a 404 without `not_found` is a pane whose folder the PC could not read (server/file-routes.ts): not a miss
    if (!(error instanceof ApiError) || error.status !== 404 || error.code !== "not_found") return true;
  }
  if (folder === null) return false;
  try {
    await folder(name);
    return true;
  } catch (error) {
    // only "no readable folder there" (400) is a miss; a folder that could not be asked keeps the link
    return !(error instanceof ApiError && error.status === 400);
  }
}

/**
 * The lookup for one pane's folder (`scope`). A name found is kept for KEPT_MS; one with nothing,
 * or still being asked, only for the same `turn` too, as the agent may write it before its turn ends.
 */
export function createFileNameLookup(scope: string, turn: unknown, stat: (name: string) => Promise<unknown>, folder: ((name: string) => Promise<unknown>) | null): FileNameLookup {
  const key = (name: string) => `${scope}\0${fileLineTarget(name).path}`;
  const kept = (name: string) => {
    const entry = answers.get(key(name));
    return entry !== undefined && Date.now() - entry.at < KEPT_MS && (entry.answer === true || entry.turn === turn) ? entry : undefined;
  };
  return {
    known: (name) => kept(name)?.answer,
    ask: (name) => {
      const known = kept(name);
      if (known !== undefined) return known.found;
      const entry = { at: Date.now(), turn } as Kept;
      entry.found = inSlot(() => opens(fileLineTarget(name).path, stat, folder), true).then((answer) => entry.answer = answer);
      answers.delete(key(name));
      answers.set(key(name), entry);
      if (answers.size > KEPT) answers.delete(answers.keys().next().value!);
      return entry.found;
    },
  };
}

/**
 * The chat's lookup, on the pane's PC and from its folder: a name with nothing is asked again
 * after the agent's next turn ends (`turn`, the pane's finish count) or in another folder.
 */
export function useFileNameLookup(paneId: string, cwd: string | null, turn: unknown): FileNameLookup {
  const machineId = useMachineId();
  const { fetchFileInfo, fetchDirectories } = useMachineApi();
  return useMemo(() => createFileNameLookup(`${machineId}\0${paneId}\0${cwd ?? ""}`, turn, (name) => fetchFileInfo(name, paneId),
    // a remote PC's bridge would list its own folder for a relative one, so the viewer lists none there (FileViewer)
    machineId === LOCAL_MACHINE ? (name) => fetchDirectories(name, false, true, paneId) : null),
  [machineId, paneId, cwd, turn, fetchFileInfo, fetchDirectories]);
}
