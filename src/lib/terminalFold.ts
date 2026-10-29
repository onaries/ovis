import type { IBufferCell, IBufferLine, ITheme, Terminal } from "@xterm/xterm";
import { canPanTerminalGrid, forwardWheel } from "./terminalWheel.ts";

/*
 * The folded view of a grid wider than its screen that this browser does not size. A Windows PC's
 * herdr has no terminal attach, so the bridge repaints the pane at the pane's own size on that PC
 * (server/mirror.ts) and a phone cannot resize it; an attached pane a phone only watches, or holds
 * under its keyboard, is drawn at the pty's grid, which another device sized. Drawn as it is, every
 * row ran off the right edge. The grid stays as it is, unseen, so whatever reads it (the masked
 * prompt, the agent's input row, Find) still reads what herdr drew (for an attached pane, what the
 * attach stream drew: never a pane read); this view draws its rows again as text that wraps at the
 * screen's width, the way Collie draws a pane read (AltanS/collie, web/src/components/ansi-output.tsx:
 * SGR runs in a pre-wrap block; no code is taken from it). A full-screen program's boxes and
 * right-aligned bars fold with the text: the pane menu's "Original width" draws the grid as it is again.
 */

/** "Wrap to screen" until the user chooses: a touch screen, or a window as narrow as a phone's layout */
export const MIRROR_WRAP_QUERY = "(pointer: coarse), (max-width: 768px)";

/** A pane of a PC, as the wide grids below name it. */
export const wideGridKey = (machineId: string, paneId: string): string => `${machineId}\n${paneId}`;
const wideOwners = new Map<object, string>();
let wideKeys: ReadonlySet<string> = new Set();
const wideListeners = new Set<() => void>();
/**
 * The panes this page draws at a grid it does not size and that is wider than their mount (wideGridKey), one
 * entry per terminal: the pane menu offers Wrap to screen / Original width for them, as for every mirrored pane.
 */
export const wideGrids = {
  subscribe(listener: () => void): () => void {
    wideListeners.add(listener);
    return () => { wideListeners.delete(listener); };
  },
  snapshot: (): ReadonlySet<string> => wideKeys,
  /** what `owner`'s terminal draws wide now: a pane's key, or null for nothing */
  set(owner: object, key: string | null): void {
    if ((wideOwners.get(owner) ?? null) === key) return;
    if (key === null) wideOwners.delete(owner);
    else wideOwners.set(owner, key);
    wideKeys = new Set(wideOwners.values());
    for (const listener of wideListeners) listener();
  },
};

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
// xterm's own sixteen, for the ones a theme leaves out (a dark theme here names none of them)
const XTERM_ANSI = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];
const CUBE = [0, 95, 135, 175, 215, 255];
const hex = (value: number): string => value.toString(16).padStart(2, "0");

/** A 256-colour palette index as CSS: the theme's sixteen colours (xterm's where it names none), then xterm's 6x6x6 cube and grey ramp. */
export function paletteColor(index: number, theme: ITheme): string {
  if (index < 16) return theme[ANSI[index]!] ?? XTERM_ANSI[index]!;
  if (index < 232) {
    const cube = index - 16;
    return `#${hex(CUBE[Math.floor(cube / 36)]!)}${hex(CUBE[Math.floor(cube / 6) % 6]!)}${hex(CUBE[cube % 6]!)}`;
  }
  return `#${hex(8 + (index - 232) * 10).repeat(3)}`;
}

/** a cell's colour as xterm holds it: a palette index, a CSS colour (24-bit, or the theme's own), or null for the default */
type CellColor = { index: number } | { css: string } | null;
const colorOf = (isDefault: boolean, isRgb: boolean, value: number): CellColor =>
  isDefault ? null : isRgb ? { css: `#${value.toString(16).padStart(6, "0")}` } : { index: value };
const cssOf = (color: CellColor, theme: ITheme): string | null => color === null ? null : "css" in color ? color.css : paletteColor(color.index, theme);

type Rgb = [number, number, number];
const rgbOf = (color: string): Rgb | null => {
  const long = /^#([0-9a-f]{6})$/i.exec(color);
  if (long) {
    const value = parseInt(long[1]!, 16);
    return [value >> 16, (value >> 8) & 255, value & 255];
  }
  const short = /^#([0-9a-f]{3})$/i.exec(color);
  return short ? [...short[1]!].map((digit) => parseInt(digit + digit, 16)) as Rgb : null;
};
// WCAG relative luminance and contrast ratio, as xterm's minimumContrastRatio measures them
const luminance = (rgb: Rgb): number => {
  const [r, g, b] = rgb.map((value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

/** The WCAG contrast ratio of two #rgb or #rrggbb colours, or null for any other notation. */
export function contrastRatio(a: string, b: string): number | null {
  const first = rgbOf(a);
  const second = rgbOf(b);
  return first && second ? contrast(first, second) : null;
}

/** `fg` moved toward white on a dark `bg` (black on a light one) until it reaches `ratio` against it, as
 *  the grid's own minimumContrastRatio draws it, and the other way when that way cannot reach it; a colour
 *  that is not #rgb or #rrggbb is left as it is. */
export function readableColor(fg: string, bg: string, ratio: number): string {
  const from = rgbOf(fg);
  const under = rgbOf(bg);
  if (!from || !under || ratio <= 1 || contrast(from, under) >= ratio) return fg;
  const toward = (target: number): string | null => {
    for (let step = 1; step <= 10; step++) {
      const mixed = from.map((value) => Math.round(value + (target - value) * step / 10)) as Rgb;
      if (contrast(mixed, under) >= ratio) return `#${mixed.map(hex).join("")}`;
    }
    return null;
  };
  const first = luminance(under) < 0.5 ? 255 : 0;
  return toward(first) ?? toward(255 - first)
    ?? (contrast([255, 255, 255], under) >= contrast([0, 0, 0], under) ? "#ffffff" : "#000000");
}

/** The inline CSS a cell draws with; "" for the terminal's plain text. `minimumContrast` is the grid's minimumContrastRatio. */
export function cellStyle(cell: IBufferCell, theme: ITheme, minimumContrast = 1): string {
  const bold = cell.isBold() !== 0;
  let fgColor = colorOf(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor());
  let bgColor = colorOf(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor());
  // as xterm draws a cell: inverse swaps the colours first (a default one standing for the theme's), then bold
  // draws a foreground of the first eight colours in its bright form (drawBoldTextInBrightColors)
  if (cell.isInverse() !== 0) {
    [fgColor, bgColor] = [bgColor ?? (theme.background ? { css: theme.background } : null), fgColor ?? (theme.foreground ? { css: theme.foreground } : null)];
  }
  if (bold && fgColor !== null && "index" in fgColor && fgColor.index < 8) fgColor = { index: fgColor.index + 8 };
  let fg = cssOf(fgColor, theme);
  const bg = cssOf(bgColor, theme);
  // the minimum contrast holds for a default foreground on a colour of the program's, and for a colour on the default background
  if (fg !== null || bg !== null) {
    const text = fg ?? theme.foreground;
    const under = bg ?? theme.background;
    if (text && under) {
      const readable = readableColor(text, under, minimumContrast);
      if (fg !== null || readable !== text) fg = readable;
    }
  }
  let style = "";
  if (cell.isInvisible() !== 0) style += "color:transparent;";
  // dim fades the text, not its background
  else if (cell.isDim() !== 0) style += `color:color-mix(in srgb, ${fg ?? theme.foreground ?? "currentColor"} 50%, transparent);`;
  else if (fg) style += `color:${fg};`;
  if (bg) style += `background:${bg};`;
  if (bold) style += "font-weight:bold;";
  if (cell.isItalic() !== 0) style += "font-style:italic;";
  const lines = [cell.isUnderline() !== 0 ? "underline" : "", cell.isStrikethrough() !== 0 ? "line-through" : "", cell.isOverline() !== 0 ? "overline" : ""].filter(Boolean);
  if (lines.length > 0) style += `text-decoration:${lines.join(" ")};`;
  return style;
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const run = (text: string, style: string): string => !text ? "" : style ? `<span style="${style}">${escapeHtml(text)}</span>` : escapeHtml(text);
/** a cell that draws nothing: a space (or nothing) on the default background */
const blank = (cell: IBufferCell): boolean => (cell.getChars() === "" || cell.getChars() === " ") && cell.isBgDefault() && cell.isInverse() === 0;

/** The grid's cursor on a row, as xterm draws it: its column, and the shape ("none" draws nothing). */
export interface FoldCursor { x: number; shape: "block" | "outline" | "bar" | "underline" | "none" }

/** The class of the folded cell the cursor is on (one at most): the input stands under it. */
export const FOLD_CURSOR_CLASS = "terminal-fold-cursor";

/** The cursor's shape as xterm's DOM renderer drew it on `cell` (its xterm-cursor-* classes). */
export function cursorShape(cell: Element): FoldCursor["shape"] {
  for (const shape of ["block", "outline", "bar", "underline"] as const) if (cell.classList.contains(`xterm-cursor-${shape}`)) return shape;
  return "none";
}

/** The inline CSS that draws the cursor over a cell's own: the theme's cursor colours, as the grid draws it. */
const cursorStyle = (shape: FoldCursor["shape"], theme: ITheme): string => {
  const color = theme.cursor ?? theme.foreground ?? "currentColor";
  if (shape === "block") return `background:${color};color:${theme.cursorAccent ?? theme.background ?? "inherit"};`;
  if (shape === "outline") return `box-shadow:inset 0 0 0 1px ${color};`;
  if (shape === "bar") return `box-shadow:inset 2px 0 0 ${color};`;
  if (shape === "underline") return `box-shadow:inset 0 -2px 0 ${color};`;
  return "";
};

/**
 * One grid row as HTML, its cells grouped in runs drawn alike, without the blank cells it ends with:
 * herdr pads every row to the grid's width, and folded those would add an empty line to each row.
 * `scratch` is a cell to read into (xterm reuses it for every getCell). `cursor`, on the cursor's row:
 * its cell is drawn on its own (FOLD_CURSOR_CLASS), the blank cells up to it included; past the last
 * column (a write that filled the row, waiting to wrap) it stands on the last cell, as xterm draws it.
 */
export function rowHtml(line: IBufferLine, cols: number, theme: ITheme, scratch: IBufferCell, minimumContrast = 1, cursor: FoldCursor | null = null): string {
  let end = 0;
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell) break;
    if (!blank(cell)) end = x + Math.max(1, cell.getWidth());
  }
  const at = cursor === null || cursor.x < 0 ? -1 : Math.min(cursor.x, cols - 1);
  if (at >= 0) end = Math.max(end, at + 1);
  let html = "";
  let text = "";
  let style = "";
  for (let x = 0; x < end; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell) break;
    // the second half of a wide glyph: the glyph itself was the cell before
    if (cell.getWidth() === 0) continue;
    const next = cellStyle(cell, theme, minimumContrast);
    // the cursor's cell (or the wide glyph it is on), alone in a span of its own
    if (cursor !== null && x <= at && at < x + Math.max(1, cell.getWidth())) {
      html += run(text, style);
      const drawnStyle = next + cursorStyle(cursor.shape, theme);
      html += `<span class="${FOLD_CURSOR_CLASS}"${drawnStyle ? ` style="${drawnStyle}"` : ""}>${escapeHtml(cell.getChars() || " ")}</span>`;
      text = "";
      style = next;
      continue;
    }
    if (next !== style) {
      html += run(text, style);
      text = "";
      style = next;
    }
    text += cell.getChars() || " ";
  }
  return html + run(text, style);
}

/** `url` without the punctuation a sentence put after it; a closing parenthesis it opened stays (`Function_(mathematics)`). */
const trimUrl = (url: string): string => {
  for (;;) {
    const last = url.at(-1);
    const extra = last === ")" && url.split(")").length > url.split("(").length;
    if (!extra && !(last !== undefined && ",.;:!?'\"]}".includes(last))) return url;
    url = url.slice(0, -1);
  }
};

/** The http(s) address in a folded row's text that `offset` falls in, its trailing punctuation left out, or null. */
export function webLinkAt(text: string, offset: number): { url: string; start: number; end: number } | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const url = trimUrl(match[0]);
    if (offset >= match.index && offset < match.index + url.length) return { url, start: match.index, end: match.index + url.length };
  }
  return null;
}

/**
 * The OSC 8 target (`ESC ] 8 ; ; uri`) of grid cell `x` on buffer row `y`, or null. xterm (5.5 and 6.0) keeps it in its own link
 * service with no public way to read it, so this reads its internals and finds nothing where they are not there; the
 * caller applies the grid's own link policy (http(s) or file only) to what it finds.
 */
export function hyperlinkAt(term: Terminal, y: number, x: number): string | null {
  const cell = term.buffer.active.getLine(y)?.getCell(x) as (IBufferCell & { extended?: { urlId?: number } }) | undefined;
  const id = cell?.extended?.urlId;
  if (!id) return null;
  const links = (term as unknown as { _core?: { _oscLinkService?: { getLinkData?: (id: number) => { uri?: string } | undefined } } })._core?._oscLinkService;
  const uri = links?.getLinkData?.(id)?.uri;
  return typeof uri === "string" && uri !== "" ? uri : null;
}

/** The grid column of the character at `offset` in a row drawn by rowHtml (each drawn cell's characters, a blank one as a space), or -1. */
export function columnAt(line: IBufferLine, cols: number, offset: number, scratch: IBufferCell): number {
  let at = 0;
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, scratch);
    if (!cell) break;
    if (cell.getWidth() === 0) continue;
    at += (cell.getChars() || " ").length;
    if (offset < at) return x;
  }
  return -1;
}

export interface TerminalFold {
  /** the folded view is drawn in place of the grid */
  readonly active: boolean;
  /** decides again whether the grid is folded (the host or the grid resized, the setting or the grid's role changed), and redraws it if so */
  sync(): void;
  /** the bottom of the folded row the grid's cursor is on, in the host's content, or null when not folded */
  cursorBottom(): number | null;
  dispose(): void;
}

/** what a tap on the folded rows landed on: a cell of the grid (an OSC 8 hyperlink or a file path may be there), or an http(s) address its text shows */
export type FoldLinkTarget = { url: string } | { row: number; col: number };

export interface TerminalFoldOptions {
  /** the grid is not this browser's to size: a mirror, a grid it watches, or one held at another device's size */
  foreign: () => boolean;
  /** the user's choice: Wrap to screen (true) or Original width */
  wrap: () => boolean;
  /** after each decision: whether the grid is foreign and wider than the host, folded or not (the menu offers the choice) */
  onWide: (wide: boolean) => void;
  /** after each drawing: the caller keeps the prompt in view */
  onDrawn: () => void;
  /** a tap on the view, which xterm under it no longer receives: it focuses the terminal, as xterm's own tap does */
  onTap: () => void;
  /** a tap that may be on a link, as xterm's link providers would have read it: true when it opened one */
  onLink: (target: FoldLinkTarget, event: MouseEvent) => boolean;
  /** a wheel moved the folded rows within the host: the view is the user's until they follow again */
  onPan: () => void;
}

type CaretDocument = Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
/** the text node and offset under a point, in the browsers that name it either way */
const caretAt = (x: number, y: number): { node: Node; offset: number } | null => {
  const doc = document as CaretDocument;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
};

/** Folds `term`'s grid inside `host` while the grid is foreign, wider than the host, and the user wraps it. */
export function createTerminalFold(term: Terminal, host: HTMLElement, { foreign, wrap, onWide, onDrawn, onTap, onLink, onPan }: TerminalFoldOptions): TerminalFold {
  const view = document.createElement("div");
  view.className = "terminal-fold";
  // the grid under it stays the terminal's accessible text; this is the same text drawn again
  view.setAttribute("aria-hidden", "true");
  const rows: HTMLDivElement[] = [];
  const drawn: string[] = [];
  const scratch = term.buffer.active.getNullCell();
  let active = false;

  const screen = (): HTMLElement | null => term.element?.querySelector<HTMLElement>(".xterm-screen") ?? null;
  const wider = (): boolean => {
    const grid = screen();
    if (!grid || !term.element || host.clientWidth === 0) return false;
    const style = getComputedStyle(term.element);
    return grid.offsetWidth + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) > host.clientWidth + 1;
  };
  const cursorRow = (): HTMLDivElement | undefined => rows[Math.min(term.buffer.active.cursorY, rows.length - 1)];
  const cursorBottom = (): number | null => {
    const row = cursorRow();
    return active && row ? view.offsetTop + row.offsetTop + row.offsetHeight : null;
  };
  // The hidden grid holds xterm's input: its helper textarea and an IME's preedit stand at the grid's
  // cursor, and the input bounds keep them inside the part of the grid in view. Folded rows are taller
  // than the grid, so the grid moves down with them until its cursor row lies on the folded cursor row:
  // a preedit is drawn where the text it adds will show. It never reaches past the folded rows' end.
  // A cursor the grid shows (an attached pane's: a mirror hides it) is drawn in the folded rows, and the
  // grid moves down to the folded line it is on and sideways to its column, so the input stands on it even
  // in an earlier part of a long folded row. Sideways it scrolls within .xterm (overflow hidden, as wide as
  // the mount) as far as that goes, and moves by `left` for the rest: moved by `left` alone, .xterm's box
  // would leave the input outside its own clip, and the browser would scroll it back.
  // It moves by `top` (.xterm is relative), not a transform: a transform would make the grid a stacking
  // context, and the preedit (xterm's helpers, z-index 5) would go under the folded rows drawn after it.
  const align = (): void => {
    const xterm = term.element;
    const grid = screen();
    const row = cursorRow();
    if (!xterm || !grid || !row || term.rows === 0 || term.cols === 0) return;
    const gridRect = grid.getBoundingClientRect();
    const line = grid.offsetHeight / term.rows;
    const gridCursorBottom = gridRect.top - xterm.getBoundingClientRect().top + (term.buffer.active.cursorY + 1) * line;
    // the bottom of the folded line the cursor is on: the row's last one, or the caret's
    let target = view.offsetTop + row.offsetTop + row.offsetHeight;
    let scroll = 0;
    let left = 0;
    const caret = row.querySelector<HTMLElement>(`.${FOLD_CURSOR_CLASS}`);
    if (caret) {
      const rect = caret.getBoundingClientRect();
      const foldLine = parseFloat(view.style.getPropertyValue("--fold-line")) || line;
      const segment = Math.max(0, Math.floor((rect.top + rect.height / 2 - row.getBoundingClientRect().top) / foldLine));
      target = view.offsetTop + row.offsetTop + Math.min(row.offsetHeight, (segment + 1) * foldLine);
      // how far the grid's cursor cell is right of the caret with the grid unmoved (gridRect counts what this set last time)
      // xterm's input stands on the last column while the cursor waits to wrap past it
      const column = Math.min(term.buffer.active.cursorX, term.cols - 1);
      const needed = gridRect.left - (parseFloat(xterm.style.left) || 0) + xterm.scrollLeft + column * grid.offsetWidth / term.cols - rect.left;
      scroll = Math.max(0, Math.min(needed, xterm.scrollWidth - xterm.clientWidth));
      left = scroll - needed;
    }
    // where the grid stands unmoved: offsetTop counts the offset this set last time
    const base = xterm.offsetTop - (parseFloat(xterm.style.top) || 0);
    const most = view.offsetTop + view.offsetHeight - (base + xterm.offsetHeight);
    const shift = Math.max(0, Math.min(most, target - (base + gridCursorBottom)));
    xterm.style.top = shift > 0 ? `${Math.round(shift)}px` : "";
    if (Math.abs(xterm.scrollLeft - scroll) >= 1) xterm.scrollLeft = scroll;
    xterm.style.left = Math.round(left) !== 0 ? `${Math.round(left)}px` : "";
  };
  const draw = (start: number, end: number): void => {
    const theme = term.options.theme ?? {};
    const grid = screen();
    view.style.fontFamily = term.options.fontFamily ?? "";
    view.style.fontSize = `${term.options.fontSize ?? 13}px`;
    // a row's own height in the grid, so the folded rows stand as far apart as the grid's
    if (grid && term.rows > 0) view.style.setProperty("--fold-line", `${grid.offsetHeight / term.rows}px`);
    view.style.color = theme.foreground ?? "";
    view.style.background = theme.background ?? "";
    while (rows.length < term.rows) {
      const row = document.createElement("div");
      row.className = "terminal-fold-row";
      view.append(row);
      rows.push(row);
      drawn.push("");
    }
    while (rows.length > term.rows) {
      rows.pop()!.remove();
      drawn.pop();
    }
    const buffer = term.buffer.active;
    // the cursor where the grid draws one (its DOM renderer marks the cell, in the shape it has now)
    const shown = term.element?.querySelector(".xterm-rows .xterm-cursor");
    const cursorY = buffer.baseY + buffer.cursorY - buffer.viewportY;
    for (let y = Math.max(0, start); y <= Math.min(end, term.rows - 1); y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      const cursor = shown && y === cursorY ? { x: buffer.cursorX, shape: cursorShape(shown) } : null;
      const html = line ? rowHtml(line, term.cols, theme, scratch, term.options.minimumContrastRatio ?? 1, cursor) : "";
      if (html === drawn[y]) continue;
      drawn[y] = html;
      rows[y]!.innerHTML = html;
    }
    align();
    onDrawn();
  };
  const sync = (): void => {
    const wide = foreign() && wider();
    onWide(wide);
    const next = wide && wrap();
    if (next === active) {
      if (active) draw(0, term.rows - 1);
      return;
    }
    active = next;
    host.toggleAttribute("data-folded", active);
    if (active) {
      host.scrollLeft = 0;
      host.append(view);
      draw(0, term.rows - 1);
      return;
    }
    view.remove();
    view.replaceChildren();
    rows.length = 0;
    drawn.length = 0;
    if (term.element) { term.element.style.top = ""; term.element.style.left = ""; term.element.scrollLeft = 0; }
  };
  // xterm draws only the rows a write changed: those are redrawn here too, after it
  const rendered = term.onRender(({ start, end }) => {
    if (!active) return;
    // the grid became this browser's to size (a pane switch, a role, the keyboard gone) since the last sync
    if (!foreign() || !wrap()) sync();
    else draw(start, end);
  });
  const resized = term.onResize(() => sync());
  // a font change (Settings, a pinch) keeps the grid's rows and columns: only its size says the grid now fits, or no longer does
  const measured = new ResizeObserver(() => sync());
  const grid = screen();
  if (grid) measured.observe(grid);
  /** the folded row under a point and the offset in its text, or null */
  const textAt = (x: number, y: number): { row: number; offset: number; text: string; node: Text } | null => {
    const caret = caretAt(x, y);
    if (!caret || !(caret.node instanceof Text)) return null;
    const row = caret.node.parentElement?.closest(".terminal-fold-row");
    const index = row ? rows.indexOf(row as HTMLDivElement) : -1;
    if (!row || index < 0) return null;
    // the caret falls between characters: on a glyph's right half it is after it, so the glyph is the one before
    const node = caret.node;
    const holds = (at: number): boolean => {
      if (at < 0 || at >= node.data.length) return false;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, Math.min(node.data.length, at + (/[\uD800-\uDBFF]/.test(node.data[at]!) ? 2 : 1)));
      return [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
    };
    const at = holds(caret.offset) ? caret.offset : holds(caret.offset - 1) ? caret.offset - 1 : caret.offset;
    let offset = 0;
    for (let walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), text = walker.nextNode(); text && text !== node; text = walker.nextNode()) offset += (text as Text).data.length;
    return { row: index, offset: offset + at, text: row.textContent ?? "", node };
  };
  /** whether the point is on the drawn text of `[start, end)` in a row, not in the blank past a line's end */
  const onText = (row: number, start: number, end: number, x: number, y: number): boolean => {
    const range = document.createRange();
    let at = 0;
    let started = false;
    for (let walker = document.createTreeWalker(rows[row]!, NodeFilter.SHOW_TEXT), node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      if (!started && start < at + text.data.length) { range.setStart(text, start - at); started = true; }
      if (started && end <= at + text.data.length) { range.setEnd(text, end - at); break; }
      at += text.data.length;
    }
    return started && [...range.getClientRects()].some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
  };
  // a tap with no text selected in the view: a long press that selected some is a copy, not a tap
  const tap = (event: MouseEvent): void => {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.anchorNode && view.contains(selection.anchorNode)) return;
    const hit = textAt(event.clientX, event.clientY);
    if (hit) {
      // the cell's own target first (an OSC 8 hyperlink, whatever its label shows, then a file path), as the grid
      // ranks its links; then the address the text shows
      const buffer = term.buffer.active;
      const line = buffer.getLine(buffer.viewportY + hit.row);
      const col = line ? columnAt(line, term.cols, hit.offset, scratch) : -1;
      if (col >= 0 && onText(hit.row, hit.offset, hit.offset + 1, event.clientX, event.clientY) && onLink({ row: hit.row, col }, event)) return;
      const web = webLinkAt(hit.text, hit.offset);
      if (web && onText(hit.row, web.start, web.end, event.clientX, event.clientY) && onLink({ url: web.url }, event)) return;
    }
    onTap();
  };
  // xterm's wheel handler is on the grid, which the view covers: the folded rows pan in the host while
  // they can, and past their edge the wheel goes on to xterm, which scrolls the mirror's history
  const wheel = (event: WheelEvent): void => {
    if (canPanTerminalGrid(host, event.deltaY)) {
      onPan();
      return;
    }
    event.preventDefault();
    if (term.element) forwardWheel(term.element, event);
  };
  view.addEventListener("click", tap);
  view.addEventListener("wheel", wheel, { passive: false });
  return {
    get active() { return active; },
    sync,
    cursorBottom,
    dispose() {
      rendered.dispose();
      resized.dispose();
      measured.disconnect();
      view.removeEventListener("click", tap);
      view.removeEventListener("wheel", wheel);
      view.remove();
      host.removeAttribute("data-folded");
      if (term.element) { term.element.style.top = ""; term.element.style.left = ""; term.element.scrollLeft = 0; }
    },
  };
}
