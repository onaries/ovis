import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useMachineApi } from "../lib/machineContext.tsx";
import { markdownImagePreview } from "../lib/markdownImages.ts";
import type { GalleryImage } from "../lib/imageViewer.ts";
import { MarkdownImageContext, MarkdownImageOpenContext, MarkdownImageRetryContext } from "./Markdown.tsx";

/** Resolve on the pane's PC; the viewer stays with ChatView when an image's row scrolls away. */
export function ChatMarkdownImages({ paneId, cwd, connected, onOpen, children }: {
  paneId: string; cwd: string | null; connected: boolean; onOpen: (image: GalleryImage) => void; children: ReactNode;
}) {
  const { fetchFileInfo, fileUrl } = useMachineApi();
  const previous = useRef({ connected, cwd, paneId, fetchFileInfo });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const before = previous.current;
    previous.current = { connected, cwd, paneId, fetchFileInfo };
    const sameOwner = before.paneId === paneId && before.fetchFileInfo === fetchFileInfo;
    if (sameOwner && ((connected && !before.connected) || cwd !== before.cwd)) setRefresh((epoch) => epoch + 1);
  }, [connected, cwd, paneId, fetchFileInfo]);
  const resolve = useCallback((src: string) => markdownImagePreview(
    // The server prefers foreground_cwd over pane.cwd and returns the canonical byte path.
    src, null,
    (path) => fetchFileInfo(path, paneId), (path, download) => fileUrl(path, paneId, download),
  ), [paneId, fetchFileInfo, fileUrl]);
  return <MarkdownImageContext.Provider value={resolve}>
    <MarkdownImageRetryContext.Provider value={refresh}>
      <MarkdownImageOpenContext.Provider value={onOpen}>{children}</MarkdownImageOpenContext.Provider>
    </MarkdownImageRetryContext.Provider>
  </MarkdownImageContext.Provider>;
}
