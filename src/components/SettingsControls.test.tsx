import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { escapeFor, movesFocus, placeSentence, sentenceRoom, SettingsBare, SettingsRow, Stepper, Toggle, typedStep } from "./SettingsControls.tsx";

/** A key on the size field, as React hands it over: `composing` while an IME still holds the draft. */
const key = (name: string, composing: boolean) => ({
  key: name,
  nativeEvent: { isComposing: composing, keyCode: composing ? 229 : name === "Enter" ? 13 : 27 },
  stopPropagation() {},
});

describe("the typed font size (G-179)", () => {
  let renderer: ReactTestRenderer | undefined;
  afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; });

  const mount = () => {
    const changes: number[] = [];
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    act(() => {
      renderer = create(createElement(Stepper, { label: "Terminal font size", value: 14, text: "14px", min: 10, max: 22, decreaseLabel: "Smaller", increaseLabel: "Larger", unit: "px", range: "Enter 10–22px", onChange: (value: number) => changes.push(value) }));
    });
    const field = () => renderer!.root.findByType("input");
    const button = (name: string) => renderer!.root.findByProps({ "aria-label": name });
    const range = () => renderer!.root.findByProps({ id: field().props["aria-describedby"] });
    return { changes, field, button, range };
  };

  it("keeps a valid size typed when the field goes without a blur, and nothing after Escape", () => {
    const { changes, field } = mount();
    act(() => field().props.onChange({ target: { value: "16" } }));
    // Settings closed by a swipe or the system Back: no blur comes
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(changes).toEqual([16]);

    const again = mount();
    act(() => again.field().props.onChange({ target: { value: "18" } }));
    act(() => again.field().props.onKeyDown(key("Escape", false)));
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(again.changes).toEqual([]);
  });

  it("steps from the size still in the field, not the saved one", () => {
    const { changes, field, button } = mount();
    act(() => field().props.onChange({ target: { value: "16" } }));
    act(() => button("Larger").props.onClick());
    expect(changes).toEqual([17]);
    // the draft is resolved: a later blur does not put 16 back
    act(() => field().props.onBlur());
    expect(changes).toEqual([17]);
  });

  it("names the range, and shows it under the field after a refused size until the next edit", () => {
    const { field, range } = mount();
    expect(range().props.children).toBe("Enter 10–22px");
    expect(range().props.className).toBe("visually-hidden");
    act(() => field().props.onChange({ target: { value: "30" } }));
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(range().props.className).toBe("settings-stepper-range");
    expect(field().props["aria-invalid"]).toBe(true);
    act(() => field().props.onChange({ target: { value: "1" } }));
    expect(range().props.className).toBe("visually-hidden");
  });

  it("leaves Enter and Escape to an IME while it composes, then commits the finished number", () => {
    const { changes, field } = mount();
    act(() => field().props.onChange({ target: { value: "16" } }));
    // the IME's own Enter confirms its text: the draft is not committed yet
    act(() => field().props.onKeyDown(key("Enter", true)));
    expect(changes).toEqual([]);
    expect(field().props.value).toBe("16");
    // nor does its Escape throw the draft away
    act(() => field().props.onKeyDown(key("Escape", true)));
    expect(field().props.value).toBe("16");
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(changes).toEqual([16]);
  });

  it("reads a pasted number whole and refuses one out of range", () => {
    const { changes, field } = mount();
    act(() => field().props.onChange({ target: { value: "200" } }));
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(changes).toEqual([]);
    expect(field().props.value).toBe("14");
  });

  it("takes the full-width digits an IME types as the number, and shows it in plain digits once committed", () => {
    const { changes, field, range } = mount();
    act(() => field().props.onChange({ target: { value: "１６" } }));
    // the text is the IME's until the commit: it is not rewritten under the composition
    expect(field().props.value).toBe("１６");
    expect(field().props["aria-invalid"]).toBeUndefined();
    act(() => field().props.onKeyDown(key("Enter", false)));
    expect(changes).toEqual([16]);
    expect(range().props.className).toBe("visually-hidden");
    expect(field().props.value).toBe("14");
    // the -/+ buttons step from a full-width size still in the field
    act(() => field().props.onChange({ target: { value: "１８" } }));
    act(() => renderer!.root.findByProps({ "aria-label": "Larger" }).props.onClick());
    expect(changes).toEqual([16, 19]);
  });
});

describe("typedStep", () => {
  it("reads full-width digits as their plain ones, alone or mixed", () => {
    expect(typedStep("１６", 10, 22)).toBe(16);
    expect(typedStep("1６", 10, 22)).toBe(16);
    expect(typedStep(" ２２ ", 10, 22)).toBe(22);
  });

  it("still refuses a full-width number out of range, and anything that is not a whole number", () => {
    expect(typedStep("２３", 10, 22)).toBeNull();
    expect(typedStep("９", 10, 22)).toBeNull();
    expect(typedStep("２００", 10, 22)).toBeNull();
    expect(typedStep("１６．５", 10, 22)).toBeNull();
    expect(typedStep("16.5", 10, 22)).toBeNull();
    expect(typedStep("１６px", 10, 22)).toBeNull();
    expect(typedStep("١٦", 10, 22)).toBeNull();
    expect(typedStep("", 10, 22)).toBeNull();
  });
});

describe("where a row's sentence goes (#3275)", () => {
  const row = { left: 100, top: 300, right: 600, bottom: 358 };
  const name = { left: 140, top: 319, right: 260, bottom: 339 };
  const size = { width: 300, height: 50 };
  const screen = { width: 1280, height: 800 };

  it("above the row on the name's left edge, ending over the row's own control", () => {
    // the control beside the name starts higher (312) than the name does: the sentence ends above it
    expect(placeSentence(row, name, 312, 346, size, screen)).toEqual({ left: 140, top: 258, side: "above" });
  });

  it("under the row only where the screen ends above it", () => {
    const first = { left: 100, top: 20, right: 600, bottom: 78 };
    expect(placeSentence(first, { left: 140, top: 39, right: 260, bottom: 59 }, 32, 66, size, screen)).toEqual({ left: 140, top: 70, side: "below" });
  });

  it("inside the row's card, and never past the screen's edge", () => {
    expect(placeSentence(row, { left: 520, top: 319, right: 590, bottom: 339 }, 312, 346, size, screen).left).toBe(300);
    const phone = { left: 0, top: 300, right: 390, bottom: 358 };
    expect(placeSentence(phone, { left: 40, top: 319, right: 120, bottom: 339 }, 312, 346, { width: 380, height: 50 }, { width: 390, height: 844 }).left).toBe(8);
  });

  it("as wide as the room beside another row's control it would lie on, or its own width where that room is too small", () => {
    const lies = { left: 140, top: 258, right: 440, bottom: 308 };
    expect(sentenceRoom(lies, [])).toBeNull();
    expect(sentenceRoom(lies, [{ left: 400, top: 250, right: 600, bottom: 284 }])).toBe(252);
    // a control it does not reach
    expect(sentenceRoom(lies, [{ left: 400, top: 100, right: 600, bottom: 134 }])).toBeNull();
    // 152px beside the control: narrower than a sentence is worth, so it keeps its width
    expect(sentenceRoom(lies, [{ left: 300, top: 250, right: 600, bottom: 284 }])).toBeNull();
  });
});

describe("when a row's sentence shows and whose Escape it is (#3275)", () => {
  it("does not take for the keyboard's a focus that follows Escape, Enter or Space: the app gives the focus back after those", () => {
    // closing an editor (Escape) and answering a confirmation (Enter, Space) return the focus to a setting: a
    // sentence there would take the next Escape from Settings. Tab is what moves the reader's own focus
    expect({ Escape: movesFocus("Escape"), Enter: movesFocus("Enter"), Space: movesFocus(" "), Tab: movesFocus("Tab") }).toEqual({ Escape: false, Enter: false, Space: false, Tab: true });
  });

  it("gives Escape to the sentence alone, shares it with a text field, and leaves it to an IME, to a row out of view and to another dialog", () => {
    const showing = { composing: false, drawn: true, textField: false, otherModal: false };
    expect(escapeFor(showing)).toBe("sentence");
    expect(escapeFor({ ...showing, textField: true })).toBe("both");
    expect(escapeFor({ ...showing, textField: true, composing: true })).toBe("other");
    expect(escapeFor({ ...showing, drawn: false })).toBe("other");
    expect(escapeFor({ ...showing, otherModal: true })).toBe("other");
  });

  it("starts a sentence taller than the screen at the screen's top", () => {
    const row = { left: 100, top: 20, right: 600, bottom: 80 };
    const placed = placeSentence(row, { left: 120, top: 40, right: 200, bottom: 60 }, 40, 80, { width: 300, height: 250 }, { width: 800, height: 200 });
    expect(placed.side).toBe("below");
    expect(placed.top).toBe(8);
  });
});

describe("a row's sentence describes its control (#3275)", () => {
  const render = (bare: boolean, control: ReactNode = createElement(Toggle, { label: "Collapse work", checked: false, onChange: () => {} })): string => {
    const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(SettingsBare.Provider, { value: bare },
        createElement(SettingsRow, { label: "Collapse work", description: "Starts folded.", children: control }))));
    } finally {
      if (saved) Object.defineProperty(navigator, "languages", saved);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };

  it.each([["a page without sentences", true, "visually-hidden"], ["a page with sentences", false, "settings-description"]] as const)("on %s", (_page, bare, shownAs) => {
    const html = render(bare);
    const id = new RegExp(`<span id="([^"]+)" class="${shownAs}">Starts folded\\.</span>`).exec(html)?.[1];
    expect(id).toBeString();
    expect(html).toContain(`role="switch" aria-checked="false" aria-label="Collapse work" aria-describedby="${id}"`);
  });

  it("describes a button and a field the page draws in the row, and leaves one that brings its own description", () => {
    const html = render(true, createElement(Fragment, null,
      createElement("span", { className: "settings-chips" }, createElement("button", { type: "button" }, "Edit key bar")),
      createElement("input", { "aria-label": "Key" }),
      createElement("button", { type: "button", "aria-describedby": "own-note" }, "Move everything")));
    const id = /<span id="([^"]+)" class="visually-hidden">Starts folded\.<\/span>/.exec(html)?.[1];
    expect(id).toBeString();
    expect(html).toContain(`<button type="button" aria-describedby="${id}">Edit key bar</button>`);
    expect(html).toContain(`<input aria-label="Key" aria-describedby="${id}"/>`);
    expect(html).toContain(`<button type="button" aria-describedby="own-note">Move everything</button>`);
  });
});
