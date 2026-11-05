import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { installHintKind, readHintDismissed, writeHintDismissed, type InstallHintEnvironment } from "./installHint.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ELECTRON = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Ovis/0.5.0 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36";

const env = (over: Partial<InstallHintEnvironment>): InstallHintEnvironment => ({
  userAgent: IPHONE, maxTouchPoints: 5, secure: true, installed: false, nativeApp: false, dismissed: false, ...over,
});

describe("installHintKind", () => {
  it("tells an iPhone or iPad browser tab to add the page to the home screen", () => {
    expect(installHintKind(env({ userAgent: IPHONE }))).toBe("ios");
    expect(installHintKind(env({ userAgent: IPAD, maxTouchPoints: 5 }))).toBe("ios");
  });

  it("tells an Android browser tab to install the app", () => {
    expect(installHintKind(env({ userAgent: ANDROID }))).toBe("android");
  });

  it("stays away from desktop browsers and the desktop app", () => {
    expect(installHintKind(env({ userAgent: DESKTOP, maxTouchPoints: 0 }))).toBeNull();
    expect(installHintKind(env({ userAgent: ELECTRON, maxTouchPoints: 0 }))).toBeNull();
    // a Mac reports the iPad's user agent without touch points
    expect(installHintKind(env({ userAgent: IPAD, maxTouchPoints: 0 }))).toBeNull();
  });

  it("stays away once the page runs installed or inside the phone apps", () => {
    expect(installHintKind(env({ installed: true }))).toBeNull();
    expect(installHintKind(env({ userAgent: ANDROID, installed: true }))).toBeNull();
    expect(installHintKind(env({ nativeApp: true }))).toBeNull();
    expect(installHintKind(env({ userAgent: ANDROID, nativeApp: true }))).toBeNull();
  });

  it("stays away once dismissed", () => {
    expect(installHintKind(env({ dismissed: true }))).toBeNull();
    expect(installHintKind(env({ userAgent: ANDROID, dismissed: true }))).toBeNull();
  });

  it("stays away over plain http, where an installed page gets no alerts", () => {
    expect(installHintKind(env({ secure: false }))).toBeNull();
    expect(installHintKind(env({ userAgent: ANDROID, secure: false }))).toBeNull();
  });
});

describe("the dismissal", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  let records: Map<string, string>;
  let failWrites: boolean;
  beforeEach(() => {
    records = new Map();
    failWrites = false;
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => { if (failWrites) throw new Error("quota"); records.set(key, value); },
    } } });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
  });

  it("is remembered across page loads", () => {
    expect(readHintDismissed()).toBe(false);
    writeHintDismissed();
    expect(readHintDismissed()).toBe(true);
  });

  it("does not throw when storage refuses the write", () => {
    failWrites = true;
    expect(() => writeHintDismissed()).not.toThrow();
    expect(readHintDismissed()).toBe(false);
  });
});
