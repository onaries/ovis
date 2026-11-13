import { useCallback, useState } from "react";

import { SHEET_QUERY } from "./sheets.ts";
import { useSettings } from "./settings.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

/**
 * A phone's header and the workspace's tabs (TabStrip's sheet). At the sheets' width, with Settings ->
 * Tabs on a phone at In the header, no row is drawn under the header (`tabsInHeader`): the header draws
 * the tabs in the title's place, and its chevron opens the sheet (`sheet`, that button while the list is
 * open). Otherwise the tabs are the row under the header, as on a wider screen. The
 * list belongs to the workspace it was opened on (`owner`, the PC and workspace, null where no pane
 * area draws it: no pane, or the setup guide in its place): it goes when that changes, as when the
 * screen widens past a phone, so a pick never lands on another workspace's tab.
 */
export function useTabSheet(owner: string | null): { tabsInHeader: boolean; sheet: HTMLElement | null; toggle: (anchor: HTMLElement) => void; close: () => void } {
  const { settings } = useSettings();
  const tabsInHeader = useMediaQuery(SHEET_QUERY) && settings.phoneTabs === "header";
  const [open, setOpen] = useState<{ anchor: HTMLElement; owner: string } | null>(null);
  if (open !== null && (!tabsInHeader || open.owner !== owner)) setOpen(null);
  const close = useCallback(() => setOpen(null), []);
  const toggle = useCallback((anchor: HTMLElement) => {
    if (owner !== null) setOpen((was) => was ? null : { anchor, owner });
  }, [owner]);
  return { tabsInHeader, sheet: open?.anchor ?? null, toggle, close };
}
