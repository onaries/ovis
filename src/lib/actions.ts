/**
 * What the shell lets its surfaces do. App builds one AppActions object and hands it
 * to the header, the sidebar, the command palette and the settings dialog, so a
 * keyboard shortcut, a palette row and a sidebar button all run the same code.
 */

import type { SplitPaneDirection } from "../../shared/protocol.ts";
import type { ZoomMode } from "./layoutMap.ts";
import type { Machine } from "../../shared/machines.ts";

/** what Add a connection → SSH fills the Add PC dialog with: the address to connect to and, where known, a name */
export interface AddPcPreset { destination: string; name?: string }

export type PaneView = "chat" | "terminal";

/** The selected pane’s mounted input and history, bound to its PC. */
export interface PaneControls {
  focusInput: () => void;
  scrollPage: (direction: -1 | 1) => void;
}

export interface AppActions {
  selectPane: (paneId: string) => void;
  /** the previous/next pane in sidebar order; wraps around */
  selectAdjacentPane: (direction: -1 | 1) => void;
  /** the previous/next tab of the selected pane's workspace in tab strip order; wraps around */
  selectAdjacentTab: (direction: -1 | 1) => void;
  /** the selected pane's workspace's tab at `number` (1-based) in tab strip order, as herdr's prefix+1..9; nothing past the last */
  selectTabNumber: (number: number) => void;
  /** the previous/next workspace of the selected PC in sidebar order (pins, worktree groups); wraps around */
  selectAdjacentWorkspace: (direction: -1 | 1) => void;
  setView: (view: PaneView) => void;
  toggleView: () => void;
  /** Focus the selected pane's mounted input without sending any text or keys. */
  focusInput: () => void;
  scrollPage: (direction: -1 | 1) => void;
  openNewSession: () => void;
  /**
   * The New tab dialog for a workspace: the named one (a sidebar row's menu, on its own PC),
   * else the selected pane's. Nothing happens without a workspace to add the tab to.
   */
  openNewTab: (target?: { machineId: string; workspaceId: string }) => void;
  /** The inline name field of the selected pane's tab, as the tab menu's Rename opens it; nothing while the tab strip is not drawn. */
  renameTab: () => void;
  /**
   * A shell tab in the same workspace, at once and with no dialog, as herdr's own new tab: the
   * new pane opens unless another one was opened meanwhile. Rejects with herdr's refusal.
   */
  openTerminalTab: (target?: { machineId: string; workspaceId: string }) => Promise<void>;
  /**
   * A one-pane tab into a new tab at the end of another workspace on its PC, its process running.
   * Where its pane is shown, in either half of a split, the app follows it there, and what was typed
   * into it and not sent goes with it. Rejects with herdr's refusal; `notice` also says it over the
   * pane, for a caller with no line of its own (the palette, which has closed).
   */
  moveTabToWorkspace: (target: { machineId: string; tabId: string; workspaceId: string; notice?: boolean }) => Promise<void>;
  /**
   * The earlier sessions of a workspace's folder (components/SessionHistory.tsx): the named
   * workspace's, listed for `agent` first (a pane's, or the row's), else the selected pane's
   * workspace and agent. A `pane` request lists that agent or opens nothing (lib/sessionHistory.ts
   * sessionHistoryListAgent). Nothing opens without a workspace.
   */
  /** `paneId`: the pane the list is asked for from (a Claude list is that pane's store); else the selected pane, else the first in tab order */
  openSessionHistory: (target?: { machineId: string; workspaceId: string; agent?: string | null; scope?: "pane" | "workspace"; paneId?: string }) => void;
  /**
   * New worktree / Open worktree… for the selected pane's workspace, as its row menu opens them
   * (components/WorktreeDialog.tsx): nothing unless that workspace is a repository's main checkout
   */
  openWorktree?: (mode: "create" | "open") => void;
  /** the palette, blank or opened on `query` (a `>` prefix keeps the actions alone) */
  openPalette: (query?: string) => void;
  /** A pane this page started an agent in opens in an agent's lens, whatever its first snapshot says. */
  agentStarted: (machineId: string, paneId: string) => void;
  openFind: () => void;
  openSettings: () => void;
  /** the Add PC dialog, from Settings → Devices and PCs and the palette; Settings closes first. `preset` fills its address (Add a connection → SSH) */
  openAddPc: (preset?: AddPcPreset) => void;
  /** a PC's own setup dialog (Connect on a PC saved in herdr), from Settings → Devices and PCs; Settings closes first */
  connectPc: (machine: Machine) => void;
  toggleSidebar: () => void;
  /** into the agent inbox (lib/inboxMode.ts) or, while `on`, back out of it; null where the mode is not offered */
  inboxMode: { on: boolean; go: () => void } | null;
  /** the sidebar's Filter field, focused, with the drawer or the sidebar opened first: drawn even where Settings → Appearance leaves it out */
  openSidebarFilter: () => void;
  /** flips dark/light (a `system` setting becomes the opposite of the resolved theme) */
  toggleTheme: () => void;
  /** Sign out of token/device authentication; null for automatic local/Tailscale access. */
  lock: (() => Promise<void>) | null;
  /** null once alerts are on (or unsupported); otherwise asks for permission */
  enableNotifications: (() => void) | null;
  refresh: () => void;
  /** null without a pane: the files of its folder, each opened in the file viewer */
  openFiles: (() => void) | null;
  /** a page this PC serves (lib/webPanel.ts localPageAddress) in the web panel; null unless Web links open in the app */
  openLocalPage: ((url: string) => void) | null;
  /** Search conversation over the selected pane's chat; null where it shows no chat, or its PC's bridge does not search */
  searchConversation: (() => void) | null;
  /**
   * herdr's split beside the selected pane (its prefix+v and prefix+-), null without a pane. The
   * selection stays on this pane, as herdr's --no-focus keeps its focus, unless `focus` asks for
   * the new pane: then herdr focuses it and the app opens it.
   */
  splitPane: ((direction: SplitPaneDirection, focus?: boolean) => void) | null;
  /**
   * herdr's prefix+z on the selected pane, with the mode the caller's item names (`zoomMode`,
   * lib/layoutMap.ts): its tab shows it alone, or every pane again; null without a pane
   */
  zoomPane: ((mode: ZoomMode) => void) | null;
  /**
   * The Zoom pane shortcut: zooms the selected pane, or unzooms it where its tab shows it alone;
   * nothing for a pane alone in its tab. null where zoomPane is
   */
  toggleZoom: (() => void) | null;
  /**
   * The Close pane shortcut and palette row: the selected pane's own menu's Close (PaneCanvas), with
   * its confirmation for a busy pane or a workspace's last one, and nothing for a locked pane. null
   * without a pane and on a watching device
   */
  closePane: (() => void) | null;
  /**
   * The Close tab shortcut and palette row: the open tab's own Close, as its row's menu has it (TabStrip), or the
   * pane's menu where the tab has no row (PaneCanvas), with the same confirmation, and nothing for a tab holding a
   * locked pane. null without a pane and on a watching device
   */
  closeTab: (() => void) | null;
}
