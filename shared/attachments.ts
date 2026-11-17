/**
 * The largest file a pane takes as an attachment. The browser checks a file against it before
 * reading or sending any of it, and POST /api/pane/image refuses what is over it.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
