import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_SETTINGS, SettingsProvider, useSettings, type Settings } from "./settings.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

describe("shortcut overrides across tabs", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let events: EventTarget;
  let renderer: ReactTestRenderer | undefined;
  let settings: Settings;
  let writes: number;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    records = new Map();
    events = new EventTarget();
    settings = DEFAULT_SETTINGS;
    writes = 0;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: {
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => { writes++; records.set(key, value); },
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "#12100e" }) });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function open(): Promise<void> {
    function Probe() {
      settings = useSettings().settings;
      return null;
    }
    await act(async () => { renderer = create(createElement(SettingsProvider, null, createElement(Probe))); });
  }

  async function storage(key: string | null): Promise<void> {
    const event = new Event("storage");
    Object.defineProperties(event, {
      key: { value: key },
      storageArea: { value: window.localStorage },
    });
    await act(async () => { events.dispatchEvent(event); });
  }

  it("updates a mounted consumer when another tab saves an override", async () => {
    // Given an already-open tab with the defaults.
    await open();
    expect(settings.shortcutOverrides).toEqual({});
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" }, terminalFontSize: 22 }));

    // When the browser announces another tab's settings write.
    await storage(SETTINGS_STORAGE_KEY);

    // Then the override is live without echoing the write or changing other settings.
    expect(settings.shortcutOverrides).toEqual({ palette: "ctrl+k" });
    expect(settings.terminalFontSize).toBe(DEFAULT_SETTINGS.terminalFontSize);
    expect(writes).toBe(0);
  });

  it.each([SETTINGS_STORAGE_KEY, null])("restores defaults when storage is removed with key %j", async (key) => {
    // Given an open tab with a saved override.
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));
    await open();
    records.clear();

    // When another tab removes the settings record or clears storage.
    await storage(key);

    // Then the mounted consumer returns to the default shortcuts.
    expect(settings.shortcutOverrides).toEqual({});
  });

  it("ignores storage events for unrelated keys", async () => {
    // Given an open tab and a settings record not announced by this event.
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ shortcutOverrides: { palette: "ctrl+k" } }));

    // When an unrelated record changes.
    await storage("ovis:unrelated");

    // Then the shortcut state stays as it was.
    expect(settings.shortcutOverrides).toEqual({});
  });
});
