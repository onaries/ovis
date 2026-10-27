import { afterEach, describe, expect, it } from "bun:test";
import type { Terminal } from "@xterm/xterm";

import { adjustTerminalGlyphs, coversAny, displayText, followLateFaces, glyphFit, iconScale, type LateFace, oversizedIcon, textPresentation } from "./terminalGlyphs.ts";

// iPhone Safari at 13px: Menlo cells are 7.84px, Hangul from Apple SD Gothic Neo 11.24px
const IOS_CELL = 7.8367;
const IOS_HANGUL = 11.245;

describe("glyphFit", () => {
  it("enlarges an iPhone Hangul syllable, capped, and centers what is left", () => {
    const fit = glyphFit(2 * IOS_CELL - IOS_HANGUL, IOS_HANGUL, IOS_CELL);
    expect(fit?.scale).toBe(1.2);
    // the glyph and the spacing after scaling still fill exactly the two cells
    expect(IOS_HANGUL * fit!.scale + fit!.spacing).toBeCloseTo(2 * IOS_CELL, 6);
    expect(fit!.spacing).toBeGreaterThan(0);
  });

  it("enlarges a 1em Han glyph only until it fills 90% of its cells", () => {
    const fit = glyphFit(2 * IOS_CELL - 13, 13, IOS_CELL);
    expect(13 * fit!.scale).toBeCloseTo(0.9 * 2 * IOS_CELL, 6);
    expect(fit!.spacing).toBeCloseTo(0.1 * 2 * IOS_CELL, 6);
  });

  it("leaves a glyph that nearly fills its cells as drawn (CJK on Linux)", () => {
    expect(glyphFit(1.04, 13, 7.02)).toBeNull();
  });

  it("only centers a narrow glyph in one cell, never enlarges it", () => {
    expect(glyphFit(IOS_CELL - 3.25, 3.25, IOS_CELL)).toEqual({ scale: 1, spacing: IOS_CELL - 3.25 });
  });

  it("leaves rounding-level spacing and glyphs wider than their cells alone", () => {
    expect(glyphFit(0.6, 4, 4.6)).toBeNull();
    expect(glyphFit(2 * IOS_CELL - 17, 17, IOS_CELL)).toBeNull();
  });
});

describe("icons fitted to their cells", () => {
  it("takes a Nerd Font icon wider than its cell for one to fit, and nothing else", () => {
    // Symbols Nerd Font Mono advances 1em: 13px against a 6.5px cell
    expect(oversizedIcon("\uf07b", 13, 6.5)).toBe(true);
    expect(oversizedIcon("\u{f0219}", 13, 7.8)).toBe(true);
    expect(oversizedIcon("\uf07b", 7, 6.5)).toBe(false);
    expect(oversizedIcon("👍", 13, 6.5)).toBe(false);
    expect(oversizedIcon("①", 13, 6.5)).toBe(false);
    expect(oversizedIcon("a", 13, 6.5)).toBe(false);
  });

  it("scales a run so its widest icon fills its cell", () => {
    expect(iconScale([13, 13], 6.5)).toBe(0.5);
    expect(iconScale([13, 10], 6.5)).toBe(0.5);
    expect(iconScale([6], 6.5)).toBe(1);
  });
});

describe("textPresentation", () => {
  it("asks a text-default symbol for its text form, so iOS does not draw ⏺ as a two-cell emoji", () => {
    expect(textPresentation("⏺ ✔")).toBe("⏺\ufe0e ✔\ufe0e");
  });

  it("leaves a span alone when it already chooses a presentation anywhere", () => {
    // xterm measured ⏺️ as the emoji it asks to be; respacing it as text would shift X
    expect(textPresentation("⏺\ufe0fX")).toBeNull();
    expect(textPresentation("⏺⏺\ufe0f")).toBeNull();
    expect(textPresentation("⏺\ufe0e")).toBeNull();
  });

  it("leaves emoji and plain text alone", () => {
    expect(textPresentation("😀#1 ●")).toBeNull();
  });
});

describe("displayText", () => {
  it("composes stacked marks iOS Safari would drop", () => {
    expect(displayText("Tie\u0302\u0301ng a\u0306\u0309")).toBe("Tiếng ẳ");
  });

  it("composes decomposed Hangul into its syllables", () => {
    expect(displayText("\u1112\u1161\u11ab\u1100\u1173\u11af")).toBe("한글");
  });

  it("keeps text without marks as it is", () => {
    expect(displayText("한글 ﾊﾝｶｸ ㄱㅏ abc")).toBe("한글 ﾊﾝｶｸ ㄱㅏ abc");
  });
});

// PaneTerminal.css's faces, as FontFace gives them back (Chrome quotes the family, WebKit does not)
const ICON_RANGE = "U+e000-f8ff, U+f0000-ffffd";
const HANGUL_RANGE = "U+3131-318e, U+ac00-d7a3";
const STACK = '"Symbols Nerd Font Mono", Pretendard Variable, Menlo, "Noto Sans Mono CJK KR", "Ovis Hangul Mono", monospace';

describe("coversAny", () => {
  it("finds a face for text with any character in its ranges", () => {
    expect(coversAny(HANGUL_RANGE, "[나라]")).toBe(true);
    expect(coversAny(HANGUL_RANGE, "ab ㄱ")).toBe(true);
    expect(coversAny(HANGUL_RANGE, "abc 漢字")).toBe(false);
  });

  it("reads single code points, upper case and wildcards", () => {
    expect(coversAny("u+7c", "a|b")).toBe(true);
    expect(coversAny("U+AC00-D7A3", "한")).toBe(true);
    expect(coversAny("U+4??", "\u04ff")).toBe(true);
    expect(coversAny("U+4??", "\u0500")).toBe(false);
  });

  it("takes a face with no range for every character", () => {
    expect(coversAny("U+0-10FFFF", "🙂")).toBe(true);
  });
});

interface FakeFace extends LateFace {
  status: string;
  arrive(): void;
  fail(): void;
}

const face = (family: string, unicodeRange: string, status = "unloaded"): FakeFace => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const fake: FakeFace = {
    family, unicodeRange, status, loaded: promise,
    arrive: () => { fake.status = "loaded"; resolve(); },
    fail: () => { fake.status = "error"; reject(new Error("network")); },
  };
  return fake;
};

/** A terminal's late faces, with its frames run by hand. */
const follow = (faces: FakeFace[]) => {
  const frames: (() => void)[] = [];
  let arrivals = 0;
  const late = followLateFaces(faces, (callback) => { frames.push(callback); }, () => { arrivals += 1; });
  return { late, frames, arrivals: () => arrivals, runFrames: () => { for (const callback of frames.splice(0)) callback(); } };
};

// what follows each face ran before this: it was attached first
const settled = (faces: FakeFace[]) => Promise.allSettled(faces.map((each) => each.loaded));

describe("followLateFaces", () => {
  it("measures again once for faces that arrive between two frames, and again for a later one", async () => {
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    const regular = face("Ovis Hangul Mono", HANGUL_RANGE);
    const bold = face("Ovis Hangul Mono", HANGUL_RANGE);
    const { late, frames, arrivals, runFrames } = follow([icons, regular, bold]);
    late.ask(STACK, "\uf07b 가");
    icons.arrive();
    regular.arrive();
    await settled([icons, regular]);
    expect(frames).toHaveLength(1);
    runFrames();
    expect(arrivals()).toBe(1);

    bold.arrive();
    await settled([bold]);
    runFrames();
    expect(arrivals()).toBe(2);
  });

  it("measures again for a chunk that arrived when another chunk of the text failed", async () => {
    const first = face("Pretendard Variable", "U+ac00-b097");
    const second = face("Pretendard Variable", "U+b098-d7a3");
    const { late, arrivals, runFrames } = follow([first, second]);
    late.ask(STACK, "가나");
    first.fail();
    second.arrive();
    await settled([first, second]);
    runFrames();
    expect(arrivals()).toBe(1);
  });

  it("follows the face of a character drawn while another face of its family is loading", async () => {
    const loading = face("Pretendard Variable", "U+ac00-b097", "loading");
    const later = face("Pretendard Variable", "U+b098-d7a3");
    const { late, arrivals, runFrames } = follow([loading, later]);
    late.ask(STACK, "가");
    late.ask(STACK, "a나");
    loading.fail();
    later.arrive();
    await settled([loading, later]);
    runFrames();
    expect(arrivals()).toBe(1);
  });

  it("follows a face whose family was typed in another case, as CSS matches it", async () => {
    const chunk = face('"Pretendard Variable"', "U+ac00-d7a3");
    const { late, arrivals, runFrames } = follow([chunk]);
    late.ask('"Symbols Nerd Font Mono", "pretendard variable", Menlo, monospace', "나");
    chunk.arrive();
    await settled([chunk]);
    runFrames();
    expect(arrivals()).toBe(1);
  });

  it("follows no face that loaded, failed, stands outside the stack or covers none of the text", async () => {
    const faces = [
      face("Ovis Hangul Mono", HANGUL_RANGE, "loaded"),
      face("Ovis Hangul Mono", HANGUL_RANGE, "error"),
      face('"JetBrains Mono Web"', "U+0-10ffff"),
      face('"Symbols Nerd Font Mono"', ICON_RANGE),
    ];
    const { late, frames } = follow(faces);
    late.ask(STACK, "가");
    for (const each of faces) each.arrive();
    await settled(faces);
    expect(frames).toHaveLength(0);
  });

  it("measures nothing again for a terminal that stopped", async () => {
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    const hangul = face("Ovis Hangul Mono", HANGUL_RANGE);
    const { late, frames, arrivals, runFrames } = follow([icons, hangul]);
    late.ask(STACK, "\uf07b가");
    icons.arrive();
    await settled([icons]);
    late.stop();
    runFrames();
    hangul.arrive();
    await settled([hangul]);
    expect(frames).toHaveLength(0);
    expect(arrivals()).toBe(0);
  });
});

const GLOBALS = ["document", "HTMLSpanElement", "MutationObserver", "requestAnimationFrame"] as const;

/** What the renderer needs of a span: its text, classes, inline style and children. */
class FakeSpan {
  textContent = "";
  className = "";
  style: Record<string, string> = { letterSpacing: "", cssText: "" };
  children: FakeSpan[] = [];
  classList = { contains: (name: string) => this.className.split(" ").includes(name) };
  append(...nodes: FakeSpan[]): void { this.children.push(...nodes); }
  replaceChildren(...nodes: FakeSpan[]): void { this.children = nodes; }
}

/**
 * adjustTerminalGlyphs on a stand-in page: one 7.8px cell per column, a canvas that measures an icon
 * 6px wide while its face has not loaded (the stand-in's width) and 13px once it has, xterm's rows
 * redrawn only when the test says (`draw`), and frames run by hand.
 */
function glyphPage(faces: FakeFace[]) {
  const before = GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const frames: (() => void)[] = [];
  const observers: ((records: { addedNodes: FakeSpan[] }[]) => void)[] = [];
  const icons = faces.find((each) => each.family.includes("Symbols"))!;
  const measure = { font: "", measureText: (text: string) => ({ width: /[\ue000-\uf8ff]/u.test(text) ? (icons.status === "loaded" ? 13 : 6) : 7.8 }) };
  const define = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  define("document", { fonts: faces, createElement: (tag: string) => tag === "canvas" ? { getContext: () => measure } : new FakeSpan() });
  define("HTMLSpanElement", FakeSpan);
  define("MutationObserver", class { constructor(callback: (records: { addedNodes: FakeSpan[] }[]) => void) { observers.push(callback); } observe() {} disconnect() {} });
  define("requestAnimationFrame", (callback: () => void) => frames.push(callback));
  const span = (text: string): FakeSpan => Object.assign(new FakeSpan(), { textContent: text });
  const drawn = [span("\uf07b"), span("가")];
  const rows = { querySelectorAll: () => drawn };
  const screen = { style: { width: "78px", height: "15px" }, querySelector: () => null };
  const term = {
    cols: 10, rows: 1, refreshes: 0,
    options: { fontFamily: '"Symbols Nerd Font Mono", Menlo, "Ovis Hangul Mono", monospace', fontSize: 13, fontWeight: "normal", fontWeightBold: "bold" },
    element: { querySelector: (selector: string) => selector === ".xterm-rows" ? rows : selector === ".xterm-screen" ? screen : null },
    refresh() { term.refreshes += 1; },
  };
  const stop = adjustTerminalGlyphs(term as unknown as Terminal);
  return {
    term, stop,
    runFrames: () => { for (const callback of frames.splice(0)) callback(); },
    /** xterm draws a row again: its new span goes through the observer, as a MutationObserver delivers it */
    draw: (text: string): FakeSpan => { const added = span(text); observers[0]!([{ addedNodes: [added] }]); return added; },
    restore: () => { for (const [name, descriptor] of before) descriptor ? Object.defineProperty(globalThis, name, descriptor) : Reflect.deleteProperty(globalThis, name); },
  };
}

/** the font size an icon was drawn at inside its cell, or null when its span was left as xterm drew it */
const iconSize = (span: FakeSpan): number | null => {
  const glyphs = span.children[0]?.children[0];
  const size = glyphs?.style["cssText"]?.match(/font-size:([\d.]+)px/);
  return size ? Number(size[1]) : null;
};

describe("adjustTerminalGlyphs with late faces", () => {
  let page: ReturnType<typeof glyphPage> | undefined;
  afterEach(() => {
    page?.stop();
    page?.restore();
    page = undefined;
  });

  it("measures an icon again once its face arrived, though a later arrival set the family back before the rows were drawn again", async () => {
    const icons = face('"Symbols Nerd Font Mono"', ICON_RANGE);
    const hangul = face('"Ovis Hangul Mono"', HANGUL_RANGE);
    page = glyphPage([icons, hangul]);
    const family = page.term.options.fontFamily;
    // each arrival in a frame of its own, and xterm draws no row in between
    icons.arrive();
    await settled([icons]);
    page.runFrames();
    hangul.arrive();
    await settled([hangul]);
    page.runFrames();
    expect(page.term.options.fontFamily).toBe(family);
    expect(page.term.refreshes).toBe(2);

    const redrawn = page.draw("\uf07b");
    expect(iconSize(redrawn)).toBeCloseTo(7.8, 5);
  });
});
