/**
 * The largest file a pane takes as an attachment. The browser checks a file against it before
 * reading or sending any of it, and POST /api/pane/image refuses what is over it. It dates from
 * pasted screenshots; 100 MB takes an archive, a PDF or a short recording too. Raising it is not
 * only this number: the upload is one base64 JSON body the server holds whole (about 4/3 of the
 * file, plus the copy it decodes into), and the route bounds that body itself (server/paste.ts).
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
