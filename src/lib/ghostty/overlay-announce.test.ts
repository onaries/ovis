import { afterAll, expect, spyOn, test } from "bun:test";
import { attachGhosttyOverlay } from "./overlay.ts";

/** just enough of an element for the overlay: children, attributes, style and a box */
class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, unknown> & { setProperty(name: string, value: string): void } = { setProperty(name, value) { this[name] = value; } };
  className = "";
  innerHTML = "";
  box = { width: 0, height: 0 };
  #text = "";
  get textContent(): string { return this.#text; }
  set textContent(value: string) { this.#text = value; this.children = []; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attributes.has(name); }
  append(...nodes: FakeElement[]): void { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove(): void { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  getBoundingClientRect(): { width: number; height: number } { return this.box; }
  /** a canvas with no 2D context: glyph widths read as 0, so every glyph is drawn as libghostty gives it */
  getContext(): null { return null; }
  listeners = new Map<string, () => void>();
  addEventListener(type: string, listener: () => void): void { this.listeners.set(type, listener); }
  removeEventListener(type: string): void { this.listeners.delete(type); }
  querySelector(): FakeElement | null { return screen; }
}

const screen = new FakeElement();
const frames: FrameRequestCallback[] = [];
const flush = (): void => { for (const frame of frames.splice(0)) frame(0); };
const fakes = {
  document: { createElement: () => new FakeElement() },
  requestAnimationFrame: (frame: FrameRequestCallback) => frames.push(frame),
  ResizeObserver: class { observe(): void {} disconnect(): void {} },
};
const saved = Object.fromEntries(Object.keys(fakes).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
Object.assign(globalThis, fakes);
afterAll(() => {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

test("only lines a program writes are announced: not a scroll back through history, nor a screen rebuilt at a new size (#2963)", async () => {
  const COLS = 40, ROWS = 6;
  screen.box = { width: COLS * 8, height: ROWS * 16 };
  const listeners = { render: [] as (() => void)[], scroll: [] as (() => void)[], resize: [] as (() => void)[] };
  const on = (list: (() => void)[]) => (listener: () => void) => { list.push(listener); return { dispose: () => {} }; };
  const buffer = { baseY: 0, viewportY: 0 };
  const term: any = {
    cols: COLS, rows: ROWS, element: screen, buffer: { active: buffer },
    options: { fontFamily: "monospace", fontSize: 13, theme: {}, scrollback: 100 },
    write: () => {}, reset: () => {}, refresh: () => {},
    onResize: on(listeners.resize), onRender: on(listeners.render), onScroll: on(listeners.scroll),
  };
  const host = new FakeElement();
  const history = Array.from({ length: 30 }, (_, i) => `OLD-${i}\r\n`).join("");
  const overlay = await attachGhosttyOverlay(term, host as unknown as HTMLElement, () => [history]);
  try {
    const announcer = screen.children[0]!.children.find((child) => child.hasAttribute("aria-live"))!;
    const frame = (listener: "render" | "scroll" | "resize"): string => {
      for (const callback of listeners[listener]) callback();
      flush();
      return announcer.textContent;
    };
    flush();
    expect(announcer.textContent).toBe("");
    term.write("HELLO\r\n");
    expect(frame("render")).toBe("HELLO");

    // the wheel moves xterm's view up three rows and back: no byte was written
    buffer.baseY = 25;
    buffer.viewportY = 22;
    expect(frame("scroll")).toBe("HELLO");
    buffer.viewportY = 25;
    expect(frame("scroll")).toBe("HELLO");

    // a larger font on the same grid: the cells grow, the rows are rebuilt with the text they had
    term.options.fontSize = 15;
    screen.box = { width: COLS * 9, height: ROWS * 18 };
    expect(frame("render")).toBe("HELLO");
    term.write("WORLD\r\n");
    expect(frame("render")).toBe("WORLD");

    // a line printed as the font changes, before the frame that draws both, is still announced
    term.write("DURING\r\n");
    term.options.fontSize = 13;
    screen.box = { width: COLS * 8, height: ROWS * 16 };
    expect(frame("render")).toBe("DURING");

    // a pane that gets shorter and back again announces only the next line, not the rows it had hidden
    term.rows = 4;
    screen.box = { width: COLS * 8, height: 4 * 16 };
    frame("resize");
    term.rows = ROWS;
    screen.box = { width: COLS * 8, height: ROWS * 16 };
    expect(frame("resize")).toBe("DURING");
    term.write("AGAIN\r\n");
    expect(frame("render")).toBe("AGAIN");

    // a line written while the view is scrolled back is told once the view is back at the bottom
    buffer.baseY = 25;
    buffer.viewportY = 22;
    expect(frame("scroll")).toBe("AGAIN");
    term.write("BACKGROUND\r\n");
    buffer.baseY = 26;
    expect(frame("render")).toBe("AGAIN");
    buffer.viewportY = 26;
    expect(frame("scroll")).toBe("BACKGROUND");

    // a write and a scroll back in one frame tell no history; the write waits for the bottom
    term.write("BUSY\r\n");
    buffer.baseY = 27;
    buffer.viewportY = 24;
    expect(frame("scroll")).toBe("BACKGROUND");
    buffer.viewportY = 27;
    expect(frame("scroll")).toBe("BUSY");

    // a write as the pane gets shorter tells the new line alone
    term.write("SHORTER\r\n");
    term.rows = 4;
    screen.box = { width: COLS * 8, height: 4 * 16 };
    expect(frame("resize")).toBe("SHORTER");
  } finally {
    overlay?.dispose();
  }
});

test("on herdr's own server, the screen herdr repaints for a wheel is not announced as output; a line after it is", async () => {
  const COLS = 40, ROWS = 6;
  screen.box = { width: COLS * 8, height: ROWS * 16 };
  screen.children = [];
  const render: (() => void)[] = [];
  const term: any = {
    cols: COLS, rows: ROWS, element: screen, buffer: { active: { baseY: 0, viewportY: 0 } },
    options: { fontFamily: "monospace", fontSize: 13, theme: {}, scrollback: 0 },
    write: () => {}, reset: () => {}, refresh: () => {},
    onResize: () => ({ dispose: () => {} }), onRender: (listener: () => void) => { render.push(listener); return { dispose: () => {} }; }, onScroll: () => ({ dispose: () => {} }),
  };
  const host = new FakeElement();
  let now = 1000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const screenOf = (from: number) => `\x1b[H\x1b[2J${Array.from({ length: ROWS - 1 }, (_, i) => `L${from + i}`).join("\r\n")}`;
  const overlay = await attachGhosttyOverlay(term, host as unknown as HTMLElement, () => [screenOf(100)]);
  try {
    const announcer = screen.children[0]!.children.find((child) => child.hasAttribute("aria-live"))!;
    const frame = (): string => { for (const callback of render) callback(); flush(); return announcer.textContent; };
    flush();
    term.write("\r\nNEWLINE");
    expect(frame()).toBe("NEWLINE");
    // a wheel goes to herdr, which paints the screen scrolled up and later back at the bottom
    host.listeners.get("wheel")!();
    term.write(screenOf(90));
    expect(frame()).toBe("NEWLINE");
    now += 200;
    term.write(`${screenOf(101)}\r\nNEWLINE`);
    expect(frame()).toBe("NEWLINE");
    // output once the gesture is over is told again
    now += 2000;
    term.write("\r\nAFTER");
    expect(frame()).toBe("AFTER");
  } finally {
    overlay?.dispose();
    clock.mockRestore();
  }
});

test("colours as xterm draws them: readable at its minimum contrast except a Powerline glyph, faint text dimmed by half, a bold box bold", async () => {
  screen.box = { width: 40 * 8, height: 4 * 16 };
  screen.children = [];
  const term: any = {
    cols: 40, rows: 4, element: screen, buffer: { active: { baseY: 0, viewportY: 0 } },
    options: { fontFamily: "monospace", fontSize: 13, theme: { background: "#000000", foreground: "#ffffff" }, scrollback: 0, minimumContrastRatio: 4.5 },
    write: () => {}, reset: () => {}, refresh: () => {},
    onResize: () => ({ dispose: () => {} }), onRender: () => ({ dispose: () => {} }), onScroll: () => ({ dispose: () => {} }),
  };
  const backlog = "\x1b[38;2;52;101;164;48;2;78;154;6m\ue0b0X\x1b[0m\r\n\x1b[2mDIM\x1b[0m\r\n\x1b[1m\uAC00\x1b[0m";
  const overlay = await attachGhosttyOverlay(term, new FakeElement() as unknown as HTMLElement, () => [backlog]);
  try {
    flush();
    const rows = screen.children[0]!.children.find((child) => child.className === "ghostty-text")!.children.map((row) => row.innerHTML);
    // the separator keeps its blue on the green; the letter beside it is made readable
    expect(rows[0]).toContain(`<span style="color:#3465a4">\ue0b0</span>`);
    expect(rows[0]).not.toMatch(/^<span style="[^"]*color:#3465a4/);
    expect(rows[1]).toContain("color-mix(in srgb, currentColor 50%, transparent)");
    expect(rows[2]).toContain(`class="ghostty-wide xterm-bold"`);
  } finally {
    overlay?.dispose();
  }
});
