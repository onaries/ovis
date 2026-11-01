import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { COMPOSER_ARTIFACTS_STORAGE_KEY, DEFAULT_SETTINGS, SettingsProvider, useSettings, type Settings } from "./settings.ts";
import { SETTINGS_STORAGE_KEY } from "./themeBoot.ts";

describe("settings across tabs", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let records: Map<string, string>;
  let events: EventTarget;
  let renderer: ReactTestRenderer | undefined;
  let settings: Settings;
  let update: (patch: Partial<Settings>) => void;
  let writes: number;
  let full: boolean;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    records = new Map();
    events = new EventTarget();
    settings = DEFAULT_SETTINGS;
    writes = 0;
    full = false;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: {
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => { if (full) throw new Error("QuotaExceededError"); writes++; records.set(key, value); },
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
      ({ settings, update } = useSettings());
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

  it("keeps another tab's change when this tab saves an unrelated setting", async () => {
    // Given a tab opened before another tab chose a wide chat and the Artifacts chip.
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ language: "en", chatWidth: "wide" }));
    records.set(COMPOSER_ARTIFACTS_STORAGE_KEY, "true");

    // When this tab changes its terminal font size.
    await act(async () => { update({ terminalFontSize: 20 }); });

    // Then the stored settings hold both tabs' changes.
    const stored = JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.chatWidth, stored.language, stored.terminalFontSize]).toEqual(["wide", "en", 20]);
    expect(records.get(COMPOSER_ARTIFACTS_STORAGE_KEY)).toBe("true");
    expect(settings.terminalFontSize).toBe(20);
  });

  it("leaves another tab's change when this tab is handed a value it already holds", async () => {
    // Given an open tab, and another tab that chose Korean since.
    await open();
    records.set(SETTINGS_STORAGE_KEY, JSON.stringify({ language: "ko" }));

    // When this tab is handed the language it already shows, and another setting.
    await act(async () => { update({ language: DEFAULT_SETTINGS.language, terminalFontSize: 20 }); });

    // Then the other tab's language stays stored.
    const stored = JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.language, stored.terminalFontSize]).toEqual(["ko", 20]);
  });

  it("stores a change whose save failed with this tab's next save", async () => {
    // Given a tab whose font size change found storage full.
    await open();
    full = true;
    await act(async () => { update({ terminalFontSize: 20 }); });
    full = false;

    // When it saves another setting once storage has room.
    await act(async () => { update({ chatWidth: "wide" }); });

    // Then both changes are stored.
    const stored = JSON.parse(records.get(SETTINGS_STORAGE_KEY) ?? "{}") as Partial<Settings>;
    expect([stored.terminalFontSize, stored.chatWidth]).toEqual([20, "wide"]);
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
