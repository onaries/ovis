import { describe, expect, it } from "bun:test";
import { typeAheadKey } from "./typeAhead.ts";

const key = (name: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  typeAheadKey({ key: name, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

describe("typeAheadKey", () => {
  it("sends the keys a shell line needs as the terminal does", () => {
    expect(key("Enter")).toEqual({ input: "\r" });
    expect(key("Enter", { shiftKey: true })).toEqual({ input: "\x1b\r" });
    expect(key("Tab")).toEqual({ input: "\t" });
    expect(key("Tab", { shiftKey: true })).toEqual({ input: "\x1b[Z" });
    expect(key("Escape")).toEqual({ input: "\x1b" });
    expect(key("ArrowLeft")).toEqual({ input: "\x1b[D", arrow: "ArrowLeft" });
    expect(key("c", { ctrlKey: true })).toEqual({ input: "\x03" });
    expect(key("U", { ctrlKey: true })).toEqual({ input: "\x15" });
  });

  it("erases and moves as the terminal does", () => {
    expect(key("Backspace")).toEqual({ input: "\x7f" });
    expect(key("Backspace", { altKey: true })).toEqual({ input: "\x1b\x7f" });
    expect(key("Backspace", { ctrlKey: true })).toEqual({ input: "\b" });
    expect(key("Backspace", { metaKey: true })).toEqual({ input: "\x15" });
    expect(key("Delete")).toEqual({ input: "\x1b[3~" });
    expect(key("Home")).toEqual({ input: "\x1b[H" });
    expect(key("End")).toEqual({ input: "\x1b[F" });
    expect(key("ArrowLeft", { metaKey: true })).toEqual({ input: "\x01" });
    expect(key("ArrowRight", { metaKey: true })).toEqual({ input: "\x05" });
  });

  it("holds the catch for an editing key it cannot be sure of", () => {
    expect(key("ArrowLeft", { altKey: true })).toBe("hold");
    expect(key("ArrowRight", { ctrlKey: true })).toBe("hold");
    expect(key("Delete", { ctrlKey: true })).toBe("hold");
    expect(key("Enter", { ctrlKey: true })).toBe("hold");
    expect(key("b", { altKey: true })).toBe("hold");
  });

  it("leaves text, the browser's paste and its shortcuts to the browser", () => {
    expect(key("a")).toBeNull();
    expect(key("v", { ctrlKey: true })).toBeNull();
    expect(key("t", { metaKey: true })).toBeNull();
    expect(key("K", { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key("F5")).toBeNull();
  });
});
