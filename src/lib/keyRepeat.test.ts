import { describe, expect, it } from "bun:test";
import {
  createKeyRepeat, isRepeatableKeyBarItem, KEY_REPEAT_DELAY_MS, KEY_REPEAT_INTERVAL_MS,
  KEY_REPEAT_MOVE_SLOP_PX, type KeyRepeat, type KeyRepeatClock,
} from "./keyRepeat.ts";

interface ScheduledTimer {
  at: number;
  callback: () => void;
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<unknown, ScheduledTimer>();
  const clock: KeyRepeatClock = {
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  return {
    clock,
    now: () => now,
    pending: () => timers.size,
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        let next: { id: unknown; timer: ScheduledTimer } | undefined;
        for (const [id, timer] of timers) {
          if (timer.at <= end && (!next || timer.at < next.timer.at)) next = { id, timer };
        }
        if (!next) break;
        now = next.timer.at;
        timers.delete(next.id);
        next.timer.callback();
      }
      now = end;
    },
  };
}

function fixture() {
  const clock = fakeClock();
  const sends: number[] = [];
  const repeat = createKeyRepeat(() => sends.push(clock.now()), clock.clock);
  return { clock, repeat, sends };
}

describe("key bar hold repeat", () => {
  it("sends a quick tap exactly once on click, never on pointerdown or the delay timer", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(20, 30);
    expect(sends).toEqual([]);
    clock.advance(KEY_REPEAT_DELAY_MS - 1);
    repeat.release();
    clock.advance(KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS);
    expect(sends).toEqual([]);
    expect(clock.pending()).toBe(0);
    if (repeat.takeClick()) sends.push(clock.now());
    expect(sends).toHaveLength(1);
  });

  it("sends first at the delay boundary and then at each interval boundary", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS - 1);
    expect(sends).toEqual([]);
    clock.advance(1);
    expect(sends).toEqual([KEY_REPEAT_DELAY_MS]);
    clock.advance(KEY_REPEAT_INTERVAL_MS - 1);
    expect(sends).toHaveLength(1);
    clock.advance(1);
    expect(sends).toEqual([KEY_REPEAT_DELAY_MS, KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS]);
    clock.advance(2 * KEY_REPEAT_INTERVAL_MS);
    expect(sends).toEqual([
      KEY_REPEAT_DELAY_MS, KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS,
      KEY_REPEAT_DELAY_MS + 2 * KEY_REPEAT_INTERVAL_MS, KEY_REPEAT_DELAY_MS + 3 * KEY_REPEAT_INTERVAL_MS,
    ]);
  });

  it("stops all future sends on release and swallows the following click only once", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS + KEY_REPEAT_INTERVAL_MS);
    repeat.release();
    repeat.release();
    clock.advance(10 * KEY_REPEAT_INTERVAL_MS);
    expect(sends).toHaveLength(2);
    expect(clock.pending()).toBe(0);
    expect(repeat.takeClick()).toBe(false);
    expect(repeat.takeClick()).toBe(true);

    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS - 1);
    repeat.release();
    if (repeat.takeClick()) sends.push(clock.now());
    expect(sends).toHaveLength(3);
  });

  it("clears stale hold-click suppression when a new press begins", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS);
    repeat.release();
    // A browser need not deliver a click after the first hold.
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS - 1);
    repeat.release();
    expect(repeat.takeClick()).toBe(true);
    expect(sends).toHaveLength(1);
  });

  it("allows an ordinary click with no preceding pointer press", () => {
    const { repeat } = fixture();
    expect(repeat.takeClick()).toBe(true);
    expect(repeat.takeClick()).toBe(true);
    repeat.release();
    expect(repeat.takeClick()).toBe(true);
  });

  it("cancels before the delay without sending or leaving a timer", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS - 1);
    repeat.cancel();
    repeat.cancel();
    repeat.release();
    clock.advance(2 * KEY_REPEAT_DELAY_MS);
    expect(sends).toEqual([]);
    expect(clock.pending()).toBe(0);
    expect(repeat.takeClick()).toBe(true);
  });

  it("cancels an active repeat without sending again", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS);
    repeat.cancel();
    repeat.release();
    clock.advance(2 * KEY_REPEAT_DELAY_MS);
    expect(sends).toHaveLength(1);
    expect(clock.pending()).toBe(0);
    expect(repeat.takeClick()).toBe(true);
  });

  it("keeps movement exactly at the slop boundary but cancels beyond it before repeating", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(20, 30);
    expect(repeat.move(20 + KEY_REPEAT_MOVE_SLOP_PX, 30)).toBe(false);
    clock.advance(KEY_REPEAT_DELAY_MS - 1);
    expect(repeat.move(20 + KEY_REPEAT_MOVE_SLOP_PX + 1, 30)).toBe(true);
    expect(repeat.move(20 + KEY_REPEAT_MOVE_SLOP_PX + 2, 30)).toBe(false);
    repeat.release();
    clock.advance(KEY_REPEAT_DELAY_MS);
    expect(sends).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it("measures slop in both axes from the original press", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(20, 30);
    expect(repeat.move(20, 30 - KEY_REPEAT_MOVE_SLOP_PX)).toBe(false);
    expect(repeat.move(20 + KEY_REPEAT_MOVE_SLOP_PX, 31)).toBe(true);
    clock.advance(KEY_REPEAT_DELAY_MS);
    expect(sends).toEqual([]);
  });

  it("does not cancel movement after repetition has begun", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS);
    expect(repeat.move(10 * KEY_REPEAT_MOVE_SLOP_PX, 10 * KEY_REPEAT_MOVE_SLOP_PX)).toBe(false);
    clock.advance(KEY_REPEAT_INTERVAL_MS);
    expect(sends).toHaveLength(2);
    repeat.release();
    expect(repeat.takeClick()).toBe(false);
  });

  it("restarts the delay on a new press and discards the previous hold timer", () => {
    const { clock, repeat, sends } = fixture();
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS - 1);
    repeat.press(10, 20);
    clock.advance(KEY_REPEAT_DELAY_MS - 1);
    expect(sends).toEqual([]);
    clock.advance(1);
    expect(sends).toEqual([2 * KEY_REPEAT_DELAY_MS - 1]);
    expect(clock.pending()).toBe(1);
  });

  it("tells whether the hold it ends had repeated", () => {
    const { clock, repeat } = fixture();
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS - 1);
    expect(repeat.release()).toBe(false);
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS);
    expect(repeat.release()).toBe(true);
    expect(repeat.release()).toBe(false);
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS);
    expect(repeat.cancel()).toBe(true);
    expect(repeat.cancel()).toBe(false);
  });

  it("does not schedule another tick when sending synchronously releases the hold", () => {
    const clock = fakeClock();
    let sends = 0;
    let repeat: KeyRepeat;
    repeat = createKeyRepeat(() => { sends++; repeat.release(); }, clock.clock);
    repeat.press(0, 0);
    clock.advance(KEY_REPEAT_DELAY_MS + 10 * KEY_REPEAT_INTERVAL_MS);
    expect(sends).toBe(1);
    expect(clock.pending()).toBe(0);
    expect(repeat.takeClick()).toBe(false);
  });
});

describe("repeatable key bar items", () => {
  it("repeats the arrows and the editing and paging keys, including saved modifiers", () => {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown"]) {
      expect(isRepeatableKeyBarItem({ type: "key", key })).toBe(true);
      expect(isRepeatableKeyBarItem({ type: "key", key, modifiers: { ctrl: true, alt: true, shift: true } })).toBe(true);
      expect(isRepeatableKeyBarItem({ type: "key", key, modifiers: { ctrl: false, alt: false, shift: false } })).toBe(true);
    }
  });

  it("does not repeat catalog keys, printable keys or modifier buttons", () => {
    for (const key of ["Escape", "Tab", "BackTab", "Enter", "Insert", "ctrl-c", "ctrl-d", "F1", "a", " "]) {
      expect(isRepeatableKeyBarItem({ type: "key", key })).toBe(false);
      expect(isRepeatableKeyBarItem({ type: "key", key, modifiers: { ctrl: true, alt: false, shift: false } })).toBe(false);
    }
    for (const modifier of ["ctrl", "alt", "shift"] as const) {
      expect(isRepeatableKeyBarItem({ type: "modifier", modifier })).toBe(false);
    }
  });
});
