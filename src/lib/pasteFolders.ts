/**
 * Where each PC's server puts uploads when `OVIS_PASTE_DIR` moves them out of `<cwd>/.ovis`: its
 * features frame's `paste_dir` (shared/protocol.ts), recorded by lib/machineSession.ts. Knowing it,
 * an upload's path through a folder named like an image file (`/tmp/shots.png backup/`) is read
 * whole by lib/tabLabels.ts and lib/chatImages.ts (#2771). None for a PC that uses `.ovis`, or an
 * older one: their readers keep stopping a spaced path at a word ending in an image's extension.
 */
const folders = new Map<string, string>();

export function setPasteFolder(machineId: string, folder: string | undefined): void {
  if (folder) folders.set(machineId, folder);
  else folders.delete(machineId);
}

export function pasteFolder(machineId: string): string | undefined {
  return folders.get(machineId);
}

/** The folder as a regular expression's literal text, valid with the `u` flag as without it. */
export function folderPattern(folder: string): string {
  return folder.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}
