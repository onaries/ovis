import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readlinkSync, readSync } from "node:fs";
import { open } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ConversationPart } from "../shared/protocol.ts";

type ImagePart = Extract<ConversationPart, { kind: "image" }>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" ? value as RecordValue : {};
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/;
/** The largest picture the image endpoint serves, from any agent's transcript. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const RASTER_TYPES = new Set(Object.values(TYPES));

/** How many bytes a base64 string decodes to, its padding left out. */
export function base64Size(data: string): number {
  return Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

/**
 * The type of a picture a transcript holds inline as base64, by its leading bytes: a raster the
 * chat shows, declared as one, within the size the image endpoint serves. Null for anything else.
 * The parsers and the image endpoint ask the same question, so a page never names a picture the
 * endpoint refuses.
 */
export function inlineImageType(declared: unknown, data: unknown): string | null {
  if (typeof data !== "string") return null;
  return inlineType(declared, data.length, data.slice(0, 16), data.slice(-2));
}

/** inlineImageType from what it reads of the text: its length, its first 16 and its last 2 characters. */
function inlineType(declared: unknown, length: number, head: string, tail: string): string | null {
  if (typeof declared !== "string" || !RASTER_TYPES.has(declared)) return null;
  if (Math.floor(length * 3 / 4) - (tail.endsWith("==") ? 2 : tail.endsWith("=") ? 1 : 0) > MAX_IMAGE_BYTES) return null;
  return imageType(Buffer.from(head, "base64"));
}

/**
 * inlineImageType asked of a text seen a piece at a time and never held whole: `push` each piece in
 * order, then `type` gives the answer inlineImageType gives for the whole text. A picture the endpoint
 * only counts on its way to the one it serves is checked so, in a window's memory.
 */
export class InlinePictureScan {
  #head = "";
  #tail = "";
  #length = 0;
  push(piece: string): void {
    if (this.#head.length < 16) this.#head += piece.slice(0, 16 - this.#head.length);
    this.#tail = (this.#tail + piece.slice(-2)).slice(-2);
    this.#length += piece.length;
  }
  type(declared: unknown): string | null {
    return inlineType(declared, this.#length, this.#head, this.#tail);
  }
}

/** The start of a data URL codexOutputPicture takes: `data:<raster type>;base64,`. */
const DATA_IMAGE_PREFIX = /^data:(image\/(?:png|jpeg|gif|webp));base64,/;

/**
 * codexOutputPicture's check of a data URL seen a piece at a time and never held whole: `push` each
 * piece in order, then `type` gives the type codexOutputPicture gives for the whole URL, or null.
 */
export class DataUrlPictureScan {
  #prefix = "";
  #declared: string | undefined;
  #body = new InlinePictureScan();
  #padding = 0;
  #valid = true;
  push(piece: string): void {
    if (!this.#valid) return;
    let rest = piece;
    if (this.#declared === undefined) {
      const seen = this.#prefix + piece;
      const prefix = DATA_IMAGE_PREFIX.exec(seen);
      if (prefix === null) {
        // the longest prefix is 23 characters: past that, no URL it could start
        if (seen.length >= 32) this.#valid = false;
        else this.#prefix = seen;
        return;
      }
      this.#declared = prefix[1]!;
      this.#prefix = "";
      rest = seen.slice(prefix[0].length);
    }
    // base64 letters, then at most two `=` that end it, as DATA_IMAGE takes it
    if (this.#padding > 0) {
      if (!/^=*$/.test(rest) || this.#padding + rest.length > 2) { this.#valid = false; return; }
      this.#padding += rest.length;
    } else {
      const letters = /^[A-Za-z0-9+/]*/.exec(rest)![0].length;
      const padding = rest.slice(letters);
      if (!/^={0,2}$/.test(padding)) { this.#valid = false; return; }
      this.#padding = padding.length;
    }
    this.#body.push(rest);
  }
  type(): string | null {
    return this.#valid && this.#declared !== undefined ? this.#body.type(this.#declared) : null;
  }
}

/** A picture omp moved out of its transcript: `blob:sha256:<digest of its bytes>`, its bytes in the agent's blob store. */
const OMP_BLOB_REF = /^blob:sha256:([a-f0-9]{64})$/;

/**
 * The digest an omp image block names its picture by, when it is one the chat could show: a raster
 * declared as one, and a ref in omp's own form. Such a block takes a place among its record's
 * pictures whatever its blob holds now, so a blob that goes missing leaves its place empty rather
 * than moving the next picture into it. Null for anything else.
 */
export function ompBlobDigest(declared: unknown, data: unknown): string | null {
  if (typeof declared !== "string" || !RASTER_TYPES.has(declared) || typeof data !== "string") return null;
  return OMP_BLOB_REF.exec(data)?.[1] ?? null;
}

/**
 * The picture an omp blob ref names in the store `blobs`, read and checked as inlineImageType checks
 * an inline one (a raster declared as one, by its leading bytes, at most MAX_IMAGE_BYTES), and only
 * when its bytes hash to the name the transcript gave them: omp names a blob by its digest, so these
 * are exactly the bytes it recorded. The ref is held to omp's own 64 lowercase hex digits, so it
 * never names a path outside the store, and neither the blob nor the store is followed through a link
 * (ompBlobSteps). Null for anything else.
 */
export function ompBlobPicture(blobs: string, declared: unknown, data: unknown): { mediaType: string; bytes: Buffer } | null {
  return finish(ompBlobPictureSteps(blobs, declared, data));
}

/**
 * ompBlobPicture, read in steps a window apart (Steps): the image endpoint gives the event loop its turn
 * between them. `anchor` is the identity the store had when the transcript was authorized
 * (ompBlobAnchor): the blob is read only from that very directory.
 */
export function* ompBlobPictureSteps(blobs: string, declared: unknown, data: unknown, anchor?: string): Steps<{ mediaType: string; bytes: Buffer } | null> {
  const digest = ompBlobDigest(declared, data);
  if (digest === null) return null;
  const picture = yield* ompBlobSteps(blobs, digest, true, anchor);
  return picture?.bytes ? { mediaType: picture.mediaType, bytes: picture.bytes } : null;
}

/**
 * The blob store of an omp transcript and its identity, taken once where the transcript is authorized
 * (the image endpoint, as it resolves the pane's transcript): a blob is then read only from that very
 * directory, whatever the paths above it come to name later. Null when there is no store, or it is
 * no real directory.
 */
export function ompBlobAnchor(blobs: string | null): { path: string; identity: string } | null {
  if (blobs === null) return null;
  const identity = blobStoreIdentity(blobs);
  return identity === null ? null : { path: blobs, identity };
}

/**
 * Steps a windowed reader takes: it yields between two windows of a file, where an async reader gives
 * the event loop its turn (finishAsync) and a synchronous one goes straight on (finish).
 */
export type Steps<T> = Generator<void, T, void>;

/** Runs a reader's steps straight through. */
export function finish<T>(steps: Steps<T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Runs a reader's steps with the event loop running between them, so a large file never holds the bridge for more than a window's work. */
export async function finishAsync<T>(steps: Steps<T>): Promise<T> {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** How much of a blob is read at a time, and all a blob not served costs to check. */
const BLOB_WINDOW = 1024 * 1024;

/**
 * The blob store `blobs` as it is now: its identity when it is a real directory; null when it is
 * missing or a link. omp keeps its store as a directory beside its sessions, so a link there (to
 * another omp's store, or anywhere) names no blob of this one.
 */
function blobStoreIdentity(blobs: string): string | null {
  try {
    const stat = lstatSync(blobs);
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch { return null; }
}

/** The platform openBlob reads blobs on: a test sets another to run the branch it takes there (blobPlatformForTests). */
let blobPlatform: NodeJS.Platform = process.platform;

/** Lets a test run openBlob as on `platform`, or as on this one again (null). */
export function blobPlatformForTests(platform: NodeJS.Platform | null): void {
  blobPlatform = platform ?? process.platform;
}

/** What openBlob opens: the store directory, then the blob in it. */
type BlobOpening = "store" | "blob";
/** Where a test stands around openBlob's opens, to change the store at that moment (aroundBlobOpenForTests). */
let aroundBlobOpen: ((opening: BlobOpening, open: () => number) => number) | null = null;

/** Lets a test run `around` each of openBlob's opens, or stops it (null). */
export function aroundBlobOpenForTests(around: ((opening: BlobOpening, open: () => number) => number) | null): void {
  aroundBlobOpen = around;
}

/**
 * Opens the blob `digest` in the store `blobs` without following a link to either, from the very
 * directory `checked` names (its identity: blobStoreIdentity, or ompBlobAnchor's). On Linux the store
 * is opened first, as a directory and not through a link (O_NOFOLLOW), and held to be that directory
 * and the one `blobs` names (its descriptor's own path, /proc/self/fd); the blob is then opened through
 * that descriptor, so nothing put in the store's place, or above it, a link or another directory, can
 * stand in for it. It needs /proc: a Linux without it serves no omp blob. Node has no
 * descriptor-relative open on macOS or Windows, and a blob opened there by name can come from wherever
 * a path above it is swapped to for that moment: there no omp blob is read at all. A descriptor, or null.
 */
function openBlob(blobs: string, digest: string, checked: string): number | null {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const opened = (opening: BlobOpening, open: () => number) => aroundBlobOpen ? aroundBlobOpen(opening, open) : open();
  if (blobPlatform !== "linux") return null;
  let store: number;
  try { store = opened("store", () => openSync(blobs, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)); } catch { return null; }
  try {
    // the directory opened must be the one checked, not one moved into its place since
    const held = fstatSync(store);
    if (`${held.dev}:${held.ino}` !== checked) return null;
    // a link above the store is followed by the open: the directory opened must be the one named
    if (readlinkSync(`/proc/self/fd/${store}`) !== blobs) return null;
    return opened("blob", () => openSync(`/proc/self/fd/${store}/${digest}`, flags));
  } catch { return null; } finally { closeSync(store); }
}

/**
 * The blob `digest` in the store `blobs`, read a window at a time and hashed as it goes, its type from
 * its leading bytes, its bytes kept only when `keep`. Null unless it is a regular file of at most
 * MAX_IMAGE_BYTES whose bytes hash to `digest` and announce a raster, opened without following a link
 * to it or to its store (openBlob) from the directory `anchor` names (the store as it is now when no
 * anchor is given), and the same one after it was read.
 */
function* ompBlobSteps(blobs: string, digest: string, keep: boolean, anchor?: string): Steps<{ mediaType: string; bytes: Buffer | null } | null> {
  const store = anchor ?? blobStoreIdentity(blobs);
  if (store === null) return null;
  const fd = openBlob(blobs, digest, store);
  if (fd === null) return null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = keep ? Buffer.alloc(stat.size) : null;
    const window = bytes ?? Buffer.alloc(Math.min(stat.size, BLOB_WINDOW));
    const hash = createHash("sha256");
    let type: string | null = null;
    for (let at = 0; at < stat.size;) {
      const offset = bytes === null ? 0 : at;
      const got = readSync(fd, window, offset, Math.min(BLOB_WINDOW, stat.size - at), at);
      if (got === 0) return null;
      const piece = window.subarray(offset, offset + got);
      if (at === 0) type = imageType(piece);
      hash.update(piece);
      at += got;
      if (at < stat.size) yield;
    }
    if (hash.digest("hex") !== digest || blobStoreIdentity(blobs) !== store) return null;
    return type === null ? null : { mediaType: type, bytes };
  } catch { return null; } finally { closeSync(fd); }
}

/** ompBlobPicture's answer for a blob, without holding it: the type, or null when ompBlobPicture would refuse it. */
function ompBlobType(blobs: string, digest: string): string | null {
  return finish(ompBlobSteps(blobs, digest, false))?.mediaType ?? null;
}

/** What ompBlobType answered for a blob, a picture or not, and the file it answered for. */
const ompBlobTypes = new Map<string, { file: string; type: string | null }>();

/**
 * The type of the picture an omp blob ref names now (ompBlobPicture), for a parser naming it. The
 * answer is kept for as long as the blob is the same file, so a page polled again reads a blob once,
 * whether it was a picture or not; a blob that is gone or changed is asked again.
 */
export function ompBlobImageType(blobs: string, declared: unknown, data: unknown): string | null {
  const digest = ompBlobDigest(declared, data);
  if (digest === null) return null;
  // a store that is gone or a link names nothing; the answer is kept for this store and this file
  const store = blobStoreIdentity(blobs);
  if (store === null) return null;
  let file: string;
  try {
    const stat = lstatSync(join(blobs, digest));
    file = `${store}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.mode}`;
  } catch { return null; }
  const key = `${blobs}\0${digest}`;
  const known = ompBlobTypes.get(key);
  if (known?.file === file) return known.type;
  const type = ompBlobType(blobs, digest);
  ompBlobTypes.delete(key);
  ompBlobTypes.set(key, { file, type });
  if (ompBlobTypes.size > 4096) ompBlobTypes.delete(ompBlobTypes.keys().next().value!);
  return type;
}

/** Forget every blob answer kept (forgetTranscriptState). */
export function forgetOmpBlobTypes(): void {
  ompBlobTypes.clear();
}

/**
 * A picture a Codex tool returned in its output, `{ type: "input_image", image_url }` with the bytes
 * inline as a data URL, checked as inlineImageType checks any inline picture. The parser and the image
 * endpoint both read a tool's pictures here. Null for anything else: a remote URL, a path, an svg.
 */
export function codexOutputPicture(value: unknown): { mediaType: string; data: string } | null {
  const part = record(value);
  if (part.type !== "input_image" || typeof part.image_url !== "string") return null;
  const inline = DATA_IMAGE.exec(part.image_url);
  if (inline === null) return null;
  const mediaType = inlineImageType(inline[1], inline[2]);
  return mediaType === null ? null : { mediaType, data: inline[2]! };
}

/** A picture a Codex tool returned: the call its output answers, and its place among that output's pictures. */
export const CODEX_TOOL_IMAGE_REF = /^codex-tool:([A-Za-z0-9_.\-]{1,128}):(\d{1,3})$/;

/** The pictures of a Codex tool's output, in order, each with the type its bytes announce. */
export function codexOutputPictures(output: unknown): { mediaType: string; data: string }[] {
  return Array.isArray(output) ? output.flatMap((value) => codexOutputPicture(value) ?? []) : [];
}
export const CODEX_IMAGE_REF = /^codex-[a-f0-9]{64}$/;

/** Only native user records name attachments; tool output and remote URLs never do. */
function imageValues(entry: RecordValue): string[] {
  const payload = record(entry.payload);
  if (entry.type === "event_msg" && payload.type === "user_message" && (!payload.kind || payload.kind === "plain")) {
    return [payload.local_images, payload.images].flatMap((value) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  }
  if (entry.type !== "response_item" || payload.type !== "message" || payload.role !== "user" || !Array.isArray(payload.content)) return [];
  return payload.content.flatMap((value) => {
    const part = record(value);
    const path = part.type === "input_image" ? part.image_url : part.type === "local_image" ? part.path : null;
    return typeof path === "string" ? [path] : [];
  });
}

function imagePart(value: string): ImagePart | null {
  if (!value || value.includes("\0") || value.length > MAX_IMAGE_BYTES * 4 / 3 + 128) return null;
  const inline = DATA_IMAGE.exec(value);
  if (!inline && /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  const mediaType = inline?.[1] ?? TYPES[extname(value).toLowerCase()];
  if (!mediaType) return null;
  return { kind: "image", media_type: mediaType, ref: `codex-${createHash("sha256").update(value).digest("hex")}` };
}

/** Hash references keep base64 blobs and filesystem paths out of conversation responses. */
export function codexImageParts(entry: RecordValue): ImagePart[] {
  return [...new Set(imageValues(entry))].flatMap((value) => {
    const part = imagePart(value);
    return part === null ? [] : [part];
  });
}

/** Whether `bytes` holds exactly `signature` at `offset`; bytes, not text, so no high bit is dropped. */
function hasBytes(bytes: Buffer, offset: number, signature: string): boolean {
  return bytes.subarray(offset, offset + signature.length).equals(Buffer.from(signature, "latin1"));
}

/** The raster type its leading bytes announce: a signature check, not a decode. */
export function imageType(bytes: Buffer): string | null {
  if (hasBytes(bytes, 0, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (hasBytes(bytes, 0, "\xff\xd8\xff")) return "image/jpeg";
  if (hasBytes(bytes, 0, "GIF87a") || hasBytes(bytes, 0, "GIF89a")) return "image/gif";
  if (hasBytes(bytes, 0, "RIFF") && hasBytes(bytes, 8, "WEBP")) return "image/webp";
  return null;
}

async function imageBytes(value: string, cwd: string): Promise<Buffer | null> {
  const inline = DATA_IMAGE.exec(value);
  if (inline) {
    const bytes = Buffer.from(inline[2]!, "base64");
    return bytes.length <= MAX_IMAGE_BYTES ? bytes : null;
  }
  const file = await open(resolve(cwd, value), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }
}

/** Scan the bound history only, including inherited rollouts but excluding backtracked bytes. */
export async function codexTranscriptImage(segments: { path: string; end: number }[], ref: string, cwd: string): Promise<{ mediaType: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  if (!CODEX_IMAGE_REF.test(ref)) return null;
  for (const segment of segments) {
    if (segment.end === 0) continue;
    const stream = createReadStream(segment.path, { end: segment.end - 1, encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let entry: RecordValue;
        try { entry = record(JSON.parse(line)); } catch { continue; }
        for (const value of imageValues(entry)) {
          if (imagePart(value)?.ref !== ref) continue;
          const bytes = await imageBytes(value, cwd);
          const mediaType = bytes === null ? null : imageType(bytes);
          return bytes && mediaType ? { mediaType, bytes: new Uint8Array(bytes) } : null;
        }
      }
    } catch { return null; }
    finally { lines.close(); stream.destroy(); }
  }
  return null;
}
