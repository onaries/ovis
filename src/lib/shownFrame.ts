/**
 * Coalesced measurements wait while the page is hidden, including an already requested frame.
 * They resume in the first visible frame. The caller cancels them on cleanup.
 */
export function requestShownFrame(callback: FrameRequestCallback): () => void {
  let frame = 0;
  const run: FrameRequestCallback = (at) => {
    frame = 0;
    if (document.hidden) return;
    document.removeEventListener("visibilitychange", changed);
    callback(at);
  };
  const changed = (): void => {
    if (document.hidden) {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    } else if (frame === 0) {
      frame = requestAnimationFrame(run);
    }
  };
  document.addEventListener("visibilitychange", changed);
  changed();
  return () => {
    document.removeEventListener("visibilitychange", changed);
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}
