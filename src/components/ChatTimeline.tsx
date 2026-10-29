import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";

import { ChatRowMemoryContext, type ChatRowMemory } from "../lib/chatRowState.tsx";
import { chatSelectionClipboardPayload } from "../lib/markdownClipboard.ts";
// ChatTimeline.css is imported by ChatView: the frame and the loading state need it before this chunk

export interface ChatTimelineRow {
  readonly key: string;
  readonly beforeUser: boolean;
}

export interface ChatTimelineProps<Row extends ChatTimelineRow> {
  rows: readonly Row[];
  scope: string;
  source: string | undefined;
  scroller: RefObject<HTMLDivElement | null>;
  listRef: RefObject<LegendListRef | null>;
  following: RefObject<boolean>;
  /**
   * A click a following reader made is laid out where they are until the rows change; held by the
   * chat, which lets it go when the reader goes back to the end (Jump to latest), whatever set it.
   */
  manualLayout: RefObject<boolean>;
  /** A turn works and motion is welcome: following the end glides. */
  smoothFollow: boolean;
  memories: Map<string, ChatRowMemory>;
  header: ReactNode;
  footer: ReactNode;
  label: string;
  onScroll: () => void;
  /** The reader opened something in a row (a tool, a folded block, a whole output): they read there. */
  onOpen: () => void;
  renderRow: (row: Row, index: number) => ReactNode;
}

/** One scroll owner; selected and focused rows stay real DOM nodes outside its window. */
export function ChatTimeline<Row extends ChatTimelineRow>({ rows, scope, source, scroller, listRef, following, manualLayout, smoothFollow, memories, header, footer, label, onScroll, onOpen, renderRow }: ChatTimelineProps<Row>) {
  const [selectionKeys, setSelectionKeys] = useState<string[]>([]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    setSelectionKeys([]);
    setFocusKey(null);
  }, [scope]);
  const rowKeys = useMemo(() => rows.map((row) => row.key), [rows]);
  const positions = useMemo(() => new Map(rowKeys.map((key, index) => [key, index])), [rowKeys]);
  const pinned = useMemo(() => [...new Set(focusKey === null ? selectionKeys : [...selectionKeys, focusKey])], [selectionKeys, focusKey]);
  const extraData = useMemo(() => ({ renderRow }), [renderRow]);
  const attachList = useCallback((instance: LegendListRef | null) => {
    listRef.current = instance;
    const node = instance?.getScrollableNode();
    scroller.current = node instanceof HTMLDivElement ? node : null;
  }, [listRef, scroller]);

  useLayoutEffect(() => {
    manualLayout.current = false;
    for (const key of memories.keys()) if (!positions.has(key)) memories.delete(key);
  }, [rows, memories, positions, manualLayout]);

  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const rowFor = (value: Node | null): string | null => {
      const element = value instanceof Element ? value : value?.parentElement;
      const row = element?.closest<HTMLElement>("[data-chat-row]");
      return row && node.contains(row) ? row.dataset.chatRow ?? null : null;
    };
    const selectionChanged = () => {
      const selection = getSelection();
      let first = rowKeys.length, last = -1;
      if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        for (const row of node.querySelectorAll<HTMLElement>("[data-chat-row]")) {
          const index = positions.get(row.dataset.chatRow ?? "");
          if (index !== undefined && range.intersectsNode(row)) {
            first = Math.min(first, index); last = Math.max(last, index);
          }
        }
      }
      const keys = last >= first ? rowKeys.slice(first, last + 1) : [];
      setSelectionKeys((previous) => previous.length === keys.length && previous.every((key, index) => key === keys[index]) ? previous : keys);
    };
    const focusChanged = () => setFocusKey(rowFor(document.activeElement));
    const focusOut = () => queueMicrotask(focusChanged);
    const interaction = (event: Event) => {
      const control = event.target instanceof Element ? event.target.closest("summary, .work-block-head, .work-row-head, .chat-tool-more") : null;
      // a pending work block's head opens nothing
      if (control === null || control.closest(".work-block.is-pending")) return;
      // captured before the row's own handler: what it shows now is what the click changes
      const details = control.matches("summary") ? control.parentElement : null;
      // Opening is reading there: following stops until the reader goes back to the end, so nothing
      // is held for them once they do (Jump to latest follows what grows next), not even a hold an
      // earlier click left. Another click a following reader makes is laid out where they are until
      // the rows change.
      if (control.matches(".chat-tool-more") || control.getAttribute("aria-expanded") === "false" || (details instanceof HTMLDetailsElement && !details.open)) {
        manualLayout.current = false;
        onOpen();
      } else if (following.current) manualLayout.current = true;
    };
    document.addEventListener("selectionchange", selectionChanged);
    node.addEventListener("focusin", focusChanged);
    node.addEventListener("focusout", focusOut);
    node.addEventListener("click", interaction, true);
    // on the document: a copy goes to where the selection starts, so one that begins outside the
    // chat (Select All) never reaches the chat itself. A field's own copy (the composer, a
    // copy button's hidden textarea) stays native.
    const copy = (event: ClipboardEvent) => {
      const selection = getSelection();
      if (event.defaultPrevented || !event.clipboardData || !selection) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]")) return;
      const payload = chatSelectionClipboardPayload(selection, node);
      if (!payload) return;
      event.clipboardData.setData("text/plain", payload.text);
      if (payload.html !== null) event.clipboardData.setData("text/html", payload.html);
      event.preventDefault();
    };
    document.addEventListener("copy", copy);
    return () => {
      document.removeEventListener("selectionchange", selectionChanged);
      node.removeEventListener("focusin", focusChanged);
      node.removeEventListener("focusout", focusOut);
      node.removeEventListener("click", interaction, true);
      document.removeEventListener("copy", copy);
    };
  }, [scroller, positions, rowKeys, onOpen, following, manualLayout]);

  // A glide aims at the end it saw; content that grew meanwhile leaves it short. Where it stops, a
  // reader still following is put at the end at once.
  useEffect(() => {
    const node = scroller.current;
    if (node === null || !smoothFollow) return;
    const settle = () => {
      if (following.current && !manualLayout.current && node.scrollHeight - node.clientHeight - node.scrollTop > 1) listRef.current?.scrollToEnd({ animated: false });
    };
    // `in` narrows the element to never: the DOM types always declare onscrollend
    if ("onscrollend" in (node as object)) {
      node.addEventListener("scrollend", settle);
      return () => node.removeEventListener("scrollend", settle);
    }
    // Safari before 26 fires no scrollend: settle once the scroll events have been quiet a moment
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const scrolled = () => { clearTimeout(quiet); quiet = setTimeout(settle, 150); };
    node.addEventListener("scroll", scrolled, { passive: true });
    return () => { clearTimeout(quiet); node.removeEventListener("scroll", scrolled); };
  }, [scroller, listRef, following, manualLayout, smoothFollow]);

  useLayoutEffect(() => {
    const transcript = scroller.current?.querySelector<HTMLElement>(".chat-transcript");
    if (transcript) {
      if (source === undefined) delete transcript.dataset.conversationSource;
      else transcript.dataset.conversationSource = source;
    }
  }, [source, scroller]);

  const rendered = useCallback(({ item, index }: { item: Row; index: number }) => {
    let memory = memories.get(item.key);
    if (!memory) {
      memory = { toggles: new Map(), outputs: new Map(), runs: new Map(), dormant: new Map() };
      memories.set(item.key, memory);
    }
    return <ChatRowMemoryContext.Provider value={memory}>
      <div data-chat-row={item.key} className={item.beforeUser ? "chat-virtual-row is-before-user" : "chat-virtual-row"}>{renderRow(item, index)}</div>
    </ChatRowMemoryContext.Provider>;
  }, [memories, renderRow]);

  return <LegendList
    ref={attachList}
    className="chat-view chat-view-virtual"
    contentContainerClassName="chat-transcript chat-transcript-virtual"
    role="log"
    aria-live="polite"
    aria-label={label}
    data-conversation-source={source}
    data-chat-virtual=""
    data-chat-pinned={pinned.length}
    dataKey={scope}
    data={rows}
    extraData={extraData}
    keyExtractor={(row) => row.key}
    renderItem={rendered}
    estimatedItemSize={120}
    drawDistance={400}
    recycleItems={false}
    initialScrollAtEnd
    maintainVisibleContentPosition
    alwaysRender={{ keys: pinned }}
    ListHeaderComponent={<div className="chat-virtual-header">{header}</div>}
    ListFooterComponent={<div className="chat-virtual-footer">{footer}</div>}
    onScroll={onScroll}
    onLoad={() => { if (following.current) listRef.current?.scrollToEnd({ animated: false }); }}
    onItemSizeChanged={() => {
      if (!following.current || manualLayout.current) return;
      // The browser's own glide yields to any scroll the reader or a jump makes next; the list's
      // animated scroll keeps retrying toward the end and would pull them back.
      const node = scroller.current;
      if (smoothFollow && node !== null) node.scrollTo({ top: node.scrollHeight - node.clientHeight, behavior: "smooth" });
      else listRef.current?.scrollToEnd({ animated: false });
    }}
  />;
}
