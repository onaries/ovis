/**
 * The ⋯ menu of a sidebar row. On a desktop it is a popover under its button, drawn through a
 * portal at fixed coordinates: the roster scrolls, and a menu inside it would be cut off at the
 * list's edge. At phone width it is the modal primitive, which is already a bottom sheet there.
 * The system Back closes the sheet (lib/sheetHistory.ts).
 * Escape, a press outside, focus leaving it (the palette opening over it, a Tab out) and, on a
 * desktop, a scroll of what holds the button or a resize close it. Focus goes back to the button when the menu goes,
 * unless what an item mounted (a rename field, a confirm) takes it first: the button is focused
 * in a layout cleanup, before a new field's autoFocus and a dialog's own focus.
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, type LucideIcon } from "lucide-react";

import "./RowMenu.css";

import { useT } from "../lib/i18n.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { SHEET_QUERY, useSheetSwipe } from "../lib/sheets.ts";
import { useSheetHistory } from "../lib/sheetHistory.ts";

export interface RowMenuItem {
  id: string;
  label: string;
  /** a state in words, after the label: "On in the app" */
  hint?: string;
  /** the item's tooltip, when it has more to say than its label */
  title?: string;
  icon: LucideIcon;
  /** drawn in the icon's place when given: an agent's mark, which is not a lucide icon */
  glyph?: ReactNode;
  /** a hairline above this item */
  divider?: boolean;
  danger?: boolean;
  /** the item that stands for what is open now (a pane picker's current pane) */
  current?: boolean;
  /** a switch's state, when the item is one: it is then a checkbox item (a pressed button in the sheet), not a plain item */
  checked?: boolean;
  /** shown with its state but not runnable here (a watching device and a shared switch): it keeps its place in the keyboard order, and a press on it leaves the menu open */
  disabled?: boolean;
  run: () => void;
}

interface Props {
  anchor: HTMLElement;
  /** A native context menu opens at the pointer, without focusing its target first. */
  point?: { x: number; y: number };
  restoreFocusTo?: HTMLElement | null;
  /** the menu's accessible name, and the sheet's title */
  title: string;
  subtitle?: string;
  /** a phone's sheet only, under the subtitle and wrapped, not cut: text a row cuts (a hover tooltip says it on a desktop) */
  detail?: string;
  /** drawn above the items, and in the sheet's head in the title's place: what the menu is about, when that is more than a name */
  header?: ReactNode;
  items: RowMenuItem[];
  /** which edge of the button the popover lines up with: its right one (a row's ⋯), or its left one (a tab) */
  align?: "start" | "end";
  onClose: () => void;
  /** `paths`: each hint is a path; the menu is wider and a long path gives way before its label */
  variant?: "paths";
}

const GAP = 4;
const EDGE = 8;
const POPOVER_ITEMS = '[role="menuitem"], [role="menuitemcheckbox"]';
// the sheet is modal: its Cancel is one of the stops
const SHEET_ITEMS = '.row-sheet-item, .row-sheet-cancel';

export function RowMenu({ anchor, point, restoreFocusTo, title, subtitle, detail, header, items, align = "end", onClose, variant }: Props) {
  const t = useT();
  const sheet = useMediaQuery(SHEET_QUERY);
  const surface = useRef<HTMLDivElement>(null);
  useSheetSwipe(surface, sheet ? onClose : null);
  // Back closes the sheet, not the pane under it
  useSheetHistory(sheet, onClose);
  const [place, setPlace] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  // where the button was when the menu was placed: a scroll that leaves it there is not a reason to close
  const placedAt = useRef<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => () => {
    const target = restoreFocusTo === undefined ? anchor : restoreFocusTo;
    if (target?.isConnected) target.focus({ preventScroll: true });
  }, [anchor, restoreFocusTo]);

  // under the button, right edges aligned (left ones for a tab); above it when the screen ends
  // first. The height is capped to the room on that side, and only to that: a tab's menu lists
  // its panes and herdr's layout operations and is tall, so it scrolls, as AgentPicker's list
  // does, only on a screen too short for it. An item below the fold must not be reachable by
  // keyboard while the pointer cannot see it
  useLayoutEffect(() => {
    if (sheet) return;
    const menu = surface.current;
    if (!menu || !anchor.isConnected) { onClose(); return; }
    const rect = anchor.getBoundingClientRect();
    placedAt.current = { top: rect.top, left: rect.left };
    if (point) {
      setPlace({
        left: Math.max(EDGE, Math.min(point.x, window.innerWidth - menu.offsetWidth - EDGE)),
        top: Math.max(EDGE, Math.min(point.y, window.innerHeight - menu.offsetHeight - EDGE)),
        maxHeight: window.innerHeight - EDGE * 2,
      });
      return;
    }
    const left = Math.max(EDGE, Math.min(align === "start" ? rect.left : rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - EDGE));
    const below = rect.bottom + GAP;
    const roomBelow = window.innerHeight - below - EDGE;
    const roomAbove = rect.top - GAP - EDGE;
    const up = below + menu.offsetHeight + EDGE > window.innerHeight && roomAbove > roomBelow;
    const top = up ? Math.max(EDGE, rect.top - GAP - menu.offsetHeight) : below;
    setPlace({ top, left, maxHeight: Math.max(EDGE, up ? roomAbove : roomBelow) });
  }, [align, anchor, onClose, point, sheet]);

  useEffect(() => {
    const first = surface.current?.querySelector<HTMLElement>(sheet ? SHEET_ITEMS : POPOVER_ITEMS);
    window.requestAnimationFrame(() => first?.focus());
  }, [sheet]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    // the button's own click toggles the menu, so a press on it is not "outside"
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (surface.current?.contains(target) || (!point && anchor.contains(target))) return;
      onClose();
    };
    // only a scroll that moves the button out from under the menu: a terminal printing in the
    // pane scrolls too, and the click that opened the menu can scroll the roster a little
    // (the browser brings a focused button into view) without the button going anywhere
    const onScroll = (): void => {
      const was = placedAt.current;
      const rect = anchor.getBoundingClientRect();
      if (was && Math.abs(rect.top - was.top) < 1 && Math.abs(rect.left - was.left) < 1) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    if (!sheet) {
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onClose);
    }
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose, point, sheet]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const buttons = [...(surface.current?.querySelectorAll<HTMLElement>(sheet ? SHEET_ITEMS : POPOVER_ITEMS) ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const move = (next: number): void => {
      event.preventDefault();
      buttons[point ? Math.max(0, Math.min(buttons.length - 1, next)) : (next + buttons.length) % buttons.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(buttons.length - 1);
    // Tab stays inside the sheet, which is modal; it leaves the popover, which then goes
    else if (event.key === "Tab" && sheet) move(index + (event.shiftKey ? -1 : 1));
    else if (event.key === "Tab") { event.preventDefault(); onClose(); }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (next && (surface.current?.contains(next) || anchor.contains(next))) return;
    onClose();
  };
  // Safari on a Mac does not focus a clicked button, so the press would blur the focused item
  // with no relatedTarget, close the menu, and the click would land on nothing: the press keeps
  // the focus where it is, and the click still comes
  const keepFocus = (event: ReactMouseEvent<HTMLButtonElement>): void => event.preventDefault();

  // opened from inside a dialog (a link in a file preview): drawn over it, sheet or popover
  const overModal = anchor.closest('[aria-modal="true"]') !== null;

  const run = (item: RowMenuItem): void => {
    if (item.disabled) return;
    onClose();
    item.run();
  };

  if (sheet) {
    return createPortal(
      <div className={`modal-scrim${overModal ? " is-over-modal" : ""}`}>
        <div ref={surface} className="modal row-sheet" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKeyDown} onBlur={onBlur}>
          <span className="row-sheet-grip" aria-hidden="true" />
          {header ? <div className="row-sheet-head">{header}</div> : (
            <div className="row-sheet-head">
              <span className="row-sheet-title">{title}</span>
              {subtitle && <span className="row-sheet-subtitle">{subtitle}</span>}
              {detail && <span className="row-sheet-detail">{detail}</span>}
            </div>
          )}
          {/* the items scroll between the head and Cancel: a tab's menu is taller than a short phone, and `.modal` hides its overflow */}
          <div className="row-sheet-items">
            {items.map((item) => (
              <button key={item.id} type="button" className={`row-sheet-item${item.danger ? " is-danger" : ""}${item.divider ? " has-divider" : ""}${item.disabled ? " is-disabled" : ""}`} aria-current={item.current ? "true" : undefined} aria-pressed={item.checked} aria-disabled={item.disabled || undefined} title={item.title} onMouseDown={keepFocus} onMouseEnter={point ? (event) => event.currentTarget.focus({ preventScroll: true }) : undefined} onClick={() => run(item)}>
                {item.glyph ?? <item.icon aria-hidden="true" />}
                <span className="row-sheet-label">{item.label}</span>
                {item.hint && <span className="row-sheet-hint">{item.hint}</span>}
                {item.checked && <Check className="row-sheet-check" aria-hidden="true" />}
              </button>
            ))}
          </div>
          <button type="button" className="btn row-sheet-cancel" onMouseDown={keepFocus} onClick={onClose}>{t("Cancel")}</button>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div ref={surface} className={`menu row-menu${overModal ? " is-over-modal" : ""}${variant === "paths" ? " row-menu-paths" : ""}`} role="menu" aria-label={title} style={place ?? { visibility: "hidden" }} onKeyDown={onKeyDown} onBlur={onBlur}>
      {header && <div className="row-menu-header" role="presentation">{header}</div>}
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.divider && <span className="row-menu-divider" role="separator" />}
          <button type="button" role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={item.checked} className={`menu-item${item.danger ? " is-danger" : ""}${item.disabled ? " is-disabled" : ""}`} aria-current={item.current ? "true" : undefined} aria-disabled={item.disabled || undefined} title={item.title} onMouseDown={keepFocus} onMouseEnter={point ? (event) => event.currentTarget.focus({ preventScroll: true }) : undefined} onClick={() => run(item)}>
            {item.glyph ?? <item.icon aria-hidden="true" />}
            <span className="menu-item-main">{item.label}</span>
            {item.hint && <span className="menu-item-hint">{item.hint}</span>}
            {item.checked && <Check className="menu-item-check" aria-hidden="true" />}
          </button>
        </Fragment>
      ))}
    </div>,
    document.body,
  );
}
