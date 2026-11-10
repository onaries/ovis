import { useLayoutEffect, type RefObject } from "react";

import { requestShownFrame } from "./shownFrame.ts";

/**
 * Says on a scrolling list which of its edges has rows past it, as `data-fade-top` and
 * `data-fade-bottom`, so its CSS fades only the edge that cuts something (SidebarSections.css):
 * a list at its top fades its foot alone, one scrolled to its end its head alone, and a list that
 * holds all its rows fades neither. Read again on a scroll, a resize of the list or of a row in it,
 * and a row added, taken away, hidden or shown.
 */
export function useEdgeFades(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const list = ref.current;
    // a test renderer's stand-in node is no element: nothing to read or mark
    if (list === null || typeof list.toggleAttribute !== "function" || typeof list.addEventListener !== "function") return;
    let cancel: (() => void) | null = null;
    const read = (): void => {
      cancel = null;
      // a pixel of slack: a fractional scroll position never quite reaches the end
      list.toggleAttribute("data-fade-top", list.scrollTop > 1);
      list.toggleAttribute("data-fade-bottom", list.scrollTop + list.clientHeight < list.scrollHeight - 1);
    };
    const schedule = (): void => { cancel ??= requestShownFrame(read); };
    read();
    list.addEventListener("scroll", schedule, { passive: true });
    const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    // the list and its own rows: a row that grows (a PC opening) changes how far the list scrolls
    const observeRows = (): void => {
      if (resized === null) return;
      resized.disconnect();
      resized.observe(list);
      for (const child of list.children) resized.observe(child);
    };
    observeRows();
    const changed = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => { observeRows(); schedule(); });
    changed?.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class"] });
    return () => {
      list.removeEventListener("scroll", schedule);
      resized?.disconnect();
      changed?.disconnect();
      cancel?.();
    };
  }, [ref]);
}
