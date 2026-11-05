import { describe, expect, it } from "bun:test";
import { KEY_BAR_EXTRAS, NO_STICKY_MODIFIERS } from "./keys.ts";
import { DEFAULT_KEY_BAR_ITEMS, KEY_BAR_ARROW_PAD, KEY_BAR_ITEMS_MAX, KEY_BAR_KEYS, KEY_BAR_SECOND_ROW, keyBarInputSequence, keyBarItemId, keyBarItemLabel, keyBarRowItems, migrateKeyBarItems, sanitizeKeyBarItems, type KeyBarItem } from "./keyBar.ts";

describe("key bar migration", () => {
  const caps = (items: KeyBarItem[]) => items.map(keyBarItemLabel);

  it("preserves legacy migration order and selected extras", () => {
    expect(caps(migrateKeyBarItems(["alt"]))).toEqual(["Esc", "Tab", "Ctrl", "Alt", "Shift", "Enter", "↑", "↓", "←", "→", "^C"]);
    expect(caps(migrateKeyBarItems(["slash", "home-end", "shift-tab", "ctrl-z"]))).toEqual([
      "Esc", "Tab", "⇧Tab", "Ctrl", "Shift", "Enter", "↑", "↓", "←", "→", "Home", "End", "^C", "^Z", "/",
    ]);
    const all = migrateKeyBarItems(KEY_BAR_EXTRAS);
    expect(caps(all)).toEqual(["Esc", "Tab", "⇧Tab", "Ctrl", "Alt", "Shift", "Enter", "↑", "↓", "←", "→", "Home", "End", "PgUp", "PgDn", "^C", "^D", "^Z", "|", "~", "/"]);
    expect(all.filter((item) => item.type === "key" && ["Home", "End", "PageUp", "PageDown"].includes(item.key))).toHaveLength(4);
  });
});

describe("default key bar", () => {
  const caps = (items: KeyBarItem[]) => items.map(keyBarItemLabel);

  it("prioritizes core keys ahead of modifiers and navigation", () => {
    expect(caps(DEFAULT_KEY_BAR_ITEMS)).toEqual(["Esc", "Tab", "^C", "Ctrl", "Alt", "Shift", "Enter", "↑", "↓", "←", "→"]);
    expect(caps(sanitizeKeyBarItems(undefined))).toEqual(caps(DEFAULT_KEY_BAR_ITEMS));
  });
});

describe("saved key bars", () => {
  it("preserves reordered keys, exact chords, sticky toggles and intentional empty bars", () => {
    const items: KeyBarItem[] = [
      { type: "key", key: "z", modifiers: { ctrl: true, alt: false, shift: true } },
      { type: "key", key: "ArrowLeft" },
      { type: "modifier", modifier: "alt" },
      { type: "key", key: "😀", modifiers: NO_STICKY_MODIFIERS },
    ];
    expect(sanitizeKeyBarItems(items)).toEqual(items);
    expect(sanitizeKeyBarItems([])).toEqual([]);
    expect(sanitizeKeyBarItems(undefined)).toEqual(DEFAULT_KEY_BAR_ITEMS);
    expect(sanitizeKeyBarItems(null, items)).toEqual(items);
    expect(sanitizeKeyBarItems(JSON.parse(JSON.stringify(items)))).toEqual(items);
  });

  it("rejects terminal sequences, command/text blocks, invalid Unicode and malformed descriptors", () => {
    const invalidKeys = ["", "paste me", "rm -rf /", "F0", "F13", "Dead", "Unidentified", "\x00", "\r", "\x1b[A", "\x7f", "\x85", "\ud800", "\u00a0", "한글"];
    const raw: unknown[] = invalidKeys.map((key) => ({ type: "key", key }));
    raw.push(null, [], "Escape", { type: "modifier", modifier: "meta" }, { type: "key", key: "a", modifiers: null }, { type: "key", key: "a", modifiers: [] });
    raw.push({ type: "key", key: "한" }, { type: "key", key: "+" });
    expect(sanitizeKeyBarItems(raw)).toEqual([{ type: "key", key: "한" }, { type: "key", key: "+" }]);
  });

  it("normalizes boolean flags, deduplicates descriptors and retains the distinction between held and exact keys", () => {
    const raw = [
      { type: "modifier", modifier: "ctrl", ignored: true }, { type: "modifier", modifier: "ctrl" },
      { type: "key", key: "a" }, { type: "key", key: "a", modifiers: undefined },
      { type: "key", key: "a", modifiers: { ctrl: "true", alt: 1, shift: false } },
      { type: "key", key: "a", modifiers: {} },
      { type: "key", key: "a", modifiers: { ctrl: true, alt: false, shift: true } },
    ];
    const result = sanitizeKeyBarItems(raw);
    expect(result).toEqual([
      { type: "modifier", modifier: "ctrl" }, { type: "key", key: "a" },
      { type: "key", key: "a", modifiers: NO_STICKY_MODIFIERS },
      { type: "key", key: "a", modifiers: { ctrl: true, alt: false, shift: true } },
    ]);
    expect(new Set(result.map(keyBarItemId)).size).toBe(result.length);
    expect(result.map(keyBarItemLabel)).toEqual(["Ctrl", "a", "a", "Ctrl+Shift+a"]);
  });

  it("bounds a large saved layout and owns its sanitized modifier objects", () => {
    const raw: KeyBarItem[] = Array.from({ length: 100 }, (_, index) => ({ type: "key", key: String.fromCodePoint(0x400 + index), modifiers: { ctrl: true, alt: false, shift: false } }));
    const result = sanitizeKeyBarItems(raw);
    expect(result).toHaveLength(KEY_BAR_ITEMS_MAX);
    const first = result[0];
    if (first?.type === "key") first.modifiers!.ctrl = false;
    expect((raw[0] as { modifiers: { ctrl: boolean } }).modifiers.ctrl).toBe(true);
  });
});

describe("key bar input", () => {
  it("covers the named catalog, printable scalar keys and application cursor mode", () => {
    for (const key of KEY_BAR_KEYS) expect(keyBarInputSequence(key, false)).not.toBeNull();
    expect(keyBarInputSequence("ArrowLeft", false)).toBe("\x1b[D");
    expect(keyBarInputSequence("ArrowLeft", true)).toBe("\x1bOD");
    expect(keyBarInputSequence("Home", true)).toBe("\x1bOH");
    expect(keyBarInputSequence("Backspace", false)).toBe("\x7f");
    expect(keyBarInputSequence("Delete", false)).toBe("\x1b[3~");
    expect(keyBarInputSequence("Insert", false)).toBe("\x1b[2~");
    expect(keyBarInputSequence("ctrl-c", false)).toBe("\x03");
    for (const key of [" ", "+", "я", "😀"]) expect(keyBarInputSequence(key, false)).toBe(key);
    expect(["F1", "F4", "F5", "F12"].map((key) => keyBarInputSequence(key, false))).toEqual(["\x1bOP", "\x1bOS", "\x1b[15~", "\x1b[24~"]);
  });
});

describe("keyBarRowItems", () => {
  it("keeps the first row as saved when compact", () => {
    expect(keyBarRowItems(DEFAULT_KEY_BAR_ITEMS, false)).toBe(DEFAULT_KEY_BAR_ITEMS);
  });

  it("expanded, leaves out the plain keys the second row and the arrow pad show, keeping modifiers and combinations", () => {
    const combination: KeyBarItem = { type: "key", key: "ArrowLeft", modifiers: { ctrl: true, alt: false, shift: false } };
    const items: KeyBarItem[] = [...DEFAULT_KEY_BAR_ITEMS, { type: "key", key: "pipe" }, { type: "key", key: "-" }, { type: "key", key: "Home" }, combination];
    expect(keyBarRowItems(items, true).map(keyBarItemId)).toEqual([
      "key:\"ctrl-c\":held", "modifier:ctrl", "modifier:alt", "modifier:shift", "key:\"Enter\":held", "key:\"Home\":held", keyBarItemId(combination),
    ]);
  });

  it("sends every second-row and arrow-pad key", () => {
    for (const key of [...KEY_BAR_SECOND_ROW, ...KEY_BAR_ARROW_PAD]) expect(keyBarInputSequence(key, false)).not.toBeNull();
  });
});
