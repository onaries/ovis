import { useCallback, useState } from "react";
import type { DevicePairedEvent } from "../../shared/machines.ts";

/** Enrollments this window was told of and has not dismissed (components/DevicePairedNotice.tsx). */
export function usePairedNotices() {
  const [pairedNotices, setPairedNotices] = useState<readonly DevicePairedEvent[]>([]);
  const dismissPairedNotice = useCallback((event: DevicePairedEvent) => setPairedNotices((list) => list.filter((item) => item.event_id !== event.event_id)), []);
  return { pairedNotices, setPairedNotices, dismissPairedNotice };
}
