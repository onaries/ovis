import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AppLink } from "./deepLink.ts";
import { watchDrawerSwipe } from "./edgeSwipe.ts";
import { FILE_PANEL_DOCK_QUERY, storedFilePanelWidth } from "./filePanelWidth.ts";
import { storedSidebarWidth } from "./sidebarWidth.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

/** a tap on the open drawer's Ovis mark this soon after the menu button's click that opened the drawer, on the same spot, is that double tap's second half */
export const SECOND_TAP_MS = 400;

/** Whether a tap at `at` on the open drawer's Ovis mark is the second half of the double tap whose first, at `openedAt`, opened it. */
export function secondTapOf(openedAt: number | null, at: number): boolean {
  return openedAt !== null && at - openedAt < SECOND_TAP_MS;
}

export interface SidebarLayoutParams {
  initialLink: AppLink | null;
  /** while true the shell has no drawer (the inbox mode, lib/inboxMode.ts): nothing opens one, a swipe included */
  drawerBlocked?: RefObject<boolean>;
}

/** Keeps the drawer, sidebar and file-panel layout state. */
export function useSidebarLayout({ initialLink, drawerBlocked }: SidebarLayoutParams) {
  // a phone opened by a link that says so starts with its drawer out (lib/deepLink.ts)
  const [drawerOpen, setDrawerOpenState] = useState(() => initialLink?.sidebar === "shown" && window.matchMedia?.("(min-width: 769px)").matches !== true && drawerBlocked?.current !== true);
  const setDrawerOpen = useCallback<Dispatch<SetStateAction<boolean>>>((next) => setDrawerOpenState((open) => {
    const asked = typeof next === "function" ? next(open) : next;
    return asked && drawerBlocked?.current !== true;
  }), [drawerBlocked]);
  const drawerOpenRef = useRef(drawerOpen); drawerOpenRef.current = drawerOpen;
  // from 769px the drawer is a plain sidebar column and its toggle is hidden, so a drawer a
  // narrow window opened must not come back (with its scrim) the next time the window narrows
  const wideScreen = useMediaQuery("(min-width: 769px)");
  useEffect(() => { if (wideScreen) setDrawerOpen(false); }, [wideScreen]);
  // on a phone the drawer follows a swipe in from the left edge, and a swipe back (lib/edgeSwipe.ts)
  useEffect(() => watchDrawerSwipe(() => drawerOpenRef.current, setDrawerOpen), []);
  // when the menu button last opened the drawer (that click's timeStamp): the Ovis mark takes the button's place in the
  // open drawer's head (App.tsx), and a tap on it within SECOND_TAP_MS of that click is no way into the inbox
  const drawerOpenedAt = useRef<number | null>(null);
  const toggleDrawerByButton = useCallback((at: number) => {
    if (!drawerOpenRef.current) drawerOpenedAt.current = at;
    setDrawerOpen((open) => !open);
  }, [setDrawerOpen]);
  const secondTapOfOpening = useCallback((at: number): boolean => secondTapOf(drawerOpenedAt.current, at), []);
  // closed any way at all, the drawer has no opening tap left to pair with
  useEffect(() => { if (!drawerOpen) drawerOpenedAt.current = null; }, [drawerOpen]);
  // While the drawer is out on a phone it holds the keyboard as a dialog does (G-003): App.tsx's useDrawerDialog
  // (lib/headerSessions.ts) owns its Tab and Escape and gives the focus back when it closes
  // a desktop opened by a link that says so starts with the sidebar collapsed, and the address says so while it is
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => initialLink?.sidebar === "hidden");
  // the width the sidebar's edge was dragged to on this device; null is the density's own
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const filePanelAvailable = useMediaQuery(FILE_PANEL_DOCK_QUERY);
  const [filePanelWidth, setFilePanelWidth] = useState(storedFilePanelWidth);
  // the palette's Filter workspaces and agents: the drawer or the sidebar comes out, and the sidebar shows its
  // field and focuses it on each new count (components/MachineSidebar.tsx)
  const [sidebarFilterRequest, setSidebarFilterRequest] = useState(0);
  const openSidebarFilter = useCallback(() => {
    if (window.matchMedia("(max-width: 768px)").matches) setDrawerOpen(true);
    else setSidebarCollapsed(false);
    setSidebarFilterRequest((count) => count + 1);
  }, []);
  return { drawerOpen, setDrawerOpen, drawerOpenRef, toggleDrawerByButton, secondTapOfOpening, wideScreen, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth, filePanelAvailable, filePanelWidth, setFilePanelWidth, sidebarFilterRequest, openSidebarFilter };
}
