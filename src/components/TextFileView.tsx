import { lazy, Suspense, useCallback, useLayoutEffect, useRef, type RefObject } from "react";

import { OpenFileContext } from "../lib/filePaths.ts";
import { resolveFromDocument } from "../lib/fileReader.ts";
import type { Lines } from "../lib/highlight.ts";
import { useT } from "../lib/i18n.ts";
import type { MarkdownBlock } from "../../shared/markdown.ts";
import { useSettings, type MarkdownWidth } from "../lib/settings.ts";
import { CodeLines } from "./HighlightedCode.tsx";
import { ProgressiveMarkdown } from "./Markdown.tsx";

// the virtualizer and its highlighter are their own chunk, loaded with the first source that needs them
const VirtualSource = lazy(() => import("./VirtualSource.tsx"));

/** The stored width is a setting's value, not a class name: a rename of either leaves the other alone. */
const MARKDOWN_CLASS: Record<MarkdownWidth, string> = {
  readable: "file-viewer-markdown file-viewer-markdown-readable",
  full: "file-viewer-markdown",
};

export interface TextFileViewProps {
  path: string;
  /** the Preview's blocks, parsed in a worker; `null` shows the code */
  blocks: MarkdownBlock[] | null;
  /** the code's lines, from `useHighlightedLines`; drawn unless `virtual` is given */
  lines: Lines;
  /** a source too long for an element per line: the virtualizer's rows, colored in its worker or plain */
  virtual: { text: string; colored: boolean } | null;
  /** a virtualized source as one readonly text box instead, for Copy to select when the clipboard is out of reach */
  selectable: boolean;
  onOpen: (path: string) => void;
  /** set to the source element while the code shows (the `<pre>`, or the text box), for Copy to select */
  sourceRef: RefObject<HTMLElement | null>;
  markedLine: number | null;
}

/** The text of a file: Markdown rendered, or its code with line numbers. */
export function TextFileView({ path, blocks, lines, virtual, selectable, onOpen, sourceRef, markedLine }: TextFileViewProps) {
  const t = useT();
  const { settings, resolvedEntry } = useSettings();
  // the app hands a new onOpen on every render (each poll): read it from a ref, so the context
  // value changes only with the file, and the memoized Markdown and its links are left alone
  const onOpenRef = useRef(onOpen);
  useLayoutEffect(() => { onOpenRef.current = onOpen; });
  const openLink = useCallback((href: string) => onOpenRef.current(resolveFromDocument(path, href)), [path]);
  // Colors arriving from the worker do not change geometry: scroll only on a target or view change.
  useLayoutEffect(() => {
    if (blocks === null && virtual === null && markedLine !== null) sourceRef.current?.querySelector(".hl-line.is-marked")?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [path, blocks, virtual, markedLine, sourceRef]);
  const code = (() => {
    if (virtual === null) return <CodeLines ref={sourceRef as RefObject<HTMLPreElement | null>} className="file-viewer-text" lines={lines} open={null} lineNumbers wrap={settings.wrapCode} markedLine={markedLine} />;
    if (selectable) return <textarea ref={sourceRef as RefObject<HTMLTextAreaElement | null>} className="file-viewer-select-source" readOnly value={virtual.text} aria-label={t("File source")} spellCheck={false} />;
    return <Suspense fallback={<p className="file-viewer-note">{t("Opening…")}</p>}>
      <VirtualSource name={path} text={virtual.text} colored={virtual.colored} wrap={settings.wrapCode} theme={resolvedEntry.mode} markedLine={markedLine} />
    </Suspense>;
  })();
  return <div className={virtual !== null && blocks === null ? "file-viewer-content file-viewer-content-virtual" : "file-viewer-content"}>
    {blocks !== null
      ? <OpenFileContext.Provider value={openLink}><ProgressiveMarkdown className={MARKDOWN_CLASS[settings.markdownWidth]} blocks={blocks} /></OpenFileContext.Provider>
      : code}
  </div>;
}
