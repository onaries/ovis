import { describe, expect, it } from "bun:test";

import { armHints, browserStorage, finishHints, FIRST_HINTS_KEY, hideSetupRow, hintsPending, setupRowOn, setupRowState } from "./firstHints.ts";

const memory = () => {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
};

describe("first-start hints", () => {
  it("are armed once, by the first run, and stay done once finished", () => {
    const storage = memory();
    expect(hintsPending(storage)).toBe(false);
    armHints(storage);
    expect(hintsPending(storage)).toBe(true);
    finishHints(storage);
    expect(hintsPending(storage)).toBe(false);
    armHints(storage);
    expect(storage.values.get(FIRST_HINTS_KEY)).toBe("done");
  });

  it("are none where storage refuses", () => {
    const refusing = { getItem: (): string | null => { throw new Error("denied"); }, setItem: (): void => { throw new Error("denied"); } };
    expect(() => armHints(refusing)).not.toThrow();
    expect(hintsPending(refusing)).toBe(false);
  });
});

describe("the sidebar's setup row", () => {
  it("shows only once a begun guide closed, and stays hidden once hidden", () => {
    const storage = memory();
    expect(setupRowState(storage)).toBeNull();
    setupRowOn(storage);
    expect(setupRowState(storage)).toBe("on");
    hideSetupRow(storage);
    setupRowOn(storage);
    expect(setupRowState(storage)).toBe("hidden");
  });
});

describe("browserStorage", () => {
  it("is null where reading the store itself throws, rather than taking the app down", () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: Object.defineProperty({}, "localStorage", { get: () => { throw new DOMException("blocked", "SecurityError"); } }) });
    try {
      expect(browserStorage()).toBeNull();
    } finally {
      if (before) Object.defineProperty(globalThis, "window", before); else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
