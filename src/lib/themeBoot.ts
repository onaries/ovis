/**
 * The saved appearance without React: the one reading of the two stored records that both the
 * page's boot script (src/theme-bootstrap.ts, run before the first paint) and loadSettings use, so
 * the theme the page is first drawn in is the one the app goes on drawing.
 */
import { shellMode } from "./shellMode.ts";
import { DEFAULT_THEME, isThemeId, type ThemeEntry, type ThemeId } from "./themes.ts";
import { themeFor } from "./themeFor.ts";

export type ThemeSetting = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

/** The part of the settings that picks the row the page is drawn in. */
export interface Appearance {
  theme: ThemeSetting;
  darkTheme: ThemeId;
  lightTheme: ThemeId;
}

export const SETTINGS_STORAGE_KEY = "ovis:settings";
/** The theme choice kept apart from the main record, so a damaged main record does not lose it. */
export const THEMES_STORAGE_KEY = "ovis:themes";

export const DEFAULT_APPEARANCE: Appearance = { theme: "system", darkTheme: DEFAULT_THEME, lightTheme: DEFAULT_THEME };

/** In the hosted shell build only, a first visit with no saved theme follows prefers-color-scheme (system). */
export function defaultThemeSetting(): ThemeSetting {
  return shellMode() === "relay" ? "system" : DEFAULT_APPEARANCE.theme;
}

/** The appearance of a stored record, with the migration of the records from before the two theme sides. */
export function sanitizeAppearance(raw: unknown): Appearance {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  // A record without a theme choice: one that carries a palette is from the dark-only app (every
  // record saved since has its theme), so it stays dark; anything else is a fresh device, on the OS scheme.
  const beforeThemes = "palette" in record || "paletteDark" in record || "paletteLight" in record;
  const theme = record["theme"] === "dark" || record["theme"] === "light" || record["theme"] === "system" ? record["theme"] : beforeThemes ? "dark" : defaultThemeSetting();
  const palette = isThemeId(record["palette"]) ? record["palette"] : "amber";
  // Absence migrates (a record from before themes wore amber, so it keeps amber); an explicitly
  // unknown id falls back to the default, not a stale pair.
  const darkTheme = "darkTheme" in record
    ? (isThemeId(record["darkTheme"]) ? record["darkTheme"] : DEFAULT_THEME)
    : theme === "dark" ? palette : isThemeId(record["paletteDark"]) ? record["paletteDark"] : theme === "system" && record["paletteDark"] !== undefined ? "amber" : palette;
  const lightTheme = "lightTheme" in record
    ? (isThemeId(record["lightTheme"]) ? record["lightTheme"] : DEFAULT_THEME)
    : theme === "light" ? palette : isThemeId(record["paletteLight"]) ? record["paletteLight"] : theme === "system" && record["paletteLight"] !== undefined ? "amber" : palette;
  return { theme, darkTheme, lightTheme };
}

/** The two records as stored: each read on its own, a missing, damaged or unreadable one left out. */
export interface StoredAppearance {
  /** the parsed main record, when there is one that parses */
  main: { value: unknown } | null;
  /** the protected theme sides, when that record parses and holds both */
  themes: { darkTheme: unknown; lightTheme: unknown } | null;
}

/** Reads both records; `storage` is a getter because reading localStorage itself throws where storage is blocked. */
export function readStoredAppearance(storage: () => Pick<Storage, "getItem">): StoredAppearance {
  const stored: StoredAppearance = { main: { value: DEFAULT_APPEARANCE }, themes: null };
  try {
    const raw = storage().getItem(SETTINGS_STORAGE_KEY);
    if (raw !== null) stored.main = { value: JSON.parse(raw) };
  } catch {
    /* a damaged main record does not hide the protected theme choice */
  }
  try {
    const raw = storage().getItem(THEMES_STORAGE_KEY);
    const themes: unknown = raw === null ? null : JSON.parse(raw);
    if (typeof themes === "object" && themes !== null && "darkTheme" in themes && "lightTheme" in themes) {
      stored.themes = { darkTheme: themes.darkTheme, lightTheme: themes.lightTheme };
    }
  } catch { /* denied or damaged storage: keep the main record */ }
  return stored;
}

/** The appearance the records hold: the main record's (or the default), with the protected sides over it. */
export function storedAppearance(stored: StoredAppearance): Appearance {
  const main = stored.main === null ? { ...DEFAULT_APPEARANCE, theme: defaultThemeSetting() } : sanitizeAppearance(stored.main.value);
  return stored.themes === null ? main : sanitizeAppearance({ ...main, ...stored.themes });
}

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(setting: ThemeSetting): ResolvedTheme {
  if (setting !== "system") return setting;
  return typeof window !== "undefined" && window.matchMedia?.(DARK_QUERY).matches === false ? "light" : "dark";
}

/** The row the saved appearance draws now. */
export function savedThemeEntry(storage: () => Pick<Storage, "getItem">): ThemeEntry {
  const appearance = storedAppearance(readStoredAppearance(storage));
  return themeFor(appearance, resolveTheme(appearance.theme));
}

/** Puts a row on the document: the attributes src/styles.css keys its tokens on, and the browser's own colors. */
export function applyThemeEntry(root: HTMLElement, entry: ThemeEntry): void {
  root.dataset["theme"] = entry.mode;
  root.dataset["palette"] = entry.id;
  root.style.colorScheme = entry.mode;
  // `<meta name="theme-color">` follows the panel surface so the PWA title bar matches
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", entry.bgPanel);
}
