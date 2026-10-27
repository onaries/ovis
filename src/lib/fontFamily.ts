/**
 * The terminal and chat font families the user types in Settings: a comma-separated list in
 * fallback order, like VS Code's `editor.fontFamily`. The list goes in front of the built-in
 * fonts, never in place of them, so a typo or a font missing on this device falls back as if
 * nothing had been typed.
 */

// Symbols Nerd Font Mono is the app's own (PaneTerminal.css) and covers only the private use
// area, so it never sizes a cell: it draws the Nerd Font icons a prompt or `ls` replacement
// prints, which no system font has and Safari will not take from a font the user installed.
// It stays first, ahead of a chosen font too, so the icons draw even when that font has none.
// The chrome's code stack (--font-mono, lib/typography.ts) opens with it for the same reason
export const SYMBOLS_FONT = '"Symbols Nerd Font Mono"';
// Ovis Hangul Mono is the app's own too (PaneTerminal.css): D2Coding's Hangul under a name of its
// own, with no Latin in its range, so it never sizes a cell (xterm measures `W`). It stands after
// the Korean coding fonts a device may have and before the generic monospace: Hangul that Menlo,
// Consolas or a phone's monospace lacks is drawn in a coding face beside the Latin, the same on
// every device, instead of the system's proportional Apple SD Gothic Neo or Malgun Gothic. In Ovis
// for Mac's window it is the Hangul left when measurableFontStack drops an installed D2Coding.
export const HANGUL_FAMILY = "Ovis Hangul Mono";
const HANGUL_FONT = `"${HANGUL_FAMILY}"`;
// xterm sizes every cell from the first matching font, so a proportional one (Malgun Gothic)
// must never win it: it stays behind the generic monospace as a per-glyph Hangul fallback
const TERMINAL_TEXT_FONTS =
  `"JetBrains Mono", "Fira Code", "D2Coding", Menlo, Monaco, "Cascadia Mono", Consolas, "Noto Sans Mono CJK KR", ${HANGUL_FONT}, monospace, "Malgun Gothic"`;
export const TERMINAL_FONT_STACK = `${SYMBOLS_FONT}, ${TERMINAL_TEXT_FONTS}`;

/** the chat's own stack: --font-ui in src/styles.css */
const CHAT_FONT_STACK = "var(--font-ui)";

export const FONT_FAMILY_MAX_CHARS = 200;

/** How long a font change waits for its faces before the grid is measured with whatever loaded. */
export const FONT_LOAD_TIMEOUT_MS = 3000;

// what could close the declaration or the style element, escape, or hide in the value
const UNSAFE_CHARS = /[;{}<>\\\u0000-\u001f\u007f]/g;
const QUOTES = /["']/g;
// a name CSS reads unquoted: one identifier (non-ASCII letters included), no spaces
const IDENTIFIER = /^-?[A-Za-z_\u0080-￿][\w\u0080-￿-]*$/;
// unquoted, these are keywords rather than names and make the whole list invalid
const RESERVED = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);

function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  const quoted = trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0];
  // a stray quote inside a name would end the CSS string early: it cannot be part of a name
  const name = (quoted ? trimmed.slice(1, -1) : trimmed).replace(QUOTES, "").replace(/\s+/g, " ").trim();
  if (name === "") return "";
  // a name the user quoted stays quoted: "monospace" is a font called monospace, not the generic
  return quoted || !IDENTIFIER.test(name) || RESERVED.has(name.toLowerCase()) ? `"${name}"` : name;
}

/**
 * A typed family list as a CSS `font-family` value: composed (NFC), unsafe characters dropped,
 * each name trimmed, empty ones removed, names CSS cannot read bare quoted. Names past the length
 * limit are dropped whole, so a cut never leaves an open quote. Anything that is not a string is
 * no list at all.
 */
export function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  // composed: a name copied from a macOS file name can arrive decomposed (NFD), and the browser
  // matches family names as written, so it would miss the installed font and fall back silently
  const names = value.normalize("NFC").replace(UNSAFE_CHARS, "").split(",").map(normalizeName).filter((name) => name !== "");
  let family = "";
  for (const name of names) {
    const next = family === "" ? name : `${family}, ${name}`;
    if (next.length > FONT_FAMILY_MAX_CHARS) break;
    family = next;
  }
  return family;
}

/** The xterm `fontFamily`: the icon font, the user's list, then the built-in text fonts. */
export function terminalFontStack(family: string): string {
  const chosen = sanitizeFontFamily(family);
  return chosen === "" ? TERMINAL_FONT_STACK : `${SYMBOLS_FONT}, ${chosen}, ${TERMINAL_TEXT_FONTS}`;
}

/** The width of PROBE_TEXT in a `font-family` list: as the page draws it, and as a canvas measures it. */
export interface FontWidths {
  drawn(family: string): number;
  measured(family: string): number;
}

// narrow and wide Latin, a digit and Hangul: any text face changes the width of some of them
const PROBE_TEXT = "mmmmmmmmmmlli1WW가나다";
const PROBE_SIZE = "32px";
// a monospaced face can match monospace's Latin to the pixel, never serif's as well
const PROBE_FALLBACKS = ["monospace", "serif"] as const;
const PROBE_TOLERANCE_PX = 0.5;
const GENERIC_FAMILIES = new Set(["monospace", "serif", "sans-serif", "cursive", "fantasy", "system-ui", "ui-monospace", "ui-serif", "ui-sans-serif", "ui-rounded", "math", "emoji", "fangsong"]);

let pageWidths: FontWidths | undefined;

/** This page's measurements, each made once: null without a document to measure in. */
function browserFontWidths(): FontWidths | null {
  if (pageWidths) return pageWidths;
  const context = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  if (!context || !document.body) return null;
  const widths = new Map<string, number>();
  const once = (kind: string, measure: (family: string) => number) => (family: string): number => {
    const key = `${kind} ${family}`;
    let width = widths.get(key);
    if (width === undefined) {
      width = measure(family);
      widths.set(key, width);
    }
    return width;
  };
  pageWidths = {
    drawn: once("drawn", (family) => {
      const span = document.createElement("span");
      span.style.cssText = "position:absolute;visibility:hidden;white-space:pre;letter-spacing:0";
      span.style.fontSize = PROBE_SIZE;
      span.style.fontFamily = family;
      span.textContent = PROBE_TEXT;
      document.body.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    }),
    measured: once("measured", (family) => {
      context.font = `${PROBE_SIZE} ${family}`;
      return context.measureText(PROBE_TEXT).width;
    }),
  };
  return pageWidths;
}

function finds(width: (family: string) => number, name: string): boolean {
  return PROBE_FALLBACKS.some((fallback) => Math.abs(width(`${name}, ${fallback}`) - width(fallback)) > PROBE_TOLERANCE_PX);
}

/**
 * The stack without the families this page draws but its canvas cannot measure. WebKit in an
 * app's web view (Ovis for Mac's window) draws text in a font the user installed, while its
 * canvas sees only the system's fonts; Safari hides an installed font from both, Chromium shows
 * it to both. xterm sizes its cells from a canvas (TextMetrics), and lib/terminalGlyphs.ts fits
 * wide glyphs from one: with JetBrains Mono and D2Coding installed, the app measured a grid in
 * Menlo and drew it in those, rows too short for their glyphs, and Hangul it measured as Apple SD
 * Gothic Neo was enlarged past its two cells. Left out, such a family falls back as if it were not
 * installed, and the terminal draws what Safari draws. The bundled icon and Hangul faces, which the
 * canvas measures as the page draws them, and generic families stay.
 */
export function measurableFontStack(stack: string, widths: FontWidths | null = browserFontWidths()): string {
  if (!widths) return stack;
  const names = stack.split(",").map((name) => name.trim());
  const kept = names.filter((name) => name === SYMBOLS_FONT || name === HANGUL_FONT || GENERIC_FAMILIES.has(name) || !finds(widths.drawn, name) || finds(widths.measured, name));
  return kept.length === names.length ? stack : kept.join(", ");
}

/** The chat body's `font-family`, or null to keep the UI font. */
export function chatFontStack(family: string): string | null {
  const chosen = sanitizeFontFamily(family);
  return chosen === "" ? null : `${chosen}, ${CHAT_FONT_STACK}`;
}

// Latin and Hangul, so a font split by unicode-range loads the faces the grid measures and shows
const FONT_LOAD_SAMPLE = "Mg가";

/**
 * Resolves once the faces of `stack` are loaded, or failed, or the timeout passed: never rejects,
 * since a font that cannot load falls back like a missing one. An installed font has no face to
 * load and resolves at once. The bundled Hangul face is not waited for: it has no Latin, so it never
 * sizes the grid, and fetching it here would fetch it on a device whose own Korean font draws the
 * Hangul ahead of it, and hold the new font back until it came. It loads when a pane prints Korean
 * that reaches it, and lib/terminalGlyphs.ts measures again then.
 */
export async function loadFontStack(stack: string, sizePx: number, timeoutMs = FONT_LOAD_TIMEOUT_MS): Promise<void> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts || typeof fonts.load !== "function") return;
  // CSS matches family names without regard to case: "ovis hangul mono" typed in Settings is the bundled face too
  const families = stack.split(",").map((name) => name.trim()).filter((name) => name.replace(QUOTES, "").toLowerCase() !== HANGUL_FAMILY.toLowerCase()).join(", ");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fonts.load(`${sizePx}px ${families}`, FONT_LOAD_SAMPLE),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch {
    /* the grid is measured with the fallback, as for a font that is not installed */
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
