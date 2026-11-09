/**
 * A pane is known by its project, not by where it sits on disk. A shell's terminal title is
 * usually its working directory written out ("/home/me/dev/api", "~/dev/api", "C:\\work\\api"):
 * shown whole, it is cut off long before the part that tells panes apart. Such a title shows as
 * its last folder; the full path stays in the row's tooltip. Any other title is left alone.
 */
const PATH_TITLE = /^(?:~(?=$|[\\/])|\/|[A-Za-z]:[\\/])/;

export function shortPathTitle(title: string): string {
  const trimmed = title.trim();
  return PATH_TITLE.test(trimmed) ? folderName(trimmed) : title;
}

/** A path's last folder, split on either platform's separator: "C:\\work\\api" is "api" as "/work/api" is. */
export function folderName(path: string): string {
  const last = path.split(/[\\/]+/).filter((part) => part !== "").at(-1);
  if (last === undefined) return path; // "/" itself
  // a drive root keeps the separator it was written with, so it still reads as a place
  return /^[A-Za-z]:$/.test(last) ? `${last}${path[2] ?? "\\"}` : last;
}

/**
 * Codex titles its terminal "<thread> | <project folder>" (0.162: "Respond to greeting |
 * worktree-rapid-valley..."). The row already says where under the title, in full, so the title
 * keeps the thread alone. A title that is only the place is left as it is.
 */
export function codexThreadTitle(title: string): string {
  const at = title.lastIndexOf(" | ");
  return at > 0 && title.slice(0, at).trim() !== "" ? title.slice(0, at) : title;
}

/** shell prompt titles: `user@host:` is chrome, the path after it is the information */
export const SHELL_PREFIX = /^[^:@\s]+@[^:@\s]+:/;
/** Herdr's agent glyph and spinner are already represented by the row mark and badge. */
export const AGENT_CHROME = /^π\s*[^\p{L}\p{N}\s]?\s*/u;

/**
 * A pane's live title without what is drawn beside it: a shell's `user@host:`, an agent's glyph and
 * spinner, and the folder Codex adds after its thread. `whole` keeps that folder: an alert is read
 * away from the row that says where the pane is.
 */
export function stripPaneChrome(title: string, agent: string | null | undefined, whole = false): string {
  const shellStripped = title.replace(SHELL_PREFIX, "");
  if (!agent) return shellStripped;
  const marked = shellStripped.replace(AGENT_CHROME, "");
  return agent === "codex" && !whole ? codexThreadTitle(marked) : marked;
}
