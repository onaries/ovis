import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
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
  /** A turn works and motion is welcome: following the end glides. */
  smoothFollow: boolean;
  memories: Map<string, ChatRowMemory>;
  header: ReactNode;
  footer: ReactNode;
  label: string;
  onScroll: () => void;
  renderRow: (row: Row, index: number) => ReactNode;
  /** A press on the reply's quote action is under way: a selection it clears keeps its rows pinned until the press resolves. */
  holdSelection?: boolean;
}

/** One scroll owner; selected and focused rows stay real DOM nodes outside its window. */
export function ChatTimeline<Row extends ChatTimelineRow>({ rows, scope, source, scroller, listRef, following, smoothFollow, memories, header, footer, label, onScroll, renderRow, holdSelection = false }: ChatTimelineProps<Row>) {
  const [selectionKeys, setSelectionKeys] = useState<string[]>([]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useLayoutEffect(() => {
    setSelectionKeys([]);
    setFocusKey(null);
  }, [scope]);
  const manualLayout = useRef(false);
  // read by the selection handler, which may run before a passive effect would have seen the press
  const holding = useRef(holdSelection);
  const recompute = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const ended = holding.current && !holdSelection;
    holding.current = holdSelection;
    // a hold that ended: the selection as it is now decides
    if (ended) recompute.current?.();
  }, [holdSelection]);
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
  }, [rows, memories, positions]);

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
      if (keys.length === 0 && holding.current) return;
      setSelectionKeys((previous) => previous.length === keys.length && previous.every((key, index) => key === keys[index]) ? previous : keys);
    };
    recompute.current = selectionChanged;
    const focusChanged = () => setFocusKey(rowFor(document.activeElement));
    const focusOut = () => queueMicrotask(focusChanged);
    const interaction = (event: Event) => {
      // a pending work block's head opens nothing
      if (event.target instanceof Element && event.target.closest("summary, .work-block-head, .work-row-head, .chat-tool-more") && !event.target.closest(".work-block.is-pending")) manualLayout.current = true;
    };
    document.addEventListener("selectionchange", selectionChanged);
    node.addEventListener("focusin", focusChanged);
    node.addEventListener("focusout", focusOut);
    node.addEventListener("click", interaction, true);
    const copy = (event: ClipboardEvent) => {
      const selection = getSelection();
      if (event.defaultPrevented || !event.clipboardData || !selection) return;
      const payload = chatSelectionClipboardPayload(selection, node);
      if (!payload) return;
      event.clipboardData.setData("text/plain", payload.text);
      event.clipboardData.setData("text/html", payload.html);
      event.preventDefault();
    };
    node.addEventListener("copy", copy);
    return () => {
      document.removeEventListener("selectionchange", selectionChanged);
      recompute.current = null;
      node.removeEventListener("focusin", focusChanged);
      node.removeEventListener("focusout", focusOut);
      node.removeEventListener("click", interaction, true);
      node.removeEventListener("copy", copy);
    };
  }, [scroller, positions, rowKeys]);

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
  }, [scroller, listRef, following, smoothFollow]);

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
      memory = { toggles: new Map(), outputs: new Map() };
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
