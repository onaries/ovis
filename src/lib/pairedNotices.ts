import type { DevicePairedEvent } from "../../shared/protocol.ts";

/** How many enrollments wait to be read at once; older ones give way to newer. */
export const PAIRED_NOTICE_LIMIT = 3;

/**
 * The notices after one more `device-paired` event: appended once per event id (a stream that
 * repeats one changes nothing), the oldest giving way past the limit. Same list when nothing changed.
 */
export function withPairedNotice<T extends Pick<DevicePairedEvent, "event_id">>(list: readonly T[], event: T): readonly T[] {
  if (list.some((item) => item.event_id === event.event_id)) return list;
  return [...list, event].slice(-PAIRED_NOTICE_LIMIT);
}
