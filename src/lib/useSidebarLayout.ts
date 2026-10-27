import { useCallback, useEffect, useRef, useState } from "react";
import type { AppLink } from "./deepLink.ts";
import { watchDrawerSwipe } from "./edgeSwipe.ts";
import { FILE_PANEL_DOCK_QUERY, storedFilePanelWidth } from "./filePanelWidth.ts";
import { storedSidebarWidth } from "./sidebarWidth.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

export interface SidebarLayoutParams {
  initialLink: AppLink | null;
}

/** Keeps the drawer, sidebar and file-panel layout state. */
export function useSidebarLayout({ initialLink }: SidebarLayoutParams) {
  // a phone opened by a link that says so starts with its drawer out (lib/deepLink.ts)
  const [drawerOpen, setDrawerOpen] = useState(() => initialLink?.sidebar === "shown" && window.matchMedia?.("(min-width: 769px)").matches !== true);
  const drawerOpenRef = useRef(drawerOpen); drawerOpenRef.current = drawerOpen;
  // from 769px the drawer is a plain sidebar column and its toggle is hidden, so a drawer a
  // narrow window opened must not come back (with its scrim) the next time the window narrows
  const wideScreen = useMediaQuery("(min-width: 769px)");
  useEffect(() => { if (wideScreen) setDrawerOpen(false); }, [wideScreen]);
  // on a phone the drawer follows a swipe in from the left edge, and a swipe back (lib/edgeSwipe.ts)
  useEffect(() => watchDrawerSwipe(() => drawerOpenRef.current, setDrawerOpen), []);
  // Escape puts the open drawer away and goes no further: in the capture phase, so a terminal that kept the
  // focus never receives it. A dialog, an IME composition or a search field with words in it (the sidebar's
  // filter clears them first) on top keeps its own Escape
  useEffect(() => {
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !drawerOpenRef.current || event.isComposing || event.keyCode === 229) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (event.target instanceof HTMLInputElement && event.target.type === "search" && event.target.value !== "") return;
      event.preventDefault();
      event.stopPropagation();
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, []);
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
  return { drawerOpen, setDrawerOpen, drawerOpenRef, wideScreen, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth, filePanelAvailable, filePanelWidth, setFilePanelWidth, sidebarFilterRequest, openSidebarFilter };
}
