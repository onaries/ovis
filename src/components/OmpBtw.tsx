import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, MessagesSquare } from "lucide-react";

import "./BackgroundTasks.css";
import "./OmpBtw.css";

import { Markdown } from "./Markdown.tsx";
import { formatChatTimestamp } from "../lib/chatTimestamp.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { useSettings } from "../lib/settings.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import type { OmpBtwExchange, OmpBtwTopic } from "../../shared/protocol.ts";

const OPEN_POLL_MS = 3000;
const CLOSED_POLL_MS = 10_000;
const READ_DEADLINE_MS = 10_000;

/**
 * The status line's chip for the side conversations an OMP pane's session saved with `/btw`
 * (GET /api/pane/btw), beside the background tasks chip, whose look it takes (BackgroundTasks.css).
 * OMP keeps these out of its transcript and its model's context, so Chat does not draw them as
 * turns: they are listed here, newest first, read-only, as OMP's own `/btw` history lists them.
 * Asking, following up and cancelling stay in the terminal. A `/btw` answer is saved without
 * touching the transcript, so the list is read on a timer, not on the conversation's updates.
 * The chip is off until this device turns it on (Settings > Chat > Composer, Side conversations
 * chip), so the composer's row stays minimal; while off, nothing is asked. A PC from before the
 * route answers 404, which reads as none.
 */
export function OmpBtw(props: { paneId: string }) {
  const { settings } = useSettings();
  return settings.composerBtw ? <OmpBtwChip {...props} /> : null;
}

function OmpBtwChip({ paneId }: { paneId: string }) {
  const t = useT();
  const locale = useLocale();
  const { fetchPaneBtw } = useMachineApi();
  const machineId = useMachineId();
  const [topics, setTopics] = useState<OmpBtwTopic[]>([]);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  // the last read failed: the list on screen is the one read before
  const [failed, setFailed] = useState(false);
  // the PC left some topics or follow-ups out to keep its answer small
  const [more, setMore] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  usePhoneSheetBack(() => setOpen(false), open);
  // another pane or PC: its own topics, never these
  useEffect(() => { setTopics([]); setMore(false); setOpen(false); setShown(null); setFailed(false); }, [paneId, machineId]);
  useEffect(() => { if (!open) setShown(null); }, [open]);
  // nothing left to list: the list goes with the chip, and its Escape and Back with it
  useEffect(() => { if (open && topics.length === 0 && !more) setOpen(false); }, [open, topics.length, more]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: AbortController | undefined;
    // a read that stalls is given up at its deadline and asked again, so the list never stops refreshing;
    // a hidden page asks nothing and looks again on the next tick
    const load = (): void => {
      const later = (): void => { if (alive) timer = setTimeout(load, open ? OPEN_POLL_MS : CLOSED_POLL_MS); };
      if (document.visibilityState === "hidden") { later(); return; }
      const controller = reading = new AbortController();
      const deadline = setTimeout(() => controller.abort(), READ_DEADLINE_MS);
      fetchPaneBtw(paneId, controller.signal).then(
        (found) => { clearTimeout(deadline); if (alive) { setTopics(found.topics); setMore(found.more); setFailed(false); } later(); },
        () => { clearTimeout(deadline); if (alive) setFailed(true); later(); },
      );
    };
    load();
    return () => { alive = false; clearTimeout(timer); reading?.abort(); };
  }, [fetchPaneBtw, paneId, open]);
  useEffect(() => {
    if (!open) return;
    // a picture or diagram opened from an answer is a dialog over the page (ImageLightbox, MermaidLightbox):
    // pressing in it, or Escape while it is up, is that dialog's, and the list stays open under it
    const overDialog = (): boolean => [...document.querySelectorAll('[aria-modal="true"]')].some((dialog) => !root.current?.contains(dialog));
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('[aria-modal="true"]')) return;
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape closes the list and goes no further: in the message box it would also stop the agent's turn
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || overDialog()) return;
      event.stopPropagation();
      // the list unmounts with the topic that held the focus: hand it back to the chip
      if (root.current?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true); };
  }, [open]);
  // Match BackgroundTasks: bound the upward-opening list to the room above the input card.
  useLayoutEffect(() => {
    const list = menu.current;
    const anchor = list?.offsetParent;
    const composer = anchor?.closest(".composer") ?? null;
    const frame = (composer ?? anchor)?.parentElement;
    if (!open || !list || !anchor || !frame) return;
    const measure = (): void => list.style.setProperty("--bg-tasks-room", `${anchor.getBoundingClientRect().top - frame.getBoundingClientRect().top}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    observer.observe(frame);
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [open]);

  if (topics.length === 0 && !more) return null;
  const name = t(topics.length === 1 ? "{n} side conversation" : "{n} side conversations", { n: topics.length });
  const now = Date.now();
  // a complete answer says nothing more; any other saved state is said, as OMP's history says it
  const state = (exchange: OmpBtwExchange): string | null => {
    switch (exchange.status) {
      case "complete": return null;
      case "running": return t("answering");
      case "cancelled": return t("cancelled");
      case "interrupted": return t("interrupted");
      case "error": return exchange.error ? `${t("failed")}: ${exchange.error}` : t("failed");
    }
  };
  const turn = (exchange: OmpBtwExchange, index: number) => {
    const said = state(exchange);
    return <div key={index} className="btw-exchange">
      <p className="btw-question">{exchange.question}</p>
      {exchange.answer.trim().length > 0 && <Markdown className="btw-answer">{exchange.answer}</Markdown>}
      {said && <p className="btw-state">{said}</p>}
    </div>;
  };
  // a phone's status line keeps the icon and the number (BackgroundTasks.css), the button's name has the words
  return <span className="bg-tasks" ref={root}>
    <button type="button" ref={toggle} className="bg-tasks-toggle is-idle" aria-label={name} title={name} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <MessagesSquare aria-hidden="true" /><span className="bg-tasks-label">{name}</span><span className="bg-tasks-count" aria-hidden="true">{topics.length}</span>
    </button>
    {open && <div ref={menu} id={id} className="menu bg-tasks-menu btw-menu" role="dialog" aria-label={t("Side conversations")}>
      <div className="menu-heading">{t("Side conversations")}</div>
      {failed && <p className="bg-tasks-note" role="status">{t("Couldn't refresh: this is the list as it last read")}</p>}
      {more && <p className="bg-tasks-note">{t("Some side conversations are left out. The terminal shows them all.")}</p>}
      <ul className="bg-task-list">{topics.map((topic) => {
        const when = formatChatTimestamp(topic.at, now, locale, t);
        const expanded = shown === topic.id;
        const said = state(topic.follow_ups.at(-1) ?? topic);
        const meta = [
          when?.label ?? null,
          topic.follow_ups.length > 0 ? t(topic.follow_ups.length === 1 ? "{n} follow-up" : "{n} follow-ups", { n: topic.follow_ups.length }) : null,
          said,
        ].filter((part) => part !== null).join(" · ");
        return <li key={topic.id} className="bg-task is-openable">
          <button type="button" className="bg-task-open" aria-expanded={expanded} onClick={() => setShown(expanded ? null : topic.id)}>
            {expanded ? <ChevronDown className="bg-task-icon" aria-hidden="true" /> : <ChevronRight className="bg-task-icon" aria-hidden="true" />}
            <span className="bg-task-main">
              <span className="bg-task-title">{topic.title ?? topic.question}</span>
              {meta && <span className="bg-task-meta" title={when?.full}>{meta}</span>}
            </span>
          </button>
          {expanded && <div className="btw-thread">{[topic, ...topic.follow_ups].map(turn)}</div>}
        </li>;
      })}</ul>
    </div>}
  </span>;
}
