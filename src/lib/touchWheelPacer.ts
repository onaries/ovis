/** Wheel reports a touch swipe sends in one animation frame, the first one included. */
export const TOUCH_WHEEL_REPORTS_PER_FRAME = 6;
/** Reports a swipe may have waiting; travel beyond them is dropped and counted. */
export const TOUCH_WHEEL_QUEUE_LIMIT = 64;

/** The animation-frame clock the pacer runs on: the browser's, or a test's controlled one. */
export interface FrameClock {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/**
 * Where one gesture's reports go: `allowed` is asked immediately before each report, and a no
 * (another pane, an observer, a lost attach) cancels everything still waiting rather than sending
 * it later.
 */
export interface TouchWheelTarget {
  emit(sign: -1 | 1): void;
  allowed(): boolean;
}

export interface TouchWheelPacer {
  /** Queue `steps` reports (the sign is the direction) for the next animation frames. */
  push(steps: number, target: TouchWheelTarget): void;
  /** Drop every waiting report: a new touch, a key, a disconnect or an ownership change. */
  cancel(): void;
  /** Cancel, and stop the frame clock for good (the terminal is gone). */
  dispose(): void;
  /** Reports waiting now. */
  readonly pending: number;
  /** The most reports that waited at once. */
  readonly peak: number;
  /** Reports dropped because the queue was full (never those a cancellation dropped). */
  readonly dropped: number;
}

const browserFrames: FrameClock = {
  request: (callback) => requestAnimationFrame(() => callback()),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/**
 * Touch wheel reports at most {@link TOUCH_WHEEL_REPORTS_PER_FRAME} per animation frame, in order,
 * with at most {@link TOUCH_WHEEL_QUEUE_LIMIT} waiting. Reports go out only from the frame callback:
 * the browser runs a frame's touch handlers before its animation-frame callbacks, so a report sent
 * from the handler would land in the same frame as the callback's. A fast swipe's reports are
 * spread over the next frames instead of all landing in one.
 */
export function createTouchWheelPacer(frames: FrameClock = browserFrames): TouchWheelPacer {
  const queue: Array<{ sign: -1 | 1; target: TouchWheelTarget }> = [];
  let frame: number | null = null;
  let peak = 0;
  let dropped = 0;
  let disposed = false;

  const onFrame = (): void => {
    frame = null;
    let sent = 0;
    while (queue.length > 0 && sent < TOUCH_WHEEL_REPORTS_PER_FRAME) {
      const next = queue.shift()!;
      if (!next.target.allowed()) {
        queue.length = 0;
        break;
      }
      sent += 1;
      next.target.emit(next.sign);
    }
    if (!disposed && queue.length > 0 && frame === null) frame = frames.request(onFrame);
  };

  return {
    push(steps, target) {
      if (disposed || steps === 0 || !Number.isFinite(steps)) return;
      const sign = Math.sign(steps) as -1 | 1;
      const count = Math.abs(Math.trunc(steps));
      for (let n = 0; n < count; n++) {
        if (queue.length >= TOUCH_WHEEL_QUEUE_LIMIT) {
          dropped += count - n;
          break;
        }
        queue.push({ sign, target });
      }
      peak = Math.max(peak, queue.length);
      if (queue.length > 0 && frame === null) frame = frames.request(onFrame);
    },
    cancel() {
      queue.length = 0;
      if (frame !== null) frames.cancel(frame);
      frame = null;
    },
    dispose() {
      disposed = true;
      queue.length = 0;
      if (frame !== null) frames.cancel(frame);
      frame = null;
    },
    get pending() { return queue.length; },
    get peak() { return peak; },
    get dropped() { return dropped; },
  };
}
