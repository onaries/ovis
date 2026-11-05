import { useCallback, useState } from "react";
import type { SplitSlot } from "./split.ts";

/** Which pane's chat Search conversation opens over: the slot of the split view it is in too, which may show the same tab as another slot. */
export interface SearchRequest {
  slot: SplitSlot;
  machineId: string;
  paneId: string;
  /** bumped for each request: the pane's chat (ChatView searchRequest) opens the search when it changes */
  serial: number;
}

/**
 * Search conversation over a pane's chat: from the palette for the selected pane, from a pane's own
 * menu for that one. The drawer closes first, as for Find in terminal.
 */
export function useSearchRequest(setDrawerOpen: (open: boolean) => void) {
  const [searchRequest, setSearchRequest] = useState<SearchRequest>({ slot: "a", machineId: "", paneId: "", serial: 0 });
  const requestSearch = useCallback((slot: SplitSlot, machineId: string, paneId: string) => {
    setDrawerOpen(false);
    setSearchRequest((request) => ({ slot, machineId, paneId, serial: request.serial + 1 }));
  }, [setDrawerOpen]);
  return { searchRequest, requestSearch };
}
