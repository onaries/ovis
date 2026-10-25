import { join } from "node:path";
import { MAX_PREFERENCES_BYTES, normalizeThemeChange, sharedPreferencesBody, type PreferencesChange, type SharedPreferences } from "../shared/preferences.ts";
import { badRequest, isJsonObject, jsonResponse } from "./http.ts";
import { damagedCopy, readStateDocument, writeStateDocument } from "./state-document.ts";

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** The document a change would make is over MAX_PREFERENCES_BYTES; nothing was kept. */
export class PreferencesTooLarge extends Error {
  constructor() { super(`Shared preferences are at most ${MAX_PREFERENCES_BYTES / 1024} KB`); }
}

/**
 * The preferences every browser of this server shares (shared/preferences.ts), kept in the state
 * directory beside devices.json. One document: a browser sends the settings it changed (and the
 * pins when they changed), laid over what is held, last write wins per setting; the others take
 * the whole document from the event. A change is held, and told, only once it is on disk.
 * The muted panes are always in the document, empty while nothing is muted: a server with none
 * stored reads as none muted, without a write or a new revision, so a browser tells a server that
 * keeps the list from an older one by the list being there. They are stored in a document of their
 * own, muted-panes.json, not in preferences.json: a release from before them rewrites
 * preferences.json whole on its next save (a rollback, a downgrade), and would erase a list kept
 * there. preferences.json keeps the shape every release reads and writes.
 */
export class PreferenceStore {
  private current: SharedPreferences = { revision: 0, settings: {}, muted_panes: [] };
  private readonly path: string;
  private readonly mutesPath: string;
  private readonly listeners = new Set<(preferences: SharedPreferences) => void>();
  /** Until this store has replaced the file, a write reads it again first: it may have been damaged or repaired since. */
  private unsettled = true;
  /** As `unsettled`, for muted-panes.json. */
  private mutesUnsettled = true;

  constructor(stateDir: string) {
    this.path = join(stateDir, "preferences.json");
    this.mutesPath = join(stateDir, "muted-panes.json");
    try {
      const held = this.readDisk();
      if (held) this.current = held;
    } catch (error) {
      // a missing file is a server that has shared nothing yet; an unreadable one is not, and is never written over
      console.error(`Cannot read ${this.path} (${(error as NodeJS.ErrnoException).code ?? "error"}); shared preferences start empty and are not saved until it can be read`);
    }
    try {
      this.current = { ...this.current, muted_panes: this.readMutes() ?? [] };
    } catch (error) {
      console.error(`Cannot read ${this.mutesPath} (${(error as NodeJS.ErrnoException).code ?? "error"}); no pane starts muted and the list is not saved until it can be read`);
    }
  }

  /** The muted panes on disk: [] when there is no list yet, null when the file is damaged. Throws when it cannot be read. */
  private readMutes(): string[] | null {
    const read = readStateDocument(this.mutesPath);
    if (read.kind === "missing") return [];
    const list = read.kind === "json" && isJsonObject(read.value) ? sharedPreferencesBody({ settings: {}, muted_panes: read.value["muted_panes"] })?.muted_panes : undefined;
    if (list === undefined) {
      console.error(`${this.mutesPath} is not a muted panes list; no pane is muted, and the next mute keeps it as ${damagedCopy(this.mutesPath)}`);
      return null;
    }
    return list;
  }

  /** The document on disk: undefined when there is none, null when it is damaged. Throws when it cannot be read. */
  private readDisk(): SharedPreferences | null | undefined {
    const read = readStateDocument(this.path);
    if (read.kind === "missing") return undefined;
    const parsed = read.kind === "json" ? read.value : undefined;
    const body = sharedPreferencesBody(parsed);
    if (body === null) {
      console.error(`${this.path} is ${read.kind === "malformed" ? "not JSON" : "not a preferences document"}; the next change keeps it as ${damagedCopy(this.path)}`);
      return null;
    }
    const revision = isJsonObject(parsed) && Number.isSafeInteger(parsed["revision"]) ? parsed["revision"] as number : 0;
    // the mutes are muted-panes.json's (readMutes): what this document holds of them is left out
    return { revision: Math.max(0, revision), settings: body.settings, ...(body.pins === undefined ? {} : { pins: body.pins }), muted_panes: this.current.muted_panes };
  }

  get(): SharedPreferences { return this.current; }

  set(change: PreferencesChange): SharedPreferences {
    let base = this.current;
    let keepDamaged = false;
    if (this.unsettled) {
      // the file as it is now, not as it was at start: a repair is kept and the change laid over it
      const held = this.readDisk();
      if (held) base = held;
      keepDamaged = held === null;
    }
    change = normalizeThemeChange(base.settings, change);
    const pins = change.pins ?? base.pins;
    // a change that names no list leaves the mutes; an empty list is the last one unmuted
    const muted = change.muted_panes ?? base.muted_panes ?? [];
    const next: SharedPreferences = { revision: base.revision + 1, settings: { ...base.settings, ...change.settings }, ...(pins === undefined ? {} : { pins }), muted_panes: muted };
    if (byteLength(JSON.stringify(next)) > MAX_PREFERENCES_BYTES) throw new PreferencesTooLarge();
    // the revision first: a save that fails there leaves the mutes as they were. One that fails at the
    // list puts the previous preferences.json back, so a refused save leaves nothing on disk that no
    // browser was told of. Two files cannot be swapped as one, so a window stays open, accepted for
    // a settings store: when putting preferences.json back fails too, or the process ends between the
    // two renames, preferences.json keeps the refused change and a restart reads it, although memory
    // and the client were told it failed. Nothing is lost; at worst a refused change comes back.
    const keepDamagedMutes = change.muted_panes !== undefined && this.mutesUnsettled && this.readMutes() === null;
    const { muted_panes: _stored, ...shared } = next;
    writeStateDocument(this.path, `${JSON.stringify(shared, null, 2)}\n`, keepDamaged);
    if (change.muted_panes !== undefined) {
      try {
        writeStateDocument(this.mutesPath, `${JSON.stringify({ muted_panes: muted }, null, 2)}\n`, keepDamagedMutes);
      } catch (error) {
        const { muted_panes: _held, ...before } = base;
        try { writeStateDocument(this.path, `${JSON.stringify(before, null, 2)}\n`, false); }
        catch (restore) { console.error(`Cannot put ${this.path} back after a failed save of ${this.mutesPath}: ${restore instanceof Error ? restore.message : String(restore)}`); }
        throw error;
      }
      this.mutesUnsettled = false;
    }
    // settled only once the whole save is on disk: after a put-back the file is read again first
    this.unsettled = false;
    this.current = next;
    for (const listener of [...this.listeners]) listener(this.current);
    return this.current;
  }

  subscribe(listener: (preferences: SharedPreferences) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** /api/preferences: GET the shared document, PUT a change to it. A watching device's PUT is refused before this (index.ts). */
export async function handlePreferencesRequest(request: Request, store: PreferenceStore): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const tooLarge = () => reply({ error: { code: "too_large", message: new PreferencesTooLarge().message } }, 413);
  if (request.method === "GET") return reply(store.get());
  if (request.method !== "PUT") return reply({ error: { code: "method_not_allowed", message: "Use GET or PUT /api/preferences" } }, 405);
  // a body announced over the limit is refused unread; one that lies about its length is measured
  const announced = Number(request.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_PREFERENCES_BYTES) return tooLarge();
  const text = await request.text();
  if (byteLength(text) > MAX_PREFERENCES_BYTES) return tooLarge();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return badRequest("invalid_json", "The body is not JSON"); }
  const body = sharedPreferencesBody(raw);
  if (body === null) return badRequest("invalid_body", "Send { settings: object, pins?: string[], muted_panes?: string[] }");
  try { return reply(store.set(body)); }
  catch (error) {
    if (error instanceof PreferencesTooLarge) return tooLarge();
    return reply({ error: { code: "preferences_unwritable", message: error instanceof Error ? error.message : String(error) } }, 500);
  }
}
