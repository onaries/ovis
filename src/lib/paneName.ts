import { AGENT_CHROME, codexThreadTitle, folderName, SHELL_PREFIX, shortPathTitle, stripPaneChrome } from "../../shared/pane-title.ts";

// shared with the server's push titles, which name a pane as the client's alerts do
export { codexThreadTitle, folderName, shortPathTitle, stripPaneChrome };

/**
 * A pane's live title as the browser tab shows it: as a row's, with the agent's glyph and spinner
 * kept in front. The tab has no row mark or badge, so its title is where a working agent shows it
 * is working (#2568). The rest is shortened as a row's is, so a path after the mark is still its folder.
 */
export function tabTitle(title: string, agent: string | null | undefined): string {
  const rest = shortPathTitle(stripPaneChrome(title, agent));
  const mark = agent ? title.replace(SHELL_PREFIX, "").match(AGENT_CHROME)?.[0] ?? "" : "";
  return rest ? `${mark}${rest}` : "";
}

/**
 * A roster row drawn on two lines: what its pane is doing, and where under it. A shell's title
 * is often just its folder, which says nothing a workspace's name does not say better, so that
 * row leads with the workspace and keeps the second line for what is left to say.
 */
export function taskRowLines({ paneTitle, labelled, folder, workspace, alias }: {
  /** the pane's title as the roster shows it */
  paneTitle: string;
  /** the user named the pane: the name is kept as it is */
  labelled: boolean;
  /** the last folder of the pane's working directory */
  folder: string;
  /** the workspace's row name: its label, which herdr makes from the branch until its owner names it */
  workspace: string;
  /** a linked worktree's branch, when the label does not already say it */
  alias?: string | null;
}): { title: string; place: string } {
  const title = !labelled && paneTitle === folder ? workspace : paneTitle;
  const where = [workspace === title ? "" : workspace, alias && alias !== title && alias !== workspace ? alias : ""].filter(Boolean).join(" · ");
  const said = folder === title || folder === workspace || folder === alias;
  return { title, place: placeLine(where, said ? "" : folder) };
}

/** "workspace · folder", without saying the same name twice. */
export function placeLine(workspace: string, folder: string): string {
  return !folder || folder === workspace ? workspace : !workspace ? folder : `${workspace} · ${folder}`;
}
