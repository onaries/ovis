import type { TelemetryAction, TelemetryActionSource, TelemetryCounter } from "../../shared/telemetry.ts";
import type { AppActions } from "./actions.ts";
import { actionsCan, actionUse, tally, usageCounters } from "./usageCounters.ts";

/**
 * what App knows when an action is counted, read at that moment as App holds it: the inbox itself rather than a flag
 * read from it, so the inbox and the mode cannot be passed in each other's place (one is an object, the other a flag)
 */
export interface AppCountingState {
  actions: Pick<AppActions, "splitPane" | "closePane" | "openFiles">;
  machineId: string;
  inbox: { readonly shown: boolean };
  inMode: boolean;
  /** whether a new tab has a workspace to go to */
  tabTarget: boolean;
}

/**
 * App's `counted`: an action taken by `source` is counted when it would do something here, on this PC's own pane where
 * it acts on one (actionUse, actionsCan), and a count that fails stands in nobody's way.
 */
export function appCounted(read: () => AppCountingState, count: (name: TelemetryCounter) => void = (name) => usageCounters.count(name)): (action: TelemetryAction, source: TelemetryActionSource) => void {
  return (action, source) => {
    const state = read();
    const { actions } = state;
    const name = actionUse(action, source, { machineId: state.machineId, can: actionsCan({
      split: actions.splitPane !== null, closePane: actions.closePane !== null, files: actions.openFiles !== null,
      inboxShown: state.inbox.shown, inMode: state.inMode, tabTarget: state.tabTarget,
    }) });
    if (name) tally(() => count(name));
  };
}

/** a pane menu's items as PaneCanvas publishes them */
type PaneItems<T> = ((target: T, options?: { counted?: boolean }) => { id: string; disabled?: boolean; run: () => void }[]) | null | undefined;

/** App's Close pane: the pane menu's own Close, run uncounted (the shortcut or palette row that asked counted it) */
export function closeFromPaneMenu<T>(items: PaneItems<T>, target: T): void {
  items?.(target, { counted: false }).find((item) => item.id === "close" && !item.disabled)?.run();
}

/** More's Browse files: counted as the menu's, and opened even when the count fails */
export function moreFilesRun(counted: AppActions["counted"], open: () => void): () => void {
  return () => { tally(() => counted?.("files", "menu")); open(); };
}
