/** How the file viewer shows a file. */
export type FileKind = "image" | "video" | "audio" | "pdf" | "text" | "binary";

/**
 * GET /api/fs/stat: a file the viewer can open (GET /api/fs/file streams it). An HTML page is
 * `text` with `mime` "text/html": `/api/fs/file` serves it as plain text, and as the page itself
 * only with `render=1`, in a sandbox with no origin and no network of its own.
 */
export interface FileInfo {
  path: string;
  name: string;
  size: number;
  /** ISO time of the last change */
  modified: string;
  mime: string;
  kind: FileKind;
}

/** The largest text file the viewer edits and saves (`/api/fs/text`), in bytes as stored. */
export const MAX_EDITABLE_TEXT_BYTES = 1024 * 1024;

/**
 * GET /api/fs/text?pane_id=&path=: a text file to edit, for a device that drives this PC (not a
 * watching one, a Portal visitor or an open LAN window; an SSH PC's own bridge token too). Only a
 * file under the pane's folder (its real path, links followed, never in `.git`) that this server's
 * user owns, with one link, at most MAX_EDITABLE_TEXT_BYTES, UTF-8 with no NUL and one kind of line
 * ending. 400 missing_pane / missing_path, 403 outside_pane / drive_only, 404 not_found, 413
 * too_large, 415 not_text / mixed_line_endings, 501 unsupported_platform (only Linux and macOS save).
 */
export interface EditableText {
  /** the file's real path, which a save names */
  path: string;
  /** with LF line endings whatever the file uses (`line_endings`) */
  text: string;
  /** the SHA-256 of the file's bytes (hex), which a save must name */
  revision: string;
  line_endings: "lf" | "crlf";
  size: number;
  modified: string;
}

/**
 * PUT /api/fs/text, application/json: `text` (LF line endings, no CR or NUL) replaces the file that
 * had `revision`, written to a new file beside it that takes its place, with the file's mode, group,
 * line endings, extended attributes and access list. The rules of GET, and the file must be writable
 * (403 not_writable, linked_file, not_owner; access_list when its access list could not be kept).
 * 409 stale_revision (`error.revision`: the file's own now) when it changed since it was read:
 * nothing is written. A change another program makes in the moment between that last
 * look and the replacement is not seen, as with any editor that does not lock the file.
 */
export interface TextSaveRequest {
  pane_id: string;
  path: string;
  revision: string;
  text: string;
}

export interface TextSaved {
  path: string;
  revision: string;
  size: number;
  modified: string;
}

/**
 * GET /api/fs/favicon?root=: the icon the project in folder `root` keeps, or null. The PC looks
 * through every place a project keeps one (`FAVICON_CANDIDATES` in server/project-favicon.ts),
 * best first, each read as /api/fs/stat reads `<root>/<place>`, and answers once: a folder with
 * no icon is `{ icon: null }`, never a 404. 400 missing_root; the access rules of /api/fs/stat
 * (no watching device, no other site's page).
 */
export interface ProjectFavicon {
  /** the image found; `path` opens it through /api/fs/file */
  icon: FileInfo | null;
}
