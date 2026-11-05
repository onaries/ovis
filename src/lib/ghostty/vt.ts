/**
 * A thin wrapper over libghostty-vt compiled to WebAssembly (ghostty-vt.wasm, MIT; built by
 * scripts/ghostty-vt/build.sh with the Kitty graphics protocol turned on).
 *
 * It owns one terminal and one render state. Each frame hands every changed row to the caller as
 * runs of text that share one style, and lists the Kitty images on screen with their pixels.
 * Raw cells are read a row at a time and decoded with the bit layout the module reports in
 * ghostty_type_json(), so a row costs one wasm call plus a few per style change.
 */

interface Bits { lsb: number; width: number; arms?: Record<string, { bits: Record<string, Bits> } | null> }
interface TypeLayout { types: Record<string, { fields?: Record<string, { offset: number }>; bits?: Record<string, Bits> }> }

interface Exports {
  memory: WebAssembly.Memory;
  ghostty_type_json(): number;
  ghostty_wasm_alloc(len: number): number;
  ghostty_wasm_free(ptr: number, len: number): void;
  ghostty_wasm_alloc_opaque(): number;
  ghostty_wasm_take_opaque(slot: number): number;
  ghostty_terminal_new(allocator: number, slot: number, cols: number, rows: number): number;
  ghostty_terminal_free(terminal: number): void;
  ghostty_terminal_reset(terminal: number): void;
  ghostty_terminal_resize(terminal: number, cols: number, rows: number, cellW: number, cellH: number): number;
  ghostty_terminal_set(terminal: number, option: number, value: number): number;
  ghostty_terminal_get(terminal: number, key: number, out: number): number;
  ghostty_terminal_vt_write(terminal: number, ptr: number, len: number): void;
  ghostty_terminal_scroll_viewport(terminal: number, behavior: number): void;
  ghostty_render_state_new(allocator: number, slot: number): number;
  ghostty_render_state_free(state: number): void;
  ghostty_render_state_update(state: number, terminal: number): number;
  ghostty_render_state_get(state: number, key: number, out: number): number;
  ghostty_render_state_clean(state: number): number;
  ghostty_render_state_row_iterator_new(allocator: number, slot: number): number;
  ghostty_render_state_row_iterator_next_dirty(iterator: number, outY: number): number;
  ghostty_render_state_row_iterator_free(iterator: number): void;
  ghostty_render_state_row_get(iterator: number, key: number, out: number): number;
  ghostty_render_state_row_cells_new(allocator: number, slot: number): number;
  ghostty_render_state_row_cells_select(cells: number, x: number): number;
  ghostty_render_state_row_cells_get(cells: number, key: number, out: number): number;
  ghostty_render_state_row_cells_free(cells: number): void;
  ghostty_render_state_image_iterator_new(allocator: number, slot: number): number;
  ghostty_render_state_image_iterator_next(iterator: number): number;
  ghostty_render_state_image_get(iterator: number, key: number, out: number): number;
  ghostty_render_state_image_iterator_free(iterator: number): void;
  ghostty_kitty_graphics_image(graphics: number, id: number): number;
  ghostty_kitty_graphics_image_get(image: number, key: number, out: number): number;
}

/** One run of cells in a row that share a style. */
export interface GhosttyRun {
  x: number;
  /** each cell's grapheme, and whether it fills two columns (Hangul, CJK, most emoji) */
  cells: { text: string; wide: boolean }[];
  fg: string | null;
  bg: string | null;
  flags: number;
}

export interface GhosttyCursor { visible: boolean; x: number; y: number; style: number }

/** A Kitty image on screen, in viewport cells and CSS pixels, as the render state places it. */
export interface GhosttyImage {
  id: number;
  /** changes whenever the image's pixels do: part of a decoded image's cache key */
  generation: number;
  /** 0 below the cell backgrounds, 1 below the text, 2 above it */
  layer: number;
  z: number;
  col: number;
  row: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  source: { x: number; y: number; width: number; height: number };
}

export interface GhosttyColors { foreground: string; background: string; cursor: string; ansi: readonly string[] }

export const STYLE_BOLD = 1 << 0;
export const STYLE_ITALIC = 1 << 1;
export const STYLE_FAINT = 1 << 2;
export const STYLE_INVERSE = 1 << 4;
export const STYLE_INVISIBLE = 1 << 5;
export const STYLE_STRIKE = 1 << 6;
export const STYLE_UNDERLINE_MASK = 0x7 << 8;

// enum values from include/ghostty/vt/render.h, terminal.h and kitty_graphics.h at the pinned commit
const RS_DATA_DIRTY = 3, RS_DATA_ROW_ITERATOR = 4, RS_DATA_CURSOR_VISUAL_STYLE = 10, RS_DATA_CURSOR_VISIBLE = 11;
const RS_DATA_CURSOR_VIEWPORT_HAS_VALUE = 14, RS_DATA_CURSOR_VIEWPORT_X = 15, RS_DATA_CURSOR_VIEWPORT_Y = 16;
const RS_DATA_IMAGE_ITERATOR = 22, RS_DATA_IMAGE_PLACEMENTS_GENERATION = 23;
const ROW_DATA_CELLS = 3, ROW_DATA_CELLS_RAW = 5;
const CELLS_STYLE = 2, CELLS_BG = 5, CELLS_FG = 6, CELLS_GRAPHEMES_UTF8 = 9;
const OPT_COLOR_FOREGROUND = 11, OPT_COLOR_BACKGROUND = 12, OPT_COLOR_CURSOR = 13, OPT_COLOR_PALETTE = 14;
const OPT_KITTY_IMAGE_STORAGE_LIMIT = 15, OPT_SCROLLBACK_MAX_LINES = 28, OPT_MODE = 34;
/** DEC private mode 2027 as ghostty_mode_new(2027, false) encodes it */
const MODE_GRAPHEME_CLUSTER = 2027;
const CSI_GROUND = 0, CSI_ESC = 1, CSI_BRACKET = 2, CSI_PRIVATE = 3, CSI_OTHER = 4, CSI_STRING = 5;
/**
 * Whether a code point joins the emoji before it into one cell: ZWJ, the emoji- and text-presentation
 * selectors, skin tones, the keycap mark, tags (subdivision flags) and regional indicators (country flags).
 */
const joinsEmoji = (codepoint: number): boolean =>
  codepoint === 0x200d || codepoint === 0xfe0f || codepoint === 0xfe0e || codepoint === 0x20e3
  || (codepoint >= 0x1f3fb && codepoint <= 0x1f3ff) || (codepoint >= 0xe0020 && codepoint <= 0xe007f)
  || (codepoint >= 0x1f1e6 && codepoint <= 0x1f1ff);
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const DATA_KITTY_GRAPHICS = 30;
const SCROLL_BOTTOM = 1, SCROLL_DELTA = 2;
const IMAGE_ID = 2, IMAGE_GENERATION = 3, IMAGE_LAYER = 4, IMAGE_Z = 5, IMAGE_COL = 6, IMAGE_ROW = 7, IMAGE_OFFSET_X = 10, IMAGE_OFFSET_Y = 11;
const IMAGE_WIDTH = 12, IMAGE_HEIGHT = 13, IMAGE_SOURCE_X = 14, IMAGE_SOURCE_Y = 15, IMAGE_SOURCE_WIDTH = 16, IMAGE_SOURCE_HEIGHT = 17;
const KITTY_WIDTH = 3, KITTY_HEIGHT = 4, KITTY_FORMAT = 5, KITTY_DATA_PTR = 7, KITTY_DATA_LEN = 8;
const FORMAT_RGB = 0, FORMAT_RGBA = 1, FORMAT_GRAY_ALPHA = 3, FORMAT_GRAY = 4;
const WIDE_WIDE = 1, WIDE_SPACER_TAIL = 2, WIDE_SPACER_HEAD = 3;
const CONTENT_CODEPOINT_GRAPHEME = 1, CONTENT_BG_PALETTE = 2, CONTENT_BG_RGB = 3;
/** decoded pictures one terminal keeps; every terminal on the page shares the module's one memory */
const IMAGE_STORAGE_BYTES = 64n * 1024n * 1024n;

let modulePromise: Promise<{ exports: Exports; layout: TypeLayout }> | null = null;

function loadModule(): Promise<{ exports: Exports; layout: TypeLayout }> {
  modulePromise ??= (async () => {
    let memory: WebAssembly.Memory | null = null;
    const env = {
      log: (ptr: number, len: number) => {
        if (memory) console.debug("[ghostty-vt]", new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len)));
      },
    };
    // compiled from the bytes, not streamed: that needs `application/wasm`, which neither this PC's server
    // nor the relay's resource worker promises
    const wasmUrl = new URL("./ghostty-vt.wasm", import.meta.url);
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error(`ghostty-vt: ${wasmUrl.href} answered ${response.status}`);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), { env });
    const exports = instance.exports as unknown as Exports;
    memory = exports.memory;
    const ptr = exports.ghostty_type_json();
    const bytes = new Uint8Array(exports.memory.buffer, ptr);
    const layout = JSON.parse(new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)))) as TypeLayout;
    return { exports, layout };
  })();
  modulePromise.catch(() => { modulePromise = null; });
  return modulePromise;
}

const hex = (r: number, g: number, b: number): string => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;

function rgb(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})/i.exec(color.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export class GhosttyVt {
  cols: number;
  rows: number;
  private readonly x: Exports;
  private readonly terminal: number;
  private readonly state: number;
  private readonly iterator: number;
  private readonly cells: number;
  private readonly images: number;
  private readonly slot: number;
  private readonly scratch: number;
  private input = 0;
  private inputCap = 0;
  private placementsGeneration = -1;
  private readonly bit: Record<"codepoint" | "content_tag" | "wide" | "style_id", Bits>;
  private readonly flagsOffset: number;
  private readonly encoder = new TextEncoder();
  /** where the bytes so far stand in a `CSI ? Pm l`, carried from one write to the next */
  private csi = CSI_GROUND;
  private param = 0;
  private sawGraphemeMode = false;
  /** whether the last code point printed was a ZWJ, and whether an escape sequence came since the last one */
  private afterZwj = false;
  private broken = true;

  private constructor(exports: Exports, layout: TypeLayout, cols: number, rows: number) {
    this.x = exports;
    this.cols = cols;
    this.rows = rows;
    const cell = layout.types["GhosttyCell"]?.bits;
    if (!cell) throw new Error("ghostty-vt: no GhosttyCell layout in ghostty_type_json");
    const pick = (name: string): Bits => {
      const found = cell[name];
      if (!found) throw new Error(`ghostty-vt: GhosttyCell has no ${name}`);
      return found;
    };
    const content = pick("content");
    const inner = content.arms?.["CODEPOINT"]?.bits["codepoint"];
    if (!inner) throw new Error("ghostty-vt: GhosttyCell content has no CODEPOINT arm");
    this.bit = { codepoint: { lsb: content.lsb + inner.lsb, width: inner.width }, content_tag: pick("content_tag"), wide: pick("wide"), style_id: pick("style_id") };
    const flags = layout.types["GhosttyStyle"]?.fields?.["flags"];
    if (!flags) throw new Error("ghostty-vt: no GhosttyStyle.flags in ghostty_type_json");
    this.flagsOffset = flags.offset;

    this.slot = exports.ghostty_wasm_alloc_opaque();
    this.scratch = exports.ghostty_wasm_alloc(1024);
    const take = (result: number, what: string): number => {
      this.check(result, what);
      return exports.ghostty_wasm_take_opaque(this.slot);
    };
    this.terminal = take(exports.ghostty_terminal_new(0, this.slot, cols, rows), "terminal_new");
    this.state = take(exports.ghostty_render_state_new(0, this.slot), "render_state_new");
    this.iterator = take(exports.ghostty_render_state_row_iterator_new(0, this.slot), "row_iterator_new");
    this.cells = take(exports.ghostty_render_state_row_cells_new(0, this.slot), "row_cells_new");
    this.images = take(exports.ghostty_render_state_image_iterator_new(0, this.slot), "image_iterator_new");
    this.view().setBigUint64(this.scratch, IMAGE_STORAGE_BYTES, true);
    this.check(exports.ghostty_terminal_set(this.terminal, OPT_KITTY_IMAGE_STORAGE_LIMIT, this.scratch), "image storage limit");
    this.setScrollback(0);
  }

  static async create(cols: number, rows: number): Promise<GhosttyVt> {
    const { exports, layout } = await loadModule();
    return new GhosttyVt(exports, layout, cols, rows);
  }

  private check(result: number, what: string): void {
    if (result !== 0) throw new Error(`ghostty-vt: ${what} failed (${result})`);
  }

  private view(): DataView {
    return new DataView(this.x.memory.buffer);
  }

  write(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? this.encoder.encode(data) : data;
    if (bytes.length === 0) return;
    if (bytes.length > this.inputCap) {
      if (this.input) this.x.ghostty_wasm_free(this.input, this.inputCap);
      this.inputCap = Math.max(bytes.length, 64 * 1024);
      this.input = this.x.ghostty_wasm_alloc(this.inputCap);
    }
    new Uint8Array(this.x.memory.buffer, this.input, bytes.length).set(bytes);
    // xterm (terminalWidths.ts) and herdr give an emoji sequence (ZWJ family, skin tone, flag, keycap,
    // an emoji-presentation selector) one two-column cell, an emoji with a text form and the
    // text-presentation selector (\u26bd\ufe0e) one one-column cell, and otherwise lay out as libghostty
    // does with grapheme clustering (mode 2027) off: clustering also joins spacing marks and Indic
    // conjuncts that they keep apart. So mode 2027 stays off, and each code point that joins an emoji
    // (joinsEmoji, or a pictograph right after a ZWJ) is printed with it on. A program's own 2027 on
    // (CSI ? ... 2027 ... h, or r restoring it), which xterm ignores, is turned off again right after;
    // the sequence may span writes.
    let start = 0;
    const flush = (end: number): void => {
      if (end > start) this.x.ghostty_terminal_vt_write(this.terminal, this.input + start, end - start);
      start = end;
    };
    for (let at = 0; at < bytes.length; at++) {
      const byte = bytes[at]!;
      if (byte === 0x1b) { this.csi = CSI_ESC; this.broken = true; continue; }
      if (this.csi === CSI_GROUND) {
        if (byte < 0x20) continue;
        if (byte >= 0x80 && byte < 0xc0) continue;
        if (byte < 0xe0 || byte >= 0xf8) { this.afterZwj = false; this.broken = false; continue; }
        const length = byte >= 0xf0 ? 4 : 3;
        if (at + length > bytes.length) continue;
        const codepoint = length === 3
          ? ((byte & 0x0f) << 12) | ((bytes[at + 1]! & 0x3f) << 6) | (bytes[at + 2]! & 0x3f)
          : ((byte & 0x07) << 18) | ((bytes[at + 1]! & 0x3f) << 12) | ((bytes[at + 2]! & 0x3f) << 6) | (bytes[at + 3]! & 0x3f);
        // xterm starts a new cell after an escape sequence, so nothing joins across one
        const joins = !this.broken && (joinsEmoji(codepoint) || (this.afterZwj && codepoint <= 0x10ffff && PICTOGRAPHIC.test(String.fromCodePoint(codepoint))));
        if (joins) {
          flush(at);
          this.setGraphemeClusters(true);
          flush(at + length);
          this.setGraphemeClusters(false);
        }
        this.afterZwj = codepoint === 0x200d && !this.broken;
        this.broken = false;
        at += length - 1;
        continue;
      }
      // an OSC, DCS or APC (a title, a Kitty picture) prints nothing up to its BEL or ST (ESC \)
      if (this.csi === CSI_STRING) {
        if (byte === 0x07 || byte === 0x18 || byte === 0x1a) this.csi = CSI_GROUND;
        continue;
      }
      // a C0 control or DEL inside an escape sequence runs without ending it; CAN and SUB cancel it
      if ((byte < 0x20 && byte !== 0x18 && byte !== 0x1a) || byte === 0x7f) continue;
      switch (this.csi) {
        case CSI_ESC:
          this.csi = byte === 0x5b ? CSI_BRACKET : byte === 0x5d || byte === 0x50 || byte === 0x5f || byte === 0x5e || byte === 0x58 ? CSI_STRING : CSI_GROUND;
          continue;
        case CSI_BRACKET:
          // another CSI (a style, a cursor move) is skipped to its final byte: its parameters print nothing
          this.csi = byte === 0x3f ? CSI_PRIVATE : byte >= 0x40 && byte <= 0x7e ? CSI_GROUND : CSI_OTHER;
          this.param = 0;
          this.sawGraphemeMode = false;
          continue;
        case CSI_OTHER:
          if (byte >= 0x40 && byte <= 0x7e) this.csi = CSI_GROUND;
          continue;
      }
      if (byte >= 0x30 && byte <= 0x39) this.param = Math.min(this.param * 10 + byte - 0x30, 1e6);
      else if (byte === 0x3b || byte === 0x3a) {
        if (this.param === MODE_GRAPHEME_CLUSTER) this.sawGraphemeMode = true;
        this.param = 0;
      } else {
        if ((byte === 0x68 || byte === 0x72) && (this.sawGraphemeMode || this.param === MODE_GRAPHEME_CLUSTER)) {
          flush(at + 1);
          this.setGraphemeClusters(false);
        }
        this.csi = CSI_GROUND;
      }
    }
    flush(bytes.length);
  }

  private setGraphemeClusters(on: boolean): void {
    // GhosttyTerminalModeConfig { uint16_t mode; bool value }
    const dv = this.view();
    dv.setUint16(this.scratch + 1000, MODE_GRAPHEME_CLUSTER, true);
    dv.setUint8(this.scratch + 1002, on ? 1 : 0);
    this.check(this.x.ghostty_terminal_set(this.terminal, OPT_MODE, this.scratch + 1000), "grapheme clusters");
  }

  reset(): void {
    // libghostty keeps a sequence it is in the middle of across a reset, and so does the scanner
    this.x.ghostty_terminal_reset(this.terminal);
    this.placementsGeneration = -1;
  }

  resize(cols: number, rows: number, cellW: number, cellH: number): void {
    this.check(this.x.ghostty_terminal_resize(this.terminal, cols, rows, Math.max(1, Math.round(cellW)), Math.max(1, Math.round(cellH))), "resize");
    this.cols = cols;
    this.rows = rows;
  }

  /** lines of history above the screen; 0 keeps none */
  setScrollback(lines: number): void {
    this.view().setUint32(this.scratch, lines, true);
    this.check(this.x.ghostty_terminal_set(this.terminal, OPT_SCROLLBACK_MAX_LINES, this.scratch), "scrollback");
  }

  /** shows the screen `rowsAboveBottom` rows up in the history (0: the newest rows) */
  scrollFromBottom(rowsAboveBottom: number): void {
    const dv = this.view();
    const behavior = this.scratch + 512;
    dv.setUint32(behavior, SCROLL_BOTTOM, true);
    this.x.ghostty_terminal_scroll_viewport(this.terminal, behavior);
    if (rowsAboveBottom <= 0) return;
    dv.setUint32(behavior, SCROLL_DELTA, true);
    dv.setInt32(behavior + 8, -rowsAboveBottom, true);
    this.x.ghostty_terminal_scroll_viewport(this.terminal, behavior);
  }

  setColors(colors: GhosttyColors): void {
    const dv = this.view();
    const setColor = (option: number, color: string): void => {
      const value = rgb(color);
      if (!value) return;
      dv.setUint8(this.scratch, value[0]);
      dv.setUint8(this.scratch + 1, value[1]);
      dv.setUint8(this.scratch + 2, value[2]);
      this.check(this.x.ghostty_terminal_set(this.terminal, option, this.scratch), `color ${option}`);
    };
    setColor(OPT_COLOR_FOREGROUND, colors.foreground);
    setColor(OPT_COLOR_BACKGROUND, colors.background);
    setColor(OPT_COLOR_CURSOR, colors.cursor);
    // the 256-colour palette: the 16 named ones from the theme, the cube and greys as xterm computes them
    const palette = this.scratch + 128;
    for (let index = 0; index < 256; index++) {
      let value: [number, number, number];
      if (index < 16) value = rgb(colors.ansi[index] ?? "") ?? [0, 0, 0];
      else if (index < 232) {
        const n = index - 16;
        const level = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
        value = [level(Math.floor(n / 36)), level(Math.floor(n / 6) % 6), level(n % 6)];
      } else {
        const grey = 8 + (index - 232) * 10;
        value = [grey, grey, grey];
      }
      dv.setUint8(palette + index * 3, value[0]);
      dv.setUint8(palette + index * 3 + 1, value[1]);
      dv.setUint8(palette + index * 3 + 2, value[2]);
    }
    this.check(this.x.ghostty_terminal_set(this.terminal, OPT_COLOR_PALETTE, palette), "palette");
  }

  /**
   * Snapshot the terminal and call `draw` for each row that changed since the last frame.
   * Returns false when nothing changed.
   */
  frame(draw: (y: number, runs: GhosttyRun[]) => void): boolean {
    const x = this.x;
    this.check(x.ghostty_render_state_update(this.state, this.terminal), "render_state_update");
    this.check(x.ghostty_render_state_get(this.state, RS_DATA_DIRTY, this.scratch), "dirty");
    if (this.view().getInt32(this.scratch, true) === 0) return false;

    const iterSlot = this.scratch + 16;
    const cellsSlot = this.scratch + 24;
    const outY = this.scratch + 32;
    const viewOut = this.scratch + 40;
    const colorOut = this.scratch + 64;
    const styleOut = this.scratch + 96;
    let dv = this.view();
    dv.setUint32(iterSlot, this.iterator, true);
    this.check(x.ghostty_render_state_get(this.state, RS_DATA_ROW_ITERATOR, iterSlot), "row iterator");
    dv.setUint32(cellsSlot, this.cells, true);
    const { codepoint: cpB, content_tag: tagB, wide: wideB, style_id: styleB } = this.bit;
    const field = (lo: number, hi: number, b: Bits): number => {
      // a 64-bit cell read as two 32-bit halves; a field may straddle them (style_id does)
      const mask = b.width >= 32 ? 0xffffffff : (1 << b.width) - 1;
      if (b.lsb >= 32) return (hi >>> (b.lsb - 32)) & mask;
      if (b.lsb + b.width <= 32) return (lo >>> b.lsb) & mask;
      return ((lo >>> b.lsb) | (hi << (32 - b.lsb))) & mask;
    };

    while (x.ghostty_render_state_row_iterator_next_dirty(this.iterator, outY)) {
      dv = this.view();
      const y = dv.getUint16(outY, true);
      this.check(x.ghostty_render_state_row_get(this.iterator, ROW_DATA_CELLS_RAW, viewOut), "cells raw");
      this.check(x.ghostty_render_state_row_get(this.iterator, ROW_DATA_CELLS, cellsSlot), "cells");
      dv = this.view();
      const ptr = dv.getUint32(viewOut, true);
      const len = dv.getUint32(viewOut + 4, true);
      const runs: GhosttyRun[] = [];
      let run: GhosttyRun | null = null;
      let runKey = -1;
      for (let col = 0; col < len; col++) {
        const lo = dv.getUint32(ptr + col * 8, true);
        const hi = dv.getUint32(ptr + col * 8 + 4, true);
        const wide = field(lo, hi, wideB);
        if (wide === WIDE_SPACER_TAIL || wide === WIDE_SPACER_HEAD) continue;
        const tag = field(lo, hi, tagB);
        const styleId = field(lo, hi, styleB);
        const bgOnly = tag === CONTENT_BG_PALETTE || tag === CONTENT_BG_RGB;
        // the style id changes whenever the style does; bg-only cells carry their colour in the cell itself
        const key = bgOnly ? -2 - lo : styleId;
        if (!run || key !== runKey) {
          run = { x: col, cells: [], fg: null, bg: null, flags: 0 };
          runKey = key;
          runs.push(run);
          if (styleId !== 0 || bgOnly) {
            x.ghostty_render_state_row_cells_select(this.cells, col);
            if (x.ghostty_render_state_row_cells_get(this.cells, CELLS_FG, colorOut) === 0) {
              dv = this.view();
              run.fg = hex(dv.getUint8(colorOut), dv.getUint8(colorOut + 1), dv.getUint8(colorOut + 2));
            }
            if (x.ghostty_render_state_row_cells_get(this.cells, CELLS_BG, colorOut) === 0) {
              dv = this.view();
              run.bg = hex(dv.getUint8(colorOut), dv.getUint8(colorOut + 1), dv.getUint8(colorOut + 2));
            }
            if (!bgOnly && x.ghostty_render_state_row_cells_get(this.cells, CELLS_STYLE, styleOut) === 0) {
              dv = this.view();
              run.flags = dv.getUint16(styleOut + this.flagsOffset, true);
            }
            dv = this.view();
          }
        }
        let text: string;
        if (tag === CONTENT_CODEPOINT_GRAPHEME) {
          text = this.grapheme(col);
          dv = this.view();
        } else {
          const cp = bgOnly ? 0 : field(lo, hi, cpB);
          text = cp === 0 ? " " : String.fromCodePoint(cp);
        }
        run.cells.push({ text, wide: wide === WIDE_WIDE });
      }
      draw(y, runs);
    }
    this.check(x.ghostty_render_state_clean(this.state), "clean");
    return true;
  }

  private grapheme(col: number): string {
    const x = this.x;
    x.ghostty_render_state_row_cells_select(this.cells, col);
    const buf = this.scratch + 256;
    const cap = 120;
    let dv = this.view();
    // GhosttyBuffer { ptr, cap, len } on wasm32
    dv.setUint32(this.scratch + 240, buf, true);
    dv.setUint32(this.scratch + 244, cap, true);
    dv.setUint32(this.scratch + 248, 0, true);
    if (x.ghostty_render_state_row_cells_get(this.cells, CELLS_GRAPHEMES_UTF8, this.scratch + 240) !== 0) {
      // a long ZWJ sequence: the call names the room it needs
      const need = this.view().getUint32(this.scratch + 248, true);
      if (need <= cap) return " ";
      const big = x.ghostty_wasm_alloc(need);
      try {
        dv = this.view();
        dv.setUint32(this.scratch + 240, big, true);
        dv.setUint32(this.scratch + 244, need, true);
        dv.setUint32(this.scratch + 248, 0, true);
        if (x.ghostty_render_state_row_cells_get(this.cells, CELLS_GRAPHEMES_UTF8, this.scratch + 240) !== 0) return " ";
        const n = this.view().getUint32(this.scratch + 248, true);
        return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, big, n).slice()) || " ";
      } finally {
        x.ghostty_wasm_free(big, need);
      }
    }
    dv = this.view();
    const n = dv.getUint32(this.scratch + 248, true);
    return new TextDecoder().decode(new Uint8Array(this.x.memory.buffer, buf, n)) || " ";
  }

  private getU8(key: number): number {
    this.check(this.x.ghostty_render_state_get(this.state, key, this.scratch), `render_state_get ${key}`);
    return this.view().getUint8(this.scratch);
  }

  private getU16(key: number): number {
    this.check(this.x.ghostty_render_state_get(this.state, key, this.scratch), `render_state_get ${key}`);
    return this.view().getUint16(this.scratch, true);
  }

  cursor(): GhosttyCursor {
    const visible = this.getU8(RS_DATA_CURSOR_VISIBLE) !== 0 && this.getU8(RS_DATA_CURSOR_VIEWPORT_HAS_VALUE) !== 0;
    if (!visible) return { visible: false, x: 0, y: 0, style: 1 };
    return { visible, x: this.getU16(RS_DATA_CURSOR_VIEWPORT_X), y: this.getU16(RS_DATA_CURSOR_VIEWPORT_Y), style: this.getU8(RS_DATA_CURSOR_VISUAL_STYLE) };
  }

  /** the Kitty images on screen after the last frame(), or null when the list has not changed since the last call */
  placedImages(): GhosttyImage[] | null {
    const x = this.x;
    const dv0 = this.view();
    dv0.setBigUint64(this.scratch, 0n, true);
    this.check(x.ghostty_render_state_get(this.state, RS_DATA_IMAGE_PLACEMENTS_GENERATION, this.scratch), "placements generation");
    const generation = Number(this.view().getBigUint64(this.scratch, true));
    if (generation === this.placementsGeneration) return null;
    this.placementsGeneration = generation;
    this.view().setUint32(this.scratch, this.images, true);
    this.check(x.ghostty_render_state_get(this.state, RS_DATA_IMAGE_ITERATOR, this.scratch), "image iterator");
    const out = this.scratch + 64;
    const read = (key: number, signed = false): number => {
      const dv = this.view();
      dv.setBigUint64(out, 0n, true);
      if (x.ghostty_render_state_image_get(this.images, key, out) !== 0) return 0;
      const fresh = this.view();
      return signed ? fresh.getInt32(out, true) : fresh.getUint32(out, true);
    };
    const list: GhosttyImage[] = [];
    while (x.ghostty_render_state_image_iterator_next(this.images)) {
      const dv = this.view();
      dv.setBigUint64(out, 0n, true);
      x.ghostty_render_state_image_get(this.images, IMAGE_GENERATION, out);
      const imageGeneration = Number(this.view().getBigUint64(out, true));
      list.push({
        id: read(IMAGE_ID), generation: imageGeneration, layer: read(IMAGE_LAYER), z: read(IMAGE_Z, true),
        col: read(IMAGE_COL, true), row: read(IMAGE_ROW, true), offsetX: read(IMAGE_OFFSET_X), offsetY: read(IMAGE_OFFSET_Y),
        width: read(IMAGE_WIDTH), height: read(IMAGE_HEIGHT),
        source: { x: read(IMAGE_SOURCE_X), y: read(IMAGE_SOURCE_Y), width: read(IMAGE_SOURCE_WIDTH), height: read(IMAGE_SOURCE_HEIGHT) },
      });
    }
    return list;
  }

  /** a stored Kitty image's pixels as RGBA, copied out of the module; null once the program deleted it */
  imagePixels(id: number): ImageData | null {
    const x = this.x;
    this.view().setUint32(this.scratch, 0, true);
    if (x.ghostty_terminal_get(this.terminal, DATA_KITTY_GRAPHICS, this.scratch) !== 0) return null;
    const graphics = this.view().getUint32(this.scratch, true);
    const image = x.ghostty_kitty_graphics_image(graphics, id);
    if (!image) return null;
    const u32 = (key: number): number => {
      this.check(x.ghostty_kitty_graphics_image_get(image, key, this.scratch + 64), `image ${key}`);
      return this.view().getUint32(this.scratch + 64, true);
    };
    const width = u32(KITTY_WIDTH), height = u32(KITTY_HEIGHT), format = u32(KITTY_FORMAT);
    const ptr = u32(KITTY_DATA_PTR), len = u32(KITTY_DATA_LEN);
    if (width === 0 || height === 0) return null;
    const source = new Uint8Array(this.x.memory.buffer, ptr, len);
    const rgba = new Uint8ClampedArray(width * height * 4);
    const pixels = width * height;
    if (format === FORMAT_RGBA) rgba.set(source.subarray(0, rgba.length));
    else {
      const channels = format === FORMAT_RGB ? 3 : format === FORMAT_GRAY_ALPHA ? 2 : format === FORMAT_GRAY ? 1 : 0;
      if (channels === 0) return null;
      for (let p = 0; p < pixels; p++) {
        const s = p * channels, d = p * 4;
        if (channels >= 3) { rgba[d] = source[s]!; rgba[d + 1] = source[s + 1]!; rgba[d + 2] = source[s + 2]!; rgba[d + 3] = 255; }
        else { rgba[d] = rgba[d + 1] = rgba[d + 2] = source[s]!; rgba[d + 3] = channels === 2 ? source[s + 1]! : 255; }
      }
    }
    return new ImageData(rgba, width, height);
  }

  dispose(): void {
    const x = this.x;
    x.ghostty_render_state_image_iterator_free(this.images);
    x.ghostty_render_state_row_cells_free(this.cells);
    x.ghostty_render_state_row_iterator_free(this.iterator);
    x.ghostty_render_state_free(this.state);
    x.ghostty_terminal_free(this.terminal);
    x.ghostty_wasm_free(this.scratch, 1024);
    if (this.input) x.ghostty_wasm_free(this.input, this.inputCap);
  }
}
