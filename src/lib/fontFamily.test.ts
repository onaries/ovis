import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { chatFontStack, type FontWidths, loadFontStack, measurableFontStack, TERMINAL_FONT_STACK, terminalFontStack } from "./fontFamily.ts";

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
