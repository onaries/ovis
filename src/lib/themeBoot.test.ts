import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_SETTINGS, loadSettings, resolveTheme, sanitizeSettings } from "./settings.ts";
import { DEFAULT_APPEARANCE, readStoredAppearance, savedThemeEntry, SETTINGS_STORAGE_KEY, storedAppearance, THEMES_STORAGE_KEY } from "./themeBoot.ts";
import { themeFor } from "./themeFor.ts";
import { rowFor, SUPPORTED_ENTRIES, THEME_IDS, type ThemeEntry } from "./themes.ts";

// The page's boot script and the app read the same two records; whatever they hold, both must draw
// the same row, or the first frame is not the one the app goes on showing.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
let records: Map<string, string>;
let systemDark: boolean;
let blocked: boolean;

beforeEach(() => {
  records = new Map();
  systemDark = true;
  blocked = false;
  const storage = { getItem: (key: string) => records.get(key) ?? null };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    get localStorage() {
      if (blocked) throw new DOMException("The operation is insecure.", "SecurityError");
      return storage;
    },
    matchMedia: () => ({ matches: systemDark }),
  } });
});
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

/** The row the page's boot script draws. */
const boot = (): ThemeEntry => savedThemeEntry(() => window.localStorage);
/** The row the app draws on its first render (SettingsProvider). */
const app = (): ThemeEntry => {
  const settings = loadSettings();
  return themeFor(settings, resolveTheme(settings.theme));
};
const store = (main: string | object | null, themes: string | object | null): void => {
  records.clear();
  if (main !== null) records.set(SETTINGS_STORAGE_KEY, typeof main === "string" ? main : JSON.stringify(main));
  if (themes !== null) records.set(THEMES_STORAGE_KEY, typeof themes === "string" ? themes : JSON.stringify(themes));
};

const MAINS: (string | object | null)[] = [
  null, "{not json", "null", "42", "[]", "{}",
  { theme: "dark" }, { theme: "light" }, { theme: "system" }, { theme: "sepia", darkTheme: "nord" },
  { theme: "light", darkTheme: "codex", lightTheme: "one-light" },
  { theme: "dark", darkTheme: "nope", lightTheme: 7 },
  { theme: "light", lightTheme: "dracula" },
  { theme: "dark", darkTheme: "solarized-light" },
  { theme: "system", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" },
  { theme: "light", palette: "catppuccin" },
  { theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" },
  { theme: "system", palette: "report", paletteLight: "lilac", paletteDark: "forest" },
  { theme: "dark", palette: "catppuccin", paletteDark: "charcoal" },
  { palette: "charcoal", paletteLight: "pink" },
];
const THEMES: (string | object | null)[] = [
  null, "{not json", "null", "[]", { darkTheme: "gruvbox" },
  { darkTheme: "gruvbox", lightTheme: "gruvbox-light" },
  { darkTheme: "nope", lightTheme: "dracula" },
  { darkTheme: "one-light", lightTheme: 3, mirror: { palette: "amber" } },
];

describe("theme boot", () => {
  test("boot and settings resolve the same complete row", () => {
    let compared = 0;
    for (const main of MAINS) {
      for (const themes of THEMES) {
        for (const dark of [true, false]) {
          store(main, themes);
          systemDark = dark;
          const label = JSON.stringify({ main, themes, dark });
          // the very same row: mode, palette, surfaces and terminal colors together
          expect(boot(), label).toBe(app());
          const settings = loadSettings();
          expect(storedAppearance(readStoredAppearance(() => window.localStorage)), label)
            .toEqual({ theme: settings.theme, darkTheme: settings.darkTheme, lightTheme: settings.lightTheme });
          compared++;
        }
      }
    }
    expect(compared).toBe(MAINS.length * THEMES.length * 2);
    // every row a pick can draw
    for (const entry of SUPPORTED_ENTRIES) {
      for (const theme of ["dark", "light"] as const) {
        store({ theme, darkTheme: entry.id, lightTheme: entry.id }, null);
        expect(boot()).toBe(app());
        expect(boot()).toBe(rowFor(entry.id, theme));
      }
    }
  });

  test("protected themes survive a corrupt main record", () => {
    store("{not json", { darkTheme: "gruvbox", lightTheme: "gruvbox-light" });
    expect(boot()).toBe(rowFor("gruvbox", "dark"));
    expect(boot()).toBe(app());
    // and they win over a readable main record's own sides
    store({ theme: "light", darkTheme: "codex", lightTheme: "codex" }, { darkTheme: "nord", lightTheme: "solarized-light" });
    expect(boot()).toBe(rowFor("solarized-light", "light"));
    expect(boot()).toBe(app());
    // a damaged protected record leaves the main record's choice
    store({ theme: "light", lightTheme: "one-light" }, "{not json");
    expect(boot()).toBe(rowFor("one-light", "light"));
    expect(boot()).toBe(app());
  });

  test("legacy palette migration is identical at boot", () => {
    const cases = [
      [{ theme: "light", palette: "catppuccin" }, rowFor("catppuccin", "light")],
      [{ theme: "dark", palette: "catppuccin" }, rowFor("catppuccin", "dark")],
      [{ theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" }, null],
      [{ theme: "system", palette: "report", paletteLight: "lilac", paletteDark: "forest" }, null],
      [{ theme: "dark", palette: "amber", paletteDark: "charcoal" }, rowFor("amber", "dark")],
      [{}, null],
    ] as const;
    for (const [record, expected] of cases) {
      for (const dark of [true, false]) {
        store(record, null);
        systemDark = dark;
        const settings = sanitizeSettings(record);
        expect(boot(), JSON.stringify(record)).toBe(themeFor(settings, resolveTheme(settings.theme)));
        expect(boot()).toBe(app());
        if (expected !== null) expect(boot()).toBe(expected);
      }
    }
    store({ theme: "system", palette: "amber", paletteLight: "catppuccin", paletteDark: "charcoal" }, null);
    systemDark = false;
    expect(boot()).toBe(rowFor("catppuccin", "light"));
    systemDark = true;
    expect(boot()).toBe(rowFor("charcoal", "dark"));
  });

  test("single-mode themes retain their actual mode", () => {
    store({ theme: "light", lightTheme: "dracula" }, null);
    expect(boot()).toBe(rowFor("dracula", "dark"));
    expect(boot().mode).toBe("dark");
    expect(boot()).toBe(app());
    store({ theme: "light", darkTheme: "codex", lightTheme: "codex" }, { darkTheme: "codex", lightTheme: "nord" });
    expect(boot().mode).toBe("dark");
    expect(boot().id).toBe("nord");
    expect(boot()).toBe(app());
    store({ theme: "dark", darkTheme: "solarized-light" }, null);
    expect(boot()).toBe(rowFor("solarized-light", "light"));
    expect(boot().mode).toBe("light");
    expect(boot()).toBe(app());
    for (const id of THEME_IDS) {
      const rows = SUPPORTED_ENTRIES.filter((entry) => entry.id === id);
      if (rows.length !== 1) continue;
      for (const theme of ["dark", "light"] as const) {
        store({ theme, darkTheme: id, lightTheme: id }, null);
        expect(boot(), `${id} on ${theme}`).toBe(rows[0]!);
      }
    }
  });

  test("blocked storage uses the normal default", () => {
    store({ theme: "light", lightTheme: "one-light" }, { darkTheme: "nord", lightTheme: "one-light" });
    blocked = true;
    expect(() => window.localStorage).toThrow("insecure");
    expect(readStoredAppearance(() => window.localStorage)).toEqual({ main: { value: DEFAULT_APPEARANCE }, themes: null });
    expect(boot()).toBe(themeFor(DEFAULT_APPEARANCE, resolveTheme(DEFAULT_APPEARANCE.theme)));
    expect(boot()).toBe(app());
    expect(DEFAULT_APPEARANCE).toEqual({ theme: "system", darkTheme: DEFAULT_SETTINGS.darkTheme, lightTheme: DEFAULT_SETTINGS.lightTheme });
    // nothing stored at all is the same default, following the OS scheme
    blocked = false;
    store(null, null);
    systemDark = false;
    expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.lightTheme, "light"));
    expect(boot()).toBe(app());
    systemDark = true;
    expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.darkTheme, "dark"));
    expect(boot()).toBe(app());
  });

  test("hosted shell build defaults to system prefers-color-scheme when no appearance is saved, while saved settings and the main app keep their defaults", () => {
    const origDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
    const setShellMeta = (shell: boolean) => {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
          querySelector: (sel: string) =>
            sel === 'meta[name="ovis-shell"]' && shell ? { getAttribute: (n: string) => (n === "content" ? "relay" : null) } : null,
        },
      });
    };
    try {
      // In the hosted shell with no saved settings: follows prefers-color-scheme (system)
      setShellMeta(true);
      store(null, null);
      systemDark = false;
      expect(storedAppearance(readStoredAppearance(() => window.localStorage))).toEqual({
        theme: "system",
        darkTheme: DEFAULT_SETTINGS.darkTheme,
        lightTheme: DEFAULT_SETTINGS.lightTheme,
      });
      expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.lightTheme, "light"));
      // the settings SettingsProvider starts from keep following the system, as the first frame did
      expect(loadSettings().theme).toBe("system");
      expect(app()).toBe(boot());

      systemDark = true;
      expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.darkTheme, "dark"));

      // A saved record with darkTheme/lightTheme but no explicit theme field in shell mode still defaults theme to system
      store({ darkTheme: "amber", lightTheme: "amber" }, null);
      systemDark = false;
      expect(boot()).toBe(rowFor("amber", "light"));
      expect(boot()).toBe(app());

      // A saved explicit theme setting always wins in the hosted shell
      store({ theme: "dark", darkTheme: "codex", lightTheme: "codex" }, null);
      systemDark = false;
      expect(boot()).toBe(rowFor("codex", "dark"));
      expect(boot()).toBe(app());

      store({ theme: "light", darkTheme: "codex", lightTheme: "codex" }, null);
      systemDark = true;
      expect(boot()).toBe(rowFor("codex", "light"));
      expect(boot()).toBe(app());

      // Main Ovis app (no ovis-shell meta): a fresh device follows the OS scheme too
      setShellMeta(false);
      store(null, null);
      systemDark = false;
      expect(storedAppearance(readStoredAppearance(() => window.localStorage)).theme).toBe("system");
      expect(boot()).toBe(rowFor(DEFAULT_SETTINGS.lightTheme, "light"));
      expect(boot()).toBe(app());
    } finally {
      if (origDoc) Object.defineProperty(globalThis, "document", origDoc);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("a record without a theme choice: a dark-only app's palette stays dark, a fresh device follows the OS", () => {
    systemDark = false;
    for (const record of [{ palette: "charcoal" }, { palette: "charcoal", paletteLight: "pink" }, { palette: "nope", paletteDark: "nord" }]) {
      store(record, null);
      expect(sanitizeSettings(record).theme, JSON.stringify(record)).toBe("dark");
      expect(boot().mode, JSON.stringify(record)).toBe("dark");
      expect(boot()).toBe(app());
    }
    expect(sanitizeSettings({ palette: "charcoal", paletteLight: "pink" }).lightTheme).toBe("charcoal");
    for (const record of [{}, { language: "en" }, { darkTheme: "nord", lightTheme: "one-light" }]) {
      store(record, null);
      expect(sanitizeSettings(record).theme, JSON.stringify(record)).toBe("system");
      expect(boot().mode, JSON.stringify(record)).toBe("light");
      expect(boot()).toBe(app());
    }
  });
});
