import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createSidebarPeek, PEEK_CLOSE_MS, PEEK_OPEN_MS } from "./sidebarPeek.ts";

describe("sidebar peek (#2588)", () => {
  let changes: boolean[];
  beforeEach(() => { jest.useFakeTimers(); changes = []; });
  afterEach(() => { jest.useRealTimers(); });
  const peek = (held: () => boolean = () => false) => createSidebarPeek((shown) => changes.push(shown), held);

  test("shows once the pointer rests on the toggle, not when it only passes over it", () => {
    const controller = peek();
    controller.enter("toggle");
    jest.advanceTimersByTime(PEEK_OPEN_MS - 1);
    controller.leave("toggle");
    jest.advanceTimersByTime(PEEK_CLOSE_MS * 2);
    expect(changes).toEqual([]);
    controller.enter("toggle");
    jest.advanceTimersByTime(PEEK_OPEN_MS);
    expect(changes).toEqual([true]);
  });

  test("stays while the pointer travels from the toggle into the sidebar and back", () => {
    const controller = peek();
    controller.enter("toggle");
    jest.advanceTimersByTime(PEEK_OPEN_MS);
    controller.leave("toggle");
    jest.advanceTimersByTime(PEEK_CLOSE_MS - 1);
    controller.enter("sidebar");
    jest.advanceTimersByTime(PEEK_CLOSE_MS * 2);
    controller.leave("sidebar");
    controller.enter("toggle");
    jest.advanceTimersByTime(PEEK_CLOSE_MS * 2);
    expect(changes).toEqual([true]);
  });

  test("hides after the grace once the pointer has left both", () => {
    const controller = peek();
    controller.enter("toggle");
    jest.advanceTimersByTime(PEEK_OPEN_MS);
    controller.leave("toggle");
    controller.enter("sidebar");
    controller.leave("sidebar");
    jest.advanceTimersByTime(PEEK_CLOSE_MS - 1);
    expect(changes).toEqual([true]);
    jest.advanceTimersByTime(1);
    expect(changes).toEqual([true, false]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("waits while a menu or dialog opened from the sidebar is up, then hides", () => {
    let menuOpen = true;
    const controller = peek(() => menuOpen);
    controller.enter("toggle");
    jest.advanceTimersByTime(PEEK_OPEN_MS);
    controller.leave("toggle");
    jest.advanceTimersByTime(PEEK_CLOSE_MS * 3);
    expect(changes).toEqual([true]);
    menuOpen = false;
    jest.advanceTimersByTime(PEEK_CLOSE_MS);
    expect(changes).toEqual([true, false]);
  });

  test("a hidden sidebar is never entered: pointing at its place shows nothing", () => {
    const controller = peek();
    controller.enter("sidebar");
    jest.advanceTimersByTime(PEEK_OPEN_MS * 3);
    expect(changes).toEqual([]);
  });

  test("hide puts it away at once, and only a new visit to the toggle shows it again", () => {
    const controller = peek();
    controller.enter("toggle");
    jest.advanceTimersByTime(PEEK_OPEN_MS);
    controller.hide();
    expect(changes).toEqual([true, false]);
    jest.advanceTimersByTime(PEEK_OPEN_MS * 3);
    controller.leave("toggle");
    jest.advanceTimersByTime(PEEK_CLOSE_MS * 2);
    expect(changes).toEqual([true, false]);
    controller.enter("toggle");
    jest.advanceTimersByTime(PEEK_OPEN_MS);
    expect(changes).toEqual([true, false, true]);
  });

  test("dispose leaves no timer behind", () => {
    const controller = peek();
    controller.enter("toggle");
    controller.dispose();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(PEEK_OPEN_MS);
    expect(changes).toEqual([]);
  });
});
