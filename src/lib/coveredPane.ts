import { useInsertionEffect, useLayoutEffect, useRef, type RefObject } from "react";

const SLOTS = ":scope > .pane-slot";
const KEPT = "data-kept-box";
const SIDES = ["left", "top", "width", "height"] as const;
/**
 * what the hold writes on a slot's own style: a split's slot carries its rectangle there (App.tsx), as percentages; and
 * the room a header over the pane takes of it (--header-over: a phone's glass header, a wide thread's zone), which the
 * page gives it from the app's root and takes away under the list
 */
const HELD = ["position", ...SIDES, "--header-over"] as const;
interface Box { left: number; top: number; width: number; height: number; over: string }

/** a slot's own style holding the box, placed in an area that lies at `origin` */
function place(slot: HTMLElement, box: Box, origin: { left: number; top: number }): void {
  const at = { position: "absolute", left: `${box.left - origin.left}px`, top: `${box.top - origin.top}px`, width: `${box.width}px`, height: `${box.height}px`, "--header-over": box.over };
  for (const name of HELD) if (at[name] !== "") slot.style.setProperty(name, at[name]);
}

/**
 * A pane the inbox mode's list stands over keeps the box it was shown in (App.tsx; InboxList.css draws it there). The
 * list takes the shell's bars away, from 769px it draws its column whether or not the classic sidebar was open, and a
 * classic split becomes one pane, so laid out again under the list the pane would have another box than the one its
 * pty was sized to. It sizes nothing while covered (PaneCoveredContext); held in its box, its terminal does not even
 * see a change. The box is written on the slot's own style, which outranks the rectangle a split's slot carries there.
 * Shown again, the slot gets back what its style held only where that still is the hold's value: the commit that
 * shows a thread clears a split slot's rectangle before the hold lets go, and what React wrote then stands.
 *
 * Each pane's box is read as the list is about to cover it: the render that says so runs before React writes any of
 * it to the page, which still lies as the pane was shown, in the classic app or in a thread. Nothing is read at any
 * other time and nothing is watched, so the classic app, where no list covers a pane, does none of this. A pane
 * that was not on the page then (one a page opened under its list) is left to the layout.
 *
 * The box is written as the commit that covers the pane is made, before anything lays the page out again (an
 * insertion effect: the list's own layout effects read the page as it opens, a scroll put back, a focus given). Laid
 * out for a moment at the size the area gives it once the bars are gone, a transcript at its end would be cut short
 * there and stand short of it once the box is held, and its chat would take that move for the reader's and draw
 * Jump to latest. It is first placed where it lay in the area as the area lay; once those effects have run, the area
 * is read where it lies now and the pane put back where it was on the screen, at the same size. The room a header over
 * the pane took of it as it was shown (--header-over) is held with the box: under the list the page gives it none,
 * and a transcript at its end, losing that room at its top while hidden, would be moved twice (by the browser, and by
 * the chat's list holding its rows in place) and stand short of its end when the row shows it again.
 */
export function useKeptPaneBoxes(area: RefObject<HTMLElement | null>, covered: boolean): void {
  const boxes = useRef(new WeakMap<Element, Box>());
  // by the slot's id too (App.tsx data-slot): a split's half that a thread took off the page is mounted again under
  // the list by Back, as another element, and is held at the box it had when the list last found it
  const bySlot = useRef(new Map<string, Box>());
  /** where the pane area lay as the boxes were last read */
  const origin = useRef<{ left: number; top: number } | null>(null);
  /** whether the list covered the panes as the page was last written */
  const wasCovered = useRef(false);
  /** each slot the hold writes on while the list covers it: its box, what its style held, and what the hold last wrote */
  const held = useRef<{ slot: HTMLElement; box: Box; own: string[]; wrote: string[] }[]>([]);
  if (covered && !wasCovered.current) {
    const host = area.current;
    if (host !== null) {
      const at = host.getBoundingClientRect();
      origin.current = { left: at.left, top: at.top };
      for (const slot of host.querySelectorAll(SLOTS)) {
        const read = slot.getBoundingClientRect();
        const box = { left: read.left, top: read.top, width: read.width, height: read.height, over: getComputedStyle(slot).getPropertyValue("--header-over").trim() };
        boxes.current.set(slot, box);
        const id = slot.getAttribute("data-slot");
        if (id !== null) bySlot.current.set(id, box);
      }
    }
  }
  useInsertionEffect(() => {
    wasCovered.current = covered;
    const host = area.current;
    const from = origin.current;
    if (!covered || host === null || from === null) return;
    const entries: typeof held.current = [];
    for (const slot of host.querySelectorAll<HTMLElement>(SLOTS)) {
      const id = slot.getAttribute("data-slot");
      const box = boxes.current.get(slot) ?? (id === null ? undefined : bySlot.current.get(id));
      if (box === undefined) continue;
      const own = HELD.map((name) => slot.style.getPropertyValue(name));
      place(slot, box, from);
      // as the style reads the values back: a length may be written with fewer digits than it was given
      entries.push({ slot, box, own, wrote: HELD.map((name) => slot.style.getPropertyValue(name)) });
      slot.setAttribute(KEPT, "");
    }
    held.current = entries;
    return () => {
      for (const { slot, own, wrote } of entries) {
        slot.removeAttribute(KEPT);
        HELD.forEach((name, at) => {
          if (slot.style.getPropertyValue(name) !== wrote[at]) return;
          if (own[at]) slot.style.setProperty(name, own[at]); else slot.style.removeProperty(name);
        });
      }
      held.current = [];
    };
  }, [covered]);
  useLayoutEffect(() => {
    const host = area.current;
    if (!covered || host === null || held.current.length === 0) return;
    const now = host.getBoundingClientRect();
    for (const entry of held.current) {
      place(entry.slot, entry.box, now);
      entry.wrote = HELD.map((name) => entry.slot.style.getPropertyValue(name));
    }
  }, [covered]);
}
