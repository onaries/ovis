import { useCallback, useState } from "react";

import { SHEET_QUERY } from "./sheets.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

/**
 * A phone's header title and the workspace's tabs it lists (TabStrip's sheet). At the sheets' width
 * no tab row is drawn (`tabsInHeader`); `sheet` is the title's button while the list is open. The
 * list belongs to the workspace it was opened on (`owner`, the PC and workspace, null where no pane
 * area draws it: no pane, or the setup guide in its place): it goes when that changes, as when the
 * screen widens past a phone, so a pick never lands on another workspace's tab.
 */
export function useTabSheet(owner: string | null): { tabsInHeader: boolean; sheet: HTMLElement | null; toggle: (anchor: HTMLElement) => void; close: () => void } {
  const tabsInHeader = useMediaQuery(SHEET_QUERY);
  const [open, setOpen] = useState<{ anchor: HTMLElement; owner: string } | null>(null);
  if (open !== null && (!tabsInHeader || open.owner !== owner)) setOpen(null);
  const close = useCallback(() => setOpen(null), []);
  const toggle = useCallback((anchor: HTMLElement) => {
    if (owner !== null) setOpen((was) => was ? null : { anchor, owner });
  }, [owner]);
  return { tabsInHeader, sheet: open?.anchor ?? null, toggle, close };
}
