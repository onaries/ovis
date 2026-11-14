import { Children, cloneElement, createContext, Fragment, isValidElement, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, Minus, Plus, RotateCcw, type LucideIcon } from "lucide-react";

import { DEFAULT_SETTINGS, useSettings, type Settings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { focusInOtherModal } from "../lib/useFocusTrap.ts";

import "./SettingsControls.css";

/**
 * The parts every Settings page is built from: a group is a caption over one card, a card holds
 * rows parted by hairlines, and a row is a label with its one control at the end of the line.
 */
/**
 * The words typed in Settings' search (SettingsDialog.tsx): while it holds any, a row draws only
 * when its label and description hold every one of them, and a group whose title holds them all
 * shows each of its rows. Outside a search it is empty and nothing is filtered.
 */
export const SettingsQuery = createContext<readonly string[]>([]);

/**
 * A page drawn as herdr-app draws its settings: rows are a label and a control, with no sentences and no group captions.
 * `"rows"`: the rows go without sentences, but each group keeps its short heading. A row's sentence still counts for search.
 */
export const SettingsBare = createContext<boolean | "rows">(false);

/** What a search matches by: case and full-width forms folded, so "Font" finds "font". */
const folded = (text: string): string => text.normalize("NFKC").toLocaleLowerCase();

export function settingsQueryWords(query: string): string[] {
  return folded(query).split(/\s+/).filter((word) => word !== "");
}

/**
 * The words a label or description shows, a description built of elements (a sentence and a warning)
 * included, and the names a row's own controls carry (an input's aria-label, placeholder or title), so a
 * search finds a row by the field inside it (G-109).
 */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement<{ children?: ReactNode; "aria-label"?: unknown; placeholder?: unknown; title?: unknown }>(node)) {
    const { children, "aria-label": ariaLabel, placeholder, title } = node.props;
    return [textOf(children), ariaLabel, placeholder, title].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
  }
  return "";
}

export function matchesSettingsQuery(words: readonly string[], ...texts: ReactNode[]): boolean {
  const shown = folded(texts.map(textOf).join(" "));
  return words.every((word) => shown.includes(word));
}

/**
 * The groups a page keeps out of its first view, folded under one line at its end: **More settings**
 * for what few people change, **Experimental** for what is still being shaped. The line counts the
 * `keys` this device has moved off their defaults, and `elsewhere` more choices kept outside the
 * settings record (Alerts' filters), so a choice is never hidden without a trace. A
 * search shows what it finds inside as if unfolded; a link to a group inside opens it
 * (SettingsDialog.tsx). Native details, so the browser's find-in-page opens it too.
 */
export function SettingsFold({ kind, keys, elsewhere = 0, children }: { kind: "more" | "experimental"; keys: readonly (keyof Settings)[]; elsewhere?: number; children: ReactNode }) {
  const t = useT();
  const words = useContext(SettingsQuery);
  const { settings } = useSettings();
  if (words.length > 0) return <>{children}</>;
  const changed = keys.filter((key) => JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key])).length + elsewhere;
  return (
    <details className="settings-fold" data-fold={kind}>
      <summary>
        <ChevronRight className="settings-fold-chevron" aria-hidden="true" />
        <span className="settings-fold-title">{kind === "more" ? t("More settings") : t("Experimental")}</span>
        {changed > 0 && <span className="settings-fold-changed">{t("{count} changed", { count: changed })}</span>}
      </summary>
      <div className="settings-fold-body">{children}</div>
    </details>
  );
}

/** `section`: the group's name in a link to it (`?settings=<page>&section=<name>`, lib/deepLink.ts) */
/**
 * `heading`: the title stays on a bare page too, as the one sub-heading a page like Experimental keeps.
 * `keepNote`: the note stays on a bare page too, for a sentence the reader must see (what leaves this PC).
 */
export function SettingsGroup({ title, note, className, section, heading = false, keepNote = false, children }: { title?: string; note?: ReactNode; className?: string; section?: string; heading?: boolean; keepNote?: boolean; children: ReactNode }) {
  const words = useContext(SettingsQuery);
  const bare = useContext(SettingsBare);
  const titled = words.length > 0 && title !== undefined && matchesSettingsQuery(words, title);
  return (
    <section className={className ? `settings-section ${className}` : "settings-section"} data-section={section} data-found={titled ? "" : undefined} tabIndex={section ? -1 : undefined}>
      {(bare !== true || heading) && title !== undefined && <h3>{title}</h3>}
      {(!bare || keepNote) && note !== undefined && <p className="settings-description settings-note">{note}</p>}
      <div className="settings-card">{titled ? <SettingsQuery.Provider value={[]}>{children}</SettingsQuery.Provider> : children}</div>
    </section>
  );
}

/**
 * The id of the sentence of the row a control sits in (SettingsRow): its switch, select or group of choices
 * is described by it, in sight or not. Zed's settings do the same (crates/settings_ui: each control names and
 * describes itself by its row's title and description) rather than make the row a group that reads its name twice.
 */
const SettingsRowSentence = createContext<string | undefined>(undefined);

/** For a control a page draws itself (a font field, a button): `aria-describedby={useSettingsRowSentence()}`. */
export function useSettingsRowSentence(): string | undefined {
  return useContext(SettingsRowSentence);
}

const describedByAll = (...ids: (string | undefined)[]): string | undefined => ids.filter((id) => id !== undefined && id !== "").join(" ") || undefined;

/** A box on the screen, as getBoundingClientRect gives it. */
export interface ScreenBox { left: number; top: number; right: number; bottom: number }

/** How far a row's sentence stays from the screen's edge, and from what it must not cover; the narrowest it gets to stay off another row's control. */
const SENTENCE_EDGE = 8;
const SENTENCE_GAP = 4;
const SENTENCE_MIN_WIDTH = 224;

/**
 * How wide a sentence whose box is `tip` may be so it lies on none of `controls` (the controls of the rows it is
 * over): up to the nearest one's left edge. Null where no control is in its way, and where the room beside it
 * is under SENTENCE_MIN_WIDTH: a sentence that narrow grows tall and covers more than it clears, so it keeps its width.
 */
export function sentenceRoom(tip: ScreenBox, controls: readonly ScreenBox[]): number | null {
  const over = controls.filter((control) => control.left < tip.right && control.right > tip.left && control.top < tip.bottom && control.bottom > tip.top);
  if (over.length === 0) return null;
  const room = Math.min(...over.map((control) => control.left)) - SENTENCE_GAP * 2 - tip.left;
  return room >= SENTENCE_MIN_WIDTH ? room : null;
}

/**
 * The parts of a sentence's box that lie on `controls` (the controls of the rows it is over, where it found no room
 * beside them), in the sentence's own coordinates. There the pointer is the control's: RowSentence cuts the sentence
 * out for the pointer in exactly those parts.
 */
export function sentenceHoles(tip: ScreenBox, controls: readonly ScreenBox[]): ScreenBox[] {
  return controls.filter((control) => control.left < tip.right && control.right > tip.left && control.top < tip.bottom && control.bottom > tip.top)
    .map((control) => ({ left: Math.max(control.left, tip.left) - tip.left, top: Math.max(control.top, tip.top) - tip.top, right: Math.min(control.right, tip.right) - tip.left, bottom: Math.min(control.bottom, tip.bottom) - tip.top }));
}

/**
 * Where a row's sentence goes when it shows over the page (#3275): above the row, its left edge on the name's,
 * so it covers neither the row's own control nor the row below, which the pointer goes to next. `clear` is the
 * top of the highest thing in the row it must stay above (the name, or a taller control beside it) and `under`
 * the bottom of the lowest. It goes under the row only where the screen ends above it.
 */
export function placeSentence(row: ScreenBox, name: ScreenBox, clear: number, under: number, size: { width: number; height: number }, screen: { width: number; height: number }): { left: number; top: number; side: "above" | "below" } {
  // inside the row's card where it fits, and always inside the screen
  const left = Math.max(SENTENCE_EDGE, Math.min(name.left, row.right - size.width, screen.width - size.width - SENTENCE_EDGE));
  const above = clear - SENTENCE_GAP - size.height;
  if (above >= SENTENCE_EDGE) return { left, top: above, side: "above" };
  // a sentence taller than the screen (a short window, a high zoom) starts at the screen's top, so its first lines are read
  return { left, top: Math.max(SENTENCE_EDGE, Math.min(under + SENTENCE_GAP, screen.height - size.height - SENTENCE_EDGE)), side: "below" };
}

/** A mouse rests this long on a row before its sentence shows; a row entered this soon after another's closed shows its own at once. */
const SENTENCE_REST_MS = 450;
const SENTENCE_FOLLOW_MS = 400;
/** one sentence over the page at a time: how to close the one showing, and when the last one closed */
let closeSentence: (() => void) | null = null;
let sentenceClosedAt = Number.NEGATIVE_INFINITY;
/** how many sentences have opened over the page: a mouse's rest that began before the last one opened is out of date */
let sentencesOpened = 0;

const FOCUS_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/** Whether a key moves the focus. Escape, Enter and Space do not: they close, confirm and press. */
function movesFocus(key: string): boolean {
  return FOCUS_KEYS.has(key);
}

/**
 * Whether the reader's last input was a key that moves the focus: only then is a focus the keyboard's, and its row's
 * sentence shown. A click or a tap that puts the focus in a field is a pointer's (though `:focus-visible` matches
 * there), and the focus the app gives back after Escape or Enter (a closed editor, a confirmed dialog) is the app's:
 * a sentence there would take the next Escape from Settings.
 */
let keyboardMovedFocus = false;

/** What the reader did last: a key, or a press of the pointer. The window's own listeners call it. */
export function inputWas(input: { key: string } | "pointer"): void {
  keyboardMovedFocus = input !== "pointer" && movesFocus(input.key);
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("keydown", (event) => inputWas({ key: event.key }), true);
  window.addEventListener("pointerdown", () => inputWas("pointer"), true);
}

/**
 * Whose Escape it is while a row's sentence is shown: the sentence's alone; the sentence's and the text field's it is
 * typed in; or not the sentence's at all, when an IME takes it to drop its composition, when nothing is drawn (its row
 * is outside the page's view), or when a dialog opened over Settings (Files, the palette) has the keyboard.
 */
function escapeFor(state: { composing: boolean; drawn: boolean; textField: boolean; otherModal: boolean }): "sentence" | "both" | "other" {
  if (state.composing || !state.drawn || state.otherModal) return "other";
  return state.textField ? "both" : "sentence";
}

/** Whether any of the row is in its page's scrolling view: a row outside it has nothing on the screen to show or to close. */
function inPageView(row: Element | null): boolean {
  if (row === null) return false;
  const box = row.getBoundingClientRect();
  const page = row.closest(".modal-body")?.getBoundingClientRect();
  return page === undefined || (box.bottom > page.top && box.top < page.bottom);
}

/** Whether the focus is where text is typed: such a field keeps Escape for its own draft, and for the dialog behind it. */
function inTextField(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement) return true;
  if (active instanceof HTMLInputElement) return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(active.type);
  return active instanceof HTMLElement && active.isContentEditable;
}

/**
 * A bare row's sentence on demand (#3275). A mouse resting on the row and the keyboard's focus on its control show it
 * over the page (RowSentence); Escape closes it alone, as it closes one a tap opened in the row, and it then stays
 * closed until the pointer or the focus leaves the row. A press on the row's control is a choice, not a question: it
 * closes the sentence too, the keyboard's press as a pointer's, so Escape after a choice is Settings' again. In a
 * text field the Escape is the field's too (a typed size goes back, as before), and the first text typed there closes
 * the sentence, so it is never in the way of what is being written. A finger has no hover: a tap on the row, anywhere
 * but on its control, opens the sentence in the row, under its name and control and as wide as the row, and a second
 * tap closes it.
 * `on`: the row has a sentence and its page does not show it.
 */
export function useRowSentence(on: boolean): {
  row: RefObject<HTMLDivElement | null>;
  /** over the page now, and why */
  shown: "hover" | "focus" | null;
  /** whether it is on the screen: while its row is outside the page's view it is shown and drawn nowhere */
  drawn: RefObject<boolean>;
  /** in the row now, opened by a tap */
  opened: boolean;
  /** the row is gone from the page (a search hides it): its sentence goes with it, however it was shown, and its rest timer */
  forget: () => void;
  rowEvents: { onPointerEnter?: (event: ReactPointerEvent) => void; onPointerLeave?: () => void; onPointerDown?: (event: ReactPointerEvent) => void; onFocus?: (event: ReactFocusEvent) => void; onBlur?: (event: ReactFocusEvent) => void; onInput?: () => void; onClick?: (event: ReactMouseEvent) => void };
} {
  const row = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<"hover" | "focus" | null>(null);
  const [opened, setOpened] = useState(false);
  const rest = useRef<number | undefined>(undefined);
  // Escape closed it: not again while the pointer rests there or the focus stays
  const dismissed = useRef(false);
  // the last press on the row came from a finger
  const finger = useRef(false);
  const drawn = useRef(false);
  // only a row that set its timer has one to clear: a test's stand-in window has no timers
  useEffect(() => () => { if (rest.current !== undefined) window.clearTimeout(rest.current); }, []);
  useEffect(() => {
    if (shown === null) return;
    sentencesOpened += 1;
    closeSentence?.();
    const close = (): void => setShown(null);
    closeSentence = close;
    return () => {
      if (closeSentence === close) closeSentence = null;
      sentenceClosedAt = performance.now();
    };
  }, [shown]);
  // Escape closes a sentence however it came: the one over the page, and the one a tap opened in the row (a
  // touch screen with a keyboard). Every sentence opened in a row in sight closes on the one press
  const closable = shown !== null || opened;
  useEffect(() => {
    if (!closable) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const otherModal = focusInOtherModal(row.current?.closest<HTMLElement>("[aria-modal='true']") ?? null);
      // key code 229: the Escape WebKit can still send for a composition after compositionend
      const whose = escapeFor({ composing: event.isComposing || event.keyCode === 229, drawn: opened ? inPageView(row.current) : drawn.current, textField: inTextField(), otherModal });
      if (whose === "other") {
        // the dialog in front takes its Escape, and a sentence left showing under it goes; one waiting for its row stays
        if (otherModal) setShown(null);
        return;
      }
      // the sentence alone: Settings stays open, and the pointer and the focus stay where they are (WCAG 1.4.13)
      if (whose === "sentence") {
        event.preventDefault();
        event.stopPropagation();
      }
      dismissed.current = true;
      setShown(null);
      setOpened(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [closable, opened]);
  const forget = (): void => {
    if (rest.current !== undefined) window.clearTimeout(rest.current);
    dismissed.current = false;
    setShown(null);
    setOpened(false);
  };
  // a row whose sentence goes away (a description that comes and goes) keeps none marked as showing or opened:
  // an Escape taken for a sentence nobody sees would be lost
  const forgetRef = useRef(forget);
  forgetRef.current = forget;
  useEffect(() => { if (!on) forgetRef.current(); }, [on]);
  if (!on) return { row, shown: null, drawn, opened: false, forget, rowEvents: {} };
  return {
    row, shown: opened ? null : shown, drawn, opened, forget,
    rowEvents: {
      onPointerEnter: (event) => {
        if (event.pointerType === "touch" || opened) return;
        window.clearTimeout(rest.current);
        // entering means the pointer had left, also where no leave came: Escape with the pointer on the sentence
        // removes it under the pointer, and a row hovered again is asked again
        dismissed.current = false;
        if (shown !== null) return;
        // the last thing asked stays: when the keyboard asks for another row's sentence during the rest, the mouse that
        // has not moved since does not replace it; a mouse that comes to rest after that sentence opened does
        const asked = sentencesOpened;
        rest.current = window.setTimeout(() => { if (sentencesOpened === asked) setShown("hover"); }, performance.now() - sentenceClosedAt < SENTENCE_FOLLOW_MS ? 0 : SENTENCE_REST_MS);
      },
      // the sentence is drawn elsewhere but is this row's child: the pointer on it has not left the row, so it stays to be read
      onPointerLeave: () => {
        window.clearTimeout(rest.current);
        dismissed.current = false;
        if (shown === "hover") setShown(null);
      },
      onPointerDown: (event) => {
        // a pen taps as a finger does: one that cannot hover has no other way to the sentence
        finger.current = event.pointerType !== "mouse";
        // a press on the row's control is a choice, not a question; a press on the sentence keeps it, to select its words
        if ((event.target as Element).closest(".settings-help")) return;
        window.clearTimeout(rest.current);
        if (shown === "hover") setShown(null);
      },
      onFocus: () => {
        if (opened || dismissed.current || !keyboardMovedFocus) return;
        window.clearTimeout(rest.current);
        setShown("focus");
      },
      onBlur: (event) => {
        if (row.current?.contains(event.relatedTarget)) return;
        dismissed.current = false;
        if (shown === "focus") setShown(null);
      },
      onInput: () => {
        if (shown === null) return;
        dismissed.current = true;
        setShown(null);
      },
      onClick: (event) => {
        const target = event.target as Element;
        // the sentence the keyboard's focus showed: a press on the row's control closes it, as a pointer's press does a hover's
        if (shown === "focus" && target.closest("button, a, input, select, textarea") !== null && target.closest(".settings-help") === null) {
          dismissed.current = true;
          setShown(null);
        }
        if (!finger.current) return;
        // the row's name and the room around it, never its control; the ↺ and a link in a condition keep their own tap
        if (target !== event.currentTarget && target.closest(".settings-row-text") === null) return;
        if (target.closest("button, a, input, select, textarea")) return;
        // a tap on a field's name opens its sentence, not the field
        if (target.closest("label")) event.preventDefault();
        setOpened((was) => !was);
      },
    },
  };
}

/**
 * A row's sentence over the page: drawn in the dialog's own layer, over the dialog and not cut by its scrolling
 * page (in the document where the row is in no dialog), and placed by placeSentence. Over a row whose control
 * would be under it, it narrows to the room beside that control (sentenceRoom). Where that room is too little it
 * keeps its width and lies on the control's near end: there the pointer is the control's, not the sentence's. The
 * sentence is cut out in exactly those parts (sentenceHoles, a clip-path, which cuts the pointer's reach with what
 * is drawn), so a press there reaches the control itself, and a copy under it, which takes no pointer, draws what
 * was cut. Everywhere else the sentence keeps the pointer, its words can be selected and it scrolls.
 * It follows its row while the page scrolls and is drawn only while the row is in the page's view: a dialog moves
 * the keyboard's focus without scrolling (lib/useFocusTrap.ts), so the focus can be on a setting the page is not
 * scrolled to, and its sentence then waits for the row (`drawn` says which). Not read out: the row's own copy
 * describes the control.
 */
function RowSentence({ row, drawn, children }: { row: HTMLElement; drawn: RefObject<boolean>; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  // `holes`: where it lies on another row's control, in its own coordinates; `width` and `height`: its size as placed
  const [at, setAt] = useState<{ left: number; top: number; maxWidth: string; width: number; height: number; holes: readonly ScreenBox[] } | null>(null);
  useLayoutEffect(() => {
    const place = (): void => {
      const tip = box.current;
      if (!tip) return;
      const rowBox = row.getBoundingClientRect();
      const pageEl = row.closest(".modal-body");
      if (!inPageView(row)) {
        drawn.current = false;
        setAt(null);
        return;
      }
      drawn.current = true;
      const text = row.querySelector(":scope > .settings-row-text");
      const name = (row.querySelector(".settings-label") ?? row).getBoundingClientRect();
      // the ↺ beside the name stands taller than the name: the sentence clears it and its focus ring too
      const line = row.querySelector(":scope > .settings-row-text > .settings-label-line")?.getBoundingClientRect();
      const beside = [...row.children].filter((child) => child !== text).map((child) => child.getBoundingClientRect()).filter((side) => side.height > 0);
      const clear = Math.min(name.top, line?.top ?? name.top, ...beside.map((side) => side.top));
      const under = Math.max(text?.getBoundingClientRect().bottom ?? rowBox.bottom, ...beside.map((side) => side.bottom));
      const screen = { width: window.innerWidth, height: window.innerHeight };
      // the other rows' controls: what a sentence over those rows must not lie on
      const controls = [...(pageEl ?? document).querySelectorAll<HTMLElement>(".settings-row")].filter((other) => other !== row)
        .flatMap((other) => [...other.children].filter((child) => !child.classList.contains("settings-row-text"))).map((child) => child.getBoundingClientRect()).filter((side) => side.height > 0);
      const measure = () => placeSentence(rowBox, name, clear, under, { width: tip.offsetWidth, height: tip.offsetHeight }, screen);
      // at its own width first, then as narrow as the controls under it ask; a narrower sentence is taller and may
      // reach another row's control, so once more; where that leaves no room, back to its own width
      let maxWidth = "";
      tip.style.maxWidth = maxWidth;
      let next = measure();
      for (let pass = 0; pass < 2; pass++) {
        const lies = { left: next.left, top: next.top, right: next.left + tip.offsetWidth, bottom: next.top + tip.offsetHeight };
        const room = sentenceRoom(lies, controls);
        if (room !== null && room < tip.offsetWidth) maxWidth = `${room}px`;
        else if (room === null && pass > 0 && controls.some((control) => control.left < lies.right && control.right > lies.left && control.top < lies.bottom && control.bottom > lies.top)) maxWidth = "";
        else break;
        tip.style.maxWidth = maxWidth;
        next = measure();
      }
      const lies = { left: next.left, top: next.top, right: next.left + tip.offsetWidth, bottom: next.top + tip.offsetHeight };
      const placed = { left: next.left, top: next.top, maxWidth, width: tip.offsetWidth, height: tip.offsetHeight, holes: sentenceHoles(lies, controls) };
      setAt((was) => was !== null && JSON.stringify(was) === JSON.stringify(placed) ? was : placed);
    };
    place();
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      drawn.current = false;
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [row, drawn]);
  // the whole box, less each hole: what the sentence keeps of itself, for the eye and for the pointer
  const cut = at === null || at.holes.length === 0 ? undefined
    : `path(evenodd, "M0 0H${at.width}V${at.height}H0Z${at.holes.map((hole) => ` M${hole.left} ${hole.top}H${hole.right}V${hole.bottom}H${hole.left}Z`).join("")}")`;
  return createPortal(
    <>
      {at !== null && cut !== undefined && <div ref={copy} className="settings-help-copy" aria-hidden="true" style={{ left: at.left, top: at.top, width: at.width, height: at.height }}>{children}</div>}
      <div ref={box} className="settings-help" aria-hidden="true" onScroll={(event) => { if (copy.current) copy.current.scrollTop = event.currentTarget.scrollTop; }}
        style={at === null ? { visibility: "hidden" } : { left: at.left, top: at.top, maxWidth: at.maxWidth === "" ? undefined : at.maxWidth, clipPath: cut }}>{children}</div>
    </>,
    row.closest<HTMLElement>(".modal-scrim") ?? document.body,
  );
}

const DESCRIBED_ELEMENTS = new Set(["button", "input", "select", "textarea"]);

/**
 * The buttons and fields a page draws in its row as plain elements (Edit key bar, Import, a key's field): each is
 * described by the row's sentence, as the row's own controls are, unless it brings a description of its own. What a
 * component draws inside the row is that component's to describe (useSettingsRowSentence). A row without a sentence
 * goes through it too, unchanged: a row whose sentence comes and goes (a shortcut being recorded) keeps one shape,
 * so its controls are never drawn anew and keep the focus.
 */
function describedByRow(children: ReactNode, sentence: string | undefined): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; "aria-describedby"?: string }>(child)) return child;
    if (typeof child.type === "string" && DESCRIBED_ELEMENTS.has(child.type)) return sentence !== undefined && child.props["aria-describedby"] === undefined ? cloneElement(child, { "aria-describedby": sentence }) : child;
    if ((typeof child.type !== "string" && child.type !== Fragment) || child.props.children === undefined) return child;
    return cloneElement(child, undefined, describedByRow(child.props.children, sentence));
  });
}

/**
 * One setting. `wide` marks a control that needs the whole line on a phone (three or more
 * segments, a text field): the row stacks there, and stays one line everywhere else. `keywords`:
 * more words a search finds it by, for a row opened by another. `held`: a row in the middle of a
 * step (a recording, a confirmation) stays in a search whatever its words have become.
 * `description`: what the setting does, in a sentence or two. A page that shows sentences draws it under
 * the name; a bare page shows it on demand (useRowSentence), and either way it describes the row's control.
 */
export function SettingsRow({ label, description, keywords, held = false, htmlFor, wide = false, reset, onReset, resetAlso, icon: Icon, preview, condition, children }: { label: string; description?: ReactNode; keywords?: string; held?: boolean; htmlFor?: string; wide?: boolean; reset?: readonly (keyof Settings)[];
  /** a row whose value lives inside a setting (one shortcut of shortcutOverrides): passed only while it is changed */
  onReset?: () => void;
  /** what the row sets outside Settings (a store of its own): whether it moved off its default, and how ↺ puts it back */
  resetAlso?: { changed: boolean; restore: () => void };
  /** a picture of what the row is about, before its name: shown, not told */
  icon?: LucideIcon;
  /** a tiny drawing of what the choice does, beside the control */
  preview?: ReactNode;
  /** what applies right now (a refusal, a missing key): shown under the name even where sentences are not */
  condition?: ReactNode;
  children: ReactNode }) {
  const words = useContext(SettingsQuery);
  const bare = useContext(SettingsBare);
  const { settings, update } = useSettings();
  const t = useT();
  const sentenceId = useId();
  const sentence = useRowSentence(description !== undefined && bare !== false);
  const filteredOut = !held && words.length > 0 && !matchesSettingsQuery(words, label, description, keywords, condition, children);
  // a row the search hides is removed under a still pointer, which sends no leave: its sentence would come back with it
  const forgetSentence = sentence.forget;
  useEffect(() => { if (filteredOut) forgetSentence(); }, [filteredOut]);
  if (filteredOut) return null;
  // `reset`: the keys this row sets; once any is off its default, a button beside the label puts them back
  const changed = onReset !== undefined || (reset !== undefined && reset.some((key) => JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_SETTINGS[key]))) || resetAlso?.changed === true;
  const restore = () => {
    if (onReset) return onReset();
    if (reset !== undefined) update(Object.fromEntries(reset.map((key) => [key, DEFAULT_SETTINGS[key]])) as Partial<Settings>);
    resetAlso?.restore();
  };
  const label_ = htmlFor !== undefined ? <label className="settings-label" htmlFor={htmlFor}>{label}</label> : <span className="settings-label">{label}</span>;
  return (
    <div ref={sentence.row} className={`settings-row${wide ? " is-wide" : ""}${sentence.opened ? " is-explained" : ""}`} data-setting="" {...sentence.rowEvents}>
      <div className="settings-row-text">
        {changed || Icon !== undefined ? (
          <span className="settings-label-line">
            {Icon !== undefined && <Icon className="settings-row-icon" aria-hidden="true" />}
            {label_}
            {changed && <button type="button" className="settings-reset" title={t("Restore defaults")} aria-label={`${t("Restore defaults")}: ${label}`} onClick={(event) => {
              // the button goes once the values are back: the row's own control takes the focus first
              event.currentTarget.closest(".settings-row")?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), [role='radio'], button:not(.settings-reset):not(:disabled)")?.focus();
              restore();
            }}>
              <RotateCcw aria-hidden="true" />
            </button>}
          </span>
        ) : label_}
        {/* a page without sentences still has them read out, and found by search */}
        {description !== undefined && !sentence.opened && <span id={sentenceId} className={bare === false ? "settings-description" : "visually-hidden"}>{description}</span>}
        {condition}
      </div>
      {preview !== undefined && <span className="settings-row-preview" aria-hidden="true">{preview}</span>}
      <SettingsRowSentence.Provider value={description !== undefined ? sentenceId : undefined}>{describedByRow(children, description !== undefined ? sentenceId : undefined)}</SettingsRowSentence.Provider>
      {/* opened by a tap: under the name and the control, as wide as the row */}
      {sentence.opened && <span id={sentenceId} className="settings-description settings-row-sentence">{description}</span>}
      {sentence.shown !== null && sentence.row.current !== null && <RowSentence row={sentence.row.current} drawn={sentence.drawn}>{description}</RowSentence>}
    </div>
  );
}

/** `id` for a `<label htmlFor>` beside it; `describedBy`: the id of the hint read with it */
export function Toggle({ checked, label, onChange, disabled, id, describedBy }: { checked: boolean; label: string; onChange: (checked: boolean) => void; disabled?: boolean; id?: string; describedBy?: string }) {
  const sentence = useContext(SettingsRowSentence);
  return (
    <button type="button" id={id} className="settings-toggle" role="switch" aria-checked={checked} aria-label={label} aria-describedby={describedByAll(describedBy, sentence)} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="settings-toggle-thumb" />
    </button>
  );
}

export function SettingsSelect({ className, children, ...props }: ComponentProps<"select">) {
  const sentence = useContext(SettingsRowSentence);
  return (
    <span className={className ? `settings-select-wrap ${className}` : "settings-select-wrap"}>
      <select {...props} aria-describedby={describedByAll(props["aria-describedby"], sentence)} className="select settings-select">{children}</select>
      <ChevronDown aria-hidden="true" />
    </span>
  );
}

/** `name`: what a screen reader and a test call the button when its short label is shared with another control nearby */
export interface SegmentedOption<T extends string> { value: T; label: string; name?: string }

/**
 * One of a few short choices, all in sight. Five or more go in a select instead. The track is told how many options it
 * holds and how wide its widest label is drawn (`--segmented-count`, `--segmented-widest`): where the control has its
 * row's whole line (a phone's stacked row, SettingsControls.css) the stylesheet lays the options out from the two, so a
 * label that does not fit its share of the line is never cut or laid over its neighbour. A label names itself in
 * `data-label`: there the stylesheet keeps the room its chosen weight takes, so choosing it changes no width.
 */
export function Segmented<T extends string>({ label, value, options, onChange, disabled }: { label: string; value: T; options: readonly SegmentedOption<T>[]; onChange: (value: T) => void; disabled?: boolean }) {
  const sentence = useContext(SettingsRowSentence);
  const track = useRef<HTMLDivElement>(null);
  const labels = options.map((option) => option.label).join("\n");
  // each label's own box, as the browser lays it out, before the frame that first shows it and again whenever it
  // changes (the language, the text size, the faces arriving, the weight of the chosen one). The labels keep their
  // size whatever the track does with it, so the measuring never feeds itself
  useLayoutEffect(() => {
    const node = track.current;
    if (node === null) return;
    const widths = new Map<Element, number>();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) widths.set(entry.target, entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width);
      node.style.setProperty("--segmented-widest", `${Math.max(0, ...widths.values())}px`);
    });
    for (const face of node.querySelectorAll(":scope > button > span")) observer.observe(face);
    return () => observer.disconnect();
  }, [labels]);
  return (
    <div ref={track} className="segmented settings-segmented" role="group" aria-label={label} aria-describedby={sentence} style={{ "--segmented-count": options.length } as CSSProperties}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={value === option.value} aria-label={option.name} disabled={disabled} onClick={() => onChange(option.value)}><span data-label={option.label}>{option.label}</span></button>
      ))}
    </div>
  );
}

/**
 * Several on/off choices of one decision on one line, each a chip that is pressed while on. `title`: what the
 * chip means in full, shown as its tooltip (the one-minute rule of Long turn finished, G-096).
 */
export function ChipToggles({ label, chips }: { label: string; chips: readonly { label: string; title?: string; icon?: LucideIcon; on: boolean; onChange: (on: boolean) => void }[] }) {
  const sentence = useContext(SettingsRowSentence);
  return (
    <div className="settings-chips" role="group" aria-label={label} aria-describedby={sentence}>
      {chips.map((chip) => (
        <button key={chip.label} type="button" className="settings-chip" aria-pressed={chip.on} title={chip.title} onClick={() => chip.onChange(!chip.on)}>{chip.icon && <chip.icon aria-hidden="true" />}{chip.label}</button>
      ))}
    </div>
  );
}

/**
 * The whole number `draft` holds when it lies within `min`..`max`; null for anything else, which is refused, never clamped (G-179).
 * The full-width digits a Japanese, Korean or Chinese IME types (１６) count as their plain ones. Only here, where the draft is
 * read: the field's own text is left alone while it is edited, so an IME's composition is never rewritten under it.
 */
export function typedStep(draft: string, min: number, max: number): number | null {
  const digits = draft.trim().replace(/[\uFF10-\uFF19]/g, (digit) => String(digit.charCodeAt(0) - 0xff10));
  if (!/^\d+$/.test(digits)) return null;
  const value = Number(digits);
  return value >= min && value <= max ? value : null;
}

/**
 * A number moved one step at a time between its limits, shown as `text`. The glyph buttons carry their names as tooltips too (G-167).
 * `unit`: the number can be typed in its place too, followed by this unit. The whole draft is read (a pasted 200 is not cut to 20);
 * a number out of range is refused and the field goes back, and `range` (the limits in words) shows under it until the next edit;
 * it describes the field all along. A valid number still in the field is kept when the field goes without a blur (a swipe or Back
 * closing Settings), and the -/+ buttons step from it (G-179).
 */
export function Stepper({ label, value, text, min, max, decreaseLabel, increaseLabel, onChange, unit, range }: { label: string; value: number; text: string; min: number; max: number; decreaseLabel: string; increaseLabel: string; onChange: (value: number) => void; unit?: string; range?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const rangeId = useId();
  const sentence = useContext(SettingsRowSentence);
  const shown = draft ?? String(value);
  const typed = draft === null ? null : typedStep(draft, min, max);
  // what the buttons step from: the size in the field when it is one, else the saved one
  const current = typed ?? value;
  const commit = () => {
    if (typed !== null && typed !== value) onChange(typed);
    setRefused(draft !== null && typed === null);
    setDraft(null);
  };
  const step = (by: number) => {
    setDraft(null);
    setRefused(false);
    const next = Math.min(max, Math.max(min, current + by));
    if (next !== value) onChange(next);
  };
  // the field can go without a blur (Settings closed by a swipe or Back): a valid size still in it is kept
  const pending = useRef<() => void>(() => {});
  pending.current = () => { if (typed !== null && typed !== value) onChange(typed); };
  useEffect(() => () => pending.current(), []);
  const stepper = (
    <div className="settings-stepper" role="group" aria-label={label} aria-describedby={sentence}>
      <button type="button" className="icon-button" aria-label={decreaseLabel} title={decreaseLabel} disabled={current <= min} onClick={() => step(-1)}><Minus aria-hidden="true" /></button>
      {unit === undefined ? <output aria-live="polite">{text}</output> : <span className="settings-stepper-field">
        <input className="settings-stepper-value" type="text" inputMode="numeric" aria-label={label} title={range} value={shown}
          aria-describedby={range === undefined ? undefined : rangeId}
          aria-invalid={refused || (draft !== null && typed === null) ? true : undefined} autoComplete="off" spellCheck={false}
          onChange={(event) => { setRefused(false); setDraft(event.target.value); }} onBlur={commit}
          onKeyDown={(event) => {
            // an IME's own Enter and Escape finish or drop its composition, not the draft
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Enter") commit(); else if (event.key === "Escape" && draft !== null) { event.stopPropagation(); setRefused(false); setDraft(null); }
          }} />
        <span aria-hidden="true">{unit}</span>
        {/* the field is not announced as it changes: the size the -/+ buttons or a typed number set is */}
        <output className="visually-hidden" aria-live="polite">{text}</output>
      </span>}
      <button type="button" className="icon-button" aria-label={increaseLabel} title={increaseLabel} disabled={current >= max} onClick={() => step(1)}><Plus aria-hidden="true" /></button>
    </div>
  );
  if (unit === undefined || range === undefined) return stepper;
  // the range is read with the field all along, and seen under it only after a refused size, until the next edit
  return <>{stepper}<span id={rangeId} className={refused ? "settings-stepper-range" : "visually-hidden"}>{range}</span></>;
}
