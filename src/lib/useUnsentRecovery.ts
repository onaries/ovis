import { useCallback, useState } from "react";
import { paneStorageId } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import type { PaneView } from "./actions.ts";
import { composerDrafts } from "./composerDraft.ts";
import { paneLifetimes } from "./paneLifetime.ts";

/**
 * Recover unsent text (components/UnsentText.tsx), opened from a pane's menu for that pane. Put in
 * message box adds the text after what the pane's box holds, never over it and never sent, and
 * shows the pane's chat; false when the box could not save it, or keeps it in this page alone (a PC
 * whose herdr is not proven, lib/paneLifetime.ts), so the record stays until the text is kept.
 */
export function useUnsentRecovery({ selectedMachineId, selectedPaneId, setView, pickView }: {
  selectedMachineId: string;
  selectedPaneId: string | null;
  setView: (next: PaneView) => void;
  pickView: (machineId: string, paneId: string, next: PaneView) => void;
}) {
  const [unsentFor, setUnsentFor] = useState<{ machineId: string; pane: HerdrPane } | null>(null);
  const recover = useCallback((text: string): boolean => {
    if (unsentFor === null) return false;
    const { machineId, pane } = unsentFor;
    const key = `ovis:composer-draft:${paneStorageId(machineId, pane.pane_id)}`;
    composerDrafts.set(key, (current) => current.trim() === "" ? text : `${current}\n\n${text}`);
    if (machineId === selectedMachineId && pane.pane_id === selectedPaneId) setView("chat");
    else pickView(machineId, pane.pane_id, "chat");
    return paneLifetimes.stored(machineId) && !composerDrafts.isUnsaved(key);
  }, [unsentFor, selectedMachineId, selectedPaneId, setView, pickView]);
  return { unsentFor, openUnsent: setUnsentFor, closeUnsent: useCallback(() => setUnsentFor(null), []), recover };
}
