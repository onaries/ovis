import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import "./MarkdownDocuments.css";
import { FileGlyph } from "./FileGlyph.tsx";
import { Skeleton } from "./Skeleton.tsx";

import type { PaneDocuments } from "../../shared/files.ts";
import { ApiError } from "../lib/api.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { skeletonRows } from "../lib/skeleton.ts";

export interface MarkdownDocumentsProps {
  paneId: string;
  /** opens the file clicked (its absolute path) in the file viewer, which renders Markdown */
  onOpenFile: (path: string) => void;
}

/** an error is kept as its kind and worded at render: a language change redraws it, never reads the list again */
type Load = { status: "pending" } | { status: "done"; listing: PaneDocuments } | { status: "error"; oldBridge: boolean };

const folded = (text: string): string => text.normalize("NFC").toLowerCase();

/**
 * Files → Documents (#1196): the Markdown files under the pane's
 * folder, newest first, with a filter over their paths. Read only: a row opens the file viewer.
 * Read once when shown and again on Refresh; nothing polls.
 */
export function MarkdownDocuments({ paneId, onOpenFile }: MarkdownDocumentsProps) {
  const t = useT();
  const locale = useLocale();
  const { fetchPaneDocuments } = useMachineApi();
  const [load, setLoad] = useState<Load>({ status: "pending" });
  const [last, setLast] = useState<PaneDocuments | null>(null);
  const [query, setQuery] = useState("");
  const asking = useRef<AbortController | null>(null);

  const read = useCallback(() => {
    asking.current?.abort();
    const controller = new AbortController();
    asking.current = controller;
    setLoad({ status: "pending" });
    fetchPaneDocuments(paneId, controller.signal).then((listing) => {
      if (!controller.signal.aborted) {
        setLoad({ status: "done", listing });
        setLast(listing);
      }
    }, (reason: unknown) => {
      if (controller.signal.aborted) return;
      // an older PC answers the route it does not know with its generic 404; a missing pane has its own code
      setLoad({ status: "error", oldBridge: reason instanceof ApiError && reason.status === 404 && reason.code === "not_found" });
    });
  }, [fetchPaneDocuments, paneId]);
  useEffect(() => {
    setLast(null);
    read();
    return () => asking.current?.abort();
  }, [read]);

  const listing = load.status === "done" ? load.listing : null;
  const shownRoot = listing?.root ?? last?.root;
  const wanted = folded(query.trim());
  const matching = (list: PaneDocuments): PaneDocuments["documents"] => wanted === "" ? list.documents : list.documents.filter((document) => folded(document.path).includes(wanted));
  const documents = listing === null ? [] : matching(listing);
  // the rows the list showed before this read, as the filter narrowed them (a note stands for none)
  const shownBefore = last === null ? 0 : matching(last).length;
  const open = (path: string): void => {
    if (listing === null) return;
    onOpenFile(listing.root.endsWith("/") ? `${listing.root}${path}` : `${listing.root}/${path}`);
  };
  const loadingWords = t("Loading documents…");

  return (
    <div className="dir-browser md-docs" role="group" aria-label={t("Documents")} aria-busy={load.status === "pending"}>
      <div className="dir-browser-bar">
        {/* the field's name stays in view while it is typed in, before the path it filters (the path keeps its end, drawn right to left) */}
        {query.trim() !== "" && <span className="md-docs-filter-label">{t("Filter documents")}:</span>}
        <span className="dir-browser-path" title={shownRoot}><span dir="ltr">{shownRoot ?? ""}</span></span>
        <button type="button" className="icon-button" aria-label={t("Refresh documents")} title={t("Refresh documents")} disabled={load.status === "pending"} onClick={read}>
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      <div className="dir-browser-tools">
        <div className="dir-browser-filter">
          {/* a touch screen would raise its keyboard over the list just opened; Escape clears the
              filter before it reaches the dialog's own Escape, which closes the dialog */}
          <input type="search" className="input" aria-label={t("Filter documents")} title={t("Filter documents")} placeholder={t("Filter documents")} value={query} autoFocus={window.matchMedia?.("(pointer: coarse)").matches !== true}
            autoComplete="off" spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter confirms an IME candidate; Escape dismisses it, not this dialog.
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                event.stopPropagation();
                return;
              }
              if (event.key === "Escape" && query !== "") {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }} />
        </div>
      </div>
      {load.status === "error" ? <p className="dir-browser-note dir-browser-error" role="alert">{load.oldBridge ? t("This PC's bridge cannot list documents yet.") : t("Documents could not be loaded.")}</p> : (
        <ul className="dir-browser-list" aria-label={t("Markdown files")}>
          {load.status === "pending" && (
            <li className="md-docs-loading" role="status">
              {/* the note takes the first row's place, the placeholders the rest: the list keeps its height while it is read again */}
              <span className="dir-browser-note md-docs-loading-note">{loadingWords}</span>
              {shownBefore > 1 && skeletonRows(shownBefore - 1).map((width, index) => (
                <span key={index} className="md-docs-skeleton" aria-hidden="true">
                  <Skeleton className="md-docs-skeleton-glyph" />
                  <Skeleton width={width} />
                  <Skeleton className="md-docs-skeleton-time" />
                </span>
              ))}
            </li>
          )}
          {documents.map((document) => {
            const slash = document.path.lastIndexOf("/");
            const name = document.path.slice(slash + 1);
            return (
              <li key={document.path}>
                <button type="button" className="dir-browser-item is-file md-docs-item" title={document.path} onClick={() => open(document.path)}>
                  <FileGlyph name={name} />
                  <span className="md-docs-name">{name}</span>
                  {slash > 0 && <span className="md-docs-folder"><span dir="ltr">{document.path.slice(0, slash)}</span></span>}
                  <time className="md-docs-time" dateTime={document.modified} title={new Date(document.modified).toLocaleString(locale)}>{lastSeen(document.modified)}</time>
                </button>
              </li>
            );
          })}
          {listing !== null && listing.documents.length === 0 && !listing.truncated && (
            <li className="dir-browser-note">
              {t("No Markdown files in this folder")}
              <span className="dir-browser-hint">{t("See every file in Browse or refresh the list.")}</span>
            </li>
          )}
          {listing !== null && listing.documents.length > 0 && documents.length === 0 && (
            <li className="dir-browser-note" role="status">
              {t("No matching documents")}
              <span className="dir-browser-hint">{t("Clear or change the filter.")}</span>
            </li>
          )}
          {listing?.truncated && <li className="dir-browser-note">{t("Some Markdown files here are not listed.")}</li>}
        </ul>
      )}
    </div>
  );
}
