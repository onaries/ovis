/**
 * Where the selected pane is, as the header says it on its one line: PC › workspace › folder.
 * The folder shows as its last name, and only when nothing beside it already says that name (the
 * title, the PC when the line names it, the workspace): it is what tells two worktrees of one
 * workspace apart, and "api › api" told nobody anything. The full path is not lost: it is in the header's tooltip and
 * the first thing in its More menu, which is where a touch screen reads it.
 */
import { folderName } from "./paneName.ts";

export interface HeaderCrumb {
  machine: string;
  /** whether the line names the PC: one PC needs no name (the sidebar leaves it out too) */
  showMachine: boolean;
  workspace: string;
  /** the folder's last name, or null when another part already says it (or there is no folder) */
  folder: string | null;
  /** "PC › workspace": the More menu's first line */
  place: string;
  /** the folder written out, as herdr reports it: the More menu's second line */
  path: string | null;
  /** complete context for accessible naming: PC, workspace, pane title and full path */
  fullContext: string;
  /** the context's tooltip: complete context for the pane */
  tooltip: string;
}

export function headerCrumb(input: { machine: string; machineCount: number; workspace: string; title: string; cwd: string | null | undefined }): HeaderCrumb {
  const machine = input.machine.trim();
  const workspace = input.workspace.trim();
  const title = input.title.trim();
  // trimmed only to tell an absent folder: a name may end in a space, and is shown as it is
  const path = input.cwd?.trim() ? input.cwd : null;
  const name = path === null ? null : folderName(path);
  // only a name the line shows can have said the folder's: a hidden PC name says nothing
  const showMachine = input.machineCount > 1;
  const said = name === null || [title, showMachine ? machine : null, workspace].includes(name);
  const fullContext = [machine, workspace, title !== workspace ? title : null, path].filter((part): part is string => part !== null && part !== "").join(" · ");
  return {
    machine,
    showMachine,
    workspace,
    folder: said ? null : name,
    place: `${machine} › ${workspace}`,
    path,
    fullContext,
    tooltip: fullContext,
  };
}

/**
 * Whether the pane column draws the chat: the header's pane zone and the tab strip take the
 * chat's surface only then. A pane herdr could not restore draws a placeholder on the terminal's
 * surface whatever the lens, and so does no pane at all.
 */
export function showsChat(pane: { restore_error?: unknown } | null | undefined, view: string): boolean {
  return !!pane && !pane.restore_error && view === "chat";
}
