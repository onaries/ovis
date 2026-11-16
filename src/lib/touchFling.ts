import type { FrameClock } from "./touchWheelPacer.ts";

/** Only the finger's last this many milliseconds count toward its speed at the lift (Android's `VelocityTracker` horizon). */
export const FLING_HORIZON_MS = 100;
/** A finger that has not moved for this long before it lifts had stopped: no fling (Android's `ASSUME_POINTER_STOPPED_TIME`). */
export const FLING_STOPPED_MS = 40;
/** Slowest lift, in CSS pixels per millisecond, that flings; a slower one is a drag that ends where the finger does. */
export const FLING_MIN_VELOCITY = 0.3;
/** A stroke that has not travelled this far, in CSS pixels, is a tap that jittered and never flings (Android's touch slop, 8 dp). */
export const FLING_SLOP_PX = 8;
/** Fastest fling, in CSS pixels per millisecond (Android's maximum fling velocity, 8000 dp/s). */
export const FLING_MAX_VELOCITY = 8;
/** A fling ends once it is this slow, in CSS pixels per millisecond. */
export const FLING_STOP_VELOCITY = 0.02;
/** The speed a fling keeps per millisecond (UIScrollView's normal deceleration rate). */
export const FLING_DECELERATION = 0.998;
/** The longest frame a fling advances by: a frame after the tab was hidden does not jump the whole glide. */
const FLING_MAX_FRAME_MS = 50;

export interface VelocityTracker {
  /** Forget the samples: a new touch, or a stroke that stopped scrolling. */
  reset(): void;
  /** The finger at `position` (its travel so far, in pixels) at `time` (milliseconds). */
  add(time: number, position: number): void;
  /** The finger's speed in pixels per millisecond when it lifts at `time`, or 0 when it does not fling. */
  release(time: number): number;
}

/**
 * The finger's speed at the lift, from its travel over the last {@link FLING_HORIZON_MS}: 0 when
 * it had stopped ({@link FLING_STOPPED_MS}), never went past {@link FLING_SLOP_PX}, or was slower than {@link FLING_MIN_VELOCITY}, and at
 * most {@link FLING_MAX_VELOCITY} either way. The sign is the travel's.
 */
export function createVelocityTracker(): VelocityTracker {
  let samples: Array<{ time: number; position: number }> = [];
  /** the farthest the stroke got from where it began: under the slop it is a tap, however fast its jitter */
  let reach = 0;
  return {
    reset() { samples = []; reach = 0; },
    add(time, position) {
      if (!Number.isFinite(time) || !Number.isFinite(position)) return;
      reach = Math.max(reach, Math.abs(position));
      samples.push({ time, position });
      // keep one sample from before the horizon: the travel across it still counts
      while (samples.length > 2 && time - samples[1]!.time > FLING_HORIZON_MS) samples.shift();
    },
    release(time) {
      const last = samples.at(-1);
      if (!last || !Number.isFinite(time) || time - last.time > FLING_STOPPED_MS || reach < FLING_SLOP_PX) return 0;
      const first = samples.find((sample) => last.time - sample.time <= FLING_HORIZON_MS && sample !== last) ?? samples.at(-2);
      if (!first) return 0;
      // events that share a timestamp still moved the finger: count them over one millisecond
      const elapsed = Math.max(1, last.time - first.time);
      const velocity = (last.position - first.position) / elapsed;
      if (Math.abs(velocity) < FLING_MIN_VELOCITY) return 0;
      return Math.sign(velocity) * Math.min(FLING_MAX_VELOCITY, Math.abs(velocity));
    },
  };
}

/**
 * One frame of a fling: the pixels it travels over `elapsed` milliseconds starting at `velocity`,
 * and its speed after them. The speed decays by {@link FLING_DECELERATION} per millisecond, so the
 * whole glide travels `velocity / -ln(FLING_DECELERATION)`, about 500 ms of the lift's speed.
 */
export function flingStep(velocity: number, elapsed: number): { travel: number; velocity: number } {
  if (!Number.isFinite(velocity) || !(elapsed > 0)) return { travel: 0, velocity: Number.isFinite(velocity) ? velocity : 0 };
  const kept = FLING_DECELERATION ** elapsed;
  return { travel: (velocity * (kept - 1)) / Math.log(FLING_DECELERATION), velocity: velocity * kept };
}

export interface TouchFling {
  /**
   * Glide from `velocity`: each animation frame hands `travel` its pixels and stops the fling when
   * it answers false. `done` runs once when the glide slows to a stop by itself, never after a
   * cancel or a false. A new start cancels the fling before it.
   */
  start(velocity: number, travel: (pixels: number) => boolean, done: () => void): void;
  cancel(): void;
  /** Cancel, and stop the frame clock for good (the terminal is gone). */
  dispose(): void;
  readonly active: boolean;
}

const browserFrames: FrameClock = {
  request: (callback) => requestAnimationFrame(() => callback()),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/** A swipe's glide after the finger lifts, one step per animation frame on `frames`, timed by `now`. */
export function createTouchFling(frames: FrameClock = browserFrames, now: () => number = () => performance.now()): TouchFling {
  let frame: number | null = null;
  let disposed = false;
  let glide: { velocity: number; at: number; travel: (pixels: number) => boolean; done: () => void } | null = null;
  const stop = (): void => {
    glide = null;
    if (frame !== null) frames.cancel(frame);
    frame = null;
  };
  const onFrame = (): void => {
    frame = null;
    const current = glide;
    if (!current) return;
    const at = now();
    const step = flingStep(current.velocity, Math.min(FLING_MAX_FRAME_MS, Math.max(0, at - current.at)));
    current.velocity = step.velocity;
    current.at = at;
    if (!current.travel(step.travel)) {
      if (glide === current) stop();
      return;
    }
    if (glide !== current) return;
    if (Math.abs(current.velocity) < FLING_STOP_VELOCITY) {
      glide = null;
      current.done();
      return;
    }
    if (!disposed) frame = frames.request(onFrame);
  };
  return {
    start(velocity, travel, done) {
      stop();
      if (disposed || !Number.isFinite(velocity) || Math.abs(velocity) < FLING_STOP_VELOCITY) {
        if (!disposed) done();
        return;
      }
      glide = { velocity, at: now(), travel, done };
      frame = frames.request(onFrame);
    },
    cancel: stop,
    dispose() {
      disposed = true;
      stop();
    },
    get active() { return glide !== null; },
  };
}
