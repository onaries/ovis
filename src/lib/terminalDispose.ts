interface FrameScheduler {
  requestAnimationFrame: (callback: () => void) => unknown;
  setTimeout: (callback: () => void) => unknown;
}

const browserScheduler: FrameScheduler = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  setTimeout: (callback) => window.setTimeout(callback, 0),
};

/**
 * Disposes an xterm Terminal once callbacks it has already scheduled can finish.
 *
 * xterm 5.5's reset/viewport sync could queue a frame and a task that read the renderer's dimensions,
 * and disposal removes the renderer, so either callback could throw if it ran afterward; the deferral
 * is kept with xterm 6, where it costs one frame. A frame queued
 * here runs after xterm's pending frame; the task scheduled from it runs after xterm's task. Hidden
 * tabs can delay frames while still running tasks, so there is deliberately no timer fallback.
 * Same-tab pane switches keep sibling terminals mounted; leaving a tab, changing PCs, sign-out
 * and StrictMode cleanup can retire one, which is when deferred disposal protects the instance.
 */
export function disposeAfterPendingFrame(term: { dispose: () => void }, scheduler: FrameScheduler = browserScheduler): void {
  scheduler.requestAnimationFrame(() => {
    scheduler.setTimeout(() => term.dispose());
  });
}
