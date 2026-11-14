import { useCallback, useEffect, useRef, useState } from "react";

import { openPresentation, type FilePresentation } from "./filePresentation.ts";
import { sheetStep } from "./historyKeys.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";
import { useFocusReturn } from "./useFocusTrap.ts";
import { useFileViewer } from "./useFileViewer.ts";
import { useRepoDiffViewer } from "./useRepoDiffViewer.ts";
import { useWebPanel } from "./useWebPanel.ts";
import type { Settings } from "./settings.ts";

export interface FilePanelsParams {
  settings: Settings;
  filePanelAvailable: boolean;
  selectedPaneId: string | null;
  selectedMachineId: string;
}

type Preview = Parameters<ReturnType<typeof useFileViewer>["openFile"]>[0];
const LEFT_FILES_KEPT = 10;
const paneKey = (machineId: string, paneId: string): string => `${machineId}\n${paneId}`;

/**
 * The viewer's React key: a path is read from its pane's folder, so two panes' files of the same path
 * are two files, and a switch from one to the other must not keep the first one's loaded content.
 */
export const fileViewerKey = (preview: { machineId: string; paneId: string | null; path: string }): string =>
  `${preview.machineId}\n${preview.paneId ?? ""}\n${preview.path}`;

/**
 * The Files dialog, the file viewer, a repository diff and the web panel, which share the place beside
 * the pane and the history entries over it; and, with Reopen files on return, the files tab switches left.
 */
export function useFilePanels({ settings, filePanelAvailable, selectedPaneId, selectedMachineId }: FilePanelsParams) {
  // the Files dialog, and the file open in the viewer (a path as the chat or the dialog gave it)
  const [filesOpen, setFilesOpen] = useState(false);
  const { viewing, openFile: openPreview, closeFile, setPresentation, releaseFile, hideFile, fileFromPop } = useFileViewer();
  // a repository diff from the Files dialog's Changes tab, an entry of its own like a file
  const { viewing: diffViewing, openDiff, closeDiff, releaseDiff } = useRepoDiffViewer();
  const presentation = viewing?.presentation ?? openPresentation(viewing?.path ?? "", settings.fileOpen);
  const fileDocked = filePanelAvailable && presentation === "panel";
  // Files beside the pane (opt-in, wide windows) shares the docked file's place: a file docking there
  // covers it, and closing the file shows Files again
  const filesDocked = filePanelAvailable && settings.filesPanel;
  useEffect(() => {
    if (viewing !== null && fileDocked && !filesDocked) setFilesOpen(false);
  }, [viewing, fileDocked, filesDocked]);
  // a same-host web page shares the docked file's place on wide windows and opens as a popup on narrow ones.
  // Either replacing the other takes over its history entry in place: no push over it, no Back to wait on.
  const { webPage, openWebPage: openWebPanel, closeWebPage, yieldEntry, holdsEntry } = useWebPanel({ settings, filePanelAvailable });
  const openWebPage = useCallback((uri: string, shiftKey: boolean, machineId: string) =>
    openWebPanel(uri, shiftKey, machineId, viewing !== null && fileDocked ? releaseFile : undefined),
  [openWebPanel, viewing, fileDocked, releaseFile]);
  const openFile = useCallback((preview: Parameters<typeof openPreview>[0], replace = false) => {
    const docks = filePanelAvailable && (preview.presentation ?? openPresentation(preview.path, settings.fileOpen)) === "panel";
    openPreview(preview, (docks && webPage !== null && yieldEntry()) || replace);
  }, [openPreview, filePanelAvailable, settings.fileOpen, webPage, yieldEntry]);
  useEffect(() => {
    if (viewing !== null && fileDocked && webPage !== null) closeWebPage(true);
  }, [viewing, fileDocked, webPage, closeWebPage]);
  // a docked file or web page over Files beside the pane; opening Files again (its button, the palette) closes it
  const filesCovered = (viewing !== null && fileDocked) || webPage !== null;
  const revealFiles = useCallback(() => {
    setFilesOpen(true);
    if (!filesDocked) return;
    if (viewing !== null && fileDocked) closeFile();
    else if (webPage !== null) closeWebPage();
  }, [filesDocked, viewing, fileDocked, closeFile, webPage, closeWebPage]);
  // no dialog, so no trap gives the focus back when it closes: what opened it gets it, as for the docked file
  useFocusReturn(filesOpen && filesDocked);
  // Files closes with the dock it lived in when the window narrows: a dialog mounted then would come up
  // under a popup file or web page already open and take their focus and Escape
  const wasDocked = useRef(filesDocked);
  useEffect(() => {
    if (wasDocked.current && !filesDocked) setFilesOpen(false);
    wasDocked.current = filesDocked;
  }, [filesDocked]);
  // the panel is no dialog, so no trap gives the focus back when it closes: what opened the file
  // (a link in the chat, a row of Files) gets it, as it does from the popup
  useFocusReturn(viewing !== null && fileDocked);
  // a collapse (below) whose two steps back have not landed: a second click on Show beside the
  // pane, or the kind correction in the same moment, must not queue two steps more and the file twice
  const collapsing = useRef(false);
  // a collapse whose step back never lands must not lock the toggle once the file and diff are gone
  useEffect(() => { if (viewing === null && diffViewing === null) collapsing.current = false; }, [viewing, diffViewing]);
  const presentFile = useCallback((next: FilePresentation) => {
    if (collapsing.current) return;
    if (next === "panel" && filePanelAvailable && diffViewing !== null && viewing !== null) {
      // Collapse the stacked diff and popup to one panel entry. Pushing from their opener
      // also discards the old forward entries, so Forward cannot resurrect the popup or diff.
      const preview = { ...viewing, presentation: next };
      collapsing.current = true;
      window.addEventListener("popstate", () => {
        collapsing.current = false;
        releaseDiff();
        openFile(preview);
      }, { once: true });
      // the panels' own step, as backUnderCurrentEntry's is
      window.history.go(-2 - (sheetStep.goingBack(window.history.state) ? 1 : 0));
    } else if (next === "panel" && filePanelAvailable && viewing !== null && webPage !== null && holdsEntry()) {
      // A popup file over the report's entry docks in the report's place: like the collapse above,
      // step back past both entries (the Back closes the report) and push the docked file from their
      // opener, so the two panels leave one entry and Forward cannot bring the popup back.
      const preview = { ...viewing, presentation: next };
      collapsing.current = true;
      const land = (): void => {
        collapsing.current = false;
        openFile(preview);
      };
      window.addEventListener("popstate", land, { once: true });
      // a step back the browser refuses lands nowhere: the file stays a popup and the toggle is free again
      backUnderCurrentEntry(2)?.catch(() => { window.removeEventListener("popstate", land); collapsing.current = false; });
    } else setPresentation(next);
  }, [filePanelAvailable, diffViewing, viewing, releaseDiff, openFile, setPresentation, webPage, holdsEntry]);
  // A diff's file docking in the place of a docked report that holds the entry under the diff: like the
  // popup collapse above, step back past the diff and the report's entry and push the file from their
  // opener, so Back closes the file and then leaves, as when the report held no entry.
  const openDiffFile = useCallback(async (preview: Parameters<typeof openPreview>[0]) => {
    const docks = filePanelAvailable && openPresentation(preview.path, settings.fileOpen) === "panel";
    if (!docks || webPage === null || !holdsEntry()) return false;
    if (collapsing.current) return true;
    collapsing.current = true;
    const land = (): void => {
      collapsing.current = false;
      openFile(preview);
    };
    window.addEventListener("popstate", land, { once: true });
    try {
      await backUnderCurrentEntry(2);
    } catch (error) {
      window.removeEventListener("popstate", land);
      collapsing.current = false;
      throw error;
    }
    return true;
  }, [filePanelAvailable, settings.fileOpen, webPage, holdsEntry, openFile]);
  // the kind corrects a guess from the extension; with files set to open in the popup there is no guess to correct
  const reportFileKind = useCallback((kind: FilePresentation) => {
    const wanted = settings.fileOpen === "panel" ? kind : "popup";
    if (viewing !== null && viewing.presentation === undefined && wanted !== openPresentation(viewing.path, settings.fileOpen)) presentFile(wanted);
  }, [viewing, presentFile, settings.fileOpen]);
  // Settings > File viewer > Reopen files on return (#3179): the file a tab switch left behind, by its
  // pane, shown again when an in-app switch comes back to that pane. Back needs none of it: the file's
  // own entry stays under the switch and shows the file again.
  const leftFiles = useRef(new Map<string, Preview>());
  // a file showing is no longer waiting: closed there, it must not come back on the next return
  useEffect(() => {
    if (viewing?.paneId) leftFiles.current.delete(paneKey(viewing.machineId, viewing.paneId));
  }, [viewing]);
  /** Forgets the files of remembered panes `paneLive` no longer finds: a later pane with the same id is another tab. */
  const forgetLeftFiles = useCallback((paneLive: (machineId: string, paneId: string) => boolean) => {
    const left = leftFiles.current;
    for (const [key, file] of left) if (file.paneId !== null && !paneLive(file.machineId, file.paneId)) left.delete(key);
  }, []);
  /**
   * Leaves the file behind on a move to another pane or PC; true when its entry keeps it for Back.
   * `paneLive` says whether a pane is still in its PC's roster: a closed tab's file gives its place up
   * before the cap is applied, and the file of a tab that just closed is released, not kept. `wasShown`
   * is false for a file opened for a pane other than the one shown, which is released as well.
   */
  const leaveFile = useCallback((paneLive: (machineId: string, paneId: string) => boolean = () => true, wasShown = true) => {
    if (!settings.reopenFileOnReturn || viewing?.paneId == null || !wasShown || !paneLive(viewing.machineId, viewing.paneId)) {
      releaseFile();
      return false;
    }
    const left = leftFiles.current;
    forgetLeftFiles(paneLive);
    const key = paneKey(viewing.machineId, viewing.paneId);
    // the oldest left beyond the cap is forgotten (a Map keeps insertion order)
    left.delete(key);
    left.set(key, viewing);
    for (const oldest of left.keys()) if (left.size > LEFT_FILES_KEPT) left.delete(oldest);
    hideFile();
    return true;
  }, [settings.reopenFileOnReturn, viewing, releaseFile, hideFile, forgetLeftFiles]);
  /** After a move's entry is pushed: the file left on that pane opens over it again, as its own entry. */
  const restoreFile = useCallback((machineId: string, paneId: string) => {
    if (!settings.reopenFileOnReturn) return;
    const key = paneKey(machineId, paneId);
    const left = leftFiles.current.get(key);
    if (left === undefined) return;
    leftFiles.current.delete(key);
    openFile(left);
  }, [settings.reopenFileOnReturn, openFile]);
  const toggleFilePresentation = filePanelAvailable && viewing !== null
    ? () => presentFile(fileDocked ? "popup" : "panel")
    : undefined;
  const viewFile = useCallback((path: string) => {
    // the Files dialog would cover the docked panel the file opens in
    if (!filesDocked && filePanelAvailable && openPresentation(path, settings.fileOpen) === "panel") setFilesOpen(false);
    openFile({ path, paneId: selectedPaneId, machineId: selectedMachineId });
  }, [openFile, selectedPaneId, selectedMachineId, filePanelAvailable, settings.fileOpen, filesDocked]);
  return { filesOpen, setFilesOpen, filesDocked, filesCovered, revealFiles, viewing, openFile, closeFile, setPresentation, releaseFile, hideFile, leaveFile, restoreFile, fileFromPop, forgetLeftFiles, diffViewing, openDiff, closeDiff, releaseDiff, presentation, fileDocked, webPage, closeWebPage, openWebPage, collapsing, presentFile, openDiffFile, reportFileKind, toggleFilePresentation, viewFile };
}
