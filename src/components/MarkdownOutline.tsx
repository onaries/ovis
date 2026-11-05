import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useT } from "../lib/i18n.ts";
import { currentHeading, type OutlineEntry } from "../lib/markdownOutline.ts";

/** A chosen heading comes to rest this far under the top of the document's scroll box. */
const JUMP_INSET_PX = 8;
/** The reading line: a heading whose top has passed it (a chosen one included) is the one being read. */
const READING_LINE_PX = 32;
/** From this width of the viewer's body the outline is a column beside the document; narrower, a drawer over it. */
export const OUTLINE_COLUMN_MIN_PX = 760;

/** The document's own headings as the Preview draws them: the Markdown root's `h3` children, in order. */
function headingsIn(scroller: HTMLElement): NodeListOf<HTMLElement> {
  return scroller.querySelectorAll<HTMLElement>(".file-viewer-markdown > h3");
}

/** Whether `element` is at least `min` pixels wide, measured before the first paint and on every resize. */
export function useWideEnough(element: HTMLElement | null, min: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (element === null) return;
    setWide(element.clientWidth >= min);
    const observer = new ResizeObserver(() => setWide(element.clientWidth >= min));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, min]);
  return wide;
}

export interface MarkdownOutlineProps {
  id: string;
  entries: readonly OutlineEntry[];
  /** the document's scroll box, which the outline follows and moves, and never focuses */
  scroller: RefObject<HTMLElement | null>;
  /** over the document (a narrow viewer) rather than beside it: it takes the focus, and closes on a choice, Escape or a press outside */
  drawer: boolean;
  /** the header button that shows it: a press there is no press outside, and the focus goes back to it */
  toggle: RefObject<HTMLElement | null>;
  onClose: (refocus: boolean) => void;
}

/**
 * The headings of a Markdown Preview (#636). As the document scrolls, the heading being read is
 * marked and kept in the middle of the list as far as the list's own scroll range allows, by
 * scrolling the list alone: the document's position and the focus stay where they are. Choosing
 * an entry brings its heading (each heading its own, a repeated title included) to the top.
 */
export function MarkdownOutline({ id, entries, scroller, drawer, toggle, onClose }: MarkdownOutlineProps) {
  const t = useT();
  const list = useRef<HTMLElement>(null);
  const [active, setActive] = useState(-1);
  // a chosen entry stays marked while the document rests where the choice left it: near the end, its
  // heading may not reach the reading line, and the end's own rule (below) would mark a later one
  const chosen = useRef<{ index: number; scrollTop: number } | null>(null);
  const shallowest = Math.min(...entries.map((entry) => entry.level));

  // the heading at the reading line, measured as the outline opens and then once a frame while the document scrolls
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box === null) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      if (chosen.current !== null && Math.abs(box.scrollTop - chosen.current.scrollTop) < 1) {
        setActive(chosen.current.index);
        return;
      }
      chosen.current = null;
      const top = box.getBoundingClientRect().top;
      const headings = headingsIn(box);
      // scrolled to its end, the document's last headings can rise no further: the last one in view is read
      const atEnd = box.scrollTop > 0 && box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
      // a heading of a chunk not drawn yet (ProgressiveMarkdown) is below every drawn one
      setActive(currentHeading(entries.map((entry) => (headings[entry.at]?.getBoundingClientRect().top ?? Infinity) - top), atEnd ? box.clientHeight : READING_LINE_PX));
    };
    measure();
    const onScroll = (): void => { if (frame === 0) frame = requestAnimationFrame(measure); };
    box.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      box.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scroller, entries]);

  // the marked entry in the middle of the list; the browser holds the list's scroll to its range at either end
  useLayoutEffect(() => {
    const box = list.current;
    if (box === null) return;
    const item = box.querySelector<HTMLElement>("[aria-current]");
    box.scrollTop = item === null ? 0 : item.offsetTop - (box.clientHeight - item.offsetHeight) / 2;
  }, [active]);

  // a drawer takes the focus once, on the marked entry (centered above) as soon as the first measure marks one
  const focusedIn = useRef(false);
  useLayoutEffect(() => {
    if (!drawer || focusedIn.current || active < 0) return;
    focusedIn.current = true;
    list.current?.querySelector<HTMLElement>("[aria-current]")?.focus({ preventScroll: true });
  }, [drawer, active]);

  // and closes on Escape or a press outside it
  useEffect(() => {
    if (!drawer) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (!list.current?.contains(target) && !toggle.current?.contains(target)) onClose(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      // only while the keyboard is in this viewer: a dialog in front of it (Settings), or the pane
      // beside a docked panel, keeps its own Escape
      const viewer = list.current?.closest("[role=dialog], .file-panel, .file-reader");
      if (!viewer?.contains(document.activeElement)) return;
      event.stopPropagation();
      onClose(true);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [drawer, toggle, onClose]);

  /** Brings the entry's own heading to the top of the document; a drawer then closes, handing the focus back to its button. */
  const choose = (entry: OutlineEntry, index: number): void => {
    const box = scroller.current;
    const heading = box === null ? undefined : headingsIn(box)[entry.at];
    if (box === null || heading === undefined) return;
    box.scrollTop += heading.getBoundingClientRect().top - box.getBoundingClientRect().top - JUMP_INSET_PX;
    chosen.current = { index, scrollTop: box.scrollTop };
    setActive(index);
    if (drawer) onClose(true);
  };

  // the list scrolls on its own: a stroke down it at its top never drags the viewer's sheet (lib/sheets.ts)
  return <nav ref={list} id={id} className={drawer ? "markdown-outline is-drawer" : "markdown-outline"} aria-label={t("Outline")} data-sheet-stroke="own">
    <ol>
      {entries.map((entry, index) => <li key={entry.at}>
        <button type="button" className={`markdown-outline-item is-depth-${entry.level - shallowest}`} aria-current={index === active ? "location" : undefined} title={entry.text} onClick={() => choose(entry, index)}>{entry.text}</button>
      </li>)}
    </ol>
  </nav>;
}
