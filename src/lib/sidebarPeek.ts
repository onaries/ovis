import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Settings → Appearance → Show the sidebar on hover (#2588, `sidebarPeek`): on a desktop with the
 * sidebar collapsed, a mouse resting on the sidebar's toggle shows the sidebar over the pane for a
 * moment, as the Claude desktop app's collapsed sidebar does. The pane keeps its width, nothing is
 * focused, and a click on the toggle keeps the sidebar open as it always did.
 */

/** how long the pointer rests on the toggle before the sidebar comes out: a pass over it shows nothing */
export const PEEK_OPEN_MS = 150;
/** how long the sidebar waits after the pointer left the toggle and the sidebar: the trip between them, or a wobble, keeps it */
export const PEEK_CLOSE_MS = 300;

export type PeekZone = "toggle" | "sidebar";

export interface SidebarPeek {
  enter(zone: PeekZone): void;
  leave(zone: PeekZone): void;
  /** puts it away at once (Escape); the pointer has to come back to the toggle to show it again */
  hide(): void;
  dispose(): void;
}

/** `held`: the sidebar is in use beyond the pointer (a row menu it opened, a field in it being typed in), so it stays until that ends */
export function createSidebarPeek(onChange: (shown: boolean) => void, held: () => boolean): SidebarPeek {
  const inside = new Set<PeekZone>();
  let shown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const show = (value: boolean): void => {
    if (shown === value) return;
    shown = value;
    onChange(value);
  };
  const closeLater = (): void => {
    timer = setTimeout(() => {
      timer = null;
      if (held()) closeLater();
      else show(false);
    }, PEEK_CLOSE_MS);
  };
  return {
    enter(zone) {
      // a hidden sidebar has no box to enter: only the toggle brings it out
      if (zone === "sidebar" && !shown) return;
      inside.add(zone);
      clear();
      if (!shown) timer = setTimeout(() => { timer = null; show(true); }, PEEK_OPEN_MS);
    },
    leave(zone) {
      if (!inside.delete(zone) || inside.size > 0) return;
      clear();
      if (shown) closeLater();
    },
    hide() {
      clear();
      inside.clear();
      show(false);
    },
    dispose: clear,
  };
}

/** a menu or popover open in the sidebar (the usage popover), or one it opened that is drawn on the body (a row
 *  menu: its anchor in the sidebar says so) */
const POPUP_IN = '[role="menu"], [role="dialog"], [aria-haspopup][aria-expanded="true"]';
/** a field taking typing (the filter, a workspace or PC being renamed): hiding it would drop the focus and the words */
const EDITING = 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable="true"]';

/** the field in the sidebar being typed in, if the focus is on one */
function editingIn(sidebar: Element): Element | null {
  const focused = document.activeElement;
  return focused !== null && sidebar.contains(focused) && focused.matches(EDITING) ? focused : null;
}

/**
 * `enabled`: the setting is on, the window is wide and the sidebar is collapsed. Turning it off (a click on
 * the toggle keeps the sidebar open) puts a peek away. Only a mouse peeks: a touch keeps the toggle's tap.
 * `sidebarRef` goes on the sidebar itself, so a keyboard that reaches it before any pointer is known too;
 * `toggleRef` on its toggle, which takes the focus back when the sidebar hides with the focus in it.
 */
export function useSidebarPeek(enabled: boolean) {
  const [peeking, setPeeking] = useState(false);
  const controller = useRef<SidebarPeek | null>(null);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  // a row being dragged in it: a drag start makes the browser cancel the pointer and report it gone (#3070). Dropped on
  // the sidebar, the browser says nothing of the pointer until it moves again, so the drop holds it until then
  const dragging = useRef(false);
  const droppedOn = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    // in use beyond the pointer: a drag, a popup it opened, or a field in it being typed in
    const show = (shown: boolean): void => {
      // a sidebar hidden with the focus in it would drop the focus on the page: the toggle that showed it takes it
      if (!shown && sidebarRef.current?.contains(document.activeElement) === true) toggleRef.current?.focus({ preventScroll: true });
      setPeeking(shown);
    };
    const peek = createSidebarPeek(show, () => {
      const sidebar = sidebarRef.current;
      return sidebar !== null && (dragging.current || droppedOn.current || sidebar.querySelector(POPUP_IN) !== null || editingIn(sidebar) !== null);
    });
    controller.current = peek;
    return () => {
      controller.current = null;
      dragging.current = false;
      droppedOn.current = false;
      peek.dispose();
      setPeeking(false);
    };
  }, [enabled]);
  // Escape puts the peek away and still reaches what has the focus. An IME composition, a modal dialog, a menu or
  // popover the focus is in or on the control that opened it (its Escape closes it first), or a field in the sidebar
  // whose Escape does something (a rename cancels, a filter with words clears) takes it first; an empty filter's
  // Escape is the peek's
  useEffect(() => {
    if (!peeking) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      if (document.activeElement?.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [aria-expanded="true"][aria-haspopup], .usage-strip[aria-expanded="true"]') != null) return;
      const sidebar = sidebarRef.current;
      const field = sidebar === null ? null : editingIn(sidebar);
      if (field !== null && !(field instanceof HTMLInputElement && field.type === "search" && field.value === "")) return;
      controller.current?.hide();
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [peeking]);
  const handlers = useMemo(() => {
    const zone = (name: PeekZone) => ({
      onPointerEnter: (event: ReactPointerEvent) => { if (event.pointerType === "mouse") controller.current?.enter(name); },
      onPointerLeave: (event: ReactPointerEvent) => { if (event.pointerType === "mouse") controller.current?.leave(name); },
    });
    return {
      toggle: zone("toggle"),
      sidebar: {
        ...zone("sidebar"),
        onDragStart: () => {
          dragging.current = true;
          // the row may be redrawn elsewhere during the drag, its dragend then never reaching the sidebar: the drop or
          // dragend reaches the window either way
          const done = (): void => { dragging.current = false; window.removeEventListener("drop", done, true); window.removeEventListener("dragend", done, true); };
          window.addEventListener("drop", done, true);
          window.addEventListener("dragend", done, true);
        },
        onDragEnd: (event: ReactDragEvent<HTMLElement>) => {
          dragging.current = false;
          const box = event.currentTarget.getBoundingClientRect();
          if (event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom) return;
          // the next move enters the sidebar again (pointerenter) or leaves it with the close grace already running
          droppedOn.current = true;
          window.addEventListener("pointermove", () => { droppedOn.current = false; }, { capture: true, once: true });
        },
      },
    };
  }, []);
  return { peeking: enabled && peeking, sidebarRef, toggleRef, toggleHandlers: handlers.toggle, sidebarHandlers: handlers.sidebar };
}
