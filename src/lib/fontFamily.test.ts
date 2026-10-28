import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";

import { chatFontStack, type FontWidths, HANGUL_FAMILY, loadFontStack, measurableFontStack, TERMINAL_FONT_STACK, terminalFontStack } from "./fontFamily.ts";

// woff2's known table tags, by the index its table directory writes for them
const WOFF2_TAGS = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB"];

/** The code points a woff2 file maps to a glyph (its format 4 cmaps), as inclusive ranges. */
function cmapRanges(file: Buffer): [number, number][] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  expect(view.getUint32(0)).toBe(0x774f4632); // "wOF2"
  let at = 48;
  const base128 = (): number => {
    let value = 0;
    for (;;) {
      const byte = file[at++]!;
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
  };
  const tables: { tag: string; length: number }[] = [];
  for (let index = view.getUint16(12); index > 0; index -= 1) {
    const flags = file[at++]!;
    const tag = (flags & 0x3f) === 0x3f ? file.toString("latin1", at, (at += 4)) : WOFF2_TAGS[flags & 0x3f] ?? "?";
    const length = base128();
    // glyf and loca are transformed unless their version says not; another table only when it says so
    const transformed = tag === "glyf" || tag === "loca" ? flags >> 6 === 0 : flags >> 6 !== 0;
    tables.push({ tag, length: transformed ? base128() : length });
  }
  const data = brotliDecompressSync(file.subarray(at, at + view.getUint32(20)));
  let offset = 0;
  for (const table of tables) {
    if (table.tag === "cmap") break;
    offset += table.length;
  }
  const cmap = new DataView(data.buffer, data.byteOffset + offset);
  const points = new Set<number>();
  for (let index = 0; index < cmap.getUint16(2); index += 1) {
    const sub = cmap.getUint32(8 + index * 8);
    expect(cmap.getUint16(sub)).toBe(4);
    const segments = cmap.getUint16(sub + 6) / 2;
    for (let segment = 0; segment < segments; segment += 1) {
      const end = cmap.getUint16(sub + 14 + segment * 2);
      const start = cmap.getUint16(sub + 16 + segments * 2 + segment * 2);
      const delta = cmap.getInt16(sub + 16 + segments * 4 + segment * 2);
      const rangeAt = sub + 16 + segments * 6 + segment * 2;
      const rangeOffset = cmap.getUint16(rangeAt);
      for (let point = start; point <= end && point !== 0xffff; point += 1) {
        const entry = rangeOffset === 0 ? point : cmap.getUint16(rangeAt + rangeOffset + (point - start) * 2);
        // a glyph array's 0 is the missing glyph as it stands; any other entry takes the delta too
        const glyph = rangeOffset !== 0 && entry === 0 ? 0 : (entry + delta) & 0xffff;
        if (glyph !== 0) points.add(point);
      }
    }
  }
  const ranges: [number, number][] = [];
  for (const point of [...points].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && last[1] === point - 1) last[1] = point;
    else ranges.push([point, point]);
  }
  return ranges;
}

describe("terminal font stack", () => {
  it("is the built-in stack when nothing is typed", () => {
    expect(terminalFontStack("")).toBe(TERMINAL_FONT_STACK);
    expect(terminalFontStack("  , ")).toBe(TERMINAL_FONT_STACK);
  });

  it("puts the typed list after the icon font and in front of the text fonts, never in place of them", () => {
    const stack = terminalFontStack('D2Coding, "Cascadia Mono"');
    // the bundled icon font never sizes a cell, so it stays first and its icons draw over any font
    expect(stack.startsWith('"Symbols Nerd Font Mono", D2Coding, "Cascadia Mono", "JetBrains Mono"')).toBe(true);
    // a missing font falls through to today's order, and Malgun Gothic stays the last resort
    expect(stack.replace('D2Coding, "Cascadia Mono", ', "")).toBe(TERMINAL_FONT_STACK);
    expect(stack.endsWith('monospace, "Malgun Gothic"')).toBe(true);
  });

  it("takes none of the faces the app bundles for its own text: xterm would size its cells from one", () => {
    const sheets = ["../fonts/fonts.css", "../fonts/pretendard/pretendardvariable-dynamic-subset.css"].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
    const bundled = new Set([...sheets.matchAll(/font-family:\s*["']([^"']+)["']/g)].map((match) => match[1]!));
    expect([...bundled].sort()).toEqual(["JetBrains Mono Web", "Pretendard Variable"]);
    const named = TERMINAL_FONT_STACK.split(",").map((name) => name.trim().replace(/["']/g, ""));
    for (const family of bundled) expect(named).not.toContain(family);
    // the chat's and the chrome's code face does take it, after the icon font
    const mono = /--font-mono:\s*([^;]+);/.exec(readFileSync(new URL("../styles.css", import.meta.url), "utf8"))![1]!;
    expect(mono.startsWith('"Symbols Nerd Font Mono", "JetBrains Mono Web", ')).toBe(true);
  });

  it("draws Hangul in the bundled coding face where no Korean coding font is installed, before the generic monospace", () => {
    const named = TERMINAL_FONT_STACK.split(",").map((name) => name.trim().replace(/["']/g, ""));
    expect(named.indexOf(HANGUL_FAMILY)).toBeGreaterThan(named.indexOf("Noto Sans Mono CJK KR"));
    expect(named.indexOf(HANGUL_FAMILY)).toBeLessThan(named.indexOf("monospace"));
  });

  it("bundles the Hangul face with no Latin in its range, so it never sizes a cell", () => {
    const css = readFileSync(new URL("../components/PaneTerminal.css", import.meta.url), "utf8");
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]!).filter((face) => face.includes(`"${HANGUL_FAMILY}"`));
    expect(faces.map((face) => /font-weight:\s*(\d+)/.exec(face)?.[1])).toEqual(["400", "700"]);
    for (const face of faces) {
      const file = /url\("([^"]+)"\)/.exec(face)![1]!;
      expect(existsSync(new URL(file, new URL("../components/", import.meta.url)))).toBe(true);
      // the compatibility jamo and the syllables, nothing else: Latin, punctuation, box drawing and the
      // private use area stay with the cell's font and the icon font
      expect(/unicode-range:\s*([^;]+);/.exec(face)![1]!.trim()).toBe("U+3131-318E, U+AC00-D7A3");
      // and the file draws exactly what the range sends it
      expect(cmapRanges(readFileSync(new URL(file, new URL("../components/", import.meta.url))))).toEqual([[0x3131, 0x318e], [0xac00, 0xd7a3]]);
    }
  });

  it("never lets an unsanitized list through", () => {
    expect(terminalFontStack("x; } body { color: red")).toBe(TERMINAL_FONT_STACK.replace(", ", ', "x body color: red", '));
  });
});

describe("fonts the canvas cannot measure", () => {
  // a page that has the fonts in `drawn` and a canvas that has those in `measured`: a list is as wide
  // as its first font either one has, and every monospaced face is as wide as monospace
  const page = (drawn: readonly string[], measured: readonly string[]): FontWidths => {
    const width = (has: readonly string[]) => (family: string): number => {
      const names = family.split(",").map((name) => name.trim().replace(/["']/g, ""));
      const first = names.find((name) => has.includes(name) || name === "monospace" || name === "serif");
      return first === "serif" ? 280 : first === "D2Coding" ? 270 : 300;
    };
    return { drawn: width(drawn), measured: width(measured) };
  };
  const system = ["Menlo", "Monaco"];
  const installed = ["JetBrains Mono", "D2Coding"];

  it("leaves out the installed fonts Ovis for Mac's web view draws but its canvas cannot measure", () => {
    const widths = page([...system, ...installed], system);
    expect(measurableFontStack(TERMINAL_FONT_STACK, widths)).toBe(TERMINAL_FONT_STACK.replace('"JetBrains Mono", ', "").replace('"D2Coding", ', ""));
    // a font typed in Settings goes the same way
    expect(measurableFontStack(terminalFontStack("D2Coding"), widths)).toBe(TERMINAL_FONT_STACK.replace('"JetBrains Mono", ', "").replace('"D2Coding", ', ""));
  });

  it("keeps the stack where the canvas measures what the page draws, as in Chromium and Safari", () => {
    expect(measurableFontStack(TERMINAL_FONT_STACK, page([...system, ...installed], [...system, ...installed]))).toBe(TERMINAL_FONT_STACK);
    expect(measurableFontStack(TERMINAL_FONT_STACK, page(system, system))).toBe(TERMINAL_FONT_STACK);
  });

  it("keeps the bundled icon font, which the canvas measures once it has loaded", () => {
    expect(measurableFontStack(TERMINAL_FONT_STACK, page(["Symbols Nerd Font Mono", ...system], system))).toBe(TERMINAL_FONT_STACK);
  });

  it("keeps the bundled Hangul face when it drops an installed D2Coding, so Hangul stays a coding face", () => {
    const kept = measurableFontStack(TERMINAL_FONT_STACK, page([HANGUL_FAMILY, ...system, ...installed], system));
    expect(kept).toBe(TERMINAL_FONT_STACK.replace('"JetBrains Mono", ', "").replace('"D2Coding", ', ""));
    expect(kept).toContain(`"${HANGUL_FAMILY}"`);
  });

  it("measures nothing without a page", () => {
    expect(measurableFontStack(TERMINAL_FONT_STACK)).toBe(TERMINAL_FONT_STACK);
  });
});

describe("chat font stack", () => {
  it("keeps the UI font when nothing is typed", () => {
    expect(chatFontStack("")).toBeNull();
    expect(chatFontStack(" ")).toBeNull();
  });

  it("puts the typed list in front of the UI font", () => {
    expect(chatFontStack("Pretendard, Noto Sans KR")).toBe('Pretendard, "Noto Sans KR", var(--font-ui)');
  });
});

describe("waiting for a font", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete (globalThis as { document?: unknown }).document;
  });
  const withFonts = (load: (font: string, text?: string) => Promise<unknown>): void => {
    Object.defineProperty(globalThis, "document", { value: { fonts: { load } }, configurable: true, writable: true });
  };

  it("asks for the stack at the terminal's size", async () => {
    const asked: string[] = [];
    withFonts(async (font) => { asked.push(font); return []; });
    await loadFontStack('D2Coding, "Cascadia Mono"', 14);
    expect(asked).toEqual(['14px D2Coding, "Cascadia Mono"']);
  });

  it("leaves the bundled Hangul face out, which never sizes the grid", async () => {
    const asked: string[] = [];
    withFonts(async (font) => { asked.push(font); return []; });
    await loadFontStack(terminalFontStack("D2Coding"), 13);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toStartWith('13px "Symbols Nerd Font Mono", D2Coding, "JetBrains Mono"');
    expect(asked[0]).not.toContain(HANGUL_FAMILY);
    expect(asked[0]).toEndWith("monospace, \"Malgun Gothic\"");
  });

  it("leaves the bundled Hangul face out whatever case it was typed in, as CSS matches it", async () => {
    const asked: string[] = [];
    withFonts(async (font) => { asked.push(font); return []; });
    await loadFontStack(terminalFontStack("ovis hangul mono, D2Coding"), 13);
    expect(asked[0]).toStartWith('13px "Symbols Nerd Font Mono", D2Coding, "JetBrains Mono"');
    expect(asked[0]!.toLowerCase()).not.toContain(HANGUL_FAMILY.toLowerCase());
  });

  it("resolves when the load fails, so the terminal goes on with its fallback", async () => {
    withFonts(() => Promise.reject(new SyntaxError("bad font")));
    await expect(loadFontStack("D2Coding", 13)).resolves.toBeUndefined();
  });

  it("stops waiting after the timeout", async () => {
    withFonts(() => new Promise(() => {}));
    const started = performance.now();
    await loadFontStack("D2Coding", 13, 20);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("does nothing without a font loading API", async () => {
    Object.defineProperty(globalThis, "document", { value: {}, configurable: true, writable: true });
    await expect(loadFontStack("D2Coding", 13)).resolves.toBeUndefined();
  });
});
