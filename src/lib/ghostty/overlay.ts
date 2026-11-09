/**
 * libghostty-vt draws every xterm terminal's screen, Kitty graphics pictures included, while xterm stays
 * the engine under it. xterm draws by itself only where this layer cannot: a module that does not load or
 * fails, and an iTerm2 or sixel picture (Pictures in the terminal), which libghostty does not take.
 *
 * xterm still takes every key, IME syllable, paste, click, selection, link, search and scroll, and
 * still answers the program's queries: everything Ovis built on it keeps working. Its text layer
 * is hidden (PaneTerminal.css `[data-renderer="ghostty"]`), and a layer of plain DOM text, one div per
 * row, is drawn over its screen at its cell size from the same bytes, in the same order. libghostty
 * answers nothing: a reply it made to a replayed stream would reach the program as typing.
 */
import type { IDisposable, Terminal } from "@xterm/xterm";
import { terminalDrawsPictures } from "../terminalImages.ts";
import { followLateFaces, glyphFit, iconScale, oversizedIcon } from "../terminalGlyphs.ts";
import { readableColor } from "../terminalFold.ts";
import { isBoxGlyph } from "../terminalBoxGlyphs.ts";
import { VIEW_MOVED_EVENT } from "./viewMoved.ts";
import { GhosttyVt, STYLE_BOLD, STYLE_FAINT, STYLE_INVERSE, STYLE_INVISIBLE, STYLE_ITALIC, STYLE_STRIKE, STYLE_UNDERLINE_MASK, type GhosttyColors, type GhosttyImage, type GhosttyRun } from "./vt.ts";

const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));

export interface GhosttyOverlay { dispose(): void }

/**
 * The lines a frame added: when the screen scrolled up by some rows, the rows that moved are not new, only
 * the ones that came in at the bottom and any row that changed in place.
 */
export function newLines(before: readonly string[], after: readonly string[]): string[] {
  const rows = after.length;
  let best = 0;
  let bestMatches = -1;
  for (let shift = 0; shift < rows; shift++) {
    let matches = 0;
    for (let y = 0; y + shift < rows; y++) if (after[y] && before[y + shift] === after[y]) matches++;
    if (matches > bestMatches) { best = shift; bestMatches = matches; }
  }
  return after.filter((line, y) => line && (y >= rows - best || before[y + best] !== line));
}

/** Nerd Font icons and the like, which a font means to fill one cell (terminalGlyphs.ts oversizedIcon) */
const PRIVATE_USE = /[\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]/u;
/** Powerline's separators run from the top of the row to the bottom: made smaller, a prompt's coloured segments would not join, so they are only narrowed */
const POWERLINE = /^[\ue0b0-\ue0d7]$/u;
/** Powerline glyphs xterm draws in their own colour whatever the contrast (its isPowerlineGlyph) */
const POWERLINE_GLYPH = /^[\ue0a4-\ue0d6]$/u;
/** distinct glyphs measured before the measures start over: a long session of ever new graphemes must not grow without end */
const MEASURED_MAX = 4096;

const latin1 = new TextDecoder("latin1");
/** an iTerm2 inline picture (OSC 1337 File=, or MultipartFile= as imgcat sends it) or a sixel one (DCS ... q): the pictures xterm's image addon draws */
export function hasXtermPicture(data: string | Uint8Array): boolean {
  const text = typeof data === "string" ? data : latin1.decode(data);
  return text.includes("\x1b]1337;File=") || text.includes("\x1b]1337;MultipartFile=") || /\x1bP[0-9;]*q/.test(text);
}

/** hasXtermPicture over a stream of writes: a picture's start split between two writes is told too */
export function xtermPictureScanner(): (data: string | Uint8Array) => boolean {
  let tail = "";
  return (data) => {
    const text = tail + (typeof data === "string" ? data : latin1.decode(data));
    // longer than any start it looks for (`ESC ] 1337 ; MultipartFile =`, a sixel DCS with its parameters)
    tail = text.slice(-64);
    return hasXtermPicture(text);
  };
}

/** how long after a wheel or a swipe a frame is taken for herdr's repaint of the scrolled screen, not for output */
const VIEW_REPAINT_MS = 1000;
/** a wheel or swipe, and herdr's view moved by the viewport tools (TerminalViewportTools.tsx) */
const VIEW_GESTURES = ["wheel", "touchmove", VIEW_MOVED_EVENT];

/** lines of one frame read out, so a flood does not drown the reader */
const ANNOUNCED_LINES = 20;

interface XtermRowRenderer { renderRows(start: number, end: number): void }

/** xterm's DOM renderer, which writes its rows; xterm.js has no public way to stop it drawing */
function xtermRowRenderer(term: Terminal): XtermRowRenderer | null {
  const core = (term as unknown as { _core?: { _renderService?: { _renderer?: { value?: XtermRowRenderer } } } })._core;
  const renderer = core?._renderService?._renderer?.value;
  return renderer && typeof renderer.renderRows === "function" ? renderer : null;
}

/** xterm.js 6's own ANSI colours, which it draws with wherever the theme names none (the dark palettes name none) */
const XTERM_ANSI = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

function themeColors(term: Terminal): GhosttyColors {
  const theme = term.options.theme ?? {};
  const ansi = [theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite]
    .map((color, index) => color || XTERM_ANSI[index]!);
  return { foreground: theme.foreground ?? "#d4d4d4", background: theme.background ?? "#1e1e1e", cursor: theme.cursor ?? theme.foreground ?? "#d4d4d4", ansi };
}

/**
 * Draws `term` with libghostty from now on, until disposed; resolves once the module is loaded, or
 * null when `takeBacklog` (the bytes xterm was given so far, called once the module is ready) has none
 * to give.
 */
export async function attachGhosttyOverlay(term: Terminal, host: HTMLElement, takeBacklog: () => (string | Uint8Array)[] | null): Promise<GhosttyOverlay | null> {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) throw new Error("ghostty overlay: the terminal is not open");
  const vt = await GhosttyVt.create(term.cols, term.rows);
  const backlog = takeBacklog();
  // a picture only xterm draws already moved xterm's rows: xterm keeps drawing this pane (#2980)
  // one scanner from the first byte on, so a picture's start split across the backlog and a later write is told
  const pictureIn = xtermPictureScanner();
  if (!backlog || (terminalDrawsPictures(term) && backlog.some(pictureIn))) {
    vt.dispose();
    return null;
  }
  let disposed = false;
  const layer = document.createElement("div");
  layer.className = "ghostty-layer";
  const below = document.createElement("div");
  below.className = "ghostty-images";
  const text = document.createElement("div");
  text.className = "ghostty-text";
  const above = document.createElement("div");
  above.className = "ghostty-images is-above";
  const cursor = document.createElement("div");
  cursor.className = "ghostty-cursor";
  // xterm's rows are hidden, and with them what a screen reader read: these rows are read instead, and
  // lines the program writes are announced (as xterm's screen reader mode does), never the pictures
  for (const decoration of [below, above, cursor]) decoration.setAttribute("aria-hidden", "true");
  const announcer = document.createElement("div");
  announcer.className = "visually-hidden";
  announcer.setAttribute("aria-live", "polite");
  layer.append(below, text, above, cursor, announcer);
  screen.append(layer);

  let rowEls: HTMLDivElement[] = [];
  // each row's text, kept with rowHtml through a rebuild: a row the next frame leaves alone is not new (#2963)
  let rowText: string[] = [];
  // the screen a pane opens on is what is there already: read, not announced
  let primed = false;
  // bytes reached libghostty since the last frame: a frame without any only scrolled the view, which announces nothing
  let written = false;
  // on herdr's own server xterm keeps no history: a wheel or a swipe scrolls herdr's screen, which comes back as
  // written bytes (TerminalViewportTools.tsx). Frames until a moment after the gesture tell nothing
  let viewMovedUntil = 0;
  const viewMoved = (): void => { if (!term.options.scrollback) viewMovedUntil = performance.now() + VIEW_REPAINT_MS; };
  // the screen at the bottom as the last frame there drew it
  let bottomText: string[] = [];
  // what each row shows: libghostty hands over only the rows that changed, so fresh row elements are refilled from it
  let rowHtml: string[] = [];
  // the runs each row was drawn from, to draw it again once a late face changes what its glyphs measure
  const rowRuns: GhosttyRun[][] = [];
  let cellW = 0;
  let cellH = 0;
  let perCell = false;
  let frameQueued = false;
  const decoded = new Map<string, HTMLCanvasElement>();

  const metrics = (): void => {
    const box = screen.getBoundingClientRect();
    cellW = box.width / term.cols;
    cellH = box.height / term.rows;
    const font = term.options.fontFamily ?? "monospace";
    const size = term.options.fontSize ?? 13;
    Object.assign(layer.style, { fontFamily: font, fontSize: `${size}px`, width: `${box.width}px`, height: `${box.height}px` });
    layer.style.setProperty("--ghostty-cw", `${cellW}px`);
    layer.style.setProperty("--ghostty-ch", `${cellH}px`);
    // each cell is xterm's width: a font whose advance differs is spaced to it. The probe measures the font's own
    // advance, not the spacing the last fit gave the layer: inherited, a wrong spacing flipped sign at every fit and
    // never healed, and Latin was drawn squashed over itself or spread apart
    const probe = document.createElement("span");
    probe.textContent = "W".repeat(50);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;letter-spacing:0";
    text.append(probe);
    const advance = probe.getBoundingClientRect().width / 50;
    probe.textContent = "i".repeat(50);
    const narrow = probe.getBoundingClientRect().width / 50;
    probe.remove();
    perCell = Math.abs(advance - narrow) > 0.5;
    layer.style.letterSpacing = `${cellW - advance}px`;
  };

  /** what a screen reader hears: the frame's new lines, the newest kept when a program floods. Only the latest
   *  message stays in the region: NVDA read a growing log whole, every earlier message again */
  const announce = (lines: string[]): void => {
    if (lines.length === 0) return;
    announcer.textContent = lines.slice(-ANNOUNCED_LINES).join("\n");
  };

  const rebuildRows = (): void => {
    text.textContent = "";
    rowEls = [];
    for (let y = 0; y < term.rows; y++) {
      const row = document.createElement("div");
      row.className = "ghostty-row";
      row.innerHTML = rowHtml[y] ?? "";
      text.append(row);
      rowEls.push(row);
    }
  };

  /** every row drawn again from its runs: a new cell size or a late face changes how its glyphs fit */
  const redrawRows = (): void => {
    rowRuns.forEach((runs, y) => {
      const row = rowEls[y];
      if (!row) return;
      let html = "";
      for (const run of runs) html += runHtml(run);
      if (rowHtml[y] === html) return;
      row.innerHTML = html;
      rowHtml[y] = html;
    });
  };

  let grid = "";
  const fit = (): void => {
    metrics();
    // a new grid redraws every row; a cell-size change alone redraws none, so the rebuilt rows refill from rowHtml
    const now = `${term.cols}x${term.rows}@${cellW}x${cellH}:${perCell}`;
    if (now === grid) return;
    grid = now;
    vt.resize(term.cols, term.rows, cellW, cellH);
    // rows past a shorter grid are gone
    rowRuns.length = Math.min(rowRuns.length, term.rows);
    rebuildRows();
    redrawRows();
    schedule();
  };

  const colors = (): void => {
    const palette = themeColors(term);
    vt.setColors(palette);
    layer.style.color = palette.foreground;
    cursor.style.background = palette.cursor;
  };

  // glyphs are fitted to their cells as xterm's rows are (terminalGlyphs.ts): a wide glyph that leaves its two cells
  // half empty is drawn larger (Hangul on a 0.6em Latin cell), an icon wider than its one cell smaller
  let measure: CanvasRenderingContext2D | null | undefined;
  const widths = new Map<string, number>();
  const asked = new Set<string>();
  const glyphWidth = (text: string, flags: number): number => {
    const key = `${flags & (STYLE_BOLD | STYLE_ITALIC)}${text}`;
    let width = widths.get(key);
    if (width === undefined) {
      measure ??= document.createElement("canvas").getContext("2d");
      if (!measure) return 0;
      const { fontFamily, fontSize, fontWeight, fontWeightBold } = term.options;
      measure.font = `${flags & STYLE_ITALIC ? "italic " : ""}${flags & STYLE_BOLD ? fontWeightBold ?? "bold" : fontWeight ?? "normal"} ${fontSize ?? 13}px ${fontFamily ?? "monospace"}`;
      width = measure.measureText(text).width;
      if (widths.size >= MEASURED_MAX) widths.clear();
      widths.set(key, width);
    }
    return width;
  };
  /** a cell drawn in a box of its own, or null for plain text; `glyph` is the inherited style its glyph takes (runHtml) */
  const fittedCell = ({ text, wide }: GhosttyRun["cells"][number], flags: number, glyph: string): string | null => {
    const bold = flags & STYLE_BOLD ? " xterm-bold" : "";
    if (!wide && !PRIVATE_USE.test(text)) {
      return perCell ? `<span class="ghostty-cell${bold}"${glyph ? ` style="${glyph}"` : ""}>${escapeHtml(text)}</span>` : null;
    }
    // each character asks for its faces once a font, as xterm's rows do
    if (!asked.has(text)) {
      if (asked.size >= MEASURED_MAX) asked.clear();
      asked.add(text);
      lateFaces.ask(term.options.fontFamily ?? "", text);
    }
    const width = glyphWidth(text, flags);
    const size = term.options.fontSize ?? 13;
    const own = (...css: string[]): string => [...css, glyph].filter(Boolean).join(";");
    // xterm's `span:not(.xterm-bold)` rule sets every span's weight under its screen: a bold cell's box says it is bold
    if (!wide) {
      if (!oversizedIcon(text, width, cellW)) return null;
      // a separator keeps its height and is narrowed to its cell, as xterm's rows draw it
      if (POWERLINE.test(text)) return `<span class="ghostty-icon${bold}"><span class="ghostty-fit${bold}" style="${own(`transform:scaleX(${cellW / width})`, "transform-origin:0 0")}">${escapeHtml(text)}</span></span>`;
      return `<span class="ghostty-icon${bold}" style="${own(`font-size:${size * iconScale([width], cellW)}px`)}">${escapeHtml(text)}</span>`;
    }
    const fit = glyphFit(2 * cellW - width, width, cellW);
    if (!fit) return `<span class="ghostty-wide${bold}"${glyph ? ` style="${glyph}"` : ""}>${escapeHtml(text)}</span>`;
    const scale = fit.scale !== 1 ? `font-size:${size * fit.scale}px` : "";
    const stretch = fit.stretch !== 1 ? `transform:scaleX(${fit.stretch})` : "";
    return `<span class="ghostty-wide${bold}"><span class="ghostty-fit${bold}" style="${own(scale, stretch)}">${escapeHtml(text)}</span></span>`;
  };
  const lateFaces = followLateFaces(document.fonts as Iterable<FontFace> | undefined, (callback) => requestAnimationFrame(callback), () => {
    widths.clear();
    redrawRows();
  });

  const runHtml = (run: GhosttyRun): string => {
    let fg = run.fg, bg = run.bg;
    const theme = themeColors(term);
    if (run.flags & STYLE_INVERSE) [fg, bg] = [bg ?? theme.background, fg ?? theme.foreground];
    // xterm's minimumContrastRatio, as its own rows and a folded mirror draw it (terminalFold.ts cellStyle)
    const drawn = fg;
    if (fg !== null || bg !== null) {
      const text = fg ?? theme.foreground;
      const readable = readableColor(text, bg ?? theme.background, term.options.minimumContrastRatio ?? 1);
      if (fg !== null || readable !== text) fg = readable;
    }
    // a box, block or Powerline glyph is part of a drawing, its colour against the next one's: xterm keeps it as written
    // (treatGlyphAsBackgroundColor), and so does this layer
    const keepsColour = (text: string): boolean => fg !== drawn && (isBoxGlyph(text) || POWERLINE_GLYPH.test(text));
    // what the run's box alone takes
    const box = [`left:calc(var(--ghostty-cw)*${run.x})`];
    if (bg) box.push(`background:${bg}`);
    if (run.flags & STYLE_BOLD) box.push("font-weight:bold");
    // what its text inherits: a faint run dims its text, not its background, as xterm and a folded mirror draw it
    const colours = (colour: string | null): string[] => {
      const css: string[] = [];
      if (colour) css.push(`color:${colour}`);
      if (run.flags & STYLE_FAINT) css.push(`color:color-mix(in srgb, ${colour ?? "currentColor"} 50%, transparent)`);
      if (run.flags & STYLE_INVISIBLE) css.push("color:transparent");
      return css;
    };
    const rest: string[] = [];
    if (run.flags & STYLE_ITALIC) rest.push("font-style:italic");
    // an underline or strikethrough takes the colour of the element that draws it: it goes with the colour
    const lines = [run.flags & STYLE_UNDERLINE_MASK ? "underline" : "", run.flags & STYLE_STRIKE ? "line-through" : ""].filter(Boolean);
    if (lines.length) rest.push(`text-decoration:${lines.join(" ")}`);
    const glyph = [...colours(fg), ...rest];
    const kept = colours(drawn ?? theme.foreground);
    // an element whose parent has an inherited value of its own (a colour) misses the browser's style cache and is
    // styled from scratch: on a screen of Korean in a colour a cell, three elements a cell made each frame's style
    // recalculation several times longer than xterm's. A run that is only boxed cells (a wide or icon cell each)
    // gives the inherited values to the innermost box instead, so no element sits under a parent with a colour of its own
    let boxed = run.cells.map((cell) => fittedCell(cell, run.flags, keepsColour(cell.text) ? kept.join(";") : ""));
    const leaves = glyph.length > 0 && boxed.every((html) => html !== null);
    if (leaves) boxed = run.cells.map((cell) => fittedCell(cell, run.flags, [...(keepsColour(cell.text) ? kept : colours(fg)), ...rest].join(";")));
    let body = "";
    let plain = "";
    run.cells.forEach((cell, index) => {
      const fitted = boxed[index] ?? (keepsColour(cell.text) ? `<span style="${kept.join(";")}">${escapeHtml(cell.text)}</span>` : null);
      if (fitted) {
        if (plain) { body += escapeHtml(plain); plain = ""; }
        body += fitted;
      } else plain += cell.text;
    });
    if (plain) body += escapeHtml(plain);
    return `<span style="${(leaves ? box : [...box, ...glyph]).join(";")}">${body}</span>`;
  };

  const picture = (image: GhosttyImage): HTMLCanvasElement | null => {
    const key = `${image.id}:${image.generation}`;
    let source = decoded.get(key);
    if (!source) {
      const pixels = vt.imagePixels(image.id);
      if (!pixels) return null;
      for (const old of decoded.keys()) if (old.startsWith(`${image.id}:`)) decoded.delete(old);
      source = document.createElement("canvas");
      source.width = pixels.width;
      source.height = pixels.height;
      source.getContext("2d")?.putImageData(pixels, 0, 0);
      decoded.set(key, source);
    }
    return source;
  };

  const drawImages = (images: GhosttyImage[]): void => {
    below.textContent = "";
    above.textContent = "";
    const live = new Set(images.map((image) => `${image.id}:${image.generation}`));
    for (const key of decoded.keys()) if (!live.has(key)) decoded.delete(key);
    for (const image of [...images].sort((a, b) => a.z - b.z)) {
      const source = picture(image);
      if (!source || image.width === 0 || image.height === 0) continue;
      const scale = window.devicePixelRatio || 1;
      const canvas = document.createElement("canvas");
      canvas.className = "ghostty-image";
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      // the grid is xterm's, in CSS pixels; libghostty placed the picture in the cell size it was given
      Object.assign(canvas.style, {
        left: `${image.col * cellW + image.offsetX}px`, top: `${image.row * cellH + image.offsetY}px`,
        width: `${image.width}px`, height: `${image.height}px`,
      });
      const { x, y, width, height } = image.source;
      canvas.getContext("2d")?.drawImage(source, x, y, width || source.width, height || source.height, 0, 0, canvas.width, canvas.height);
      (image.layer === 2 ? above : below).append(canvas);
    }
  };

  // font, theme and history follow xterm's options, which the font and theme effects set in place
  let options: unknown[] = [];
  const optionsChanged = (): boolean => {
    const now = [term.options.fontFamily, term.options.fontSize, term.options.theme, term.options.scrollback];
    if (now.every((value, index) => value === options[index])) return false;
    options = now;
    return true;
  };

  const draw = (): void => {
    if (disposed) return;
    try {
      drawFrame();
    } catch (error) {
      // the module failed (a trap, out of memory): xterm draws from here on
      console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
      overlay.dispose();
    }
  };

  const drawFrame = (): void => {
    if (optionsChanged()) {
      widths.clear();
      asked.clear();
      grid = "";
      colors();
      vt.setScrollback(term.options.scrollback ?? 0);
      fit();
    }
    // xterm's own history (a herdr-core server's `terminal-history`): the layer shows the rows xterm shows
    const buffer = term.buffer.active;
    vt.scrollFromBottom(buffer.baseY - buffer.viewportY);
    const changed = vt.frame((y, runs) => {
      const row = rowEls[y];
      if (!row) return;
      rowRuns[y] = runs;
      let html = "";
      for (const run of runs) html += runHtml(run);
      // a row libghostty marks dirty can come out the same (a cursor that moved past it): no DOM write
      if (rowHtml[y] === html) return;
      row.innerHTML = html;
      rowHtml[y] = html;
      rowText[y] = runs.map((run) => run.cells.map((cell) => cell.text).join("")).join("").trimEnd();
    });
    // lines are told from the screen at the bottom, the one a program writes to: a view scrolled back holds a
    // write until it is back there, and a frame that only moved the view tells nothing (#2963)
    if (buffer.viewportY === buffer.baseY) {
      const screenText = rowText.slice(0, term.rows);
      // a grid that changed height keeps its bottom rows, as xterm does: the baseline lines up with them
      const before = Array.from({ length: term.rows }, (_, y) => bottomText[bottomText.length - term.rows + y] ?? "");
      if (primed && written && performance.now() >= viewMovedUntil) announce(newLines(before, screenText));
      // the screen a pane opens on is the first one written: herdr's own server paints it only after the attach
      if (written) primed = true;
      written = false;
      bottomText = screenText;
    }
    if (changed) {
      const c = vt.cursor();
      Object.assign(cursor.style, c.visible
        ? { display: "block", left: `${c.x * cellW}px`, top: `${c.y * cellH + (c.style === 2 ? cellH - 2 : 0)}px`, width: `${c.style === 0 ? 2 : cellW}px`, height: `${c.style === 2 ? 2 : cellH}px` }
        : { display: "none" });
    }
    const images = vt.placedImages();
    if (images) drawImages(images);
    // xterm may make a new renderer (a font or theme change): that one draws nothing either. A folded mirror
    // (lib/terminalFold.ts) hides this layer and reads xterm's rows and cursor, so xterm draws while folded
    if (host.hasAttribute("data-folded")) {
      if (muted) { unmuteXtermRows(); term.refresh(0, term.rows - 1); }
    } else muteXtermRows();
  };

  const schedule = (): void => {
    if (frameQueued || disposed) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      draw();
    });
  };

  // every byte xterm is given, libghostty is given first, in the same order
  const write = term.write.bind(term);
  term.write = ((data: string | Uint8Array, callback?: () => void) => {
    // libghostty takes Kitty pictures but not iTerm2 or sixel ones: when xterm draws one (Pictures in the terminal),
    // its cursor moves past the picture and libghostty's would not, so the text after it would sit on other rows.
    // xterm draws the pane from that picture on (#2980)
    if (!disposed && pictureIn(data) && terminalDrawsPictures(term)) overlay.dispose();
    if (!disposed) {
      try {
        vt.write(data);
        written = true;
      } catch (error) {
        // the module failed (a trap, out of memory): xterm draws from here on, and its write still runs
        console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
        overlay.dispose();
      }
    }
    write(data, callback);
  }) as Terminal["write"];
  const reset = term.reset.bind(term);
  term.reset = () => {
    if (!disposed) {
      vt.reset();
      decoded.clear();
    }
    reset();
  };

  // at xterm's grid and cell size, so a picture in the backlog is placed as xterm's cells are. Any of it failing
  // gives the terminal back to xterm, its own write and reset included: no write waits on a failed module
  try {
    optionsChanged();
    colors();
    vt.setScrollback(term.options.scrollback ?? 0);
    fit();
    for (const chunk of backlog) vt.write(chunk);
    written = backlog.length > 0;
  } catch (error) {
    // the caller falls back to xterm: it gets its own write and reset back, so nothing reaches the freed module
    disposed = true;
    term.write = write;
    term.reset = reset;
    lateFaces.stop();
    layer.remove();
    vt.dispose();
    throw error;
  }
  // a resize the module fails gives the pane back to xterm, as a failed frame does
  const refit = (): void => {
    if (disposed) return;
    try {
      fit();
    } catch (error) {
      console.warn("libghostty stopped drawing this terminal; xterm draws it", error);
      overlay.dispose();
    }
  };
  const subscriptions: IDisposable[] = [
    term.onResize(refit),
    term.onRender(() => schedule()),
    term.onScroll(() => schedule()),
  ];
  for (const gesture of VIEW_GESTURES) host.addEventListener(gesture, viewMoved, { capture: true, passive: true });
  const screenResize = new ResizeObserver(refit);
  screenResize.observe(screen);

  // xterm still parses every byte (its buffer serves input, selection, search and the input row), but its
  // own rows are hidden under this layer: redrawing them was a third of the cost of a busy pane
  let muted: { renderer: XtermRowRenderer; renderRows: XtermRowRenderer["renderRows"] } | null = null;
  const muteXtermRows = (): void => {
    const renderer = xtermRowRenderer(term);
    if (!renderer || muted?.renderer === renderer) return;
    unmuteXtermRows();
    muted = { renderer, renderRows: renderer.renderRows };
    renderer.renderRows = () => {};
  };
  const unmuteXtermRows = (): void => {
    if (!muted) return;
    muted.renderer.renderRows = muted.renderRows;
    muted = null;
  };
  muteXtermRows();

  host.dataset["renderer"] = "ghostty";
  const overlay: GhosttyOverlay = {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      delete host.dataset["renderer"];
      unmuteXtermRows();
      term.refresh(0, term.rows - 1);
      term.write = write;
      term.reset = reset;
      for (const subscription of subscriptions) subscription.dispose();
      screenResize.disconnect();
      for (const gesture of VIEW_GESTURES) host.removeEventListener(gesture, viewMoved, { capture: true });
      lateFaces.stop();
      layer.remove();
      decoded.clear();
      vt.dispose();
    },
  };
  return overlay;
}
