/**
 * One file thread (`file-pool.ts`): runs the tasks it is sent one at a time and answers each,
 * so a slow disk holds this thread and not the server's.
 */
import { type FileTask, runFileTask, transferablesOf } from "./file-tasks.ts";

declare const self: Worker;

self.onmessage = (event: MessageEvent<FileTask>) => {
  let result;
  try {
    result = runFileTask(event.data);
  } catch (error) {
    postMessage({ error: error instanceof Error ? error.message : String(error) });
    return;
  }
  postMessage({ result }, transferablesOf(result));
};
