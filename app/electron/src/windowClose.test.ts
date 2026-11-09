import { describe, expect, it } from "bun:test";
import { hideWindow, type HideableWindow } from "./windowClose.ts";

/** A window that records what was done to it; leaving full screen ends when `left()` is called, as macOS ends its animation. */
function fakeWindow(fullScreen: boolean) {
  const calls: string[] = [];
  const leaveListeners: Array<() => void> = [];
  const window: HideableWindow = {
    isFullScreen: () => fullScreen,
    setFullScreen: (flag) => { calls.push(`setFullScreen(${flag})`); },
    once: (_event, listener) => { leaveListeners.push(listener); },
    removeListener: (_event, listener) => {
      const at = leaveListeners.indexOf(listener);
      if (at >= 0) leaveListeners.splice(at, 1);
    },
    hide: () => { calls.push(`hide (full screen: ${fullScreen})`); },
  };
  const left = () => {
    fullScreen = false;
    for (const listener of leaveListeners.splice(0)) listener();
  };
  return { window, calls, left };
}

describe("hideWindow", () => {
  it("hides a window that is not full screen at once", () => {
    const { window, calls } = fakeWindow(false);
    hideWindow(window, "darwin");
    expect(calls).toEqual(["hide (full screen: false)"]);
  });

  it("on macOS, leaves full screen first and hides only once it has left", () => {
    const { window, calls, left } = fakeWindow(true);
    hideWindow(window, "darwin");
    expect(calls).toEqual(["setFullScreen(false)"]);
    left();
    expect(calls).toEqual(["setFullScreen(false)", "hide (full screen: false)"]);
  });

  it("on macOS, a hide cancelled before full screen is left (the window reopened) does not hide it", () => {
    const { window, calls, left } = fakeWindow(true);
    const cancel = hideWindow(window, "darwin");
    cancel?.();
    left();
    expect(calls).toEqual(["setFullScreen(false)"]);
  });

  it("elsewhere, hides a full-screen window as it is", () => {
    const { window, calls } = fakeWindow(true);
    hideWindow(window, "linux");
    expect(calls).toEqual(["hide (full screen: true)"]);
  });
});
