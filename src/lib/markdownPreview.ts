import type { MarkdownBlock } from "../../shared/markdown.ts";
import { createOffThreadQueue, type OffThreadJob, type WorkerLike } from "./offThread.ts";

/**
 * How long a worker may take to parse a file for its Preview. Ordinary Markdown of a quarter
 * megabyte parses in a few milliseconds; past this the file opens as its source and says why.
 */
export const PREVIEW_BUDGET_MS = 2_000;

const queue = createOffThreadQueue<string, MarkdownBlock[]>(
  () => new Worker(new URL("./markdownPreview.worker.ts", import.meta.url), { type: "module" }) as WorkerLike,
  PREVIEW_BUDGET_MS,
);

// the last file parsed: a Preview toggled to its source and back, or reopened, is not parsed again
let last: { text: string; blocks: MarkdownBlock[] | null } | null = null;

/** The Preview of `text` if it is the last one parsed: its blocks, `null` when it could not be parsed, else `undefined`. */
export function knownPreview(text: string): MarkdownBlock[] | null | undefined {
  return last !== null && last.text === text ? last.blocks : undefined;
}

/**
 * `text` parsed as Markdown in a worker. `null` when it took longer than `PREVIEW_BUDGET_MS`, the
 * parser failed (a stack overflow included), it would draw more than `PREVIEW_ELEMENT_LIMIT`
 * elements, or it was cancelled before it started.
 */
export function parsePreviewOffThread(text: string): OffThreadJob<MarkdownBlock[]> {
  const job = queue(text);
  let dropped = false;
  return {
    cancel: () => {
      if (job.cancel()) dropped = true;
      return dropped;
    },
    promise: job.promise.then((blocks) => {
      // a job dropped before it ran says nothing about its text; one that ran is kept either way
      if (!dropped) last = { text, blocks };
      return blocks;
    }),
  };
}
