import { useCallback, useEffect, useRef, useState } from "react";
import { outsideSettings } from "./settingsHistory.ts";
import { FILE_PREVIEW_KEY, WEB_PANEL_BELOW_KEY, webPagesBelow, withoutWebPanel } from "./historyKeys.ts";
import type { FilePresentation } from "./filePresentation.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";

interface FilePreview {
  path: string;
  paneId: string | null;
  machineId: string;
  presentation?: FilePresentation;
}
const HISTORY_KEY = FILE_PREVIEW_KEY;

function previewFromState(state: unknown): FilePreview | null {
  if (state === null || typeof state !== "object") return null;
  const preview = (state as Record<string, unknown>)[HISTORY_KEY];
  if (preview === null || typeof preview !== "object") return null;
  const value = preview as Record<string, unknown>;
  return typeof value.path === "string" && typeof value.machineId === "string" &&
    (value.paneId === null || typeof value.paneId === "string") ? {
      path: value.path, machineId: value.machineId, paneId: value.paneId,
      ...(value.presentation === "panel" || value.presentation === "popup" ? { presentation: value.presentation } : {}),
    } : null;
}

/**
 * The file open in the viewer, held in its own history entry. Android Back traverses history: a
 * preview must be an entry above the chat, not just a modal. Back closes it, Forward and a reload
 * restore it from the entry, and a tab switch releases it, or hides it with its entry kept (#3179).
 */
export function useFileViewer() {
  const [viewing, setViewing] = useState(() => previewFromState(window.history.state));
  const closing = useRef(false);
  // the file shown is the one a Back or Forward restored (a reload's too), not one opened since: the
  // pop's number, 0 for none, so a later pop is told apart from one already handled
  const pops = useRef(viewing !== null ? 1 : 0);
  const popped = useRef(pops.current);

  useEffect(() => {
    const onPop = (event: PopStateEvent): void => {
      closing.current = false;
      // Forward restores the preview with its original PC/pane, including after reload.
      const preview = previewFromState(event.state);
      if (preview !== null) pops.current += 1;
      popped.current = preview !== null ? pops.current : 0;
      setViewing(preview);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openFile = useCallback((preview: FilePreview, replace = false) => {
    if (closing.current) return;
    // a preview opened over Settings is no entry of Settings: a reload on it closes Settings and keeps the file
    const current = outsideSettings(window.history.state);
    const state = { ...withoutWebPanel(current), [HISTORY_KEY]: preview };
    // Choosing a different file inside an open preview must not add another Back step.
    if (replace || previewFromState(window.history.state)) {
      // a docked file taking over the entry of a page stacked on the web panel's other entries keeps
      // their count: closing it goes back past them too, or the page under it would show again (#3058)
      const below = webPagesBelow(current);
      window.history.replaceState(below > 0 ? { ...state, [WEB_PANEL_BELOW_KEY]: below } : state, "");
    } else window.history.pushState(state, "");
    popped.current = 0;
    setViewing(preview);
  }, []);

  const closeFile = useCallback(() => {
    if (closing.current) return;
    if (previewFromState(window.history.state)) {
      closing.current = true;
      // X, Escape and scrim clicks consume the same entry as the system Back button. A traversal
      // the browser refuses lands nowhere and fires no popstate: the latch is let go for the next click.
      backUnderCurrentEntry(1 + webPagesBelow(outsideSettings(window.history.state)))?.catch(() => { closing.current = false; });
    } else { popped.current = 0; setViewing(null); }
  }, []);

  const setPresentation = useCallback((presentation: FilePresentation) => {
    const preview = previewFromState(window.history.state);
    if (closing.current || preview === null || preview.presentation === presentation) return;
    const next = { ...preview, presentation };
    window.history.replaceState({ ...window.history.state, [HISTORY_KEY]: next }, "");
    setViewing(next);
  }, []);

  /**
   * Hands the file's entry to a move to another pane, or to a web page that takes its place: the file
   * leaves it without a traversal, and the viewer closes. The count of the web panel's entries under it
   * stays, so a page taking the entry over still goes back past them on closing.
   */
  const releaseFile = useCallback(() => {
    const { [HISTORY_KEY]: _, ...rest } = (window.history.state ?? {}) as Record<string, unknown>;
    window.history.replaceState(rest, "");
    popped.current = 0;
    setViewing(null);
  }, []);

  /**
   * Hides the file when a tab switch leaves it behind and Settings asks for it again on return
   * (#3179): its entry keeps it, so Back to that tab shows it again, and the move pushes its own.
   */
  const hideFile = useCallback(() => { popped.current = 0; setViewing(null); }, []);
  const fileFromPop = useCallback(() => popped.current, []);

  return { viewing, openFile, closeFile, setPresentation, releaseFile, hideFile, fileFromPop };
}
