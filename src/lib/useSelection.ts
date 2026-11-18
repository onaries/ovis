import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import { fetchSession } from "./api.ts";
import { fileFromLink, resolveLink, type AppLink, type LinkNote } from "./deepLink.ts";
import { linkLanding, machineGone, notificationLanding, notificationTargetFromSearch, sameLink, onNotificationTarget, type NotificationTarget } from "./notificationTarget.ts";
import { pageSearch } from "./pageQuery.ts";
import type { TerminalPeek } from "./terminalPeek.ts";
import { markSelection, type SelectionMark } from "./selectionMark.ts";
import { paneAfterClose } from "./paneAfterClose.ts";
import { lastViewedPane } from "./lastViewedPane.ts";
import type { PaneView } from "./actions.ts";
import type { Translate } from "./i18n.ts";
import { storedSelection, storeSelection } from "./useSplitView.ts";

type SelectionHint = { machine: string; pane: string; workspace: string } | null;
type SelectTarget = (machineId: string, paneId: string | null, view?: PaneView) => void;

export function linkSelects(initialLink: AppLink | null): boolean {
  return initialLink !== null && Boolean(initialLink.pane || initialLink.workspace || fileFromLink(initialLink) || initialLink.create);
}

export function useSelectedMachine({ initialLink, machines }: { initialLink: AppLink | null; machines: Machine[] }) {
  const [selectedMachineId, setSelectedMachineId] = useState(() => {
    if (linkSelects(initialLink) && initialLink) return initialLink.machine;
    return storedSelection()?.machine_id ?? "local";
  });
  const selectedMachine = machines.find((m) => m.id === selectedMachineId);
  const snapshot = selectedMachine?.snapshot ?? null;
  return { selectedMachineId, setSelectedMachineId, selectedMachine, snapshot };
}

export function useSelectionState({ initialLink }: { initialLink: AppLink | null }) {
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(() => {
    if (initialLink?.pane) return initialLink.pane;
    if (initialLink && (initialLink.workspace || fileFromLink(initialLink))) return null;
    const stored = storedSelection();
    if (initialLink?.create && stored?.machine_id !== initialLink.machine) return null;
    return stored?.pane_id ?? null;
  });
  const [notificationViewTarget, setNotificationViewTarget] = useState<NotificationTarget | null>(
    () => notificationTargetFromSearch(pageSearch()),
  );
  const [terminalPeek, setTerminalPeek] = useState<TerminalPeek | null>(null);
  const endPeek = useCallback((peek?: TerminalPeek) => {
    setTerminalPeek((current) => peek === undefined || current === peek ? null : current);
  }, []);
  const pendingLink = useRef<AppLink | null>(initialLink && (initialLink.pane || initialLink.workspace || fileFromLink(initialLink)) ? initialLink : null);
  const [linkLanded, setLinkLanded] = useState(() => pendingLink.current === null);
  const rosterSeq = useRef(0);
  const linkSince = useRef(0);
  const selectionSince = useRef(0);
  const [rosterTick, setRosterTick] = useState(0);
  const [linkTick, setLinkTick] = useState(0);
  return { selectedPaneId, setSelectedPaneId, notificationViewTarget, setNotificationViewTarget, terminalPeek, setTerminalPeek, endPeek, pendingLink, linkLanded, setLinkLanded, rosterSeq, linkSince, selectionSince, rosterTick, setRosterTick, linkTick, setLinkTick };
}

export function useLinkLanding({ initialLink, otherRecheck, setOtherRosterTick, pendingLink, rosterSeq, setRosterTick, linkLanded, t }: {
  initialLink: AppLink | null;
  otherRecheck: RefObject<boolean>;
  setOtherRosterTick: Dispatch<SetStateAction<number>>;
  pendingLink: RefObject<AppLink | null>;
  rosterSeq: RefObject<number>;
  setRosterTick: Dispatch<SetStateAction<number>>;
  linkLanded: boolean;
  t: Translate;
}) {
  const rosterIn = useCallback((): void => {
    rosterSeq.current += 1;
    if (pendingLink.current !== null) setRosterTick(rosterSeq.current);
    if (otherRecheck.current) { otherRecheck.current = false; setOtherRosterTick(rosterSeq.current); }
  }, []);
  const pendingFile = useRef<string | null>(initialLink ? fileFromLink(initialLink) : null);
  const selectionHint = useRef<{ machine: string; pane: string; workspace: string } | null>(null);
  const [headerNote, setHeaderNote] = useState<LinkNote | "copied" | null>(null);
  useEffect(() => {
    if (headerNote === null) return;
    const timer = window.setTimeout(() => setHeaderNote(null), headerNote === "copied" ? 1600 : 8000);
    return () => window.clearTimeout(timer);
  }, [headerNote]);
  const note = headerNote
    ? t(headerNote === "copied" ? "Link copied" : headerNote === "pane-closed" ? "That agent has closed: its workspace is open" : headerNote === "machine-missing" ? "That link's PC is not set up here" : "That link's workspace is closed")
    : !linkLanded ? t("Opening link…") : null;
  const [autoSelected, setAutoSelected] = useState(false);
  return { rosterIn, pendingFile, selectionHint, headerNote, setHeaderNote, note, autoSelected, setAutoSelected };
}

export function useSelectionMark({ selectedMachineId, selectedPaneId }: { selectedMachineId: string; selectedPaneId: string | null }) {
  // Marked at commit, not in render: a render React throws away (Strict Mode, a replay) must not move the
  // generation on, and every reader runs from an event or a reply, after the commit
  const selectionRef = useRef<SelectionMark>({ machineId: selectedMachineId, paneId: selectedPaneId, generation: 0 });
  useLayoutEffect(() => {
    selectionRef.current = markSelection(selectionRef.current, selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);
  // panes a tab move has on its way to another workspace (paneStorageId): herdr can drop the old ID
  // from a roster before the move answers with the new one, and until it does neither the selection
  // nor the split's other half falls back from it
  const movingPanes = useRef(new Set<string>());
  return { selectionRef, movingPanes };
}

export function useSelectTarget({ selectedMachineId, setConnected, setConnectedBefore, setSelectedMachineId, setSelectedPaneId, setAutoSelected, setDrawerOpen, setOutputStopped, setNotificationViewTarget, setTerminalPeek, pendingLink, pendingFile, setLinkLanded, selectionHint, selectionSince, rosterSeq, snapshot, selectedMachine, selectedPaneId, setHeaderNote, linkTick, movingPanes, onPick, onLinkMiss }: {
  selectedMachineId: string;
  setConnected: Dispatch<SetStateAction<boolean>>;
  setConnectedBefore: Dispatch<SetStateAction<boolean>>;
  setSelectedMachineId: Dispatch<SetStateAction<string>>;
  setSelectedPaneId: Dispatch<SetStateAction<string | null>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  setOutputStopped: Dispatch<SetStateAction<boolean>>;
  setNotificationViewTarget: Dispatch<SetStateAction<NotificationTarget | null>>;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
  pendingLink: RefObject<AppLink | null>;
  pendingFile: RefObject<string | null>;
  setLinkLanded: Dispatch<SetStateAction<boolean>>;
  selectionHint: RefObject<SelectionHint>;
  selectionSince: RefObject<number>;
  rosterSeq: RefObject<number>;
  snapshot: Machine["snapshot"];
  selectedMachine: Machine | undefined;
  selectedPaneId: string | null;
  setHeaderNote: Dispatch<SetStateAction<LinkNote | "copied" | null>>;
  linkTick: number;
  movingPanes: RefObject<Set<string>>;
  onPick?: (paneId: string | null) => void;
  onLinkMiss?: () => void;
}) {
  const onPickRef = useRef(onPick); onPickRef.current = onPick;
  const onLinkMissRef = useRef(onLinkMiss); onLinkMissRef.current = onLinkMiss;
  const selectedMachineRef = useRef(selectedMachineId);
  selectedMachineRef.current = selectedMachineId;
  const picks = useRef(0);
  const selectTarget = useCallback((machineId: string, paneId: string | null, view?: PaneView) => {
    picks.current += 1;
    onPickRef.current?.(paneId);
    // Only another PC mounts a new terminal (and socket), which reports its own state. A pane
    // on the same PC keeps the connected socket, which never reports again: resetting here
    // left the header on "reconnecting" after every pane switch.
    if (machineId !== selectedMachineRef.current) { setConnected(false); setConnectedBefore(false); }
    setSelectedMachineId(machineId); setSelectedPaneId(paneId); setAutoSelected(false); setDrawerOpen(false);
    setOutputStopped(false);
    setNotificationViewTarget(view && paneId !== null ? { machine_id: machineId, pane_id: paneId, view } : null);
    setTerminalPeek(null);
    // this browser's choice only: herdr's focus, its TUI and every other device stay where they are
    storeSelection(machineId, paneId);
    pendingLink.current = null; pendingFile.current = null; setLinkLanded(true);
    selectionHint.current = null;
    selectionSince.current = rosterSeq.current;
  }, []);
  const selectTargetRef = useRef(selectTarget); selectTargetRef.current = selectTarget;
  const lastSeen = useRef<{ machine: string; pane: string; roster: NonNullable<typeof snapshot>; previous: string | null } | null>(null);
  useEffect(() => {
    // An offline PC's cached roster cannot invalidate a selection.
    if (!snapshot || selectedMachine?.state !== "connected") return;
    const seen = lastSeen.current?.machine === selectedMachineId && lastSeen.current.pane === selectedPaneId ? lastSeen.current : null;
    const fallback = (current: typeof snapshot) => (seen && paneAfterClose(seen.roster, current, seen.pane, seen.previous, (scope, id) => lastViewedPane(scope, selectedMachineId, id)))
      ?? current.panes.find((pane) => pane.pane_id === current.focused_pane_id)?.pane_id ?? current.panes[0]?.pane_id ?? null;
    if (selectedPaneId !== null && snapshot.panes.some((pane) => pane.pane_id === selectedPaneId)) {
      const last = lastSeen.current?.machine === selectedMachineId ? lastSeen.current : null;
      const previous = last && last.pane !== selectedPaneId ? last.pane : (last?.previous ?? null);
      lastSeen.current = { machine: selectedMachineId, pane: selectedPaneId, roster: snapshot, previous };
    }
    const linked = pendingLink.current;
    if (linked && linked.machine === selectedMachineId) {
      const land = (landed: ReturnType<typeof resolveLink>): boolean => {
        pendingLink.current = null;
        setLinkLanded(true);
        if (landed.note) { setHeaderNote(landed.note); onLinkMissRef.current?.(); }
        if (landed.pane) {
          if (landed.pane !== selectedPaneId) {
            setSelectedPaneId(landed.pane);
            setNotificationViewTarget(landed.pane === linked.pane && linked.view ? { machine_id: linked.machine, pane_id: landed.pane, view: linked.view } : null);
          }
          if (landed.pane !== linked.pane) pendingFile.current = null;
          return true;
        }
        if (linked.pane || linked.workspace) pendingFile.current = null;
        return false;
      };
      const landed = resolveLink(snapshot, linked);
      if (!landed.note) {
        if (land(landed)) return;
      } else {
        // The combined roster is cached: a pane made just before the link opened can be missing
        // from it. Ask this PC before saying the link's place has closed.
        let cancelled = false;
        void fetchSession(selectedMachineId).then((current) => ({ current, confirmed: resolveLink(current, linked) }), () => null).then((read) => {
          if (cancelled || pendingLink.current !== linked) return;
          // A failed read is not evidence that anything closed: a pane still selected stays, and the
          // link settles without a word.
          if (read === null) {
            if (selectedPaneId !== null) { land({ pane: null, workspace: null, note: null }); return; }
            if (!land({ ...landed, note: null })) setSelectedPaneId(fallback(snapshot));
            return;
          }
          const { current, confirmed } = read;
          if (land(confirmed)) return;
          if (current.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
          setSelectedPaneId(fallback(current));
          if (selectedPaneId !== null) setAutoSelected(true);
        });
        return () => { cancelled = true; };
      }
    }
    if (snapshot.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
    if (selectedPaneId === null) { setSelectedPaneId(fallback(snapshot)); return; }
    const moving = (): boolean => movingPanes.current.has(paneStorageId(selectedMachineId, selectedPaneId));
    if (moving()) return;
    // The combined roster is cached: a newly created pane can be selected before it
    // appears there. Confirm absence against this PC before discarding the selection.
    let cancelled = false;
    void fetchSession(selectedMachineId).then((current) => {
      if (cancelled || moving() || current.panes.some((pane) => pane.pane_id === selectedPaneId)) return;
      const hint = selectionHint.current;
      selectionHint.current = null;
      if (hint && hint.machine === selectedMachineId && hint.pane === selectedPaneId) {
        const landed = resolveLink(current, { workspace: hint.workspace, workspaceSlug: null, pane: hint.pane });
        if (landed.note) { setHeaderNote(landed.note); onLinkMissRef.current?.(); }
        setNotificationViewTarget(null); setTerminalPeek(null);
        setSelectedPaneId(landed.pane ?? fallback(current));
        setAutoSelected(true);
        return;
      }
      setSelectedPaneId(fallback(current));
      setAutoSelected(true);
    }).catch(() => { /* a failed read is not evidence that the pane disappeared */ });
    return () => { cancelled = true; };
  }, [snapshot, selectedPaneId, selectedMachineId, selectedMachine?.state, linkTick]);
  useEffect(() => {
    storeSelection(selectedMachineId, selectedPaneId);
  }, [selectedMachineId, selectedPaneId]);
  return { selectedMachineRef, selectTarget, selectTargetRef, picks };
}

export function useSelectPane({ pendingLink, pendingFile, setLinkLanded, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, setDrawerOpen, onPick }: {
  pendingLink: RefObject<AppLink | null>;
  pendingFile: RefObject<string | null>;
  setLinkLanded: Dispatch<SetStateAction<boolean>>;
  selectionHint: RefObject<SelectionHint>;
  setSelectedPaneId: Dispatch<SetStateAction<string | null>>;
  setNotificationViewTarget: Dispatch<SetStateAction<NotificationTarget | null>>;
  setTerminalPeek: Dispatch<SetStateAction<TerminalPeek | null>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
  setDrawerOpen: Dispatch<SetStateAction<boolean>>;
  onPick?: () => void;
}) {
  const onPickRef = useRef(onPick); onPickRef.current = onPick;
  const selectPane = useCallback((paneId: string, focusInput = true) => {
    if (focusInput) onPickRef.current?.();
    pendingLink.current = null; pendingFile.current = null; setLinkLanded(true);
    selectionHint.current = null;
    setSelectedPaneId(paneId);
    setNotificationViewTarget(null); setTerminalPeek(null);
    setAutoSelected(!focusInput);
    setDrawerOpen(false);
  }, []);
  return { selectPane };
}

export function useNotificationTargets({ machinesRef, selectTargetRef, selectionHint, pendingLink, pendingFile, setLinkLanded, linkSince, rosterSeq, setLinkTick, load, onLinkWait }: {
  machinesRef: RefObject<Machine[]>;
  selectTargetRef: RefObject<SelectTarget>;
  selectionHint: RefObject<SelectionHint>;
  pendingLink: RefObject<AppLink | null>;
  pendingFile: RefObject<string | null>;
  setLinkLanded: Dispatch<SetStateAction<boolean>>;
  linkSince: RefObject<number>;
  rosterSeq: RefObject<number>;
  setLinkTick: Dispatch<SetStateAction<number>>;
  load: () => Promise<void>;
  onLinkWait?: () => void;
}) {
  const onLinkWaitRef = useRef(onLinkWait); onLinkWaitRef.current = onLinkWait;
  const takeNotificationTarget = useCallback((target: NotificationTarget): void => {
    const wait = (link: AppLink, stale: boolean): void => {
      pendingLink.current = link; pendingFile.current = null; setLinkLanded(false);
      linkSince.current = rosterSeq.current;
      setLinkTick((tick) => tick + 1);
      if (stale) void load();
    };
    // a desktop link lands as the address's own link does: its pane once the roster says it is the
    // link's, and until then no pane at all, only its PC, so nothing draws or attaches a pane it may not mean
    if (target.link) {
      const link = target.link;
      const landing = linkLanding(machinesRef.current, link);
      if (landing.kind === "select") { selectTargetRef.current(link.machine, landing.pane, link.view ?? undefined); return; }
      if (sameLink(pendingLink.current, link)) return;
      selectTargetRef.current(link.machine, null);
      onLinkWaitRef.current?.();
      wait(link, landing.stale);
      return;
    }
    const landing = notificationLanding(machinesRef.current, target);
    if (landing.kind === "select") {
      selectTargetRef.current(target.machine_id, target.pane_id, target.view);
      if (target.workspace_id) selectionHint.current = { machine: target.machine_id, pane: target.pane_id, workspace: target.workspace_id };
      return;
    }
    if (sameLink(pendingLink.current, landing.link)) return;
    selectTargetRef.current(target.machine_id, target.pane_id, target.view);
    wait(landing.link, landing.stale);
  }, [load]);
  const takeNotificationTargetRef = useRef(takeNotificationTarget); takeNotificationTargetRef.current = takeNotificationTarget;
  useEffect(() => onNotificationTarget(takeNotificationTarget), [takeNotificationTarget]);
  return { takeNotificationTarget, takeNotificationTargetRef };
}

export function useSelectedPane({ snapshot, selectedPaneId }: { snapshot: Machine["snapshot"]; selectedPaneId: string | null }) {
  const selectedPane = snapshot?.panes.find((pane) => pane.pane_id === selectedPaneId) ?? null;
  return { selectedPane };
}

export function useSelectedLayout({ selectedPane, snapshot, drawerOpen, selectedMachineId, selectedPaneId, setSelectedPaneId, setAutoSelected }: {
  selectedPane: ReturnType<typeof useSelectedPane>["selectedPane"];
  snapshot: Machine["snapshot"];
  drawerOpen: boolean;
  selectedMachineId: string;
  selectedPaneId: string | null;
  setSelectedPaneId: Dispatch<SetStateAction<string | null>>;
  setAutoSelected: Dispatch<SetStateAction<boolean>>;
}) {
  const selectedWorkspace = selectedPane
    ? (snapshot?.workspaces.find((workspace) => workspace.workspace_id === selectedPane.workspace_id) ?? null)
    : null;
  const selectedLayout = snapshot?.layouts.find((layout) => layout.tab_id === selectedPane?.tab_id);
  const presentedPaneId = !drawerOpen && selectedPane && !selectedPane.restore_error
    && (!selectedLayout?.panes.length || selectedLayout.panes.some((pane) => pane.pane_id === selectedPane.pane_id))
    && (!selectedLayout?.zoomed || selectedLayout.focused_pane_id === selectedPane.pane_id)
    ? selectedPane.pane_id : null;
  useLayoutEffect(() => {
    if (selectedLayout?.zoomed && selectedLayout.focused_pane_id !== selectedPaneId
      && snapshot?.panes.some((pane) => pane.pane_id === selectedLayout.focused_pane_id)) {
      setSelectedPaneId(selectedLayout.focused_pane_id);
      setAutoSelected(true);
    }
    // a pick of another pane of a zoomed tab lands on herdr's zoomed one too: herdr shows only it
  }, [selectedMachineId, selectedPaneId, selectedLayout?.zoomed, selectedLayout?.focused_pane_id]);
  return { selectedWorkspace, selectedLayout, presentedPaneId };
}

export function useMachineGone({ machines, pendingLink, pendingFile, pendingCreate, selectedMachineRef, linkSince, selectionSince, rosterSeq, setLinkLanded, setHeaderNote, selectTargetRef, rosterTick, linkTick }: {
  machines: Machine[];
  pendingLink: RefObject<AppLink | null>;
  pendingFile: RefObject<string | null>;
  pendingCreate: RefObject<import("./deepLink.ts").CreateDraft | null>;
  selectedMachineRef: RefObject<string>;
  linkSince: RefObject<number>;
  selectionSince: RefObject<number>;
  rosterSeq: RefObject<number>;
  setLinkLanded: Dispatch<SetStateAction<boolean>>;
  setHeaderNote: Dispatch<SetStateAction<LinkNote | "copied" | null>>;
  selectTargetRef: RefObject<SelectTarget>;
  rosterTick: number;
  linkTick: number;
}) {
  useEffect(() => {
    const linked = pendingLink.current;
    const machineId = linked ? linked.machine : selectedMachineRef.current;
    const since = linked ? linkSince.current : selectionSince.current;
    if (!machineGone(machines, rosterSeq.current, since, machineId)) return;
    pendingLink.current = null; pendingFile.current = null; pendingCreate.current = null;
    setLinkLanded(true);
    setHeaderNote("machine-missing");
    selectTargetRef.current("local", null);
  }, [machines, rosterTick, linkTick]);
}
