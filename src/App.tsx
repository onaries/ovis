import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Ellipsis, FolderOpen, Link, Menu, MessageSquare, PanelLeft, Search, SquareTerminal, X } from "lucide-react";

import type { HerdrPane } from "../shared/protocol.ts";
import { authenticate, createTab, moveTabToWorkspace, pairDevice, shareSeen, signOut, splitPane, swapPaneWith, zoomPane } from "./lib/api.ts";
import { deviceLabel } from "./lib/phone.ts";
import { displayPaneTitle } from "./components/Sidebar.tsx";
import { PaneCanvas } from "./components/PaneCanvas.tsx";
import { MachineSessionsProvider } from "./lib/machineSessionContext.tsx";
import { PaneTerminal } from "./components/PaneTerminal.tsx";
import { paneCovered, paneContentKey, paneContentPresented } from "./lib/panePresentation.ts";
import { PANE_TABPANEL_ID, paneTabPanelLabel } from "./lib/paneRegion.ts";
import { worktreeRepoName } from "./lib/composerStrip.ts";
import { AccessGate } from "./components/AccessGate.tsx";
import { AgentMark } from "./components/AgentMark.tsx";
import { NewSessionDialog } from "./components/NewSessionDialog.tsx";
import { SessionHistory } from "./components/SessionHistory.tsx";
import { UnsentTextDialog } from "./components/UnsentText.tsx";
import { useUnsentRecovery } from "./lib/useUnsentRecovery.ts";
import { sessionHistoryAgent, sessionHistoryListAgent, sessionHistorySourcePane } from "./lib/sessionHistory.ts";
import { usePreferencesSync } from "./lib/preferencesSync.ts";
import { TabStrip } from "./components/TabStrip.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { loadedOnSettingsEntry } from "./lib/settingsHistory.ts";
import { useSettingsDialog } from "./lib/useSettingsDialog.ts";
import { usePhoneSheetBack } from "./lib/sheetHistory.ts";
import { peekFor, type PeekRequest } from "./lib/terminalPeek.ts";
import { linksSomewhere, readLink } from "./lib/deepLink.ts";
import { copyText } from "./lib/clipboard.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { MachineContext } from "./lib/machineContext.tsx";
import { MachineActionBanner, MachineSidebar } from "./components/MachineSidebar.tsx";
import { SidebarResizer } from "./components/SidebarResizer.tsx";
import { useSidebarActivityState } from "./lib/sidebarActivity.tsx";
import { FilePanelResizer } from "./components/FilePanelResizer.tsx";
import { openPresentation } from "./lib/filePresentation.ts";
import { MachineDialog } from "./components/MachineDialog.tsx";
import { RowMenu, type RowMenuItem } from "./components/RowMenu.tsx";
import { headerCrumb, showsChat } from "./lib/headerCrumb.ts";
import { paneStorageId } from "../shared/machines.ts";
import { usePairedNotices } from "./lib/usePairedNotices.ts";
import { takeAuthTokenFromUrl } from "./lib/authLink.ts";
import { rosterPanes } from "./lib/dagPane.ts";
import { ReorderContext } from "./lib/machineContext.tsx";
import { useSettings } from "./lib/settings.ts";
import { useShownMachines } from "./lib/hiddenMachines.ts";
import { formatKeys, shortcutDisplayKeys, useShortcuts } from "./lib/shortcuts.ts";
import { useMediaQuery } from "./lib/useMediaQuery.ts";
import { useAnnouncedText } from "./lib/useAnnouncedText.ts";
import { paneContextPress } from "./lib/paneCanvas.ts";
import type { AppActions, PaneView, PaneControls } from "./lib/actions.ts";
import { removePushSubscription } from "./lib/push.ts";
import { resetPushHealth } from "./lib/pushHealth.ts";
import { useUpdates } from "./lib/updates.ts";
import { UpdateNotice } from "./components/UpdateControls.tsx";
import { LanExposureNotice } from "./components/LanExposureNotice.tsx";
import { PushHealthNotice } from "./components/PushHealthNotice.tsx";
import { DevicePairedNotice } from "./components/DevicePairedNotice.tsx";
import { TelemetryNotice } from "./components/TelemetryControls.tsx";
import { FilesDialog } from "./components/FilesDialog.tsx";
import { folderQueryFor } from "./lib/paletteFolders.ts";
import { FileViewer } from "./components/FileViewer.tsx";
import { WebPanel } from "./components/WebPanel.tsx";
import { WebPanelContext } from "./lib/webPanel.ts";
import { RepoDiffViewer } from "./components/RepoDiffViewer.tsx";
import { OpenFileContext } from "./lib/filePaths.ts";
import { useAccessState, useLockedRef } from "./lib/useAccess.ts";
import { useLocalHealth } from "./lib/useLocalHealth.ts";
import { useMachinesRef, useRecentFolderMemory, useRefetchTimer, useRosterError, useRosterEvents, useRosterLoader, useRosterState } from "./lib/useMachineRoster.ts";
import { useMachineDialog } from "./lib/useMachineDialog.ts";
import { useNewSessionMachine, useNewSessionState, useSessionHistoryList } from "./lib/useNewSessionDialog.ts";
import { useCommandPalette } from "./lib/useCommandPalette.ts";
import { useRenameRequest } from "./lib/useRenameRequest.ts";
import { useFilePanels } from "./lib/useFilePanels.ts";
import { usePaneCoverage } from "./lib/usePaneCoverage.ts";
import { useT } from "./lib/i18n.ts";
import { useConnectionChip, useServerMessageHandler } from "./lib/useConnectionChip.ts";
import { selectionStill } from "./lib/selectionMark.ts";
import { carryPaneState } from "./lib/paneMove.ts";
import { useScreenWakeLock } from "./lib/wakeLock.ts";
import { useSidebarLayout } from "./lib/useSidebarLayout.ts";
import { useAlertPrefs, useAlertRefs } from "./lib/useAlerts.ts";
import { useAlertSignals } from "./lib/useAlertSignals.ts";
import { useNotificationState, useNotificationSwitch } from "./lib/useNotifications.ts";
import { alertsBell } from "./lib/alertsBell.ts";
import { Droplet } from "./components/Droplet.tsx";
import { MarkdownLinkMenu } from "./components/MarkdownLinkMenu.tsx";
import { paneDragData, PANE_DRAG_TYPE, sameTarget, slotSide, type SplitSlot, type SplitTarget } from "./lib/split.ts";
import { useLayoutNotice, useLayoutRefused, useMoveRefused } from "./lib/useLayoutNotice.ts";
import { PaneFollowContext } from "./lib/paneSubmitContext.ts";
import { SplitDropPreview } from "./components/SplitDropPreview.tsx";
import { CrashProbe, RegionCrash } from "./components/AppCrash.tsx";
import { RenderBoundary } from "./components/RenderBoundary.tsx";
import { lensOwner, storedView, usePaneLens, usePaneLensState, usePaneViewPicks } from "./lib/usePaneLens.ts";
import { useSplitLayout, useSplitRecheck, useSplitState } from "./lib/useSplitView.ts";
import { linkSelects, useLinkLanding, useMachineGone, useNotificationTargets, useSelectedLayout, useSelectedMachine, useSelectedPane, useSelectionMark, useSelectionState, useSelectPane, useSelectTarget } from "./lib/useSelection.ts";
import { useAddressBar } from "./lib/useAddressBar.ts";

const APP_TITLE = "Ovis";
/** how soon after a key press a focus counts as the user's own (lastKeyAtRef) */
const KEY_FOCUS_MS = 1000;

/** Slot b of the split draws on connections of its own: both halves may attach one tab, and each
 *  attaches and detaches it as the other is not there (lib/split.ts). */
function SlotSessions({ slot, machineIds, children }: { slot: SplitSlot; machineIds: readonly string[]; children: ReactNode }) {
  return slot === "b" ? <MachineSessionsProvider machineIds={machineIds}>{children}</MachineSessionsProvider> : <>{children}</>;
}

/** The header's note. Its status is in the header from the header's first render, clipped while empty
    (never display: none, as the connection chip), and its words land a frame after the box, even the
    ones a page opens with (lib/useAnnouncedText.ts). Its sentence is cut like the title it stands in
    for, under its own class: only the pane title carries .context-title-text, which the browser
    checks measure (scripts/mobile-tabs-regression.ts). */
function HeaderNote({ note }: { note: string | null }) {
  const shown = useAnnouncedText(note);
  return (
    <div className={shown === null ? "visually-hidden" : "context"}>
      <span className={shown === null ? undefined : "pill header-note"} role="status" style={{ minWidth: 0 }}>
        <span className="header-note-text">{shown}</span>
      </span>
    </div>
  );
}

/** The connecting shell's one sidebar line: the same announced status as every other (lib/useAnnouncedText.ts). */
function ConnectingNote() {
  const t = useT();
  const shown = useAnnouncedText(t("Connecting…"));
  return <p className={shown === null ? "visually-hidden" : "tree-state"} role="status">{shown}</p>;
}

/** The header's connection chip. It speaks only while the bridge is not live; live, it stays in the document
    for a screen reader (and the browser scripts that wait on it), drawn by nothing (styles.css). Its word lands
    a frame after the chip (lib/useAnnouncedText.ts), as every status line's does. */
function ConnectionChip({ connected, word, title }: { connected: boolean; word: string; title: string | undefined }) {
  const shown = useAnnouncedText(word);
  return (
    <span className={`conn ${connected ? "conn-live" : "conn-reconnecting"}`} role="status" title={title}>
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-text">{shown}</span>
    </span>
  );
}

function Brand() {
  return (
    <h1 className="brand">
      <img src="/icons/icon-192.png?v=sheep1" alt="" width="22" height="22" className="brand-mark" />
      <span className="brand-name">
        Ovis
      </span>
    </h1>
  );
}

export function App() {
  const t = useT();
  const apple = /Mac|iPhone|iPad/.test(navigator.platform);
  const { settings, resolvedTheme, resolvedEntry, update: updateSettings } = useSettings();
  const { alerts, alertsRef, alertsOn, alertsOnRef } = useAlertPrefs({ settings });
  const { machines, setMachines, machineRosterLoaded, setMachineRosterLoaded } = useRosterState();
  // the place the address names, read once at load: a link wins over this window's last selection
  const [initialLink] = useState(() => {
    // a link's lens is drawn over its pane's own, as a tapped notification's is (notificationViewTarget below)
    if (!linksSomewhere(window.location.search)) return null;
    const link = readLink(window.location.search);
    // a load onto an entry Settings left (a reload) steps out of it (lib/settingsHistory.ts): the
    // dialog its address names, on that entry or on the one stepped back to, is the one it closed
    return loadedOnSettingsEntry() ? { ...link, settings: null, section: null } : link;
  });
  useRecentFolderMemory({ machines });
  const { selectedMachineId, setSelectedMachineId, selectedMachine, snapshot } = useSelectedMachine({ initialLink, machines });
  const { machinesRef } = useMachinesRef({ machines });
  const [updateRemote, setUpdateRemote] = useState(false);
  const { machineDialog, setMachineDialog, addPcFocusReturn, closeMachineDialog } = useMachineDialog();
  const { newSessionMachineId, setNewSessionMachineId } = useNewSessionMachine();
  const { health, localFreshness, shownHealth, readLocalHealth } = useLocalHealth();
  const { error, setError } = useRosterError();
  const { layoutNotice, setLayoutNotice } = useLayoutNotice();
  const { locked, setLocked, lockReason, pairCode, auth, canSignOut, pairedFromAddress, security, readBridgeHealth } = useAccessState();
  const { pairedNotices, setPairedNotices, dismissPairedNotice } = usePairedNotices();
  useEffect(() => {
    if (locked !== false || pairCode === "" || pairedFromAddress.current || auth?.via === "device") return;
    pairedFromAddress.current = true;
    pairDevice(pairCode, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0)).then(() => loadHealth()).catch(() => { /* the gate, if any, reports it */ });
  }, [locked, pairCode, auth]); // eslint-disable-line react-hooks/exhaustive-deps
  const updates = useUpdates(locked === false);
  const { selectedPaneId, setSelectedPaneId, notificationViewTarget, setNotificationViewTarget, terminalPeek, setTerminalPeek, endPeek, pendingLink, linkLanded, setLinkLanded, rosterSeq, linkSince, selectionSince, rosterTick, setRosterTick, linkTick, setLinkTick } = useSelectionState({ initialLink });
  const { otherRecheck, otherRosterTick, setOtherRosterTick } = useSplitRecheck();
  const { rosterIn, pendingFile, selectionHint, setHeaderNote, note, autoSelected, setAutoSelected } = useLinkLanding({ initialLink, otherRecheck, setOtherRosterTick, pendingLink, rosterSeq, setRosterTick, linkLanded, t });
  const { drawerOpen, setDrawerOpen, drawerOpenRef, wideScreen, sidebarCollapsed, setSidebarCollapsed, sidebarWidth, setSidebarWidth, filePanelAvailable, filePanelWidth, setFilePanelWidth, sidebarFilterRequest, openSidebarFilter } = useSidebarLayout({ initialLink });
  const { selectionRef, movingPanes } = useSelectionMark({ selectedMachineId, selectedPaneId });
  const { lens, setLens, viewPicks, setViewPicks } = usePaneLensState();
  const { split, setSplit, soloSlot, endSplit, splitRef, splitShownRef, lastKeyAtRef, paneDragging, setPaneDragging, dropAt, dropAtRef, showDropTarget, clearDropPreview, paneAreaRef, tabDrag, draggedPaneRef, markSwap } = useSplitState();
  const { paletteOpen, paletteQuery, openPalette, setPaletteOpen } = useCommandPalette();
  const paneControls = useRef<PaneControls | null>(null);
  const [findRequest, setFindRequest] = useState<{ paneId: string | null; serial: number }>({ paneId: null, serial: 0 });
  // the Rename tab shortcut and palette action: the tab strip of the selected pane opens its name field
  const { renameRequest, requestRename, clearRenameRequest } = useRenameRequest(selectedMachineId, selectedPaneId);
  // the header's More menu: its button
  const [more, setMore] = useState<{ anchor: HTMLElement } | null>(null);
  const closeMore = useCallback(() => setMore(null), []);
  // the pane canvas's actions, for the phone's tab menu (TabStrip)
  const paneActionsRef = useRef<((target: HerdrPane) => RowMenuItem[]) | null>(null);
  const { filesOpen, setFilesOpen, viewing, openFile, closeFile, releaseFile, diffViewing, openDiff, closeDiff, releaseDiff, presentation, fileDocked, webPage, setWebPage, openWebPage, reportFileKind, toggleFilePresentation, viewFile } = useFilePanels({ settings, filePanelAvailable, selectedPaneId, selectedMachineId });
  const { settingsOpen, setSettingsOpen, settingsLinkPage, setSettingsLinkPage, settingsLinkSection, settingsPage, settingsSection, setSettingsSection, closeSettings, onSettingsPage } = useSettingsDialog(initialLink);
  const { newSessionOpen, setNewSessionOpen, newPrefill, setNewPrefill, newFields, setNewFields, pendingCreate, newTab, setNewTab, sessionHistory, setSessionHistory } = useNewSessionState({ initialLink });
  const { connected, setConnected, connectedBefore, setConnectedBefore, paneLost, outputStopped, setOutputStopped } = useConnectionChip();
  const { notifications, setNotifications, pushOn, setPushOn, pushOnRef } = useNotificationState();
  // the shared settings and pins, the same in every browser of this server, once the app is in
  const { receive: receivePreferences, saveError: settingsSaveError, paused: settingsSavePaused, retrying: settingsSaveRetrying, retry: retrySettingsSave, resubscribed: preferencesResubscribed, disconnected: preferencesDisconnected, closed: preferencesClosed } = usePreferencesSync(locked === false);
  const receivePreferencesRef = useRef(receivePreferences); receivePreferencesRef.current = receivePreferences;
  const preferencesResubscribedRef = useRef(preferencesResubscribed); preferencesResubscribedRef.current = preferencesResubscribed;
  const preferencesDisconnectedRef = useRef(preferencesDisconnected); preferencesDisconnectedRef.current = preferencesDisconnected;
  const preferencesClosedRef = useRef(preferencesClosed); preferencesClosedRef.current = preferencesClosed;
  const { lockedRef } = useLockedRef({ locked });
  const { statusRef, turnStartRef, lastTurnRef, alertInAppRef, alertSoundRef } = useAlertRefs({ settings });
  const followFocusRef = useRef(settings.followHerdrFocus);
  followFocusRef.current = settings.followHerdrFocus;
  const { refetchTimer } = useRefetchTimer();
  const snapshotRef = useRef<typeof snapshot>(null);
  snapshotRef.current = snapshot;

  const loadHealth = useCallback(async () => {
    await readBridgeHealth();
    await readLocalHealth();
  }, []);
  const { snapshotRequests, reorderCoordinator, load, scheduleRefetch } = useRosterLoader({ rosterIn, setMachines, setMachineRosterLoaded, setError, setLocked, loadHealth, lockedRef, refetchTimer });

  const { dropIn, chime, onRoster, onPaneStatus, onPaneExited } = useAlertSignals({ settings, selectionRef, drawerOpenRef, splitRef, splitShownRef, machinesRef, alertsRef, alertsOnRef, pushOnRef, statusRef, turnStartRef, lastTurnRef, alertInAppRef, alertSoundRef });

  useRosterEvents({ locked, receivePreferencesRef, snapshotRequests, onRoster, reorderCoordinator, setMachines, rosterIn, setMachineRosterLoaded, machinesRef, onPaneStatus, onPaneExited, followFocusRef, selectionRef, splitShownRef, splitRef, pendingLink, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, scheduleRefetch, preferencesResubscribedRef, preferencesDisconnectedRef, preferencesClosedRef, dropIn, chime, setPairedNotices, getTakeNotificationTargetRef: () => takeNotificationTargetRef });

  const handleServerMessage = useServerMessageHandler(setOutputStopped);

  const { enableNotifications, disableNotifications, repairNotifications } = useNotificationSwitch({ updateSettings, locked, notifications, setNotifications, alerts, alertsRef, alertsOn, setPushOn });

  const unlock = useCallback(() => {
    setLocked(false);
    void loadHealth();
    void load();
  }, [load, loadHealth]);

  // pasting the auth link into an already-open tab is a fragment-only navigation:
  // no reload happens, so the boot consumer never re-runs. Watch for the arrival
  // of the fragment instead; a wrong token just leaves the gate as it is.
  useEffect(() => {
    const onHashChange = (): void => {
      const linkToken = takeAuthTokenFromUrl();
      if (linkToken === null) return;
      void authenticate(linkToken)
        .then(unlock)
        .catch(() => undefined);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [unlock]);

  const lock = useCallback(async () => {
    setDrawerOpen(false);
    // before signOut: the unsubscribe call needs the cookie, and a locked device must stop
    // receiving pane titles
    await removePushSubscription().catch(() => undefined);
    setPushOn(false);
    resetPushHealth();
    try {
      await signOut();
    } catch {
      throw new Error(t("Could not sign out. Try again."));
    } finally {
      // The response may have been lost after the cookie was cleared.
      await loadHealth();
    }
  }, [loadHealth, t]);

  const { selectedMachineRef, selectTarget, selectTargetRef, picks } = useSelectTarget({ selectedMachineId, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setDrawerOpen, setOutputStopped, setNotificationViewTarget, setTerminalPeek, pendingLink, pendingFile, setLinkLanded, selectionHint, selectionSince, rosterSeq, snapshot, selectedMachine, selectedPaneId, setHeaderNote, linkTick, movingPanes });

  const { selectPane } = useSelectPane({ pendingLink, pendingFile, setLinkLanded, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, setDrawerOpen });

  const layoutRefused = useLayoutRefused(setLayoutNotice, t);
  const moveRefused = useMoveRefused(setLayoutNotice, t);
  // a pane's title dropped on another pane's title of its tab (useSplitLayout's drop)
  const swapPanes = (dragged: SplitTarget, targetPaneId: string): void => {
    void swapPaneWith(dragged.paneId, targetPaneId, dragged.machineId).then((swap) => {
      if (!swap.changed) {
        const reason = swap.reason === "cross_tab" ? t("The panes are in different tabs.")
          : swap.reason === "same_pane" ? t("Choose two different panes.")
          : swap.reason === "not_found" ? t("A pane is no longer available.")
          : swap.reason === "no_neighbor" ? t("There is no pane on that side.")
          : t("Something went wrong. Try again.");
        setLayoutNotice(t("Pane swap was refused: {reason}", { reason }));
      }
      void load();
    }).catch((err) => layoutRefused("pane swap failed", err));
  };

  const { takeNotificationTargetRef } = useNotificationTargets({ machinesRef, selectTargetRef, selectionHint, pendingLink, pendingFile, setLinkLanded, linkSince, rosterSeq, setLinkTick, load });


  const { selectedPane } = useSelectedPane({ snapshot, selectedPaneId });
  useScreenWakeLock(settings.keepScreenOn && locked === false && selectedPane !== null);
  const { selectedWorkspace, presentedPaneId } = useSelectedLayout({ selectedPane, snapshot, drawerOpen, selectedMachineId, selectedPaneId, setSelectedPaneId, setAutoSelected });
  // the selected pane has a tab strip to rename in: its pane and workspace are in the roster
  const tabStripMounted = selectedPane !== null && selectedWorkspace !== null;
  const targetHerdr = selectedMachineId === "local" ? health?.herdr : selectedMachine?.herdr;
  // the herdr the header names as current: this PC's last answer only while it is still shown (through one
  // failed read, not once unavailable), though its capabilities stay in targetHerdr
  const shownHerdr = selectedMachineId === "local" ? shownHealth?.herdr : targetHerdr;
  const selectedTitle = selectedPane ? displayPaneTitle(selectedPane) : null;
  // the tab that governs the pane region, so the strip's tabs and the pane they select are
  // one thing to a screen reader (A4); null while no tab owns this pane
  const tabPanelLabel = paneTabPanelLabel(snapshot, selectedPane, t);
  const selectedAgent = selectedPane?.agent ?? null;
  // a herdr not heard from yet (or a server that predates the flag) counts as attach-capable; a failed
  // health read keeps this PC's last answer (lib/healthPresentation.ts)
  // a server that repaints the pane's screen instead (terminal_mirror) has a terminal lens too
  const terminalAttach = targetHerdr?.terminal_attach !== false || targetHerdr?.terminal_mirror === true;

  const { lenses, view } = usePaneLens({ settings, selectedPaneId, selectedMachineId, selectedPane, selectedAgent, terminalAttach, notificationViewTarget, setNotificationViewTarget, lens, setLens, viewPicks, terminalPeek, setTerminalPeek });

  const contentKey = paneContentKey(selectedMachine, selectedPane, view);
  const { dialogCover, contentReady } = usePaneCoverage({ contentKey });
  const paneInFront = useCallback(() => locked === false && linkLanded && pendingFile.current === null && pendingCreate.current === null
    && !drawerOpen && !settingsOpen && !newSessionOpen
    && !filesOpen && !machineDialog && !paletteOpen && !diffViewing && !(viewing && !fileDocked)
    && !dialogCover && !paneCovered()
    && contentReady && paneContentPresented(contentKey),
  [locked, linkLanded, drawerOpen, settingsOpen, newSessionOpen, filesOpen, machineDialog, paletteOpen, diffViewing, viewing, fileDocked, dialogCover, contentReady, contentKey]);
  // one source for the sidebar's two lists: live counters per PC and finishes looked at here
  const activity = useSidebarActivityState(machines, selectedMachineId, presentedPaneId, paneInFront, shareSeen);

  const { pickView, setView } = usePaneViewPicks({ setViewPicks, setNotificationViewTarget, setTerminalPeek, setLens, setAutoSelected, selectedPaneId, selectedMachineId });
  const { unsentFor, openUnsent, closeUnsent, recover } = useUnsentRecovery({ selectedMachineId, selectedPaneId, setView, pickView });
  // on a phone a peek is a step of its own: Back takes the chat back, as it closes a sheet. It stays
  // up under a sheet or Settings opened over it: their close, or a Back, comes back to the peek
  usePhoneSheetBack(() => endPeek(), terminalPeek !== null, true);

  const { otherMachine, otherPane, splitOn, sameTabs, otherWorkspace, otherHerdr, otherAttach, activateSlot, closeSlot, selectInSlot, dockSide, splitDragOn, paneDragOver, paneDragLeave, paneDrop } = useSplitLayout({ machines, split, wideScreen, selectedPaneId, selectedPane, selectedMachineId, splitShownRef, health, machineRosterLoaded, endSplit, otherRecheck, otherRosterTick, setSplit, soloSlot, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setOutputStopped, splitRef, selectPane, paneAreaRef, dropAtRef, clearDropPreview, tabDrag, showDropTarget, setPaneDragging, movingPanes, draggedPaneRef, markSwap, swapPanes });

  useAddressBar({ newSessionOpen, selectedPane, selectedPaneId, selectedWorkspace, viewing, selectedMachineId, releaseFile, locked, machines, snapshot, linkLanded, view, settingsOpen, settingsPage, settingsLinkPage, settingsLinkSection, wideScreen, sidebarCollapsed, newTab, newFields, autoSelected, pendingFile, selectedMachine, openFile, machinesRef, selectTargetRef, pendingLink, setLinkLanded, linkSince, rosterSeq, setNewSessionOpen, pendingCreate, setHeaderNote, selectionRef });


  const { bell, bellVisible, alertsOffDot } = alertsBell({ t, settings, alertsOn, notifications, pushOn, enableNotifications, disableNotifications });
  const connWord = t(connected ? "live" : outputStopped ? "disconnected" : connectedBefore ? "reconnecting" : "connecting");
  const crumb = selectedPane && selectedTitle !== null
    ? headerCrumb({ machine: selectedMachine?.name ?? selectedMachineId, machineCount: machines.length, workspace: selectedWorkspace?.label ?? selectedPane.workspace_id, title: selectedTitle, cwd: selectedPane.cwd })
    : null;

  useEffect(() => {
    document.title = selectedTitle ? `${selectedTitle} · Ovis` : APP_TITLE;
  }, [selectedTitle]);

  // A new tab's workspace: the named one, else the selected pane's. Its folder is the workspace's:
  // a worktree's checkout, else where the pane in front (the selected one, else the one herdr has
  // in front, else the first) is. Read from refs, so the actions keep no stale roster.
  const newTabTarget = (target?: { machineId: string; workspaceId: string }) => {
    const machineId = target?.machineId ?? selectionRef.current.machineId;
    const roster = machinesRef.current.find((m) => m.id === machineId)?.snapshot;
    // pane ids repeat across PCs: the selected pane counts only on the PC the tab is for
    const selectedPaneId = selectionRef.current.machineId === machineId ? selectionRef.current.paneId : null;
    const workspaceId = target?.workspaceId ?? roster?.panes.find((pane) => pane.pane_id === selectedPaneId)?.workspace_id;
    const workspace = roster?.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
    if (!roster || !workspace) return null;
    const panes = roster.panes.filter((pane) => pane.workspace_id === workspace.workspace_id);
    const inFront = panes.find((pane) => pane.pane_id === selectedPaneId)
      ?? panes.find((pane) => pane.pane_id === roster.layouts?.find((layout) => layout.tab_id === workspace.active_tab_id)?.focused_pane_id)
      ?? panes[0];
    return { machineId, workspace, cwd: workspace.worktree?.checkout_path ?? inFront?.cwd ?? null, agent: inFront?.agent ?? null, panes };
  };

  const actions = useMemo<AppActions>(
    () => ({
      selectPane,
      selectAdjacentPane: (direction) => {
        // the panes the sidebar lists: a step never lands on a viewer it leaves out
        const panes = rosterPanes(snapshotRef.current?.panes ?? [], selectedPaneId);
        if (panes.length === 0) return;
        const index = panes.findIndex((pane) => pane.pane_id === selectedPaneId);
        const next = panes[(index + direction + panes.length) % panes.length];
        if (next) selectPane(next.pane_id);
      },
      setView,
      // a peek shows the terminal over the chat: the shortcut takes the chat back, the lens stays Chat
      toggleView: () => { if (terminalPeek !== null) endPeek(); else setView(view === "chat" ? "terminal" : "chat"); setDrawerOpen(false); },
      focusInput: () => paneControls.current?.focusInput(),
      scrollPage: (direction) => paneControls.current?.scrollPage(direction),
      openNewSession: () => {
        setDrawerOpen(false);
        setNewSessionMachineId(selectedMachineId);
        setNewTab(null);
        setNewSessionOpen(true);
      },
      openNewTab: (target) => {
        const found = newTabTarget(target);
        if (!found) return;
        const { machineId, workspace, cwd } = found;
        setDrawerOpen(false);
        setNewSessionMachineId(machineId);
        setNewTab({ workspaceId: workspace.workspace_id, workspaceLabel: workspace.label, cwd, number: workspace.tab_count + 1 });
        setNewSessionOpen(true);
      },
      renameTab: () => {
        if (selectedPaneId === null || !tabStripMounted) return;
        setDrawerOpen(false);
        requestRename(selectedMachineId, selectedPaneId);
      },
      openTerminalTab: async (target) => {
        const found = newTabTarget(target);
        if (!found) return;
        const asked = selectionRef.current;
        const created = await createTab({ workspace_id: found.workspace.workspace_id, cwd: found.cwd, label: null, agent: null }, found.machineId);
        void load();
        // what the user went to while herdr answered is theirs to keep
        if (selectionStill(asked, selectionRef.current)) selectTargetRef.current(found.machineId, created.pane_id);
      },
      moveTabToWorkspace: async ({ machineId, tabId, workspaceId, notice }) => {
        const roster = machinesRef.current.find((m) => m.id === machineId)?.snapshot;
        const from = roster?.panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null;
        const moving = from === null ? null : paneStorageId(machineId, from);
        if (moving !== null) movingPanes.current.add(moving);
        try {
          const moved = await moveTabToWorkspace(tabId, workspaceId, machineId);
          if (from === null) return;
          // what was typed into the pane and not sent goes to its new ID with it (lib/paneMove.ts)
          carryPaneState(machineId, from, moved.pane_id);
          // the pane changed its ID with its workspace: wherever the old one is still shown, in either half,
          // the view goes with it. A pane the user went to meanwhile is theirs to keep
          const open = splitRef.current;
          if (open && sameTarget(open.other, { machineId, paneId: from })) setSplit({ ...open, other: { machineId, paneId: moved.pane_id } });
          const now = selectionRef.current;
          if (now.machineId === machineId && now.paneId === from) selectTargetRef.current(machineId, moved.pane_id);
        } catch (err) {
          if (notice) moveRefused(err);
          throw err;
        } finally {
          if (moving !== null) movingPanes.current.delete(moving);
          void load();
        }
      },
      openSessionHistory: (target) => {
        const found = newTabTarget(target);
        if (!found) return;
        // a pane's own agent, or nothing; for a workspace, the agent named, else the pane in front's, else any of it
        const agent = sessionHistoryListAgent(target, found.agent, found.panes.map((pane) => pane.agent));
        if (agent === null) return;
        // Claude's list prefers a pane running Claude, so a selected shell never hides its store.
        const selected = selectionRef.current.machineId === found.machineId ? selectionRef.current.paneId : null;
        const tabs = machinesRef.current.find((m) => m.id === found.machineId)?.snapshot?.tabs ?? [];
        const tabNumber = (tabId: string) => tabs.find((tab) => tab.tab_id === tabId)?.number ?? Number.MAX_SAFE_INTEGER;
        const askingPaneId = target?.paneId ?? null;
        const paneId = sessionHistorySourcePane(agent, [...found.panes].sort((one, other) => tabNumber(one.tab_id) - tabNumber(other.tab_id)), { workspaceId: found.workspace.workspace_id, askingPaneId, selectedPaneId: selected });
        setDrawerOpen(false);
        setSessionHistory({ machineId: found.machineId, workspaceId: found.workspace.workspace_id, agent, paneId, askingPaneId, selectedPaneId: selected });
      },
      openPalette,
      agentStarted: (machineId, paneId) => lenses.startedAgent(lensOwner(machineId, paneId), window.matchMedia?.("(pointer: coarse)").matches === true),
      openFind: () => {
        if (selectedPaneId === null) return;
        // a peek already shows the pane's terminal: find searches it there, and the peek (its return,
        // and the lens and address under it) stays
        if (terminalPeek?.paneId !== selectedPaneId || terminalPeek.machineId !== selectedMachineId) setView("terminal");
        setDrawerOpen(false);
        setFindRequest((request) => ({ paneId: selectedPaneId, serial: request.serial + 1 }));
      },
      openSettings: () => {
        setDrawerOpen(false);
        setSettingsSection(null);
        setSettingsOpen(true);
      },
      openAddPc: () => {
        // the new PC reports its progress in the sidebar: nothing should sit over it
        setSettingsOpen(false);
        setUpdateRemote(false);
        addPcFocusReturn.current = true;
        setMachineDialog("new");
      },
      toggleSidebar: () => {
        if (window.matchMedia("(max-width: 768px)").matches) setDrawerOpen((open) => !open);
        else setSidebarCollapsed((collapsed) => !collapsed);
      },
      openSidebarFilter,
      toggleTheme: () => updateSettings({ theme: resolvedTheme === "dark" ? "light" : "dark" }),
      lock: canSignOut ? lock : null,
      enableNotifications: bellVisible && bell.run === enableNotifications ? () => void enableNotifications() : null,
      refresh: () => void load(),
      openFiles: selectedPaneId !== null ? () => { setDrawerOpen(false); setFilesOpen(true); } : null,
      // herdr's layout calls on the selected pane (components/TabStrip.tsx has the same for the
      // tab's own menu): the new layout reaches every client as session-changed, so only a
      // refusal is left to say, and that is logged as other background failures are
      splitPane: selectedPaneId !== null ? (direction, focus = false) => {
        const asked = selectionRef.current;
        if (asked.paneId === null) return;
        void splitPane(asked.paneId, direction, focus, asked.machineId)
          .then((pane) => {
            void load();
            // herdr focused the new pane: the app follows, unless another pane or PC was opened
            // while herdr answered (over SSH, say): what the user went to is theirs to keep
            if (focus && selectionStill(asked, selectionRef.current)) selectPane(pane.pane_id);
          })
          .catch((err) => layoutRefused("pane split failed", err));
      } : null,
      zoomPane: selectedPaneId !== null ? (mode) => {
        const { machineId, paneId } = selectionRef.current;
        if (paneId === null) return;
        void zoomPane(paneId, mode, machineId).then(() => void load()).catch((err) => layoutRefused("pane zoom failed", err));
      } : null,
    }),
    [selectPane, selectedPaneId, selectedMachineId, tabStripMounted, setView, view, terminalPeek, endPeek, updateSettings, resolvedTheme, canSignOut, lock, bellVisible, bell.run, enableNotifications, load, layoutRefused, moveRefused, lenses, openSidebarFilter],
  );

  useShortcuts(actions, locked === false);

  // The header's More menu: what used to be three buttons of its own. Each item is there under
  // the condition its button had. At phone width the palette's button gives its room to the
  // pane's title, and the menu's first item opens the palette.
  useMachineGone({ machines, pendingLink, pendingFile, selectedMachineRef, linkSince, selectionSince, rosterSeq, setLinkLanded, setHeaderNote, selectTargetRef, rosterTick, linkTick });
  // the PCs this device shows in its sidebar, Agents list and palette (Settings → Remote PCs); every other
  // use of the roster keeps them all, so a link, an alert or a split still reaches a hidden PC's pane
  const sidebarMachines = useShownMachines({ machines, selectedMachineRef, selectTargetRef, picks, restored: !linkSelects(initialLink) });

  // a link to the New workspace dialog opens it once the PCs are in; one for a tab, once the
  // linked workspace's pane is selected (its folder is the workspace's, as the tab strip's + does)
  const [createTick, setCreateTick] = useState(0);
  useEffect(() => {
    const linked = pendingCreate.current;
    if (linked === null || !linkLanded || machines.length === 0 || newSessionOpen) return;
    if (linked.kind === "tab" && !selectedPane) return;
    pendingCreate.current = null;
    const fields = { cwd: linked.cwd, name: linked.name, agent: linked.agent };
    setNewPrefill(fields);
    setNewFields(fields);
    if (linked.kind === "tab") actions.openNewTab({ machineId: selectedMachineId, workspaceId: selectedPane!.workspace_id });
    else { setNewSessionMachineId(selectedMachineId); setNewTab(null); setNewSessionOpen(true); }
  }, [linkLanded, machines.length, newSessionOpen, selectedPane, selectedMachineId, actions, createTick]);
  // Forward onto an entry the dialog was open on: the popstate above leaves it pending
  useEffect(() => {
    const onPop = (): void => setCreateTick((tick) => tick + 1);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const { closeNewSession, closeSessionHistory, recentResumes, rememberResume, sessionHistoryWorkspace } = useSessionHistoryList({ machines, sessionHistory, setSessionHistory, setNewSessionOpen, setNewPrefill, setNewFields });

  // the palette's shortcut, said beside its item where a hardware keyboard is likely (a fine pointer)
  const keyboardLikely = useMediaQuery("(hover: hover) and (pointer: fine)");
  const paletteKeys = keyboardLikely ? formatKeys(shortcutDisplayKeys("palette", settings.shortcutOverrides)).join("+") : "";
  const moreItems: RowMenuItem[] = [
    // first at every width: a phone's header has no palette button, and a touch screen no shortcut
    { id: "palette", label: t("Search panes and actions"), icon: Search, ...(paletteKeys ? { hint: paletteKeys } : {}), run: () => openPalette() },
    ...(selectedPane && !selectedPane.restore_error ? [{ id: "find", label: t("Find in terminal"), icon: Search, run: actions.openFind }] : []),
    // from 769px Files has its own button beside the lens switch; a phone keeps it here
    ...(selectedPane && !wideScreen ? [{ id: "files", label: t("Browse files"), icon: FolderOpen, run: () => setFilesOpen(true) }] : []),
    // the address says where the app is (lib/deepLink.ts); a phone has no address bar to copy it from
    { id: "copy-link", label: t("Copy link"), icon: Link, run: () => void copyText(window.location.href).then((ok) => { if (ok) setHeaderNote("copied"); }) },
    ...(bellVisible ? [{ id: "alerts", label: t("Alerts"), hint: bell.state, checked: bell.on, title: bell.title, icon: Bell, run: () => void bell.run() }] : []),
  ];

  // the chat's surface is what the pane column shows: the header's pane zone and the tab strip
  // take it (from 769px). A pane herdr could not restore draws a placeholder, not the chat.
  const chatShown = showsChat(selectedPane, view);

  if (locked === null) {
    // the auth state is unknown until /api/health or /api/session answers (ten seconds when
    // herdr is down): show the shell without the terminal, and so without a WebSocket,
    // instead of a blank page
    return (
      <div className="app">
        <header className="app-header">
          <Brand />
        </header>
        <div className="app-body">
          <aside className="sidebar">
            <ConnectingNote />
          </aside>
          <main className="terminal-host">
            <div className="terminal-placeholder">
              <div className="terminal-placeholder-inner">
                <span>{t("Connecting to Ovis…")}</span>
              </div>
            </div>
          </main>
        </div>
      </div>
    );
  }
  if (locked) return <AccessGate reason={lockReason} initialCode={pairCode} onUnlocked={unlock} />;

  return (
    <MachineSessionsProvider machineIds={machines.map((machine) => machine.id)}><MachineContext.Provider value={selectedMachineId}><div className={`app${sidebarCollapsed ? " sidebar-collapsed" : ""}`} style={sidebarWidth === null && filePanelWidth === null ? undefined : {
      ...(sidebarWidth === null ? {} : { "--sidebar-user-w": `${sidebarWidth}px` }),
      ...(filePanelWidth === null ? {} : { "--file-panel-user-w": `${filePanelWidth}px` }),
    } as CSSProperties}>
      <header className={`app-header is-zoned${chatShown ? " is-chat" : ""}`}>
        {/* is-zoned tells this header from the connecting shell's, which has no zones to draw.
            .header-side is the sidebar's own top row from 769px (styles.css); below that its
            buttons sit in the bar */}
        <div className="header-side">
          <button
            type="button"
            className="icon-button drawer-toggle"
            aria-label={t(drawerOpen ? "Close workspace list" : "Open workspace list")}
            aria-expanded={drawerOpen}
            aria-controls="workspace-drawer"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            {drawerOpen ? <X /> : <Menu />}
          </button>
          <button
            type="button"
            className="icon-button header-desktop-only sidebar-toggle"
            aria-label={t(sidebarCollapsed ? "Show workspace list" : "Hide workspace list")}
            aria-pressed={!sidebarCollapsed}
            title={t("Toggle sidebar (⌘⇧B)")}
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            <PanelLeft />
          </button>
          <button type="button" className="icon-button palette-button" aria-label={t("Command palette")} title={t("Command palette (⌘⇧K)")} onClick={() => openPalette()}>
            <Search />
          </button>
        </div>
        <HeaderNote note={note} />
        {note !== null ? null : selectedPane && crumb ? (
          <div className="context" title={crumb.tooltip}>
            <div className="context-title">
              {selectedAgent && <AgentMark agent={selectedAgent} size={18} />}
              <span className="context-title-text">{selectedTitle}</span>
            </div>
            <div className="context-sub">
              {/* one PC needs no name: the sidebar leaves it out too, and More still says it */}
              {crumb.showMachine && <><span className="machine-context-name">{crumb.machine}</span><span className="context-sep" aria-hidden="true">›</span></>}
              <span>{crumb.workspace}</span>
              {crumb.folder !== null && (
                <>
                  <span className="context-sep" aria-hidden="true">›</span>
                  <span>{crumb.folder}</span>
                </>
              )}
            </div>
          </div>
        ) : (
          <><Brand /><span className="machine-context-name">{selectedMachine?.name ?? selectedMachineId}</span></>
        )}
        {selectedPane && (
          <div className="segmented view-switch" role="group" aria-label="Pane view">
            <button type="button" aria-pressed={view === "chat"} onClick={() => { setView("chat"); setDrawerOpen(false); }} title={t("Chat transcript (⌘⇧J)")}>
              <MessageSquare />
              <span className="header-desktop-only">{t("Chat")}</span>
            </button>
            <button type="button" aria-pressed={view === "terminal"} onClick={() => { setView("terminal"); setDrawerOpen(false); }} title={terminalAttach ? t("Live terminal (⌘⇧J)") : t("Live terminal: coming to Windows PCs once herdr can attach there")}>
              <SquareTerminal />
              <span className="header-desktop-only">{t("Terminal")}</span>
              {!terminalAttach && <span className="pill pill-soon">{t("soon")}</span>}
            </button>
          </div>
        )}
        {selectedPane && wideScreen && (
          <>
            {/* opens Files, it is no third lens: set apart from the switch by a hairline */}
            <span className="header-divider" aria-hidden="true" />
            <button type="button" className="icon-button header-files-button" aria-label={t("Browse files")} title={t("Browse files")} onClick={() => setFilesOpen(true)}>
              <FolderOpen />
            </button>
          </>
        )}
        <div className="header-meta">
          <ConnectionChip
            connected={connected}
            word={connWord}
            title={[connected ? null : connWord, shownHerdr ? t("herdr {version} · protocol {protocol}", { version: shownHerdr.version, protocol: shownHerdr.protocol }) : null].filter((part) => part !== null).join(" · ") || undefined}
          />
          {/* the Host's herdr is away: the step to take is on that PC (the sidebar's state line says the same) */}
          {/* this PC's herdr is told by its health reads: one failed read is unknown, a second unavailable, and
              neither is proof that herdr stopped. Another PC's is told by its bridge (the roster) */}
          {selectedMachineId !== "local"
            ? !targetHerdr && <span className="pill pill-offline">{t("herdr offline")}</span>
            : localFreshness === "unknown"
              ? <span className="pill pill-stale" title={health ? t("The last health check failed. Last seen: herdr {version} · protocol {protocol}", { version: health.herdr.version, protocol: health.herdr.protocol }) : t("The health check failed")}>{t("Status unknown")}</span>
              : localFreshness === "unavailable" && <span className="pill pill-offline" title={t("Start herdr on this PC, or check HERDR_SOCKET.")}>{t("herdr unavailable")}</span>}
          <span className="header-more">
            <button
              type="button"
              className="icon-button header-more-button"
              aria-label={alertsOffDot ? t("More · alerts are off") : t("More")}
              title={alertsOffDot ? t("More · alerts are off") : t("More")}
              aria-haspopup="menu"
              aria-expanded={more !== null}
              onClick={(event) => {
                const anchor = event.currentTarget;
                setMore((open) => (open ? null : { anchor }));
              }}
            >
              <Ellipsis />
            </button>
            {alertsOffDot && <span className="header-more-dot" aria-hidden="true" />}
          </span>
        </div>
        {more && (
          <RowMenu
            anchor={more.anchor}
            title={t("More")}
            header={crumb ? (
              <div className="header-more-crumb">
                <span>{crumb.place}</span>
                {crumb.path !== null && <span className="header-more-path">{crumb.path}</span>}
              </div>
            ) : undefined}
            items={moreItems}
            onClose={closeMore}
          />
        )}
      </header>

      <div className="app-body">
        <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}`}>
          {error && <div className="error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => void load()}>{t("Retry")}</button></div>}
          {/* a sidebar that cannot be drawn leaves the panes working */}
          <RenderBoundary resetKey={null} fallback={(retry) => <RegionCrash message={t("The sidebar can't be shown.")} retry={retry} />}>
            <CrashProbe region="sidebar" />
            <ReorderContext.Provider value={reorderCoordinator}><MachineSidebar machines={sidebarMachines} hiddenCount={machines.length - sidebarMachines.length} watching={auth?.role === "watch"} drawerOpen={drawerOpen} filterRequest={sidebarFilterRequest} selectedMachineId={selectedMachineId} selectedPaneId={selectedPaneId} activity={activity} actions={actions} onSelect={selectTarget} onSetup={(machine, update = false) => { setUpdateRemote(update); setMachineDialog(machine); }} onNew={(id) => { setNewSessionMachineId(id); setNewTab(null); setNewSessionOpen(true); setDrawerOpen(false); }} /></ReorderContext.Provider>
          </RenderBoundary>
          <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
        </aside>

        {/* kept on the page closed (styles.css): a swipe that begins on it closes the drawer */}
        <div className={`scrim${drawerOpen ? " is-open" : ""}`} aria-hidden="true" onClick={() => setDrawerOpen(false)} />

        {/* a file path in the chat opens in the viewer, relative to the selected pane's folder */}
        <OpenFileContext.Provider value={selectedPaneId !== null ? viewFile : null}>
        <WebPanelContext.Provider value={filePanelAvailable ? openWebPage : null}>
        <div className={`pane-column${chatShown ? " is-chat" : ""}`}>
        {/* over the pane only: a bar across the window would cut the sidebar off from its top row in the header */}
        <UpdateNotice updates={updates} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <TelemetryNotice enabled={locked === false} onOpen={() => { setSettingsSection("updates"); setSettingsOpen(true); }} />
        <MachineActionBanner machines={machines} onSetup={(machine, update = false) => { setDrawerOpen(false); setUpdateRemote(update); setMachineDialog(machine); }} />
        {layoutNotice && <p className="pane-notice" role="alert">{layoutNotice}</p>}
        {shownHealth?.lan_exposure && <LanExposureNotice host={shownHealth.lan_exposure.host} onOpen={() => { setSettingsLinkPage("devices"); setSettingsOpen(true); }} />}
        <PushHealthNotice onRepair={repairNotifications} onOpen={() => { setSettingsLinkPage("alerts"); setSettingsOpen(true); }} />
        {pairedNotices.length > 0 && <DevicePairedNotice events={pairedNotices} onDismiss={dismissPairedNotice} onOpen={(event) => { dismissPairedNotice(event); setSettingsLinkPage("devices"); setSettingsOpen(true); }} />}
        {/* the pane's tab, or two tabs side by side (lib/split.ts): a tab dragged down out of its strip,
            or a sidebar row dragged over this area, opens its pane in the half it is dropped on */}
        <div ref={paneAreaRef} className={`pane-split${splitOn ? " is-split" : ""}`} onDragEnterCapture={paneDragOver} onDragOverCapture={paneDragOver} onDragLeave={paneDragLeave} onDropCapture={paneDrop}>
          {(["a", "b"] as const).map((slot) => {
            // one pane: the solo slot, or a split's active half where the window is too narrow for both
            if (!splitOn && slot !== (split ? split.active : soloSlot)) return null;
            const active = !splitOn || split!.active === slot;
            const machineId = active ? selectedMachineId : split!.other.machineId;
            const paneId = active ? selectedPaneId : split!.other.paneId;
            const machine = active ? selectedMachine : otherMachine;
            const herdr = active ? targetHerdr : otherHerdr;
            const pane = active ? selectedPane : otherPane;
            const workspace = active ? selectedWorkspace : otherWorkspace;
            const slotSnapshot = active ? snapshot : otherMachine?.snapshot ?? null;
            const attach = active ? terminalAttach : otherAttach;
            const lensOf = (item: HerdrPane): PaneView => active && item.pane_id === selectedPaneId ? view
              : storedView(lenses, viewPicks, item.pane_id, machineId, item.agent != null, attach);
            const slotView = active ? view : pane ? lensOf(pane) : "terminal";
            const onSelect = active ? selectPane : (id: string, focusInput = true) => selectInSlot(slot, machineId, id, focusInput);
            // one pane's panel keeps the page's own id, whichever slot draws it
            const slotPanelId = !splitOn || slot === "a" ? PANE_TABPANEL_ID : `${PANE_TABPANEL_ID}-${slot}`;
            const slotPanelLabel = active ? tabPanelLabel : paneTabPanelLabel(slotSnapshot, pane, t);
            // a peek shows this half's terminal over its chat: the half's lens button says the chat,
            // and takes it back, as the palette's toggle and Mod+Shift+J do
            const slotPeek = active && pane ? peekFor(terminalPeek, slot, machineId, pane.pane_id) : null;
            const shownView: PaneView = slotPeek !== null ? "terminal" : slotView;
            const toggleSlotView = (): void => {
              if (slotPeek !== null) { endPeek(slotPeek); return; }
              const next = slotView === "chat" ? "terminal" : "chat";
              if (active) setView(next); else if (pane) pickView(machineId, pane.pane_id, next);
            };
            // a half's own lens and close sit at the end of its tab strip. The row's free end is the
            // half's grip: its pane, dropped on a half of the pane area, opens there too (dockSide)
            const slotEnd = splitOn ? <div className="pane-slot-grip" draggable={paneId !== null}
              onDragStart={(event) => {
                if (paneId === null) return;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId }));
              }}>
              {machines.length > 1 && <span className="pane-slot-machine">{machine?.name ?? machineId}</span>}
              {pane && <button type="button" className="icon-button pane-slot-action" aria-label={t(shownView === "chat" ? "Show the terminal" : "Show the chat")} title={t(shownView === "chat" ? "Show the terminal" : "Show the chat")} onClick={toggleSlotView}>
                {shownView === "chat" ? <SquareTerminal /> : <MessageSquare />}
              </button>}
              <button type="button" className="icon-button pane-slot-action" aria-label={t("Close this half")} title={t("Close this half")} onClick={() => closeSlot(slot)}>
                <X />
              </button>
            </div> : undefined;
            // a half with no strip to carry its close (its pane gone, or the half crashed) keeps one in a bar of its own
            const slotBar = splitOn ? <div className="pane-slot-bar"><span className="pane-slot-title">{pane ? displayPaneTitle(pane) : t("Pane closed")}</span>{slotEnd}</div> : null;
            return (
              <MachineContext.Provider key={slot} value={machineId}><SlotSessions slot={slot} machineIds={machines.map((item) => item.id)}><PaneFollowContext.Provider value={sameTabs && !active}>
              <div
                className={`pane-slot${showsChat(pane, slotView) ? " is-chat" : ""}${splitOn ? active ? " is-active" : " is-inactive" : ""}`}
                data-slot={slot}
                data-machine={machineId}
                data-side={splitOn ? slotSide(split!, slot) : undefined}
                // a press or the focus in the other half makes it the active one, before the press acts;
                // its own bar's buttons (its lens, its close) act on it as it is. A menu the half opened
                // is portaled out of it: a press or a focus there reaches these handlers through React but
                // is not in the half, and activating would close the menu before its item's click lands
                onPointerDownCapture={active ? undefined : (event) => {
                  if (!event.currentTarget.contains(event.target as Node)) return;
                  if (event.button === 0 && !paneContextPress(event, apple) && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot);
                }}
                onFocusCapture={active ? undefined : (event) => { if (event.currentTarget.contains(event.target as Node) && Date.now() - lastKeyAtRef.current < KEY_FOCUS_MS && !(event.target as Element).closest(".pane-slot-action")) activateSlot(slot, true); }}
                // a file or text dropped into the other half is for its pane: an upload's paths and the pasted
                // text reach only the active half's terminal, so the drop makes the half active first
                onDropCapture={active ? undefined : (event) => { if (!event.dataTransfer.types.includes(PANE_DRAG_TYPE)) activateSlot(slot); }}
              >
                {/* a pane this half cannot draw leaves the sidebar and the other half working; picking
                    another pane tries again */}
                <RenderBoundary resetKey={`${machineId}:${paneId ?? ""}`} fallback={(retry) => <>{slotBar}<RegionCrash message={t("This pane can't be shown.")} retry={retry} onShown={active ? paneLost : undefined} /></>}>
                <CrashProbe region="pane" />
                {!(slotSnapshot && pane && workspace) && slotBar}
                {slotSnapshot && pane && workspace && (
                  <TabStrip snapshot={slotSnapshot} workspace={workspace} selectedPane={pane} panelId={slotPanelId} splitDrag={wideScreen} onSelectPane={onSelect} end={slotEnd}
                    renameRequest={active && renameRequest?.machineId === machineId && renameRequest.paneId === pane.pane_id ? renameRequest : null}
                    onRenameHandled={clearRenameRequest}
                    onNewTab={() => actions.openNewTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id })}
                    onNewTerminal={() => actions.openTerminalTab(active ? undefined : { machineId, workspaceId: workspace.workspace_id })}
                    onMoveToWorkspace={(tabId, workspaceId) => actions.moveTabToWorkspace({ machineId, tabId, workspaceId })}
                    paneActions={active ? (paneId) => {
                      const target = snapshot?.panes.find((item) => item.pane_id === paneId);
                      if (!target || !paneActionsRef.current) return [];
                      // the strip renders before the canvas, so its items come from the canvas's previous render:
                      // an action runs against the canvas's latest one, where a snapshot change has landed
                      return paneActionsRef.current(target).map((item) => ({ ...item, run: () => (paneActionsRef.current?.(target).find((fresh) => fresh.id === item.id) ?? item).run() }));
                    } : undefined} />
                )}
                {/* the tab strip's panel: its id is what each tab's aria-controls points at, one per half.
                    No tabIndex - the terminal (PaneTerminal) and the composer are the focusable things inside it. */}
                <main className="terminal-host">
                  <div id={slotPanelId} className="terminal-tabpanel" role={slotPanelLabel === null ? undefined : "tabpanel"} aria-label={slotPanelLabel ?? undefined}>
                  <PaneCanvas key={machineId} snapshot={slotSnapshot} pane={pane} selectedPaneId={paneId} onSelect={onSelect} onChanged={actions.refresh} actionsRef={active ? paneActionsRef : undefined}
                    mirrored={herdr?.terminal_attach === false || herdr?.terminal_mirror === true}
                    onOpenInHalf={wideScreen ? (id, side) => dockSide({ machineId, paneId: id }, side) : undefined}
                    onRecoverUnsent={(target) => openUnsent({ machineId, pane: target })}
                    renderPane={(item, itemActive, herdrSplit) => <OpenFileContext.Provider value={item ? (path) => openFile({ path, paneId: item.pane_id, machineId }) : null}>
                      <PaneTerminal
                         onOpenDiff={openDiff}
                        presentationKey={paneContentKey(machine, item, item ? lensOf(item) : slotView)}
                        finishEpoch={machine?.snapshot?.finish_epoch}
                        finishId={item?.finish_id}
                        title={item ? displayPaneTitle(item) : active ? selectedTitle : null}
                        // Wait for the roster before attaching: the loading placeholder is replaced
                        // by the keyed tile, and must never claim the pane on a throwaway connection.
                        paneId={item?.restore_error ? null : item?.pane_id ?? null}
                        terminalId={item?.terminal_id ?? null}
                        mirrored={herdr ? herdr.terminal_attach === false || herdr.terminal_mirror === true : null}
                        restoreError={item?.restore_error ?? null}
                        agent={item?.agent ?? null}
                        agentStatus={item?.agent_status}
                        backgroundTasks={item?.background_tasks ?? 0}
                        // an offline PC's cached plan cannot be read
                        plan={machine?.state === "connected" ? (item as HerdrPane | undefined)?.plan ?? null : null}
                        backgroundWait={item?.background_wait === true}
                        cwd={item?.cwd ?? null}
                        workspaceId={item?.workspace_id ?? null}
                        worktreeRepo={worktreeRepoName(item === null ? undefined : slotSnapshot?.workspaces.find((workspace) => workspace.workspace_id === item.workspace_id))}
                        machineName={machine?.name ?? machineId}
                        view={item ? lensOf(item) : slotView}
                        // the composer's way to the terminal: the selected pane's lens, or the pane's own remembered one
                        onOpenTerminal={item ? () => { if (active && item.pane_id === selectedPaneId) setView("terminal"); else pickView(machineId, item.pane_id, "terminal"); } : undefined}
                        // a terminal command's peek, for the active half's selected pane alone (lib/terminalPeek.ts)
                        peek={active && item?.pane_id === selectedPaneId ? peekFor(terminalPeek, slot, machineId, item.pane_id) : null}
                        onPeek={active && item && item.pane_id === selectedPaneId && attach ? (request: PeekRequest) => setTerminalPeek({ ...request, slot, machineId, paneId: item.pane_id }) : undefined}
                        onEndPeek={endPeek}
                        // /resume lists the pane's own agent's sessions, and only for an agent whose store is read
                        onOpenHistory={item && sessionHistoryAgent(item.agent) !== null ? () => actions.openSessionHistory({ machineId, workspaceId: item.workspace_id, agent: item.agent, scope: "pane", paneId: item.pane_id }) : undefined}
                        // the composer's new-agent button: the New tab dialog on this pane's workspace, as the tab menu opens it
                        onOpenNewSession={item ? () => actions.openNewTab({ machineId, workspaceId: item.workspace_id }) : undefined}
                        // the other half never takes the keyboard: a press in it makes it active first
                        active={active && itemActive}
                        // the paging shortcuts reach the selected pane of the active half only
                        controls={active && itemActive ? paneControls : undefined}
                        findRequest={active && findRequest.paneId === item?.pane_id ? findRequest.serial : 0}
                        autoSelected={active ? autoSelected : true}
                        terminalFontSize={settings.terminalFontSize}
                        split={herdrSplit || splitOn}
                        terminalWheelSpeed={settings.terminalWheelSpeed}
                        terminalFontFamily={settings.terminalFontFamily}
                        theme={resolvedEntry.mode}
                        palette={resolvedEntry.id}
                        onConnectionChange={active && itemActive ? (next, before) => { setConnected(next); setConnectedBefore(before); if (next) setOutputStopped(false); } : undefined}
                        onServerMessage={active && itemActive ? handleServerMessage : undefined}
                      />
                    </OpenFileContext.Provider>} />
                  </div>
                </main>
                </RenderBoundary>
              </div>
              </PaneFollowContext.Provider></SlotSessions></MachineContext.Provider>
            );
          })}
          <SplitDropPreview visible={splitDragOn && (paneDragging || tabDrag !== null)} side={dropAt} />
        </div>
        </div>
        </WebPanelContext.Provider>
        </OpenFileContext.Provider>
        {/* last in the row: the file beside the pane (from 980px), the pane column shrinks and its terminal refits */}
        {viewing !== null && fileDocked && <MachineContext.Provider value={viewing.machineId}>
          <FileViewer key={viewing.path} docked panelStart={<FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} />} path={viewing.path} paneId={viewing.paneId} onClose={closeFile} onOpen={(path) => openFile({ ...viewing, path, presentation })} onKind={reportFileKind} onTogglePresentation={toggleFilePresentation} keyboardActive={!settingsOpen} />
        </MachineContext.Provider>}
        {webPage !== null && filePanelAvailable && !(viewing !== null && fileDocked) &&
          <WebPanel key={webPage} url={webPage} onClose={() => setWebPage(null)} panelStart={<FilePanelResizer width={filePanelWidth} onResize={setFilePanelWidth} />} />}
      </div>

      <MachineContext.Provider value={newSessionMachineId}><NewSessionDialog
        key={newSessionMachineId}
        machineName={machines.find((m) => m.id === newSessionMachineId)?.name ?? newSessionMachineId}
        worktrees={machines.find((m) => m.id === newSessionMachineId)?.snapshot?.workspaces.flatMap((workspace) => workspace.worktree?.is_linked_worktree ? [workspace.worktree.checkout_path] : []) ?? []}
        open={newSessionOpen}
        tab={newTab}
        defaultCwd={newSessionMachineId === selectedMachineId ? selectedPane?.cwd ?? null : null}
        prefill={newPrefill}
        onDraft={setNewFields}
        onClose={closeNewSession}
        onCreated={(paneId, agentStarted, messageWaits = false) => {
          closeNewSession();
          if (agentStarted) actions.agentStarted(newSessionMachineId, paneId);
          // the first message waits in the chat's box: the pane opens on it, whatever lens the page would pick
          if (messageWaits) pickView(newSessionMachineId, paneId, "chat");
          selectTarget(newSessionMachineId, paneId);
          void load();
        }}
      /></MachineContext.Provider>
      {sessionHistory && sessionHistoryWorkspace && <MachineContext.Provider value={sessionHistory.machineId}><SessionHistory
        workspace={sessionHistoryWorkspace.workspace}
        panes={sessionHistoryWorkspace.panes}
        agent={sessionHistory.agent}
        sourcePaneId={sessionHistory.paneId}
        askingPaneId={sessionHistory.askingPaneId}
        selectedPaneId={sessionHistory.selectedPaneId}
        recent={recentResumes}
        onClose={closeSessionHistory}
        onSelectPane={(paneId) => { closeSessionHistory(); selectTarget(sessionHistory.machineId, paneId); }}
        onResumed={(opened, session) => {
          closeSessionHistory();
          if (opened.agent_started) {
            rememberResume({ machineId: sessionHistory.machineId, workspaceId: sessionHistory.workspaceId, agent: session.agent, id: session.id, store: session.store, paneId: opened.pane_id });
            actions.agentStarted(sessionHistory.machineId, opened.pane_id);
          }
          selectTarget(sessionHistory.machineId, opened.pane_id);
          void load();
        }}
      /></MachineContext.Provider>}
      {machineDialog && <MachineDialog updateRemote={updateRemote} machine={machineDialog === "new" ? undefined : machineDialog} onClose={closeMachineDialog} onConnected={(id) => { closeMachineDialog(); selectTarget(id, null); void load(); }} />}
      <Droplet onOpen={(machineId, paneId) => {
        // an ended pane's card outlives the pane: the refetch has dropped it, and selecting it attaches nothing
        if (!machinesRef.current.find((m) => m.id === machineId)?.snapshot?.panes.some((p) => p.pane_id === paneId)) return;
        // Files lists the pane it was opened on, and would open its paths on the new one
        setFilesOpen(false);
        selectTargetRef.current(machineId, paneId);
      }} />
      <SettingsDialog machines={machines} auth={auth} herdrVersion={shownHealth?.herdr?.version ?? null} security={security} open={settingsOpen} section={settingsSection} linkPage={settingsLinkPage} linkSection={settingsLinkSection} onPage={onSettingsPage} onClose={closeSettings} onUsageLogin={(paneId) => { closeSettings(); selectTarget("local", paneId, "terminal"); void load(); }} actions={actions} updates={updates} onEnableNotifications={enableNotifications} saveError={settingsSaveError} savePaused={settingsSavePaused} saveRetrying={settingsSaveRetrying} onRetrySave={retrySettingsSave} overPreview={(viewing !== null && !fileDocked) || diffViewing !== null} />
      {filesOpen && selectedPane && (
        <FilesDialog start={selectedPane.foreground_cwd ?? selectedPane.cwd ?? ""} paneId={selectedPane.pane_id} viewing={(viewing !== null && !fileDocked) || diffViewing !== null} onOpenFile={viewFile}
          onOpenDiff={(comparison, file, directory) => openDiff({ machineId: selectedMachineId, paneId: selectedPane.pane_id, directory, ...comparison, path: file.path, oldPath: file.old_path })}
          onBrowseFolders={(path) => actions.openPalette(folderQueryFor(path, null))}
          onClose={() => setFilesOpen(false)} />
      )}
      {diffViewing !== null && <MachineContext.Provider value={diffViewing.machineId}>
        <RepoDiffViewer key={`${diffViewing.scope}:${diffViewing.path}`} target={diffViewing} onClose={closeDiff} onOpenFile={(path) => {
          const docked = filePanelAvailable && openPresentation(path, settings.fileOpen) === "panel";
          if (docked) {
            setFilesOpen(false);
            releaseDiff();
          }
          openFile({ path, paneId: diffViewing.paneId, machineId: diffViewing.machineId }, docked);
        }} keyboardActive={!settingsOpen && (viewing === null || fileDocked)} />
      </MachineContext.Provider>}
      {viewing !== null && !fileDocked && <MachineContext.Provider value={viewing.machineId}>
        <FileViewer key={viewing.path} path={viewing.path} paneId={viewing.paneId} onClose={closeFile} onOpen={(path) => openFile({ ...viewing, path, presentation })} onKind={reportFileKind} onTogglePresentation={toggleFilePresentation} keyboardActive={!settingsOpen} />
      </MachineContext.Provider>}
      {unsentFor && <UnsentTextDialog machines={machines} canRecover={unsentFor.pane.agent != null} onClose={closeUnsent} onRecover={recover} />}
      <CommandPalette key={selectedMachineId} machines={sidebarMachines} onSelect={selectTarget} open={paletteOpen} initialQuery={paletteQuery} onClose={() => setPaletteOpen(false)} snapshot={snapshot} online={selectedMachine?.state === "connected"} selectedPaneId={selectedPaneId}
        // a peek shows the terminal: its toggle says Switch to chat, which ends the peek
        view={terminalPeek !== null ? "terminal" : view} actions={actions} />
      <MarkdownLinkMenu />
    </div></MachineContext.Provider></MachineSessionsProvider>
  );
}
