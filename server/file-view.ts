import { randomBytes } from "node:crypto";
import { type BigIntStats, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, read, readdirSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

import type { FileInfo, FileKind } from "../shared/protocol.ts";
import { filesNamed } from "./files.ts";
import { jsonResponse } from "./http.ts";

/**
 * Opening a file from the browser: the files agents write (a screenshot, a demo video, a
 * PDF, a log) seen on a phone that has no terminal to open them with.
 *
 * Nothing is read into memory to serve a file: the response is `Bun.file`, which Bun
 * streams from disk (sendfile where it can) and answers Range requests for, so a video
 * plays and seeks without the server holding more than its socket buffers. Only the
 * first bytes of a file are read, to tell text from binary. A rendered page's own files and
 * the videos it plays are the exception: they are read only from a descriptor whose opened
 * file was shown to lie where the page may reach (`openAuthorized`).
 *
 * It opens what this server's user can read, which is no more than the terminal the same
 * browser can already type into.
 */

/** A path as agents and people write it: absolute, `~/…`, or relative to the pane's folder. */
export function resolveFilePath(input: string, cwd: string | null): string | null {
  const path = input.trim();
  if (path === "") return null;
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return cwd === null ? null : resolve(cwd, path);
}

const TEXT_TYPES = /^(?:text\/|application\/(?:json|javascript|typescript|xml|x-sh|toml|yaml|x-yaml|sql)|image\/svg\+xml)/;
const SNIFF_BYTES = 8192;

function kindOf(mime: string, path: string): FileKind {
  if (mime === "image/svg+xml") return "image";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (TEXT_TYPES.test(mime)) return "text";
  // no known type (a .log, a dotfile, source without a registered extension): text when
  // its first bytes hold no NUL
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, read).includes(0) ? "binary" : "text";
  } catch {
    return "binary";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const MAX_NAME_MATCHES = 10;

/** The same visible name may be stored composed or decomposed, one folder at a time. */
function pathsByName(path: string): string[] {
  if (!/[^\x00-\x7f]/.test(path)) return [];
  const root = parse(path).root;
  let paths = [root];
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    const next: string[] = [];
    for (const dir of paths) {
      const exact = join(dir, part);
      if (existsSync(exact)) {
        next.push(exact);
        continue;
      }
      if (!/[^\x00-\x7f]/.test(part)) continue;
      try {
        for (const name of readdirSync(dir)) {
          if (name.normalize("NFC") === part.normalize("NFC")) next.push(join(dir, name));
        }
      } catch { /* an unreadable folder has no matches */ }
    }
    paths = next.sort().slice(0, MAX_NAME_MATCHES);
    if (paths.length === 0) return [];
  }
  return paths;
}

/**
 * The file a path means: as written, or — for a relative path that is not there — the one
 * file under the pane's folder whose path ends in it (agents often name `demo.mp4` without
 * `docs/screenshots/`). Several such files come back as candidates to choose from.
 */
export async function locateFile(input: string, cwd: string | null, anyForm = false): Promise<{ info: FileInfo } | { candidates: string[] } | null> {
  const path = resolveFilePath(input, cwd);
  const info = anyForm || path === null ? null : fileInfo(path);
  if (info !== null) return { info };
  if (anyForm && path !== null) {
    const matches = pathsByName(path).map(fileInfo).filter((match) => match !== null);
    if (matches.length === 1) return { info: matches[0]! };
    if (matches.length > 1) return { candidates: matches.map((match) => match.path) };
  }
  const relative = input.trim();
  if (cwd === null || relative === "" || isAbsolute(relative) || relative.startsWith("~") || relative.startsWith("../")) return null;
  if (anyForm && !/[^\x00-\x7f]/.test(relative)) return null;
  const found = (await filesNamed(cwd, relative, 10, anyForm)).map((match) => resolve(cwd, match));
  if (found.length === 1) {
    const only = fileInfo(found[0]!);
    return only === null ? null : { info: only };
  }
  return found.length > 1 ? { candidates: found } : null;
}

/** A relative fallback stays in its own folder, including after following symlinks. */
export async function locateFileInFolder(input: string, folder: string, anyForm = false): ReturnType<typeof locateFile> {
  const relative = input.trim();
  if (isAbsolute(relative) || relative.startsWith("~") || !resolve(folder, relative).startsWith(resolve(folder) + sep)) return null;
  const found = await locateFile(relative, folder, anyForm);
  if (found === null) return null;
  try {
    const root = realpathSync(folder) + sep;
    const paths = "info" in found ? [found.info.path] : found.candidates;
    return paths.every((path) => realpathSync(path).startsWith(root)) ? found : null;
  } catch { return null; /* a missing or unreadable target is not a fallback */ }
}

/** Try every exact place before opening a name stored in another form. */
export async function findFile(input: string, cwd: string | null, scratchFolder: () => Promise<string | null>): ReturnType<typeof locateFile> {
  const exact = await locateFile(input, cwd);
  if (exact !== null) return exact;
  let folder: string | null = null;
  if (cwd !== null && !isAbsolute(input.trim()) && !input.trim().startsWith("~")) {
    folder = await scratchFolder();
    if (folder !== null) {
      const scratch = await locateFileInFolder(input, folder);
      if (scratch !== null) return scratch;
    }
  }
  const found = await locateFile(input, cwd, true);
  if (found !== null) return found;
  return folder === null ? null : locateFileInFolder(input, folder, true);
}

/** What the viewer needs to know about a file, or null when it is not a readable file. */
export function fileInfo(path: string): FileInfo | null {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  const mime = Bun.file(path).type.split(";")[0] || "application/octet-stream";
  return { path, name: basename(path), size: stat.size, modified: stat.mtime.toISOString(), mime, kind: kindOf(mime, path) };
}

/**
 * An HTML page drawn as a page (the report or chart an agent wrote): its own script runs, but in
 * a sandbox without `allow-same-origin`, so it has no origin, no cookie and no storage of this
 * app's, and with no `connect-src` it cannot fetch, open a socket or beacon anything, here or
 * anywhere. It may load pictures, styles, fonts and scripts from https (a page made with a chart
 * library from a CDN draws as it does in any browser), but nothing from this server: an image
 * that loads or fails would tell it which of this PC's files exist. Only this app may frame it.
 * What it takes from its own folder (a screenshot beside the report, its stylesheet and script)
 * is put into the page before it is sent (`pageWithLocalFiles`), so it still asks for nothing.
 * The one exception is a video or sound too large to put into it, which plays from
 * `mediaSource` (`PAGE_MEDIA_PATH`): that path answers only the addresses this render gave out,
 * and only to the client that rendered it.
 */
const pagePolicy = (mediaSource: string | null): string => [
  "sandbox allow-scripts",
  "default-src 'none'",
  // nothing from the web either: the page holds its own folder's files (below), and a script that
  // could reach any https URL could send them there
  "script-src 'unsafe-inline' 'unsafe-eval' data:",
  "style-src 'unsafe-inline' data:",
  "img-src data: blob:",
  mediaSource === null ? "media-src data: blob:" : `media-src data: blob: ${mediaSource}`,
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** A page's own files are put into it up to these sizes; a larger one is left as the page names it. */
const EMBED_FILE_BYTES = 8 * 1024 * 1024;
const EMBED_TOTAL_BYTES = 32 * 1024 * 1024;
/** A page larger than this is sent as it is, without its files put into it. */
const EMBED_PAGE_BYTES = 8 * 1024 * 1024;
/** Distinct URLs a page may name; past this many the rest are left as they are (each is a filesystem lookup). */
const EMBED_REFS = 1_000;

/**
 * Where a rendered page plays a video or sound too large to put into it: a random address per
 * file and render, handed out only by `pageWithLocalFiles` for a file that page names. The page
 * never holds the file (its script cannot read media served to another origin), but its script
 * can read the address from its own `<video src>` and pass it on. So an address plays only for
 * the client address (`authClient`) that rendered the page, only for `PAGE_MEDIA_LIFETIME_MS`
 * from the render, and no longer once that device is revoked or signs out (`forgetPageMedia`).
 * The page's request carries no cookie (it has no origin, and the cookies are SameSite=Strict),
 * so the client address is the one identity the render and the playing share: another device
 * behind the same address (one NAT, one proxy that hides its visitors) shares it too, and a phone
 * whose address changes must reload the page. The shared token is read once at startup, and
 * these addresses live in memory only: the restart that changes the token drops them all.
 */
export const PAGE_MEDIA_PATH = "/api/fs/page-media/";
/** A page media address and nothing else: the one shape `requiresAuth` lets through without a cookie. */
export const PAGE_MEDIA_ROUTE = /^\/api\/fs\/page-media\/[A-Za-z0-9_-]{32}$/;
/**
 * How long an address plays after its render, never extended. A player asks by Range for as long
 * as it plays and seeks, not only to start, so this covers a sitting with the page; past it a
 * reload gives a new address. It is also how long an address a page passed on keeps working.
 */
export const PAGE_MEDIA_LIFETIME_MS = 30 * 60 * 1000;
/** Addresses held at once; past this many the oldest goes. */
const PAGE_MEDIA_ADDRESSES = 4_096;
/** Files one render may play from here; past this many a page's media is left as it is, so one page cannot push out every other page's addresses. */
export const PAGE_MEDIA_PER_RENDER = 50;
/** Who rendered a page: the client address its media must come from, and the paired device (if any) whose revocation ends it. */
export interface PageMediaOwner { client: string | null; device: string | null }
/** What a page may play from here: the policy's media source and who rendered it. */
export interface PageMedia extends PageMediaOwner { source: string }
/** What an address serves: the path its render asked for, under the folders it was allowed then, which file that led to and in what state, and for whom. */
interface PageMediaEntry extends PageMediaOwner { requested: string; roots: readonly string[]; mime: string; expires: number; dev: bigint; ino: bigint; size: number; mtimeNs: bigint }
/** In mint order, which with a fixed lifetime is also expiry order. */
const pageMediaFiles = new Map<string, PageMediaEntry>();

/** A new address (its token) for a file opened and authorized for this render (`openAuthorized`), for this render only. */
function pageMediaUrl(file: Authorized, owner: PageMediaOwner, now = Date.now()): string {
  for (const [old, entry] of pageMediaFiles) {
    if (entry.expires > now && pageMediaFiles.size < PAGE_MEDIA_ADDRESSES) break;
    pageMediaFiles.delete(old);
  }
  const token = randomBytes(24).toString("base64url");
  pageMediaFiles.set(token, { requested: file.requested, roots: file.roots, mime: file.mime, expires: now + PAGE_MEDIA_LIFETIME_MS, dev: file.dev, ino: file.ino, size: file.size, mtimeNs: file.mtimeNs, client: owner.client, device: owner.device });
  return token;
}

/** Drop the addresses a device was given (it was revoked or signed out), or those a client address was given. */
export function forgetPageMedia(owner: { device: string } | { client: string | null }): void {
  for (const [token, entry] of pageMediaFiles) {
    if ("device" in owner ? entry.device === owner.device : entry.client === owner.client) pageMediaFiles.delete(token);
  }
}

/**
 * The media source a page's policy allows, for the address the browser asked this server by;
 * null for a Host that is not a plain host[:port]. Behind a proxy (`cameThroughProxy`) that is
 * the X-Forwarded-Host it passes on, as the scheme is its X-Forwarded-Proto: a proxy that rewrites
 * Host would otherwise write a source the page's relative `<video src>` never matches.
 */
export function pageMediaSource(host: string | null, secure: boolean, forwardedHost: string | null = null): string | null {
  const asked = forwardedHost?.split(",")[0]?.trim() || host;
  if (asked === null || !/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i.test(asked)) return null;
  return `${secure ? "https" : "http"}://${asked}${PAGE_MEDIA_PATH}`;
}

/**
 * The file behind a page's media address, or null when this server never gave it out, it lapsed,
 * another client asks for it, or the file is not the one its render checked. Each request opens
 * the path its render asked for again, authorizes what it opened as the render did
 * (`openAuthorized`), and plays it only while it is still the file, size and modification time
 * the render saw: a folder on the way swapped for a symlink since, the file replaced or written
 * over in place would otherwise serve another one under the address (a new render gives a new
 * address). It is sent from that descriptor (`descriptorBody`), with `request`'s Range.
 */
export function pageMediaResponse(token: string, client: string | null, request: Request | null = null, now = Date.now()): Response | null {
  const entry = pageMediaFiles.get(token);
  if (entry === undefined) return null;
  if (entry.expires <= now) {
    pageMediaFiles.delete(token);
    return null;
  }
  // an address the page passed on plays nowhere else, answered like an address that never existed
  if (entry.client !== client) return null;
  const file = openAuthorized(entry.requested, entry.roots);
  if (file === null) return null;
  if (file.dev !== entry.dev || file.ino !== entry.ino || file.size !== entry.size || file.mtimeNs !== entry.mtimeNs) {
    release(file.fd);
    return null;
  }
  // no CORS and no Cross-Origin-Resource-Policy: the page that plays it has no origin, and its script cannot read it
  const headers = new Headers({
    "content-type": entry.mime,
    "accept-ranges": "bytes",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy": "sandbox; default-src 'none'",
  });
  // RFC 9110 defines a range for GET alone: a HEAD describes the whole file
  const range = request?.method === "GET" ? byteRange(request.headers.get("range"), request.headers.has("if-range"), file.size) : null;
  if (range === "unsatisfiable") {
    release(file.fd);
    headers.set("content-range", `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  const [start, end] = range ?? [0, file.size - 1];
  headers.set("content-length", String(end - start + 1));
  if (range !== null) headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
  const status = range === null ? 200 : 206;
  if (request?.method === "HEAD") {
    release(file.fd);
    return new Response(null, { status, headers });
  }
  return new Response(descriptorBody(file, start, end - start + 1), { status, headers });
}

/**
 * The one range a `Range` header asks for, inclusive, within `size` bytes (RFC 9110 section 14):
 * null for the whole file, which is the answer to no header, to one that comes with `If-Range`
 * (this answer names no validator it could match), and to one this server does not serve (another
 * unit, several ranges, one it cannot read); "unsatisfiable" for a range that starts past the end.
 * An end past the last byte means the last byte.
 */
function byteRange(header: string | null, ifRange: boolean, size: number): [number, number] | "unsatisfiable" | null {
  // an empty file has no byte to send a range of: the whole of it is the answer
  if (header === null || ifRange || size === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (match === null) return null;
  const [first, last] = [match[1]!, match[2]!];
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0 ? "unsatisfiable" : [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) return null;
  if (start >= size) return "unsatisfiable";
  return [start, last === "" ? size - 1 : Math.min(Number(last), size - 1)];
}

const STREAM_CHUNK_BYTES = 256 * 1024;

/**
 * `length` bytes of an authorized file from `start`, read from its descriptor a chunk at a time
 * as the client takes them, never the whole file in memory. Each chunk is followed by a look at
 * the descriptor: a file written over in place since it was authorized (another size or
 * modification time) ends the stream with an error. That cannot see a write that keeps both, nor
 * take back bytes already sent. The descriptor is closed once: at the end, on an error, or when
 * the client goes away (after a read under way returns, so the number is never reused under it).
 */
function descriptorBody(file: Authorized, start: number, length: number): ReadableStream<Uint8Array> {
  let position = start;
  let left = length;
  let reading = false;
  let cancelled = false;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    release(file.fd);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (left === 0) {
        finish();
        controller.close();
        return;
      }
      const buffer = Buffer.allocUnsafe(Math.min(STREAM_CHUNK_BYTES, left));
      reading = true;
      let read: number;
      try {
        read = await (pageFileHooks.read ?? readAt)(file.fd, buffer, position);
        const now = (pageFileHooks.fstat ?? fstatBig)(file.fd);
        if (read === 0 || now.size !== BigInt(file.size) || now.mtimeNs !== file.mtimeNs) throw new Error("the file changed while it was read");
      } catch (error) {
        reading = false;
        finish();
        if (!cancelled) controller.error(error);
        return;
      }
      reading = false;
      if (cancelled) {
        finish();
        return;
      }
      position += read;
      left -= read;
      controller.enqueue(buffer.subarray(0, read));
      if (left === 0) {
        finish();
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
      if (!reading) finish();
    },
  }, { highWaterMark: 0 });
}

const readAt = (fd: number, buffer: Buffer, position: number): Promise<number> => new Promise((done, fail) => {
  read(fd, buffer, 0, buffer.length, position, (error, bytes) => { if (error) fail(error); else done(bytes); });
});

/** A page's relative URL as a path, decoded; null for a URL with a scheme, a host or a rooted path. */
function pageRelative(ref: string): string | null {
  const value = ref.trim();
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.startsWith("\\") || value.startsWith("#")) return null;
  let relative: string;
  try { relative = decodeURIComponent(value.split(/[?#]/)[0]!); } catch { return null; }
  // decoded, it may name a root, a drive or a share (`%5C%5Chost%5Cshare`): on Windows, resolving
  // that would reach out to the share before any check, so it never gets that far
  if (!relative || isAbsolute(relative) || /^[\\/]/.test(relative) || /^[a-z]:/i.test(relative)) return null;
  return relative;
}

/**
 * Where a relative URL of a page leads, in the page's folder or below before symlinks are
 * resolved; null for a URL with a scheme, a host or a rooted path, or anything outside.
 */
function pageTarget(ref: string, folder: string): string | null {
  const relative = pageRelative(ref);
  if (relative === null) return null;
  const target = resolve(folder, relative);
  return target.startsWith(folder + sep) ? target : null;
}

const hiddenBelow = (folder: string, path: string): boolean => path.slice(folder.length + 1).split(sep).some((part) => part.startsWith("."));

/**
 * The first of `roots` (resolved folders) that `file` (a resolved path) lies in, when it has no
 * hidden name below that folder (`.ssh/`, `.env`).
 */
function rootOf(file: string, roots: readonly string[]): string | undefined {
  const root = roots.find((candidate) => file.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep));
  if (root === undefined || hiddenBelow(root.endsWith(sep) ? root.slice(0, -1) : root, file)) return undefined;
  return root;
}

/**
 * Test seams for the steps of `openAuthorized` and the descriptors it hands out, and for the page's
 * own folder (`pageWithLocalFiles`); never set outside tests. `platform` and `uid` stand in for the
 * process's own, `fstat`, `readlink` and `read` for the filesystem calls they name, and the other
 * hooks run at the moment they name.
 */
export const pageFileHooks: {
  platform?: NodeJS.Platform;
  uid?: () => number | undefined;
  pageFolder?: (folder: string) => void;
  pageOpened?: (fd: number) => void;
  afterResolve?: (file: string) => void;
  afterOpen?: (file: string) => void;
  beforeIdentity?: (file: string) => void;
  afterAuthorize?: (requested: string) => void;
  fstat?: (fd: number) => BigIntStats;
  readlink?: (path: string) => string;
  read?: (fd: number, buffer: Buffer, position: number) => Promise<number>;
  opened?: (fd: number) => void;
  closed?: (fd: number) => void;
} = {};

const fstatBig = (fd: number): BigIntStats => fstatSync(fd, { bigint: true });
/** O_NONBLOCK, so a FIFO put where a file was is not waited on; O_NOFOLLOW, so a link put there since the check is not followed. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

function release(fd: number): void {
  closeSync(fd);
  pageFileHooks.closed?.(fd);
}

/** A file a page may read, open: its descriptor, what it was asked as and allowed under, and the file's type, identity, size and modification time. */
interface Authorized { fd: number; requested: string; file: string; roots: readonly string[]; mime: string; dev: bigint; ino: bigint; size: number; mtimeNs: bigint }

/**
 * `requested` opened for a page to read, when what was opened is a file in one of `roots` with no
 * hidden name below it; null for anything else. The checks of the path before it is opened only
 * refuse early: a folder on the way can be swapped between any check of a path and the next, so
 * what decides is the opened file. The path is resolved and checked again once it is open, and it
 * must still name the opened file (the same device and inode), but these are samples of a path
 * too, which a swap timed around each of them passes. So each platform proves it as it can:
 * - Linux: the kernel's own path of the opened file (`/proc/self/fd`) must lie in `roots`, with no
 *   hidden name; a descriptor whose path cannot be read, or whose file was deleted, is refused.
 * - macOS: every folder from the root the file lies in down to its own folder must be a folder,
 *   not a link, owned by this server's user and writable by no group or other user, so only this
 *   user's own processes can swap them, and those can already read what a swap would expose. It
 *   is not a proof against this user's own processes.
 * - Windows: the second resolution and identity check only, and no look at the folders' access
 *   lists: anyone allowed to write to a folder on the way can race them. That is outside the one
 *   user this server serves.
 * - Anywhere else, nothing is authorized.
 * The caller reads only from the descriptor and closes it (`release`).
 */
function openAuthorized(requested: string, roots: readonly string[]): Authorized | null {
  const hooks = pageFileHooks;
  let file: string;
  try {
    file = realpathSync(requested);
    if (rootOf(file, roots) === undefined || !statSync(file).isFile()) return null;
  } catch { return null; }
  hooks.afterResolve?.(file);
  let fd: number;
  try { fd = openSync(file, OPEN_FLAGS); } catch { return null; }
  hooks.opened?.(fd);
  let kept = false;
  try {
    const opened = (hooks.fstat ?? fstatBig)(fd);
    if (!opened.isFile() || opened.ino === 0n) return null;
    hooks.afterOpen?.(file);
    const again = realpathSync(requested);
    const root = rootOf(again, roots);
    if (root === undefined) return null;
    hooks.beforeIdentity?.(again);
    const named = statSync(again, { bigint: true });
    if (named.dev !== opened.dev || named.ino !== opened.ino) return null;
    if (!openedWithin(fd, again, root, roots)) return null;
    hooks.afterAuthorize?.(requested);
    // what is handed out (an address's size, a HEAD's length) is the file as it is once authorized:
    // one written over in place since it was first looked at is refused, not described by that look
    const settled = (hooks.fstat ?? fstatBig)(fd);
    if (settled.dev !== opened.dev || settled.ino !== opened.ino || settled.size !== opened.size || settled.mtimeNs !== opened.mtimeNs) return null;
    kept = true;
    return { fd, requested, file: again, roots, mime: mimeOf(again), dev: opened.dev, ino: opened.ino, size: Number(opened.size), mtimeNs: opened.mtimeNs };
  } catch {
    return null;
  } finally {
    if (!kept) release(fd);
  }
}

/** This platform's proof that the file open at `fd` (found at `file`, under `root`) lies in `roots` (`openAuthorized`). */
function openedWithin(fd: number, file: string, root: string, roots: readonly string[]): boolean {
  const platform = pageFileHooks.platform ?? process.platform;
  if (platform === "linux") {
    let opened: string;
    try { opened = (pageFileHooks.readlink ?? readlinkSync)(`/proc/self/fd/${fd}`); } catch { return false; }
    return !opened.endsWith(" (deleted)") && rootOf(opened, roots) !== undefined;
  }
  if (platform === "darwin") return ownedFolders(root, file, pageFileHooks.uid ? pageFileHooks.uid() : process.getuid?.());
  return platform === "win32";
}

/**
 * Whether the page open at `fd` (whose identity is `opened`) is `file`, its path resolved once before
 * it was opened: on Linux the kernel's path of the descriptor is that path (one that cannot be read, or
 * was deleted, is not); elsewhere that path is a file, not a link, with the descriptor's device and
 * inode, and still resolves to itself (no folder on the way became a link): samples, like the other
 * platforms' checks (`openAuthorized`).
 */
function pageOpenedAs(fd: number, file: string, opened: BigIntStats): boolean {
  if ((pageFileHooks.platform ?? process.platform) === "linux") {
    let path: string;
    try { path = (pageFileHooks.readlink ?? readlinkSync)(`/proc/self/fd/${fd}`); } catch { return false; }
    return path === file;
  }
  const named = lstatSync(file, { bigint: true });
  return named.isFile() && named.dev === opened.dev && named.ino === opened.ino && realpathSync(file) === file;
}

/** Every folder from `root` to `file`'s own is a folder (not a link), owned by `uid`, and writable by no group or other user. */
function ownedFolders(root: string, file: string, uid: number | undefined): boolean {
  if (uid === undefined) return false;
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  const below = dirname(file).slice(base.length).split(sep).filter(Boolean);
  let folder = base === "" ? sep : base;
  for (let index = 0; ; index += 1) {
    let stat;
    try { stat = lstatSync(folder); } catch { return false; }
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o022) !== 0) return false;
    if (index === below.length) return true;
    folder = join(folder, below[index]!);
  }
}

/**
 * The folders besides a page's own that a video it plays may lie in (a network share where
 * recordings are kept), from OVIS_MEDIA_ROOTS: absolute paths joined by the path delimiter.
 * None by default: a page that came with its own symlinks (an unpacked archive, a cloned
 * repository) could otherwise name any of this PC's videos, and whether one plays would tell it
 * that the file exists; in a folder named here, any page may learn that. Read on every render, so
 * a share mounted later counts. On macOS a share owned by another user, or one its group or anyone
 * else may write to, plays nothing (`openAuthorized`).
 */
function mediaRoots(): string[] {
  const roots: string[] = [];
  for (const entry of (process.env["OVIS_MEDIA_ROOTS"] ?? "").split(delimiter)) {
    const path = entry.trim();
    if (!path || !isAbsolute(path)) continue;
    try { roots.push(realpathSync(path)); } catch { /* a share that is not mounted holds nothing to play */ }
  }
  return roots;
}

/**
 * Where a video or sound a page names by a relative URL may be looked for: a URL with no hidden
 * name in it, in the page's folder, or with `roots` anywhere (`openAuthorized` then decides by
 * where the file lies, whether a symlink beside the page leads there or the URL climbs out of its
 * folder, `../clips/take.mp4`). Without `roots` the URL stays in its folder. Null for anything else.
 */
function pageStreamTarget(ref: string, folder: string, roots: readonly string[]): string | null {
  const relative = pageRelative(ref);
  if (relative === null || relative.split(/[\\/]/).some((part) => part.startsWith(".") && part !== "." && part !== "..")) return null;
  const target = resolve(folder, relative);
  return target.startsWith(folder + sep) || roots.length > 0 ? target : null;
}

/** The page's script can read what is put into it, so each element takes only its own kind of
 * file: never a key or a .env named as a picture's source. */
const mimeOf = (file: string): string => Bun.file(file).type.split(";")[0] || "application/octet-stream";
const MEDIA = (mime: string) => /^(?:image|video|audio)\//.test(mime);
const PLAYS = (mime: string) => /^(?:video|audio)\//.test(mime);
const SCRIPT = (mime: string) => mime === "text/javascript" || mime === "application/javascript";
const STYLE = (mime: string) => mime === "text/css";
/** a script element that runs (no type, a JavaScript type, or a module); a data block (`type="text/plain"`) takes no file */
const RUNS = (type: string | null) => type === null || /^\s*(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)?\s*$/i.test(type);

/** All of an open file's bytes as its descriptor read them, or null when it is not the size and modification time it was authorized at, before or after. */
function readWhole(fd: number, size: number, mtimeNs: bigint): Buffer | null {
  const buffer = Buffer.alloc(size);
  for (let at = 0; at < size;) {
    const read = readSync(fd, buffer, at, size - at, at);
    if (read === 0) return null;
    at += read;
  }
  const after = (pageFileHooks.fstat ?? fstatBig)(fd);
  return after.size === BigInt(size) && after.mtimeNs === mtimeNs ? buffer : null;
}

/** A page's own file as the page found it: its type and size, and its bytes once one of its elements took it. */
interface PageAsset { target: string; mime: string; size: number; data: string | null }

/**
 * The page at `path` (any file this server's user can read, as every file the viewer opens), read
 * from one descriptor, with the pictures, media, stylesheets and scripts it takes from its own
 * folder put into it as data: URLs, so the element keeps its attributes (`defer`, `type="module"`,
 * a stylesheet's `media`): the sandbox may ask this server for nothing, and on a paired phone it
 * could not anyway (the device cookie is SameSite=Strict, and a sandboxed page has no origin).
 * Nothing outside the page's folder is read, and each file only from a descriptor
 * `openAuthorized` let through; a URL is resolved once however often it is named. With `media`,
 * a video or sound that does not fit is given an address to play from instead
 * (`PAGE_MEDIA_PATH`, up to `PAGE_MEDIA_PER_RENDER` files), the one thing this server answers the
 * page. Null when the page is not a file of at most `EMBED_PAGE_BYTES`, or changed while it was read.
 */
export function pageWithLocalFiles(path: string, media: PageMedia | null = null): string | null {
  // the page's path is resolved once, before the page is opened (a page that is a link, to the file it
  // leads to), and the page read must be that file, proven from its descriptor (`pageOpenedAs`), never by
  // looking a path up again; its files come from that file's folder: a folder swapped for a link between
  // two lookups would otherwise serve another folder's page, or make it the folder the page's files come from
  let file: string;
  try { file = realpathSync(path); } catch { return null; }
  const folder = dirname(file);
  pageFileHooks.pageFolder?.(folder);
  let html: string;
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  pageFileHooks.pageOpened?.(fd);
  try {
    const page = fstatBig(fd);
    if (!page.isFile() || page.size > BigInt(EMBED_PAGE_BYTES) || !pageOpenedAs(fd, file, page)) return null;
    // and the asked path still leads there: a folder that was a link only while it was looked up, put
    // back since, made that lookup another folder's page
    if (realpathSync(path) !== file) return null;
    const bytes = readWhole(fd, Number(page.size), page.mtimeNs);
    if (bytes === null) return null;
    html = bytes.toString("utf8");
  } catch {
    return null;
  } finally { closeSync(fd); }
  let left = EMBED_TOTAL_BYTES;
  const resolved = new Map<string, PageAsset | null>();
  const streamed = new Map<string, string | null>();
  const roots = media !== null ? mediaRoots() : [];
  // one address per file in this render, however the page names it
  const addresses = new Map<string, string | null>();
  let granted = 0;
  const lookups = () => resolved.size + streamed.size;
  /** the file at `target`, and its bytes when `accepts` takes its type and it fits what is left */
  const asset = (target: string, accepts: (mime: string) => boolean): PageAsset | null => {
    const file = openAuthorized(target, [folder]);
    if (file === null) return null;
    try {
      const found: PageAsset = { target, mime: file.mime, size: file.size, data: null };
      if (!accepts(file.mime) || file.size > EMBED_FILE_BYTES || file.size > left) return found;
      // written over since it was authorized: left as the page names it
      const bytes = readWhole(file.fd, file.size, file.mtimeNs);
      if (bytes === null) return null;
      found.data = bytes.toString("base64");
      return found;
    } finally { release(file.fd); }
  };
  const take = (ref: string | null, accepts: (mime: string) => boolean): PageAsset | null => {
    if (ref === null) return null;
    if (!resolved.has(ref)) {
      const target = lookups() < EMBED_REFS ? pageTarget(ref, folder) : null;
      resolved.set(ref, target === null ? null : asset(target, accepts));
    }
    let found = resolved.get(ref) ?? null;
    if (found === null || !accepts(found.mime) || found.size > EMBED_FILE_BYTES || found.size > left) return null;
    // first named by an element that takes another kind of file: read now
    if (found.data === null) {
      found = asset(found.target, accepts);
      resolved.set(ref, found);
      if (found?.data == null) return null;
    }
    left -= found.size;
    return found;
  };
  const play = (ref: string, owner: PageMedia): string | null => {
    if (!streamed.has(ref)) {
      const target = lookups() < EMBED_REFS ? pageStreamTarget(ref, folder, roots) : null;
      const file = target === null ? null : openAuthorized(target, [folder, ...roots]);
      let address: string | null = null;
      if (file !== null) {
        try {
          if (PLAYS(file.mime)) {
            const key = `${file.dev}:${file.ino}`;
            if (!addresses.has(key)) {
              const token = granted < PAGE_MEDIA_PER_RENDER ? pageMediaUrl(file, owner) : null;
              if (token !== null) granted += 1;
              // absolute, from the same host as the policy's media source, so the two never disagree
              addresses.set(key, token === null ? null : owner.source + token);
            }
            address = addresses.get(key) ?? null;
          }
        } finally { release(file.fd); }
      }
      streamed.set(ref, address);
    }
    return streamed.get(ref) ?? null;
  };
  const embed = (attribute: string, accepts: (mime: string) => boolean, when: (element: HTMLRewriterTypes.Element) => boolean = () => true, streams = false) => ({
    element(element: HTMLRewriterTypes.Element) {
      if (!when(element)) return;
      const ref = element.getAttribute(attribute);
      const file = take(ref, accepts);
      if (file !== null) element.setAttribute(attribute, `data:${file.mime};base64,${file.data}`);
      else if (media !== null && streams && ref !== null) {
        // gone or refused since it was looked up: the src stays as the page wrote it
        const address = play(ref, media);
        if (address !== null) element.setAttribute(attribute, address);
      }
    },
  });
  return new HTMLRewriter()
    .on("img[src]", embed("src", MEDIA))
    .on("source[src]", embed("src", MEDIA, undefined, true))
    .on("video[src]", embed("src", MEDIA, undefined, true))
    .on("video[poster]", embed("poster", MEDIA))
    .on("audio[src]", embed("src", MEDIA, undefined, true))
    .on("script[src]", embed("src", SCRIPT, (element) => RUNS(element.getAttribute("type"))))
    .on('link[rel~="stylesheet" i][href]', embed("href", STYLE))
    .transform(html);
}

/**
 * A file read asked for by another site's page as a picture, script or fetch, not a navigation:
 * a rendered page (which has no origin) naming this server's files to learn which exist, or any
 * other site doing the same where the server lets a request in without a cookie. A navigation (a
 * new tab, a download, Android's PDF "Open" button) and a browser that sends no Fetch Metadata
 * still pass.
 */
export function crossSiteFileRead(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === null || site === "same-origin" || site === "none") return false;
  return request.headers.get("sec-fetch-mode") !== "navigate";
}

/** Whether `fileResponse` can draw this file as a page, given `render`. */
export function isHtmlPage(info: FileInfo): boolean {
  return info.kind === "text" && info.mime === "text/html";
}

/**
 * The file itself. `download` asks the browser to save it. Answers are sandboxed (an HTML
 * or SVG file opened from this origin must not run script with the app's access), and
 * text is served as plain text whatever its extension says it runs as. `render` asks for an
 * HTML page as a page (`pagePolicy`); any other file ignores it. `media`
 * (`pageMediaSource` and who asked) lets that page play its videos too large to put into it.
 */
export function fileResponse(info: FileInfo, download: boolean, render = false, media: PageMedia | null = null): Response {
  const name = encodeURIComponent(info.name);
  const headers = new Headers({
    "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  const page = render && !download && isHtmlPage(info);
  // a PDF is drawn by the browser's own viewer, which refuses a sandboxed document; its
  // scripts stay inside that viewer, never on this origin
  if (page) headers.set("content-security-policy", pagePolicy(media?.source ?? null));
  else if (info.kind !== "pdf") headers.set("content-security-policy", "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'");
  // text shows as text, whatever its extension says it runs as
  const type = page ? "text/html; charset=utf-8" : info.kind === "text" && info.mime !== "image/svg+xml" ? "text/plain; charset=utf-8" : info.mime;
  if (page && info.size <= EMBED_PAGE_BYTES) {
    const html = pageWithLocalFiles(info.path, media);
    // gone, grown past the page limit or written over since it was found
    if (html === null) return jsonResponse({ error: { code: "not_found", message: "no readable file at that path" } }, 404);
    headers.set("content-type", type);
    return new Response(html, { headers });
  }
  const file = Bun.file(info.path, { type });
  return new Response(file, { headers });
}
