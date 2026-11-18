/**
 * Paired devices: the per-device credential a phone (or anyone the owner lets in) uses
 * instead of the shared token. The owner starts a pairing on the PC and gets a short code
 * that lives ten minutes; the device sends the code once and receives a token of its own
 * in an HttpOnly cookie. Only a hash of that token is stored, so devices.json in the state
 * dir (0600, written whole, and flushed before it replaces the old list whenever access
 * changes: private-state.ts) reveals nothing if read. Revocation also closes that device's
 * active streams; revoking all is one write of an empty, gated registry, after which every
 * credential (paired, pending or unconfirmed) is void. A device is either allowed to drive
 * (type, answer, manage) or only to watch. A durable enrollment is announced (`onPaired`) once
 * its write succeeded, so every other session can hear of a device it did not pair.
 */
import { createHash, createPublicKey, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AccountRecordError, parseAccountRecord, type AddRecord, type RemoveRecord } from "../shared/account-records.ts";
import { type AccountPairing, type AccountPairingEnd, type AccountPairingState, type AccountPairingTurnedAway, type DevicePairedEvent, type DeviceRemovedEvent, type DevicePairToken, type DeviceRole, type DevicesRevokedAll, type PairedDevice, type DeviceConnection, STREAM_COOKIE_PREFIX } from "../shared/protocol.ts";
import type { MuxClock } from "../shared/relay-mux-engine.ts";
import type { Access } from "./access.ts";
import { CLEAR_LEGACY_DEVICE_COOKIE, COOKIE_MAX_AGE_SECONDS, DEVICE_COOKIE_CLEARED, deviceCookie, isSecureRequest, noContent, parseCookies } from "./auth.ts";
import { badRequest, isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";
import { privateStateRefusal, writePrivateState } from "./private-state.ts";

/** How long a pairing code pairs new devices. */
export const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const LAST_SEEN_WRITE_MS = 60_000;
const UNCONFIRMED_FIRST_PAIR_LIMIT = 8;
const LABEL_MAX = 48;
const PAIRING_WINDOW_MS = 10 * 60_000;
/** A device that paired with a code made for a PC in no account has this long to link itself into an account. */
export const PAIRING_LINK_MS = 30_000;
/** The pairings one such code takes: each makes a row that waits to link, and nothing gives one back. */
export const PAIRING_USES = 5;
/** The links one waiting row may send; the next turns it away. */
const WAITING_LINKS = 5;
/** Codes made for an account that ended, kept for a read of how they ended (accountPairingState): the latest ones. */
const ENDED_ACCOUNT_CODES = 8;

/** A clock that only moves forward, never the PC's wall clock: what a waiting row's time is counted on (DeviceStore.useClock). */
const MONOTONIC: MuxClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    // a bound that is still running never keeps a stopping server alive
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export class PairingRateLimitedError extends Error {
  readonly code = "pairing_rate_limited";
  constructor(readonly retryAfter: number) {
    super("Too many pairing attempts; try again later");
  }
}

/**
 * The paired device a request came from is paired no more: it was revoked while the request was on its way (a relay
 * round trip, a look-up of who asks). It gets no pairing code: a code held by a device that is already gone is one
 * no revoke ends.
 */
export class DeviceGoneError extends Error {
  readonly code = "unauthorized";
  constructor() {
    super("this device is no longer paired");
  }
}

/**
 * The paired device a request came from may only watch by now: it was made one while the request was on its way (a
 * relay round trip). It gets no pairing code either: holding one is a driver's right.
 */
export class DeviceReadOnlyError extends Error {
  readonly code = "read_only";
  constructor() {
    super("this device can only watch");
  }
}

/**
 * This PC is in an account, so no code is made that would put it in one (DeviceStore.pairingForNoAccount): a device
 * joins a PC that has members by signing in to their account, with a member's approval (docs/account.md).
 */
export class PcInAccountError extends Error {
  readonly code = "in_account";
  constructor() {
    super("This PC is already in an Ovis account. Sign in to that account on the device to add it.");
  }
}

/**
 * An offer named the code it is to carry by its id (`x-ovis-pairing`), and that code is no longer the one pending, or
 * not one the offer can carry: no code is started, and the one pending stays as it was (pairingForAccount).
 */
export class PairingGoneError extends Error {
  readonly code = "pairing_gone";
  constructor() {
    super("The code this offer names is no longer the one pending on this PC; no new code was made.");
  }
}

/**
 * The relay tab's code is past its ten minutes while a device that paired with it in time may still link: no new code
 * is made, since one would end that device's pairing. `retryAfter`: the seconds until the last such device's time to
 * link is over.
 */
export class PairingFinishingError extends Error {
  readonly code = "pairing_finishing";
  constructor(readonly retryAfter: number) {
    super("A device that paired with this PC's code is still linking; a new code follows once it is done.");
  }
}

/** Canonical base64url SPKI containing a public P-256 key, never private key material. */
function isRelayPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return false;
  try {
    const key = createPublicKey({ key: bytes, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
      && key.export({ format: "der", type: "spki" }).equals(bytes);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export interface StoredDevice {
  id: string;
  label: string;
  role: DeviceRole;
  token_hash: string;
  relay_public_key?: string;
  created_at: string;
  last_seen_at: string | null;
  account?: string;
  /** the account member on this PC that approved it from another device; absent when this PC or a code admitted it */
  added_by?: string;
  linked_at?: string;
  /**
   * whether a `link` gave the row a key other than the one it was paired with here; false when every link kept
   * the paired key (the usual link, which only joins the account). Absent on a row never linked, and on one linked
   * before this was recorded: that one counts as kept, as it did then.
   */
  link_moved_key?: boolean;
  /** the signed `add` that let this row in, as received: /api/account/status lists it for a client to hand on */
  account_add?: unknown;
  /**
   * the account whose member approved the pairing that made the row, as it stood then: a remote approval, or a code a
   * member started (and still was a member of that account when the code was used); `added_by` names that member.
   * Absent when `added_by` names a starter that was no member then, and on every other row. Only a link into this same
   * account counts as the member's (linkAccountKey): any other is on the device's own word.
   */
  member_approved_in?: string;
  /**
   * how a `link` made the row a member (docs/account.md, "How a device joined"): set once, by the link that took it from
   * no account into one, and kept by every later link. Absent on a row that became a member before this was recorded,
   * and on one an account member's signature (`add`) or approval (`member_approved_in`, for that account) stands behind. A value this PC does
   * not know is kept as it is and counts as `word`.
   */
  joined_by?: JoinedBy;
}

/**
 * `code`: the row paired with a code made for a PC in no account and linked into the account that code held it to, on
 * a PC from before such a link needed the account's word; `service`: such a code was alive and the account service
 * vouched for the key the row took (records.ts applyLink);
 * `word`: any other link, on the device's own word.
 */
export type JoinedBy = "code" | "service" | "word";
/** The marks of a member something other than the device itself vouched for: every other mark is its own word. */
export const VOUCHED: ReadonlySet<unknown> = new Set<JoinedBy>(["code", "service"]);

/**
 * The three ways relay pairing failures are counted (docs/account.md, "Who may admit a device"): codes
 * and comparisons for this PC alone, comparisons asking to join the account, and another PC of the
 * account vouched for, so a flood of one kind cannot pause the others.
 */
export type PairingPath = "code" | "account" | "vouched";
/** The relay's paths, and codes typed on the LAN HTTPS listener (server/lan-https.ts), counted apart so LAN guessing cannot pause relay pairing. */
export type PairingFailurePath = PairingPath | "lan";

interface UnconfirmedFirstPair {
  device: StoredDevice;
  expires: number;
  origin: readonly string[];
}

/**
 * A browser's stream keys (shared/protocol.ts, "Browser stream keys"): HttpOnly cookies named
 * `ovis_stream_<32 hex>` with the value `1`. They grant nothing. The key is in the NAME, so
 * two answers that each issue one (two tabs opening at once, before either had a key) add two
 * cookies instead of the second overwriting the first: every later request of that browser,
 * the pairing included, carries every key any of its streams was opened with.
 */
const STREAM_KEYS_MAX = 8;
const STREAM_KEY = /^[0-9a-f]{32}$/;

/** Malformed names or values are ignored, never refused. */
export function streamKeys(request: Request): string[] {
  const keys: string[] = [];
  for (const [name, value] of parseCookies(request.headers.get("cookie"))) {
    if (!name.startsWith(STREAM_COOKIE_PREFIX) || value !== "1") continue;
    const key = name.slice(STREAM_COOKIE_PREFIX.length);
    if (STREAM_KEY.test(key) && !keys.includes(key)) keys.push(key);
    if (keys.length === STREAM_KEYS_MAX) break;
  }
  return keys;
}

/** The request names `application/json` among the types it accepts: a browser's fetch sends `*\/*` and never asks. */
function acceptsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((type) => type.split(";")[0]!.trim().toLowerCase() === "application/json");
}

export function newStreamKey(): string {
  return randomBytes(16).toString("hex");
}

export function streamCookie(key: string, secure: boolean): string {
  return `${STREAM_COOKIE_PREFIX}${key}=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure ? "; Secure" : ""}`;
}

export function sameBrowser(a: readonly string[], b: readonly string[]): boolean {
  return a.some((key) => b.includes(key));
}

export interface PairingCode {
  code: string;
  expires_at: string;
}

export interface DeviceMatch {
  id: string;
  label: string;
  role: DeviceRole;
  /**
   * Set by the relay session on one request, never kept: the row waited to link when that request began
   * (server/relay/session.ts), so the request is one of its two calls.
   */
  provisional?: true;
}

/** What stood when a link arrived (DeviceStore.linkArrived): its checks are held to it. */
export interface LinkArrival {
  /** whether the row had paired with a code made for a PC in no account and not linked */
  readonly provisional: boolean;
  /**
   * the code made for a PC in no account that was alive (DeviceStore.pinnedCode), or null: while one is, every link
   * is held to its account and needs the account service's word. Compared only with what is alive later
   */
  readonly pinned: object | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const same = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function normalizeLabel(value: unknown, fallback: string): string {
  const label = typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) : "";
  return label || fallback;
}

export function isDeviceRole(value: unknown): value is DeviceRole {
  return value === "drive" || value === "watch";
}

/**
 * `placeholder`: written only to close the gate where there was no registry (state-merge.ts); it says
 * nothing about which devices were revoked. The store's next save drops the mark.
 */
export type DeviceRegistry = { kind: "missing" } | { kind: "ok"; gateClosedAt: string | null; devices: StoredDevice[]; placeholder: boolean } | { kind: "bad" };

export function readDeviceRegistry(path: string): DeviceRegistry {
  // one another account could write is as unreadable as a damaged one: the gate stays closed
  const refused = privateStateRefusal(path);
  if (refused !== null) {
    console.error(`devices.json is not trusted: ${refused}`);
    return { kind: "bad" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "bad" };
  }
  if (!isJsonObject(parsed) || !Array.isArray(parsed.devices)
    || !(parsed.gate_closed_at === null || typeof parsed.gate_closed_at === "string")
    || !parsed.devices.every((d) => isJsonObject(d) && typeof d.id === "string"
      && typeof d.token_hash === "string" && isDeviceRole(d.role)
      && (d.relay_public_key === undefined || isRelayPublicKey(d.relay_public_key))
      && typeof d.label === "string" && typeof d.created_at === "string"
      && (d.last_seen_at === null || typeof d.last_seen_at === "string")
      && (d.account === undefined || typeof d.account === "string")
      && (d.added_by === undefined || typeof d.added_by === "string")
      && (d.linked_at === undefined || typeof d.linked_at === "string")
      && (d.link_moved_key === undefined || typeof d.link_moved_key === "boolean")
      && (d.account_add === undefined || isJsonObject(d.account_add)))) return { kind: "bad" };
  return { kind: "ok", gateClosedAt: parsed.gate_closed_at, devices: parsed.devices as StoredDevice[], placeholder: parsed.placeholder === true && parsed.devices.length === 0 };
}

/**
 * A key removed through the account, kept in `account-tombstones.json` beside devices.json; `records`
 * are the signed `remove`s that removed it, as received, one per signer (at most
 * TOMBSTONE_RECORDS_MAX), which a client relays to a PC it enrolls (#2956).
 */
export interface AccountTombstone { key: string; account: string; record_id: string; removed_at: string; records?: unknown[] }

/** Signed removals kept per tombstone: one per signer, so a PC where only a later signer is a member can still apply one. */
export const TOMBSTONE_RECORDS_MAX = 8;

function withRecords(records: readonly unknown[] | undefined, more: readonly unknown[]): unknown[] | undefined {
  const signer = (record: unknown) => isJsonObject(record) ? record.signer : undefined;
  const kept = [...records ?? []];
  for (const record of more) {
    if (kept.length >= TOMBSTONE_RECORDS_MAX || kept.some((own) => signer(own) === signer(record))) continue;
    kept.push(record);
  }
  return kept.length ? kept : undefined;
}

/** Null for a file that exists and will not parse; an absent file holds no tombstones. */
function readTombstones(path: string): AccountTombstone[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  if (!isJsonObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.tombstones)
    || !parsed.tombstones.every((t) => isJsonObject(t) && typeof t.key === "string" && typeof t.account === "string"
      && typeof t.record_id === "string" && typeof t.removed_at === "string" && (t.records === undefined || Array.isArray(t.records)))) return null;
  return parsed.tombstones as AccountTombstone[];
}

/**
 * The tombstones of two state dirs that share one device registry (state-merge.ts), written to both:
 * a key removed in either stays removed in both. Per key the later removal is kept. A file that will
 * not parse is left as it is, and the store then refuses account records there.
 */
export function mergeAccountTombstones(active: string, sibling: string): string | null {
  const paths = [join(active, "account-tombstones.json"), join(sibling, "account-tombstones.json")];
  const read = paths.map(readTombstones);
  // the active dir's own unreadable file stops its store anyway; a sibling's must too, or its removals are lost
  if (read[1] === null) return `Cannot read ${paths[1]}: account records are refused until it is restored or fixed.`;
  if (read[0] === null) return null;
  const pending = [active, sibling].flatMap((dir) => readTombstones(join(dir, "account-tombstones.pending.json")) ?? []);
  const merged = new Map<string, AccountTombstone>();
  for (const tombstone of [...read.flatMap((list) => list ?? []), ...pending]) {
    const kept = merged.get(tombstone.key);
    if (!kept) { merged.set(tombstone.key, tombstone); continue; }
    // the account's removal outranks a revoke on the PC (only it keeps a relay code out), with the later of the two times
    const local = (t: AccountTombstone) => t.record_id === "local";
    const winner = local(kept) && !local(tombstone) ? tombstone : !local(kept) && local(tombstone) ? kept : tombstone.removed_at > kept.removed_at ? tombstone : kept;
    const removedAt = tombstone.removed_at > kept.removed_at ? tombstone.removed_at : kept.removed_at;
    const records = local(winner) ? undefined : withRecords(winner.records, [...kept.records ?? [], ...tombstone.records ?? []]);
    const { records: _records, ...rest } = winner;
    merged.set(tombstone.key, { ...rest, removed_at: removedAt, ...(records ? { records } : {}) });
  }
  const tombstones = [...merged.values()];
  for (const [index, path] of paths.entries()) {
    if ((read[index] ?? []).length !== tombstones.length || tombstones.some((t) => !read[index]?.some((own) => own.key === t.key && own.removed_at === t.removed_at && own.record_id === t.record_id && JSON.stringify(own.records ?? []) === JSON.stringify(t.records ?? [])))) {
      writePrivateState(path, { v: 1, tombstones });
    }
  }
  return null;
}

/**
 * A device that paired with a code made for a PC in no account and has not linked: in memory only, never in
 * devices.json, and shown to its own relay session alone (DeviceStore.sessionRow).
 */
interface ProvisionalRow {
  readonly id: string;
  readonly label: string;
  /** the key its PAIR named; only an AUTH proves it */
  readonly key: string;
  /** on the store's clock */
  readonly pairedAt: number;
  /** the links it sent */
  links: number;
  /** what its last link is waiting for, or got: the account service's word, or no answer from it */
  link?: "asked" | "service_unreachable";
  readonly cancel: () => void;
}

/** What a code made for a PC in no account holds besides its six digits: the pairings it still takes, and the rows that wait to link. */
interface WaitingRows {
  usesLeft: number;
  readonly rows: Map<string, ProvisionalRow>;
  /** set while the link of one of its rows is written (promote): the device the code's end names */
  joined?: { readonly device_id: string; readonly label: string };
  /** every row of this code that went without becoming a member, oldest first */
  readonly turnedAway: AccountPairingTurnedAway[];
}

/**
 * Whether the row is a pairing of its current key made on this PC (a code, or a comparison approved here): not a
 * row an account record or a remote approval made (`added_by`), and not one a `link` moved onto the key from the
 * key it was paired with, which never paired this key here. A link that kept the paired key changes nothing.
 */
function pairedHere(device: StoredDevice): boolean {
  return device.added_by === undefined && device.link_moved_key !== true;
}

export class DeviceStore {
  private devices: StoredDevice[] = [];
  /** when the first device was paired: from then on, only this PC, the owner's login, a device or the token get in */
  private gateClosedAt: string | null = null;
  /**
   * `remote`: started through the relay, so it never lets a removed key back in; `startedBy`: the account
   * member that started it there, whose addition the new device then is; `holders`: the paired devices that
   * started it or were handed it, on any transport. It ends when one of them is revoked (`revoke`)
   */
  /**
   * `open`: started by a request the open LAN alone let in (access.ts `via: "open"`), so it ends when the gate closes;
   * `noAccountOnly`: made to put this PC in an account (pairingForNoAccount), so it ends when the PC is in one;
   * `waiting`: what such a code holds, the devices that paired with it through the relay and have not linked;
   * `id`: names the code to a caller that ends or reads it (endPairing, accountPairingState);
   * `named`: such a code made for one account (startAccountPairing), whose waiting devices are taken into it alone;
   * `expires`: the wall-clock end of its ten minutes, which its `expires_at` shows; `deadline`: the same end on the
   * store's clock, which only moves forward; `over`: set the first time either says its ten minutes are over (codeOver)
   */
  private pending: { code: string; id: string; expires: number; deadline: number; over?: true; attempts: number; lanAttempts?: number; remote: boolean; startedBy: string | null; approvedIn?: string; memberRequired: boolean; open?: boolean; noAccountOnly?: boolean; holders: Set<string>; waiting?: WaitingRows; named?: { readonly account: string }; issuedUnder?: string } | null = null;
  /** How the latest codes made for an account ended, newest last: ENDED_ACCOUNT_CODES at most, in memory only. */
  private endedAccountCodes: Extract<AccountPairingState, { state: "ended" }>[] = [];
  /** What a row that waits to link, and the redemption of a code, is bounded on (useClock). */
  private clock: MuxClock = MONOTONIC;
  private codeIssues: number[] = [];
  private readonly relayFailures: Record<PairingFailurePath, { at: number[]; blockedUntil: number }> = {
    code: { at: [], blockedUntil: 0 }, account: { at: [], blockedUntil: 0 }, vouched: { at: [], blockedUntil: 0 }, lan: { at: [], blockedUntil: 0 },
  };
  /** First-pair cookies are not devices, and do not close the gate, until one returns. */
  private unconfirmedFirstPairs: UnconfirmedFirstPair[] = [];
  private readonly path: string;
  private readonly revocations = new Map<string, Set<(waiting?: true) => void>>();
  private readonly relinks = new Map<string, Set<(sessionId: string) => void>>();
  private readonly revokeAllListeners = new Set<() => void>();
  private readonly gateListeners = new Set<() => void>();
  private readonly pairings = new Set<(event: DevicePairedEvent, origin: readonly string[]) => void>();
  private readonly codeStarts = new Set<() => void>();
  private readonly removals = new Set<(event: DeviceRemovedEvent) => void>();
  private readonly tombstonePath: string;
  private readonly pendingTombstonePath: string;
  /** Keys removed through the account (docs/account.md, rule 5); only a pairing on this PC clears one. */
  private tombstones: AccountTombstone[] = [];
  /** Why account records cannot be applied: a tombstone file that will not parse is not an empty one. */
  readonly accountError: string | null = null;
  readonly error: string | null = null;

  /**
   * `blocked`: why the registry may lack devices that must stay paired (state-merge.ts could not
   * take over the other state dir's): the store then stays gated and changes nothing, as for a
   * damaged registry, while the devices it holds still get in.
   */
  /** `accountBlocked`: why account records cannot be trusted here (a sibling dir's tombstones that could not be merged). */
  constructor(stateDir: string, blocked: string | null = null, accountBlocked: string | null = null) {
    this.path = join(stateDir, "devices.json");
    this.tombstonePath = join(stateDir, "account-tombstones.json");
    this.pendingTombstonePath = join(stateDir, "account-tombstones.pending.json");
    const tombstones = readTombstones(this.tombstonePath);
    const pending = readTombstones(this.pendingTombstonePath) ?? [];
    if (accountBlocked !== null) this.accountError = accountBlocked;
    if (tombstones === null) {
      this.accountError = `Cannot read ${this.tombstonePath}: account records are refused until it is restored or fixed.`;
      this.tombstones = pending;
    } else this.tombstones = [...tombstones, ...pending.filter((t) => !tombstones.some((own) => own.key === t.key))];
    const read = readDeviceRegistry(this.path);
    if (read.kind === "ok") {
      this.gateClosedAt = read.gateClosedAt;
      this.devices = read.devices;
    } else if (read.kind === "bad") {
      // A damaged registry is not a first installation. Keep it intact for recovery and
      // let the existing local/token/Tailscale routes provide access to the owner.
      this.error = `Cannot read ${this.path}. Restore a valid devices.json or fix its permissions, then restart the server. External access without a token or trusted Tailscale login remains blocked.`;
      console.error(this.error);
    }
    if (blocked !== null && this.error === null) {
      this.error = blocked;
      console.error(this.error);
    }
    if (this.error === null && this.accountError === null) {
      if (pending.length) {
        this.writeTombstones(this.tombstones);
        rmSync(this.pendingTombstonePath, { force: true });
      }
      this.finishInterruptedWrites();
    }
  }

  /**
   * A stop between the two writes of a removal leaves a row and the tombstone of its key; one between
   * the two writes of a pairing on this PC does too. Their times tell them apart: a row made after the
   * key's removal is the pairing's, and the tombstone goes; one made before it is the removal's, and
   * the row goes (`stale`, which nothing admits meanwhile).
   */
  private finishInterruptedWrites(): void {
    const tombstones = this.tombstones.filter((t) => !this.devices.some((d) => d.relay_public_key === t.key && !this.stale(d)));
    if (tombstones.length !== this.tombstones.length) {
      writePrivateState(this.tombstonePath, { v: 1, tombstones });
      this.tombstones = tombstones;
    }
    const devices = this.devices.filter((d) => !this.stale(d));
    if (devices.length !== this.devices.length) {
      const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
      this.save(devices, gate);
      this.devices = devices;
      this.gateClosedAt = gate;
    }
  }

  /** A row whose key was removed at or after the row was made: revoked, whether or not its own write happened yet. */
  private stale(device: StoredDevice): boolean {
    return device.relay_public_key !== undefined
      && this.tombstones.some((t) => t.key === device.relay_public_key && (!pairedHere(device) || t.removed_at >= device.created_at));
  }

  /**
   * Whether the gate is closed to strangers: it is from the first pairing on, and stays so when
   * every device is revoked (revoking must never reopen the LAN); this PC itself always gets in.
   */
  get gated(): boolean {
    return this.error !== null || this.gateClosedAt !== null || this.devices.length > 0;
  }

  /**
   * Hears of the gate closing to strangers (`gated` turning true): the first device's cookie came back, or the
   * relay was turned on. Told once, right after the call that closed it (save). Whoever the open LAN let in has
   * no access from then on, and neither a later device nor a revoke opens the gate again. Never told of a gate
   * that is closed already: endWithGate.
   */
  onGateClosed(listener: () => void): () => void {
    this.gateListeners.add(listener);
    return () => { this.gateListeners.delete(listener); };
  }

  /** The end of what the open LAN alone let in: `close` when the gate closes, at once when it is closed already. */
  endWithGate(close: () => void): () => void {
    if (this.gated) { close(); return () => {}; }
    return this.onGateClosed(close);
  }

  /** Relay opt-in closes open LAN access before any outbound connection is made. */
  closeGate(): void {
    this.assertWritable();
    if (this.gated) return;
    const gate = new Date().toISOString();
    this.save(this.devices, gate);
    this.gateClosedAt = gate;
    this.voidPending();
    this.unconfirmedFirstPairs = [];
  }

  onLinked(id: string, listener: (sessionId: string) => void): () => void {
    const listeners = this.relinks.get(id) ?? new Set<(sessionId: string) => void>();
    listeners.add(listener);
    this.relinks.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.relinks.delete(id);
    };
  }

  /**
   * Ends stale authority on revocation or role changes, never a label-only update. Called immediately for an already-revoked identity.
   * `waiting`: the row that went had paired with a code made for a PC in no account and not linked (dropProvisional).
   */
  onRevoke(id: string, close: (waiting?: true) => void): () => void {
    // a row that waits to link has sessions too: they end when it goes, as a device's do when it is revoked
    if (!this.devices.some((device) => device.id === id) && this.pending?.waiting?.rows.has(id) !== true) { close(); return () => {}; }
    const listeners = this.revocations.get(id) ?? new Set<(waiting?: true) => void>();
    listeners.add(close);
    this.revocations.set(id, listeners);
    return () => {
      listeners.delete(close);
      if (listeners.size === 0) this.revocations.delete(id);
    };
  }

  /**
   * Hears of every durable enrollment: a gated pairing, or a first-pair cookie confirmed. Never an
   * unconfirmed credential, a last-seen write or a failed one.
   */
  onPaired(listener: (event: DevicePairedEvent, origin: readonly string[]) => void): () => void {
    this.pairings.add(listener);
    return () => { this.pairings.delete(listener); };
  }

  /**
   * After the registry write that made `device` durable, and only then. `enrolledAt` is that write's
   * moment, not the credential's issue: a first-pair cookie confirmed later is enrolled when it returns.
   */
  private announce(device: StoredDevice, enrolledAt: number, origin: readonly string[]): void {
    const approver = device.added_by === undefined ? undefined : this.devices.find((d) => d.id === device.added_by);
    const event: DevicePairedEvent = {
      type: "device-paired", event_id: randomBytes(8).toString("hex"), device_id: device.id, label: device.label, enrolled_at: new Date(enrolledAt).toISOString(),
      ...(approver ? { approved_by: { device_id: approver.id, label: approver.label } } : {}),
    };
    for (const listener of this.pairings) listener(event, origin);
  }

  private assertWritable(): void {
    if (this.error !== null) throw new Error(this.error);
  }

  /** `withAccounts`: add the account fields of member rows, for a caller that may drive (GET /api/devices). */
  list(currentId: string | null, withAccounts = false): PairedDevice[] {
    return this.devices.map((d) => ({
      id: d.id, label: d.label, role: d.role, created_at: d.created_at, last_seen_at: d.last_seen_at, current: d.id === currentId,
      ...(d.relay_public_key === undefined ? {} : { via_relay: true as const }),
      ...(withAccounts && d.account !== undefined && d.relay_public_key !== undefined
        ? { account: d.account, account_key: d.relay_public_key, ...(d.added_by === undefined ? {} : { added_by: d.added_by }) } : {}),
    }));
  }

  /**
   * Hears of every new six-digit code, which replaces the one pending, and of a code ended (endPairing):
   * either way a typed relay code bound to the old one goes (server/relay/pair-code.ts).
   */
  onPairingStarted(listener: () => void): () => void {
    this.codeStarts.add(listener);
    return () => { this.codeStarts.delete(listener); };
  }

  activePairing(now = Date.now()): PairingCode | null {
    const pending = this.pending;
    if (pending === null || this.codeOver(pending, now) || pending.attempts >= CODE_ATTEMPTS) return null;
    return { code: pending.code, expires_at: new Date(pending.expires).toISOString() };
  }

  /**
   * A fresh six-digit code, replacing any code still pending. `by`: the paired device whose request started it
   * (null for this PC itself), which holds it from then on. One that is paired no more by now, or may only watch by
   * now, starts nothing (assertHolder), and the code pending stays as it was.
   */
  startPairing(now = Date.now(), from: { remote: boolean; startedBy: string | null; memberRequired: boolean; open?: boolean; noAccountOnly?: boolean; by?: string | null; account?: string; issuedUnder?: string } = { remote: false, startedBy: null, memberRequired: false }): PairingCode {
    this.assertWritable();
    const { by = null, account, issuedUnder, ...how } = from;
    if (by !== null) this.assertHolder(by);
    if (how.startedBy !== null && !this.has(how.startedBy)) throw new DeviceGoneError();
    this.pruneUnconfirmedFirstPairs(now);
    this.codeIssues = this.codeIssues.filter((at) => now - at < PAIRING_WINDOW_MS);
    if (this.codeIssues.length >= 10) throw new PairingRateLimitedError(Math.ceil(((this.codeIssues[0] ?? now) + PAIRING_WINDOW_MS - now) / 1000));
    this.codeIssues.push(now);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    // the code this one replaces takes the rows that waited under it along
    this.voidPending("replaced");
    this.pending = {
      code, id: randomBytes(16).toString("hex"), expires: now + CODE_TTL_MS, deadline: this.clock.now() + CODE_TTL_MS, attempts: 0, ...how,
      // the account its starter approves the pairing for, judged as the code is made: a starter that joins later approved nothing
      ...(how.startedBy !== null && this.approverAccount(how.startedBy) !== null ? { approvedIn: this.approverAccount(how.startedBy)! } : {}),
      holders: new Set([by, how.startedBy].filter((id): id is string => id !== null)),
      ...(how.noAccountOnly === true ? { waiting: { usesLeft: PAIRING_USES, rows: new Map<string, ProvisionalRow>(), turnedAway: [] } } : {}),
      ...(how.noAccountOnly === true && account !== undefined ? { named: { account } } : {}),
      ...(how.noAccountOnly === true && issuedUnder !== undefined ? { issuedUnder } : {}),
    };
    const started = { code, expires_at: new Date(this.pending.expires).toISOString() };
    for (const listener of this.codeStarts) listener();
    return started;
  }

  /**
   * The code of the QR code that puts this PC in an account: a signed-in device that scans it links itself as the
   * PC's first member, with no approval here (the relay tab's QR code, POST /api/relay/offer with
   * `x-ovis-no-account-only`). So it is made only while the PC is in no account (PcInAccountError otherwise, and the
   * code pending stays as it was), and it ends when the PC joins one (endNoAccountCode). The code pending when that
   * was made the same way, else a fresh one: never a code another place started, which may be on a screen as digits.
   * A device that pairs with it through the relay is no device yet: it waits to link (pairProvisional), and the
   * code takes PAIRING_USES such pairings. No other offer carries it (pairingForOffer), and it is redeemed through
   * the relay only (pair). `by` as in startPairing. `issuedUnder`: the account named for this PC as the code is made
   * (RelayService.offer); a device that waits under the code is taken into that account only (issuedUnder), and a code
   * pending that was made under another is not carried on: a fresh one replaces it.
   */
  pairingForNoAccount(by: string | null = null, now = Date.now(), issuedUnder?: string): PairingCode {
    if (by !== null) this.assertHolder(by);
    if (this.account() !== null) throw new PcInAccountError();
    const active = this.activePairing(now);
    const pending = this.pending;
    // never a code made for one account: the device that pairs with this one is taken into the account named for the PC
    const carried = pending?.noAccountOnly === true && pending.named === undefined && pending.issuedUnder === issuedUnder;
    if (active !== null && carried) {
      if (by !== null) pending.holders.add(by);
      return active;
    }
    // past its ten minutes, the code stays while a device that paired with it in time may still link (expirePending)
    if (carried && this.codeOver(pending, now)) {
      this.expirePending();
      const rows = [...this.pending === pending ? pending.waiting?.rows.values() ?? [] : []];
      if (rows.length > 0) throw new PairingFinishingError(Math.max(1, Math.ceil(Math.max(...rows.map((row) => row.pairedAt + PAIRING_LINK_MS - this.clock.now())) / 1000)));
    }
    return this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, noAccountOnly: true, by, ...(issuedUnder === undefined ? {} : { issuedUnder }) });
  }

  /**
   * The account named for this PC when the relay tab's code that the row `id` waits under was made (pairingForNoAccount),
   * whatever is named now: its link is taken into that account only. Null for a row that does not wait under such a code.
   */
  issuedUnder(id: string): string | null {
    return this.pending?.waiting?.rows.has(id) === true && this.pending.named === undefined ? this.pending.issuedUnder ?? null : null;
  }

  /**
   * The code of an offer asked for with `x-ovis-expect-account: <account>` (docs/account.md, "A code made for an
   * account"): the code pending when that was made for the same account, else a fresh one (startAccountPairing).
   * `want`: the id of the code pending to carry; `new` asks for a fresh one. An id that names no code this offer can
   * carry starts none (PairingGoneError): a fresh code would replace the one pending, which another run may have made
   * since, with the devices that wait under it. `by` as in startPairing.
   */
  pairingForAccount(account: string, by: string | null = null, now = Date.now(), want?: string): PairingCode & AccountPairing {
    if (by !== null) this.assertHolder(by);
    // a code made for an account ends when the PC joins one (endNoAccountCode): one still pending is for a PC in none
    const active = this.activePairing(now);
    const pending = this.pending;
    if (active !== null && pending?.named?.account === account && (want === undefined || want === pending.id)) {
      if (by !== null) pending.holders.add(by);
      return { ...active, expect_account: account, pairing: { id: pending.id } };
    }
    // a PC in an account says so first (startAccountPairing)
    if (want !== undefined && want !== "new" && this.account() === null) throw new PairingGoneError();
    return this.startAccountPairing(account, by, now);
  }

  /**
   * A fresh code made for `account`, replacing any code pending. It is the code of the QR code that puts this PC in
   * an account (pairingForNoAccount), with one difference: a device that pairs with it and waits to link is taken
   * into `account` alone, whatever account was named for this PC (server/account/records.ts applyLink). So it is made
   * only while the PC is in no account (PcInAccountError otherwise, and the code pending stays as it was). Its id
   * names it for a read of its state (accountPairingState). `by` as in startPairing.
   */
  startAccountPairing(account: string, by: string | null = null, now = Date.now()): PairingCode & AccountPairing {
    if (this.account() !== null) throw new PcInAccountError();
    const started = this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, noAccountOnly: true, by, account });
    return { ...started, expect_account: account, pairing: { id: this.pending!.id } };
  }

  /**
   * Ends the relay tab's code (pairingForNoAccount) and the rows that wait to link under it, as endPairing does; a code
   * made for an account, or another code, stays. False when that code is not the one pending.
   */
  endNoAccountPairing(): boolean {
    if (this.pending?.noAccountOnly !== true || this.pending.named !== undefined) return false;
    return this.endPairing();
  }

  /**
   * The account that the code a waiting row paired with was made for (startAccountPairing), also once that code's ten
   * minutes are over: the row is held to it until it links or goes. Null for the relay tab's code, and for a row that
   * does not wait to link.
   */
  waitingFor(id: string): string | null {
    return this.pending?.waiting?.rows.has(id) === true ? this.pending.named?.account ?? null : null;
  }

  /**
   * The code made for a PC in no account that is alive now (pairingForNoAccount, startAccountPairing): the code pending
   * and the PC still in no account, within its ten minutes or, past them, while a device that paired with it in time
   * still waits to link (expirePending; it pairs no new device then). Null for none. What it returns names that code
   * and no later one, so a link holds it from its arrival to its write (LinkArrival).
   */
  pinnedCode(now = Date.now()): object | null {
    if (this.pending?.noAccountOnly === true && this.codeOver(this.pending, now)) this.expirePending();
    const pending = this.pending;
    return pending?.noAccountOnly === true && this.account() === null && (!this.codeOver(pending, now) || (pending.waiting?.rows.size ?? 0) > 0) ? pending : null;
  }

  /** The account a code from pinnedCode was made for (startAccountPairing); null for the relay tab's code, or a code no longer pending. */
  pinnedFor(pinned: object): string | null {
    return this.pending === pinned ? this.pending.named?.account ?? null : null;
  }

  /** Whether `code` is the six digits of a code that pinnedCode names now: its offer carries the mark (shared/relay-offer.ts `admission`). */
  isPinnedCode(code: string): boolean {
    return this.pinnedCode() !== null && this.pending !== null && same(code, this.pending.code);
  }

  /** What the last link of the row `id` that waits to link waits for or got (records.ts applyLink); the keep shows it. */
  noteLink(id: string, link: "asked" | "service_unreachable"): void {
    const row = this.pending?.waiting?.rows.get(id);
    if (row) row.link = link;
  }

  /** The clock a row that waits to link is bounded on (useClock): the wait of its link for the account service is too. */
  waitClock(): MuxClock {
    return this.clock;
  }

  /**
   * Whether the code made for an account that `id` names is still the pending one, and how it ended. A code whose ten
   * minutes are over pairs no new device, and stays the pending one only while a device that paired with it in time
   * may still link (expirePending): with none, it has ended at this read, whether or not anything used it since. While
   * it lives, the rows that wait under it, and every row of it that went without becoming a member.
   */
  accountPairingState(id: string, now = Date.now()): AccountPairingState {
    const pending = this.pending;
    if (pending?.named !== undefined && pending.id === id) {
      if (this.codeOver(pending, now)) this.expirePending();
      if (this.pending === pending) {
        const waiting = [...pending.waiting?.rows.values() ?? []].map((row) => ({ id: row.id, label: row.label, link: row.link ?? "not_sent" as const }));
        return { state: "live", id, expect_account: pending.named.account, expires_at: new Date(pending.expires).toISOString(), waiting, turned_away: [...pending.waiting?.turnedAway ?? []] };
      }
    }
    return this.endedAccountCodes.find((ended) => ended.id === id) ?? { state: "unknown" };
  }

  /**
   * The code of every other relay offer (POST /api/relay/offer without `x-ovis-no-account-only`): the code pending,
   * else a fresh one. Never the code made for a PC in no account (pairingForNoAccount): the device that pairs with
   * that one waits to link, and this offer is for a device that is paired at once. With that code pending a fresh
   * one is started, which replaces it as every new code does. `want` as in pairingForAccount, `by` as in startPairing.
   */
  pairingForOffer(by: string | null = null, now = Date.now(), want?: string): PairingCode {
    const active = this.activePairing(now);
    if (active !== null && this.pending?.noAccountOnly !== true && (want === undefined || want === this.pending?.id)) return active;
    if (want !== undefined && want !== "new") throw new PairingGoneError();
    return this.startPairing(now, { remote: false, startedBy: null, memberRequired: false, by });
  }

  /**
   * A row just became an account member. A code made only for a PC in no account goes: left pending, whoever scans it
   * next would be paired with a PC that has members, with nobody approving and nobody asked.
   */
  private endNoAccountCode(): void {
    if (this.pending?.noAccountOnly === true && this.account() !== null) this.endPairing(undefined, "joined");
  }

  /**
   * The paired device `id` is handed the code pending (a relay offer it asked for carries it): it holds it too.
   * Called before the code leaves this PC: a device that is paired no more, or may only watch, by now is handed
   * nothing (assertHolder).
   */
  holdPairing(id: string): void {
    this.assertHolder(id);
    this.pending?.holders.add(id);
  }

  /**
   * The paired device `id` may still hold a pairing code: checked right before one is started or handed to it, since
   * its request may have waited (on the relay, say) while it was removed (DeviceGoneError) or made one that only
   * watches (DeviceReadOnlyError).
   */
  private assertHolder(id: string): void {
    if (!this.has(id)) throw new DeviceGoneError();
    if (!this.canDrive(id)) throw new DeviceReadOnlyError();
  }

  /**
   * Whether the code pending is past its ten minutes: from the first time the wall clock `now`, or the store's clock,
   * which only moves forward, said so. A clock set back or forward and back again gives no time back, so a code kept
   * past its ten minutes for the devices that paired with it in time (expirePending) never pairs a new one. Those
   * devices keep their own time to link, on the store's clock.
   */
  private codeOver(pending: { expires: number; deadline: number; over?: true }, now: number): boolean {
    if (now > pending.expires || this.clock.now() > pending.deadline) pending.over = true;
    return pending.over === true;
  }

  /** The id of the code pending (endPairing, accountPairingState); null when none is. */
  pairingId(): string | null {
    return this.pending?.id ?? null;
  }

  /**
   * Takes the pending six-digit code back, and the typed relay code bound to it: nothing it was shown as pairs any more.
   * With `match`, only when its `code` and its `id`, each that is given, are the pending code's, so a caller never ends
   * a pairing started after its own; false when it did not. `why`: what a code made for an account is remembered to
   * have ended by.
   */
  endPairing(match?: { readonly code?: string; readonly id?: string }, why: AccountPairingEnd = "cancelled"): boolean {
    const pending = this.pending;
    if (match !== undefined && (pending === null || (match.code !== undefined && !same(match.code, pending.code)) || (match.id !== undefined && match.id !== pending.id))) return false;
    this.voidPending(why);
    for (const listener of this.codeStarts) listener();
    return true;
  }

  /**
   * The clock a row that waits to link is bounded on, and a code's redemption with it (codeOver). It only moves
   * forward (performance.now by default), so a PC's wall clock set back extends none of those bounds. A test hands in
   * one it moves by hand.
   */
  useClock(clock: MuxClock): void {
    this.clock = clock;
  }

  /**
   * Drops the code pending, with nobody told; the rows that waited to link under it go with it. A code made for an
   * account is remembered as ended by `why` (accountPairingState).
   */
  private voidPending(why: AccountPairingEnd = "cancelled"): void {
    const waiting = this.pending?.waiting;
    const id = this.pending?.id;
    const named = this.pending?.named;
    this.pending = null;
    if (waiting) for (const row of [...waiting.rows.values()]) this.dropProvisional(waiting, row, "code_ended");
    if (named && id !== undefined) {
      const joined = why === "joined" ? waiting?.joined : undefined;
      this.endedAccountCodes = [...this.endedAccountCodes, { state: "ended" as const, id, expect_account: named.account, ended: { why, at: new Date().toISOString() }, ...(joined ? { joined } : {}), turned_away: [...waiting?.turnedAway ?? []] }]
        .slice(-ENDED_ACCOUNT_CODES);
    }
  }

  /**
   * The code pending is past its ten minutes: it pairs no new device. It goes now, unless devices that paired with it
   * in time still wait to link: each keeps its own PAIRING_LINK_MS, and the code goes with the last of them
   * (dropProvisional), or when one links.
   */
  private expirePending(): void {
    const waiting = this.pending?.waiting;
    // a row whose time is over goes at this look (provisional)
    if (waiting) for (const id of [...waiting.rows.keys()]) this.provisional(id);
    if (this.pending !== null && (this.pending.waiting?.rows.size ?? 0) === 0) this.voidPending("expired");
  }

  /**
   * A row that waits to link goes: its sessions end `auth_revoked`, and a later sign-in with its id fails. Nothing
   * was written for it, so nothing is unwritten and no tombstone is left. Its use stays spent; a code with no use
   * left, or past its ten minutes (expirePending), ends as the last row that waited under it goes. `why`, with the
   * account its link named when that was the reason, goes into the code's history (accountPairingState).
   */
  private dropProvisional(waiting: WaitingRows, row: ProvisionalRow, why: AccountPairingTurnedAway["why"], account?: string): void {
    if (!waiting.rows.delete(row.id)) return;
    row.cancel();
    waiting.turnedAway.push({ n: waiting.turnedAway.length + 1, id: row.id, label: row.label, why, link: row.link ?? (row.links > 0 ? "sent" : "not_sent"), ...(account === undefined ? {} : { account }) });
    const listeners = this.revocations.get(row.id);
    this.revocations.delete(row.id);
    for (const close of listeners ?? []) close(true);
    if (this.pending?.waiting !== waiting || waiting.rows.size > 0) return;
    if (waiting.usesLeft === 0) this.endPairing(undefined, "overused");
    else if (this.codeOver(this.pending, Date.now())) this.endPairing(undefined, "expired");
  }

  /**
   * `keys` were removed on this PC in this turn (a revoke, a revoke of all, an account's removal): every row that
   * waits to link with one of them goes with it, once the removal is written and before anything else is. Such a
   * row paired before the removal, and its link would take it back (promote clears the tombstone of a key its row
   * kept). So a tombstone that stands when a waiting row links stood when that row paired.
   */
  private dropWaiting(keys: readonly string[]): void {
    const waiting = this.pending?.waiting;
    if (!waiting) return;
    for (const row of [...waiting.rows.values()]) if (keys.includes(row.key)) this.dropProvisional(waiting, row, "removed");
  }

  /**
   * The row `id` that waits to link, by the clock read now: one whose PAIRING_LINK_MS are over is gone at the first
   * look, whether or not its timer has run.
   */
  private provisional(id: string): ProvisionalRow | undefined {
    const waiting = this.pending?.waiting;
    const row = waiting?.rows.get(id);
    if (!waiting || !row) return undefined;
    if (this.clock.now() - row.pairedAt < PAIRING_LINK_MS) return row;
    this.dropProvisional(waiting, row, "link_timeout");
    return undefined;
  }

  /**
   * The row `id` as its own relay session may see it: a device, or one that waits to link (`provisional`). Nothing
   * else is shown a waiting row: no list, no route and no holder of a code knows it, and its role is the one with
   * the fewest rights. This look reads no clock: the two calls such a row may make do (provisionalStands,
   * linkArrived), so a row whose time is over is gone at the first of them, and can make no other call meanwhile.
   */
  sessionRow(id: string): { role: DeviceRole; key: string | undefined; provisional: boolean } | null {
    const device = this.devices.find((d) => d.id === id);
    if (device) return { role: device.role, key: device.relay_public_key, provisional: false };
    const waiting = this.pending?.waiting?.rows.get(id);
    return waiting ? { role: "watch", key: waiting.key, provisional: true } : null;
  }

  /** Whether the row `id` still waits to link: its code is the one pending, and its PAIRING_LINK_MS are not over by the clock read now. */
  provisionalStands(id: string): boolean {
    return this.provisional(id) !== undefined;
  }

  /**
   * A row that waits to link is turned away: its link named another account than the one this PC is for
   * (`account_mismatch`, with the account it named), or the account service did not vouch for its key (`unverified`).
   * It goes at once, as when its time runs out. Its use of the code stays spent, and the code stays.
   */
  turnAway(id: string, why: "account_mismatch" | "unverified", account?: string): void {
    const row = this.provisional(id);
    const waiting = this.pending?.waiting;
    if (row && waiting) this.dropProvisional(waiting, row, why, account);
  }

  /**
   * A link came from the row `id` (POST /api/account/link), before its signature is checked: whether the row is one
   * that waits to link. `wasProvisional`: its relay session said so when the request began, so a row that went
   * since is never taken for a device. A waiting row sends WAITING_LINKS links; the next turns it away, and null
   * says so.
   */
  linkArrived(id: string, wasProvisional = false): LinkArrival | null {
    const row = this.provisional(id);
    const waiting = this.pending?.waiting;
    if (row && waiting) {
      row.links += 1;
      if (row.links > WAITING_LINKS) { this.dropProvisional(waiting, row, "link_refused"); return null; }
    }
    return { provisional: wasProvisional || row !== undefined, pinned: this.pinnedCode() };
  }

  /**
   * The link of a row that waits (linkAccountKey): the row becomes a device and a member of `link.account` in one
   * write of devices.json. First the check again, right before anything is written: the row still waits and still
   * names the key the link starts from, the PC is still in no account, and no account removed the key the row would
   * hold. Null when one of them fails, and nothing is written; a write that throws leaves the row waiting. Once the
   * row is written the code it paired with has done what it was for: it ends, every other row that waited goes, the
   * row's other sessions end (`auth_changed`), and the device is announced. Last, the tombstone of a key the row
   * kept is cleared. It is this PC's own removal of that key (Revoke, Revoke all), and it stood when the row paired:
   * one made since would have taken the row (dropWaiting). That write's failure is logged and changes nothing of the
   * above; the next start clears it.
   */
  private promote(id: string, link: { oldKey: string; key: string; account: string }, sessionId: string, vouched: boolean): PairedDevice | null {
    const row = this.provisional(id);
    const waiting = this.pending?.waiting;
    if (!row || !waiting || row.key !== link.oldKey || this.account() !== null || this.removedByAccount(link.key)) return null;
    const now = Date.now();
    const at = new Date(now).toISOString();
    // the removal of a key the row keeps, by this PC (removedByAccount refused the account's above)
    const removedAt = link.key === link.oldKey ? this.tombstones.find((t) => t.key === link.key)?.removed_at : undefined;
    const device: StoredDevice = {
      id: row.id, label: row.label, role: "drive", token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: link.key,
      // made at this write, not at its pairing, and after that removal even on a wall clock set back since: the row
      // is newer than the removal, so a stop before the tombstone is cleared leaves a row that the next start keeps
      // (finishInterruptedWrites)
      created_at: removedAt !== undefined && removedAt >= at ? new Date(Date.parse(removedAt) + 1).toISOString() : at, last_seen_at: at, account: link.account, linked_at: at, link_moved_key: link.key !== link.oldKey, joined_by: vouched ? "service" : "code",
    };
    // no waiting row from here on: the end of its code, which this write brings, takes the rows that still wait
    waiting.rows.delete(row.id);
    // the end of its code, which this write brings, names the device it brought in
    waiting.joined = { device_id: row.id, label: row.label };
    try { this.enroll(device, now, [], false); }
    catch (error) {
      waiting.rows.set(row.id, row);
      delete waiting.joined;
      throw error;
    }
    row.cancel();
    for (const listener of [...this.relinks.get(id) ?? []]) listener(sessionId);
    if (link.key === link.oldKey) {
      try { this.clearTombstone(link.key); }
      catch (error) { console.error(`[devices] the tombstone of a key that paired again could not be cleared; the next start clears it: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return this.list(null).find((d) => d.id === id) ?? null;
  }

  pair(code: string, label: string, role: DeviceRole, now = Date.now(), origin: readonly string[] = [], localCodeOnly = false): { token: string; device: DeviceMatch } | null {
    this.assertWritable();
    this.pruneUnconfirmedFirstPairs(now);
    // a code started through the relay is never redeemed on the LAN listener, nor are its guesses spent there:
    // it would make a credential no relay key or account removal reaches
    if (localCodeOnly && this.pending?.remote === true) return null;
    // a code made for a PC in no account is redeemed through the relay only, and no try is spent on it here: the
    // device it is for links itself into an account with the key it paired with (pairProvisional), and a device
    // paired here holds a cookie and no key
    if (this.pending?.waiting) return null;
    if (!this.checkPairingCode(code, now, localCodeOnly)) return null;
    // a member's code goes with the member here too (pairRelay)
    const startedBy = this.pending?.startedBy ?? null;
    if (this.pending?.memberRequired && (startedBy === null || !this.isAccountApprover(startedBy))) return null;
    const token = randomBytes(32).toString("hex");
    const device: StoredDevice = { id: randomBytes(8).toString("hex"), label, role, token_hash: hash(token), created_at: new Date(now).toISOString(), last_seen_at: null };
    if (!this.gated) {
      this.voidPending();
      this.unconfirmedFirstPairs.push({ device, expires: now + CODE_TTL_MS, origin });
      if (this.unconfirmedFirstPairs.length > UNCONFIRMED_FIRST_PAIR_LIMIT) this.unconfirmedFirstPairs.shift();
      return { token, device: { id: device.id, label: device.label, role: device.role } };
    }
    this.enroll(device, now, origin);
    return { token, device: { id: device.id, label: device.label, role: device.role } };
  }

  /**
   * Both transports spend the same pending code's five guesses. The LAN HTTPS listener has five of its
   * own instead (`lan`), so a stranger there cannot spend a code a phone is about to type in elsewhere.
   */
  private checkPairingCode(code: string, now: number, lan = false): boolean {
    const pending = this.pending;
    if (pending === null) return false;
    // the devices that paired with it in time still have their own time to link (expirePending)
    if (this.codeOver(pending, now)) { this.expirePending(); return false; }
    // made for a PC in no account, and the PC is in one: it ended as the PC joined (endNoAccountCode), and pairs nobody
    if (pending.noAccountOnly === true && this.account() !== null) { this.endPairing(undefined, "joined"); return false; }
    if (lan) {
      if ((pending.lanAttempts ?? 0) >= CODE_ATTEMPTS) return false;
      if (same(code.replace(/\D/g, ""), pending.code)) return true;
      pending.lanAttempts = (pending.lanAttempts ?? 0) + 1;
      return false;
    }
    if (!same(code.replace(/\D/g, ""), pending.code)) {
      pending.attempts += 1;
      if (pending.attempts >= CODE_ATTEMPTS) this.voidPending("guessed");
      return false;
    }
    return true;
  }

  /** One authorization write precedes every state change and enrollment announcement. */
  private enroll(device: StoredDevice, now: number, origin: readonly string[], codeSpent = true): void {
    const next = [...this.devices, device];
    const gate = this.gateClosedAt ?? device.created_at;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    if (codeSpent) this.voidPending();
    if (device.account !== undefined) this.endNoAccountCode();
    // A relay enrollment closes the gate immediately, invalidating every first-cookie candidate.
    if (device.relay_public_key !== undefined) this.unconfirmedFirstPairs = [];
    this.announce(device, now, origin);
  }

  /**
   * No cookie is issued: even the first relay pairing is durable and closes the gate at once. `admit` is asked once
   * the code holds and nothing else refuses the key, before any device is made: false makes none, spends no code and
   * counts no failure (server/relay/session.ts, a relay pass that allows no new sessions). It is asked only for a
   * key new to this PC (isNewKey).
   */
  pairRelay(code: string, label: string, publicKey: string, now = Date.now(), admit?: () => boolean): { device: DeviceMatch } | null {
    this.assertRelayPairing("code", now);
    // a code made for a PC in no account makes no device: the one that pairs with it waits to link
    const waiting = this.pending?.waiting;
    if (waiting) return this.pairProvisional(waiting, code, label, publicKey, now, admit);
    if (!this.checkPairingCode(code, now) || !isRelayPublicKey(publicKey)) {
      this.noteRelayFailure("code", now);
      return null;
    }
    // a code started through the relay is not a pairing made on this PC (docs/account.md, rule 5)
    const remote = this.pending?.remote ?? false;
    const startedBy = this.pending?.startedBy ?? null;
    // a code started through the relay is not a pairing made on this PC; a member's code goes with the member.
    // On a PC in no account such a code may bring back a key this PC revoked itself, as before account linking;
    // never one the account removed
    const accountless = this.account() === null;
    const refusedKey = accountless ? this.removedByAccount(publicKey) : this.isTombstoned(publicKey);
    if ((remote && (this.accountError !== null || refusedKey)) || (this.pending?.memberRequired && (startedBy === null || !this.isAccountApprover(startedBy)))) {
      this.noteRelayFailure("code", now);
      return null;
    }
    // a device let in by a code started through the relay is its starter's addition, not a pairing made on this PC (removeAccountKey);
    // one that brings back a key this PC revoked itself (on a PC in no account) undoes that revoke, and is the PC's own
    // pairing, so a tombstone that comes back (a sibling dir, a stop before it is cleared) takes it only if newer
    const undoesRevoke = remote && accountless && this.isTombstoned(publicKey);
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    // the starter's approval stands only while it is still a member of the account it approved for
    const approvedIn = startedBy !== null && this.pending?.approvedIn !== undefined && this.approverAccount(startedBy) === this.pending.approvedIn ? this.pending.approvedIn : undefined;
    const paired = this.enrollRelay(label, publicKey, now, true, undoesRevoke ? {} : { addedBy: startedBy ?? undefined, approvedIn });
    if (!remote || accountless) this.clearTombstone(publicKey);
    return paired;
  }

  /**
   * PAIR with a code made for a PC in no account: no device yet. The row it makes is in memory and in no list, and
   * has PAIRING_LINK_MS to link itself into an account (promote); until then its answer names the role with the
   * fewest rights. It spends one of the code's uses and does not end the code. A right code with no use left makes
   * nothing and counts neither as a wrong try nor as a failed pairing; a wrong one counts as ever. Nothing is
   * written, and a removed key is not judged here: the link is (records.ts applyLink, promote).
   */
  private pairProvisional(waiting: WaitingRows, code: string, label: string, publicKey: string, now: number, admit?: () => boolean): { device: DeviceMatch } | null {
    if (!this.checkPairingCode(code, now) || !isRelayPublicKey(publicKey)) {
      this.noteRelayFailure("code", now);
      return null;
    }
    if (waiting.usesLeft === 0) return null;
    // asked last, as for any pairing: a relay pass that takes no new device makes no row and spends no use
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    let id = randomBytes(8).toString("hex");
    while (this.has(id) || waiting.rows.has(id)) id = randomBytes(8).toString("hex");
    const row: ProvisionalRow = {
      id, label: normalizeLabel(label, "Device"), key: publicKey, pairedAt: this.clock.now(), links: 0,
      cancel: this.clock.setTimeout(() => this.dropProvisional(waiting, row, "link_timeout"), PAIRING_LINK_MS),
    };
    waiting.usesLeft -= 1;
    waiting.rows.set(id, row);
    return { device: { id, label: row.label, role: "watch" } };
  }

  assertRelayPairing(path: PairingFailurePath = "code", now = Date.now()): void {
    this.assertWritable();
    const { blockedUntil } = this.relayFailures[path];
    if (now < blockedUntil) throw new PairingRateLimitedError(Math.ceil((blockedUntil - now) / 1000));
  }

  noteRelayFailure(path: PairingFailurePath = "code", now = Date.now()): void {
    const count = this.relayFailures[path];
    count.at = count.at.filter((at) => now - at < PAIRING_WINDOW_MS);
    count.at.push(now);
    if (count.at.length >= 20) count.blockedUntil = now + PAIRING_WINDOW_MS;
  }

  /**
   * A pairing by comparing digits that was approved (server/relay/session.ts): on this PC, or by the
   * account member `addedBy` through the relay. No code is spent. `admit` as in pairRelay: asked last and only for
   * a key new to this PC, false makes no device and counts no failure.
   */
  pairRelayApproved(label: string, publicKey: string, approval: { path: PairingPath; addedBy?: string; id?: string }, now = Date.now(), admit?: () => boolean): { device: DeviceMatch } | null {
    this.assertRelayPairing(approval.path, now);
    if (!isRelayPublicKey(publicKey)) { this.noteRelayFailure(approval.path, now); return null; }
    // an approver revoked or demoted while the device waited approves nothing
    if (approval.addedBy !== undefined && !this.isAccountApprover(approval.addedBy)) { this.noteRelayFailure(approval.path, now); return null; }
    // only this PC lets a key removed through the account back in
    if (approval.addedBy !== undefined && (this.accountError !== null || this.isTombstoned(publicKey))) { this.noteRelayFailure(approval.path, now); return null; }
    if (approval.id !== undefined && this.has(approval.id)) { this.noteRelayFailure(approval.path, now); return null; }
    if (admit && this.isNewKey(publicKey) && !admit()) return null;
    const paired = this.enrollRelay(label, publicKey, now, false, { addedBy: approval.addedBy, approvedIn: approval.addedBy === undefined ? undefined : this.approverAccount(approval.addedBy) ?? undefined }, approval.id);
    // written after the row, so a stop between the two leaves a row newer than its tombstone (finishInterruptedWrites)
    if (approval.addedBy === undefined) this.clearTombstone(publicKey);
    return paired;
  }

  /**
   * Whether a pairing with `key` makes a device new to this PC, which `admit` may refuse (pairRelay). A key a row
   * here already holds does not: a paired phone that opens the pairing QR again, or one that forgot this PC and pairs
   * again with the key its account gave it, is the device this PC knows, and refusing it would cut off someone the
   * limit never meant. The trade-off: PAIR does not prove the key, so someone holding a pairing that would succeed
   * (the owner's code, or digits the owner confirmed) who also names a paired device's public key gets the session
   * that pairing opens past the limit. They cannot sign in with it afterwards (AUTH needs the private key), so each
   * further session takes another pairing that succeeds; on a PC in no account a driving session may start that code
   * itself (devices routes, pair/start). It takes a client changed to name another device's key, on a limit a
   * changed PC could skip anyway.
   */
  private isNewKey(key: string): boolean { return !this.hasKey(key); }

  account(): string | null {
    return this.devices.find((d) => d.account !== undefined)?.account ?? null;
  }

  isMemberOf(id: string, account: string): boolean {
    return this.devices.some((d) => d.id === id && d.account === account && d.relay_public_key !== undefined);
  }

  /** A drive account member whose session signed in with the row's current key: a session left from an older key acts as no member. */
  isAccountApproverSession(id: string, sessionKey: string): boolean {
    return sessionKey !== "" && this.relayKeyOf(id) === sessionKey && this.isAccountApprover(id);
  }

  hasAccountApprover(): boolean { return this.devices.some((d) => this.isAccountApprover(d.id)); }

  /** A drive account member: the only device that may approve a pairing or start a code through the relay (docs/account.md). */
  isAccountApprover(id: string): boolean {
    const device = this.devices.find((d) => d.id === id);
    return device !== undefined && device.role === "drive" && device.account !== undefined && device.relay_public_key !== undefined && !this.stale(device);
  }

  /** The account `id` may approve a pairing for (isAccountApprover), or null. */
  private approverAccount(id: string): string | null {
    return this.isAccountApprover(id) ? this.devices.find((d) => d.id === id)?.account ?? null : null;
  }

  private enrollRelay(label: string, publicKey: string, now: number, codeSpent: boolean, { addedBy, approvedIn }: { addedBy?: string | undefined; approvedIn?: string | undefined }, id = randomBytes(8).toString("hex")): { device: DeviceMatch } {
    const device: StoredDevice = {
      id, label: normalizeLabel(label, "Device"), role: "drive",
      token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: publicKey,
      // PAIR authenticates this relay session too, so the device is seen as it pairs.
      created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(),
      ...(addedBy === undefined ? {} : { added_by: addedBy }),
      // what a later link reads to tell a member's approval from a code a device outside the account started
      ...(addedBy !== undefined && approvedIn !== undefined ? { member_approved_in: approvedIn } : {}),
    };
    this.enroll(device, now, [], codeSpent);
    return { device: { id: device.id, label: device.label, role: device.role } };
  }

  /** The transport owns a fresh 32-byte nonce per session and consumes AUTH only once. */
  async matchRelay(deviceId: string, nonce: Uint8Array, signature: string, serverId: string, now = Date.now()): Promise<DeviceMatch | null> {
    if (nonce.byteLength !== 32 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return null;
    const signed = Buffer.from(signature, "base64url");
    if (signed.length !== 64 || signed.toString("base64url") !== signature) return null;
    const device = this.devices.find((d) => d.id === deviceId && d.relay_public_key !== undefined);
    // a row that waits to link signs in as any row does, by the key its PAIR named, while it stands; only that
    // sign-in proves the key
    const waiting = device === undefined ? this.provisional(deviceId) : undefined;
    const publicKey = device?.relay_public_key ?? waiting?.key;
    if (publicKey === undefined || (device !== undefined && this.stale(device))) return null;
    const message = Buffer.concat([Buffer.from("ovis-relay-auth/1"), nonce, Buffer.from(serverId)]);
    try {
      const key = await crypto.subtle.importKey("spki", Buffer.from(publicKey, "base64url"), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signed, message);
      // the row went, or linked, while its signature was checked: the proof was for a row that is no more
      if (waiting !== undefined) return verified && this.provisional(deviceId) === waiting ? { id: waiting.id, label: waiting.label, role: "watch" } : null;
      // Authorization changes during WebCrypto invalidate the proof; a rename does not.
      const current = this.devices.find((d) => d.id === deviceId);
      if (!verified || !current || device === undefined || current.role !== device.role || current.relay_public_key !== device.relay_public_key) return null;
      this.noteSeen(current, now);
      return { id: current.id, label: current.label, role: current.role };
    } catch (error) {
      if (error instanceof DOMException) return null;
      throw error;
    }
  }

  match(token: string | undefined, now = Date.now()): DeviceMatch | null {
    this.pruneUnconfirmedFirstPairs(now);
    if (!token) return null;
    const digest = hash(token);
    const candidateIndex = this.unconfirmedFirstPairs.findIndex(({ device }) => same(digest, device.token_hash));
    if (candidateIndex !== -1) {
      const { device: candidate, origin } = this.unconfirmedFirstPairs[candidateIndex]!;
      const confirmed = { ...candidate, last_seen_at: new Date(now).toISOString() };
      const next = [...this.devices, confirmed];
      const gate = this.gateClosedAt ?? confirmed.created_at;
      // This is an authorization write, not last-seen telemetry: do not match the cookie
      // unless the device and closed gate reached disk together.
      this.save(next, gate);
      this.devices = next;
      this.gateClosedAt = gate;
      // Once one first-pair cookie closes the gate, every sibling candidate is stale:
      // subsequent devices must be issued through the gated pairing flow.
      this.unconfirmedFirstPairs = [];
      // So is a code the open LAN started: it admits whoever holds it, and until now anyone on the LAN could start
      // one. It ends with the gate, and whoever shows it is told (endPairing). A code this PC, its token or its owner's
      // login started stays: the request that brings the first cookie back may be the one that redeems it.
      if (this.pending?.open) this.endPairing();
      this.announce(confirmed, now, origin);
      return { id: confirmed.id, label: confirmed.label, role: confirmed.role };
    }
    for (const device of this.devices) {
      if (!same(digest, device.token_hash)) continue;
      this.noteSeen(device, now);
      return { id: device.id, label: device.label, role: device.role };
    }
    return null;
  }

  private noteSeen(device: StoredDevice, now: number): void {
    const seen = device.last_seen_at === null ? 0 : Date.parse(device.last_seen_at);
    if (this.error !== null || now - seen < LAST_SEEN_WRITE_MS) return;
    try {
      const next = this.devices.map((d) => d === device ? { ...d, last_seen_at: new Date(now).toISOString() } : d);
      // devices.json is also the authorization registry: a torn write here would lock every device out
      this.save(next);
      this.devices = next;
    } catch { /* last-seen telemetry must not deny an otherwise valid credential */ }
  }

  update(id: string, patch: { label?: string; role?: DeviceRole }): PairedDevice | null {
    this.assertWritable();
    const device = this.devices.find((d) => d.id === id);
    if (!device) return null;
    const updated = { ...device, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.role === undefined ? {} : { role: patch.role }) };
    const next = this.devices.map((d) => d === device ? updated : d);
    this.save(next);
    this.devices = next;
    if (updated.role !== device.role) {
      const listeners = this.revocations.get(id);
      this.revocations.delete(id);
      for (const close of listeners ?? []) close();
    }
    return { id: updated.id, label: updated.label, role: updated.role, created_at: updated.created_at, last_seen_at: updated.last_seen_at, current: false, ...(updated.relay_public_key === undefined ? {} : { via_relay: true as const }) };
  }

  /** Hears of every device that lost its access, after the write that took it (DeviceRemovedEvent). */
  onRemoved(listener: (event: DeviceRemovedEvent) => void): () => void {
    this.removals.add(listener);
    return () => { this.removals.delete(listener); };
  }

  private announceRemoval(device: StoredDevice, by: DeviceRemovedEvent["by"]): void {
    const event: DeviceRemovedEvent = { type: "device-removed", event_id: randomBytes(8).toString("hex"), device_id: device.id, label: device.label, removed_at: new Date().toISOString(), ...(by === undefined ? {} : { by }) };
    for (const listener of [...this.removals]) listener(event);
  }

  revoke(id: string, by: DeviceRemovedEvent["by"] = "pc"): boolean {
    this.assertWritable();
    const next = this.devices.filter((d) => d.id !== id);
    if (next.length === this.devices.length) return false;
    const gone = this.devices.find((d) => d.id === id);
    // a revoke on this PC wins over the account: its key cannot come back by a record (docs/account.md, rule 1)
    this.tombstone(this.devices.filter((d) => d.id === id), Date.now());
    // A valid older/manual registry can have devices without a gate timestamp. Removing its
    // last device must still leave durable evidence that this store was once gated.
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? null;
    this.save(next, gate);
    this.devices = next;
    this.gateClosedAt = gate;
    // A code the device started or was handed goes with it. Whoever it passed the code to would otherwise pair after
    // it was removed, on a PC in no account with nobody approving (a member's code already needs its member)
    if (this.pending?.holders.has(id)) this.endPairing(undefined, "revoked");
    const listeners = this.revocations.get(id);
    this.revocations.delete(id);
    for (const close of listeners ?? []) close();
    if (gone) this.announceRemoval(gone, by);
    return true;
  }

  /**
   * Told on every revokeAll, after the empty registry is saved: a relay pairing by comparing digits
   * that is still under way (server/relay/session.ts) ends there, approved or not, so no device is
   * made from a comparison the owner's "revoke all" came after.
   */
  onRevokeAll(listener: () => void): () => void {
    this.revokeAllListeners.add(listener);
    return () => { this.revokeAllListeners.delete(listener); };
  }

  /**
   * Every paired device loses its access in one durable write, the caller's own included; the
   * ids it returns are for the cleanup that follows (push subscriptions, page media). The write
   * comes first and alone: until it succeeds nothing changes, and if it throws, the registry,
   * every credential and every listener stay as they were. After it, the pending code and every
   * unconfirmed first-pair credential are void as well, and every revoked device's streams close.
   * The gate stays closed, with a timestamp even when nothing was ever confirmed (only first-pair
   * candidates existed): revoking must never reopen the LAN, not even after a restart.
   */
  revokeAll(): string[] {
    this.assertWritable();
    this.tombstone(this.devices, Date.now());
    const gate = this.gateClosedAt ?? this.devices[0]?.created_at ?? new Date().toISOString();
    this.save([], gate);
    const gone = this.devices;
    const revoked = this.devices.map((device) => device.id);
    this.devices = [];
    this.gateClosedAt = gate;
    this.voidPending("revoked");
    this.unconfirmedFirstPairs = [];
    const listeners = [...this.revocations.values()];
    this.revocations.clear();
    for (const closes of listeners) for (const close of closes) close();
    for (const listener of [...this.revokeAllListeners]) listener();
    for (const device of gone) this.announceRemoval(device, "pc");
    return revoked;
  }

  has(id: string): boolean { return this.devices.some((device) => device.id === id); }

  /** Whether the device may answer a pane's prompt: paired to drive, not to watch. */
  canDrive(id: string): boolean { return this.devices.some((device) => device.id === id && device.role === "drive"); }

  private pruneUnconfirmedFirstPairs(now: number): void {
    this.unconfirmedFirstPairs = this.unconfirmedFirstPairs.filter(({ expires }) => now <= expires);
  }

  private save(devices = this.devices, gateClosedAt = this.gateClosedAt): void {
    const closes = !this.gated && (gateClosedAt !== null || devices.length > 0);
    writePrivateState(this.path, { gate_closed_at: gateClosedAt, devices });
    // The write that closes the gate: onGateClosed. Told once the caller has set the store's own fields, which each
    // does right after this returns, and before anything else of this process runs (no frame of a connection is
    // read in between). Each on its own: one that throws ends neither the others nor the pairing that closed the gate.
    if (closes) queueMicrotask(() => {
      for (const listener of [...this.gateListeners]) {
        try { listener(); } catch (error) { console.warn(`[devices] ending what the open LAN let in failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
  }

  /** The drive member of `account` whose key is `key`, the only signer whose `add` or `remove` applies. */
  /** The member of `account` holding `key`: a drive one, unless `anyRole` (a device signing its own leave). */
  accountSigner(key: string, account: string, anyRole = false): DeviceMatch | null {
    const device = this.devices.find((d) => d.relay_public_key === key && d.account === account && (anyRole || d.role === "drive") && !this.stale(d));
    return device ? { id: device.id, label: device.label, role: device.role } : null;
  }

  accountRows(): { members: number; unlinked: string[]; own_word: string[] } {
    const groups = this.accountGroups();
    return {
      members: this.devices.filter((d) => d.account !== undefined).length,
      unlinked: groups.unlinked.map((d) => d.id), own_word: groups.own_word.map((d) => d.id),
    };
  }

  /**
   * The rows the owner is shown apart (/api/account/status, the owner's /api/health, `ovis status`): relay rows in no
   * account, and members whose link was on their own word (`joined_by`). A row is in one of them at most.
   */
  accountGroups(): { unlinked: { id: string; label: string }[]; own_word: { id: string; label: string }[] } {
    const shown = (d: StoredDevice) => ({ id: d.id, label: d.label });
    return {
      unlinked: this.devices.filter((d) => d.account === undefined && d.relay_public_key !== undefined).map(shown),
      own_word: this.devices.filter((d) => d.account !== undefined && d.joined_by !== undefined && !VOUCHED.has(d.joined_by)).map(shown),
    };
  }

  isTombstoned(key: string): boolean { return this.tombstones.some((t) => t.key === key); }

  /** Whether an account's removal keeps `key` out (the tombstone of a `remove`), not only a revoke made on this PC. */
  removedByAccount(key: string): boolean { return this.tombstones.some((t) => t.key === key && t.record_id !== "local"); }

  /** Every key this PC keeps out, signed removal or not (a Revoke here, a record that no longer parses): /api/account/status `blocked`. */
  tombstoneKeys(): string[] { return [...new Set(this.tombstones.map((t) => t.key))]; }

  /** The signed `add`s behind this PC's account rows, as received: what /api/account/status lists. One that no longer parses or names another key is left out. */
  accountAdds(): AddRecord[] {
    const account = this.account();
    return this.devices.flatMap((d) => {
      if (account === null || d.account_add === undefined || this.stale(d)) return [];
      try {
        const record = parseAccountRecord(d.account_add);
        return record.kind === "add" && record.key === d.relay_public_key && record.account === account ? [record] : [];
      } catch (error) {
        if (error instanceof AccountRecordError) return [];
        throw error;
      }
    });
  }

  /**
   * Keeps `record` on the row it is for when that row's approver signed it and none is kept yet: the
   * approver of a remote approval hands its add to this PC too (an `unchanged` add), so the PC can
   * list it for a client to pass on.
   */
  keepAccountAdd(record: AddRecord, signerId: string): void {
    const device = this.devices.find((d) => d.relay_public_key === record.key && d.added_by === signerId && (d.account_add === undefined || (d.account_add as { key?: unknown }).key !== d.relay_public_key) && !this.stale(d));
    if (!device) return;
    const next = this.devices.map((d) => d === device ? { ...d, account_add: record } : d);
    this.save(next);
    this.devices = next;
  }

  /** The signed `remove`s behind this PC's tombstones for its account, as received: what /api/account/status lists. One that no longer parses is left out. */
  accountRemovals(): RemoveRecord[] {
    const account = this.account();
    return this.tombstones.flatMap((t) => t.account !== account ? [] : (t.records ?? []).flatMap((value) => {
      try {
        const record = parseAccountRecord(value);
        return record.kind === "remove" && record.key === t.key && record.account === t.account ? [record] : [];
      } catch (error) {
        if (error instanceof AccountRecordError) return [];
        throw error;
      }
    }));
  }

  hasKey(key: string): boolean { return this.devices.some((d) => d.relay_public_key === key && !this.stale(d)); }

  acceptsRelayKey(key: string): boolean { return isRelayPublicKey(key); }

  wasAddedByMember(key: string): boolean { return this.devices.some((d) => d.relay_public_key === key && d.added_by !== undefined && !this.stale(d)); }

  keyHeldByOther(key: string, id: string): boolean { return this.devices.some((d) => d.relay_public_key === key && d.id !== id); }

  relayKeyOf(id: string): string | undefined { return this.devices.find((d) => d.id === id)?.relay_public_key; }

  /** An `add` that verified: a new member row, announced like any other enrollment. Never for a tombstoned key. */
  addAccountDevice(entry: { id: string; key: string; label: string; role: DeviceRole; account: string; addedBy: string; record?: AddRecord }, now = Date.now()): DeviceMatch {
    this.assertAccountWritable();
    if (this.isTombstoned(entry.key)) throw new Error("tombstoned key");
    // an id another row holds would merge two devices' authority; a derived id collides only for the same key
    if (this.has(entry.id)) throw new Error("device id in use");
    const device: StoredDevice = {
      id: entry.id, label: normalizeLabel(entry.label, "Device"), role: entry.role,
      token_hash: hash(randomBytes(32).toString("hex")), relay_public_key: entry.key,
      created_at: new Date(now).toISOString(), last_seen_at: null, account: entry.account, added_by: entry.addedBy,
      ...(entry.record === undefined ? {} : { account_add: entry.record }),
    };
    this.enroll(device, now, [], false);
    return { id: device.id, label: device.label, role: device.role };
  }

  /**
   * A `remove` that verified: the tombstone is written first, so a crash between the two writes
   * leaves the key refused; then the rows that wait to link with the key go (dropWaiting), and every
   * row holding the key is revoked, closing its sessions.
   */
  removeAccountKey(key: string, account: string, record: { id: string; issuedAt: string; by?: { device_id: string; label: string }; signed?: RemoveRecord }, now = Date.now()): boolean {
    this.assertAccountWritable();
    // a pairing of this key made on this PC after the removal was signed wins: a replayed or late remove
    // leaves it be. Any other row goes, however late the remove arrives (pairedHere).
    if (this.devices.some((d) => d.relay_public_key === key && pairedHere(d) && d.created_at > record.issuedAt)) return false;
    const recordId = record.id;
    const fresh = !this.isTombstoned(key);
    const removal: AccountTombstone = { key, account, record_id: recordId, removed_at: new Date(now).toISOString(), ...(record.signed ? { records: [record.signed] } : {}) };
    const kept = this.tombstones.find((t) => t.key === key);
    if (fresh) this.writeTombstones([...this.tombstones, removal]);
    // a key this PC revoked first becomes the account's removal, so a code started through the relay cannot bring it back
    else if (kept?.record_id === "local") this.writeTombstones(this.tombstones.map((t) => t.key === key ? removal : t));
    // another signer's removal of a removed key is kept beside the first, for a PC where only that signer is a member (#2956)
    else if (kept && record.signed && kept.account === account) {
      const records = withRecords(kept.records, [record.signed]);
      if ((records?.length ?? 0) !== (kept.records?.length ?? 0)) this.writeTombstones(this.tombstones.map((t) => t === kept ? { ...t, ...(records ? { records } : {}) } : t));
    }
    this.dropWaiting([key]);
    const ids = this.devices.filter((d) => d.relay_public_key === key).map((d) => d.id);
    for (const id of ids) this.revoke(id, record.by);
    return fresh || ids.length > 0;
  }

  /**
   * A `link` the device `deviceId` sent over its own session `sessionId`: its row takes `key` and joins
   * `account` in one write. The row's other sessions signed in with a key it no longer has, so they end
   * (`auth_changed`); the linking one goes on until it signs in again with the new key. A row that waits to link
   * is no device yet: its link makes it one (promote).
   */
  linkAccountKey(deviceId: string, oldKey: string, key: string, account: string, sessionId = "", vouched = false): PairedDevice | null {
    this.assertAccountWritable();
    const device = this.devices.find((d) => d.id === deviceId && d.relay_public_key === oldKey);
    if (!device) return this.promote(deviceId, { oldKey, key, account }, sessionId, vouched);
    const moved = key !== oldKey || device.link_moved_key === true;
    // the link that takes a row from no account into one is on the device's own word unless a member of that same
    // account approved its pairing: a code started by a device outside the account names its starter in `added_by` and
    // approves nothing, and an approval for another account does not carry over
    const ownWord = device.account === undefined && device.member_approved_in !== account;
    const updated: StoredDevice = { ...device, relay_public_key: key, account, linked_at: new Date().toISOString(), link_moved_key: moved, ...(ownWord ? { joined_by: vouched ? "service" as const : "word" as const } : {}) };
    const next = this.devices.map((d) => d === device ? updated : d);
    this.save(next);
    this.devices = next;
    this.endNoAccountCode();
    for (const listener of [...this.relinks.get(deviceId) ?? []]) listener(sessionId);
    return this.list(null).find((d) => d.id === deviceId) ?? null;
  }

  /** A pairing made on this PC (a code, or a comparison approved here) lets a removed key back in. */
  private clearTombstone(key: string): void {
    if (this.accountError !== null || !this.isTombstoned(key)) return;
    this.writeTombstones(this.tombstones.filter((t) => t.key !== key));
  }

  /**
   * Tombstones for the relay keys of rows this PC revokes, written before the revoke itself. The rows that wait to
   * link with one of those keys go next, before the revoke as well (dropWaiting).
   */
  private tombstone(rows: readonly StoredDevice[], now: number): void {
    const keys = [...new Set(rows.flatMap((d) => d.relay_public_key === undefined || this.isTombstoned(d.relay_public_key) ? [] : [d.relay_public_key]))];
    const removedAt = new Date(now).toISOString();
    const next = [...this.tombstones,
      ...keys.map((key) => ({ key, account: rows.find((d) => d.relay_public_key === key)?.account ?? "", record_id: "local", removed_at: removedAt }))];
    if (keys.length) {
      // with the main file unreadable the revoke still wins: its tombstone waits beside it
      if (this.accountError !== null) {
        writePrivateState(this.pendingTombstonePath, { v: 1, tombstones: next });
        this.tombstones = next;
      } else this.writeTombstones(next);
    }
    this.dropWaiting(rows.flatMap((d) => d.relay_public_key ?? []));
  }

  private writeTombstones(next: AccountTombstone[]): void {
    writePrivateState(this.tombstonePath, { v: 1, tombstones: next });
    this.tombstones = next;
  }

  private assertAccountWritable(): void {
    this.assertWritable();
    if (this.accountError !== null) throw new Error(this.accountError);
  }
}

export interface DeviceConnections {
  list(): Map<string, DeviceConnection>;
  check(timeoutMs: number): Promise<void>;
}

const CHECK_MS = 3_000;

/**
 * /api/devices*. Pairing itself is public, like /api/auth: it is how a device gets in. The
 * rest reaches here only through the gate in index.ts, and anything that changes the list
 * needs the app's own mutation guard (same origin + X-Herdr-Machine), like the other mutations.
 * `onRevoked` is told the id of every device a request revoked, once the registry says so: the
 * cleanup that follows (push subscriptions, page media) works from those ids, never from the path.
 */
export async function handleDeviceRequest(request: Request, pathname: string, store: DeviceStore, access: Access, relayKey: string | null, onRevoked?: (ids: string[]) => void, lanHttps = false, connections?: DeviceConnections): Promise<Response> {
  if (store.error !== null) return jsonResponse({ error: { code: "device_store_unavailable", message: access.level === "full" ? store.error : "Device pairing is unavailable; ask the owner to check Settings → Devices on the host." } }, 503);
  const json = async (): Promise<Record<string, unknown> | Response> => {
    try {
      const body = (await request.json()) as unknown;
      return isJsonObject(body) ? body : badRequest("invalid_body", "request body must be a JSON object");
    } catch { return badRequest("invalid_json", "request body must be JSON"); }
  };
  if (pathname === "/api/devices/pair") {
    setRequestRoute(pathname);
    if (access.level === "full" && access.via === "relay") return jsonResponse({ error: { code: "device_key_required", message: "Pair relay devices through the encrypted channel" } }, 403);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const body = await json();
    if (body instanceof Response) return body;
    if (typeof body["code"] !== "string") return badRequest("missing_code", "code is required");
    // the LAN HTTPS listener counts its wrong codes like the relay does, apart from it
    if (lanHttps) {
      try { store.assertRelayPairing("lan"); } catch (error) {
        if (error instanceof PairingRateLimitedError) return jsonResponse({ error: { code: error.code, message: error.message } }, 429, { "retry-after": String(error.retryAfter), "cache-control": "no-store" });
        throw error;
      }
    }
    const firstPair = !store.gated;
    const paired = store.pair(body["code"], normalizeLabel(body["label"], "Device"), "drive", Date.now(), streamKeys(request), lanHttps);
    if (paired === null) {
      if (lanHttps) store.noteRelayFailure("lan");
      return jsonResponse({ error: { code: "invalid_code", message: "the code is wrong, spent or expired; start a new pairing on the PC" } }, 401);
    }
    const cookies = [deviceCookie(paired.token, isSecureRequest(request)), CLEAR_LEGACY_DEVICE_COOKIE];
    if (!acceptsJson(request)) return noContent(...cookies);
    // a script asked for the token itself, to send as `Authorization: Device <token>` (#2744); a
    // browser never asks, so its page never reads the credential its HttpOnly cookie keeps. A first
    // pairing waits in memory for its cookie to come back; a script may store the token and use it
    // after a restart, so its pairing is confirmed (written, gate closed) before the answer
    if (firstPair) store.match(paired.token);
    const answer = jsonResponse({ token: paired.token } satisfies DevicePairToken, 200, { "cache-control": "no-store" });
    for (const cookie of cookies) answer.headers.append("set-cookie", cookie);
    return answer;
  }
  if (pathname === "/api/devices") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    const drive = access.level === "full" && access.role === "drive";
    // how the other devices are connected, and pinging them all, is for a caller that may manage them:
    // not a watching device, nor a Portal visitor, who see the list as before
    const manager = drive && access.via !== "portal";
    if (manager && connections && new URL(request.url).searchParams.get("check") === "1") await connections.check(CHECK_MS);
    const live = manager ? connections?.list() ?? new Map<string, DeviceConnection>() : new Map<string, DeviceConnection>();
    const devices = store.list(access.level === "full" ? access.device?.id ?? null : null, drive)
      .map((device) => { const connection = live.get(device.id); return connection ? { ...device, connection } : device; });
    return jsonResponse({ devices }, 200, { "cache-control": "no-store" });
  }
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return jsonResponse({ error: { code: "invalid_origin", message: "Manage devices from this app" } }, 403);
  if (access.level === "full" && access.role === "watch") return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  if (pathname === "/api/devices/pair/start") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    // a code admits whoever holds it, so through the relay to a PC in an account only those who may approve a pairing
    // may start one; a PC in no account keeps letting any driving relay device start one, as before
    if (access.level === "full" && access.via === "relay" && store.account() !== null && !(access.device && store.isAccountApproverSession(access.device.id, relayKey ?? ""))) {
      return jsonResponse({ error: { code: "account_required", message: "Start a pairing on this PC, or from a device linked to your account" } }, 403);
    }
    try {
      const remote = access.level === "full" && access.via === "relay";
      // its starter is recorded as the new device's adder; on a PC in an account that starter must stay a member
      const startedBy = remote ? access.device?.id ?? null : null;
      // the paired device that asks, through the relay or at this PC's own address: the code goes when it is revoked
      const by = access.level === "full" ? access.device?.id ?? null : null;
      const open = access.level === "full" && access.via === "open";
      return jsonResponse(store.startPairing(Date.now(), { remote, startedBy, memberRequired: remote && store.account() !== null, by, ...(open ? { open } : {}) }), 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof PairingRateLimitedError) return jsonResponse({ error: { code: error.code, message: error.message } }, 429, { "retry-after": String(error.retryAfter), "cache-control": "no-store" });
      if (error instanceof DeviceGoneError) return jsonResponse({ error: { code: error.code, message: error.message } }, 401, { "cache-control": "no-store" });
      throw error;
    }
  }
  if (pathname === "/api/devices/pair/cancel") {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    // whoever may start a code may take it back (the same rule as /pair/start)
    if (access.level === "full" && access.via === "relay" && store.account() !== null && !(access.device && store.isAccountApproverSession(access.device.id, relayKey ?? ""))) {
      return jsonResponse({ error: { code: "account_required", message: "End a pairing on this PC, or from a device linked to your account" } }, 403);
    }
    const text = await request.text();
    let body: unknown = {};
    try { if (text.trim() !== "") body = JSON.parse(text); } catch { return badRequest("invalid_json", "request body must be JSON"); }
    if (!isJsonObject(body)) return badRequest("invalid_body", "code must be the six-digit pairing code");
    const { code, id } = body;
    if (code !== undefined && (typeof code !== "string" || !/^\d{6}$/.test(code))) return badRequest("invalid_body", "code must be the six-digit pairing code");
    if (id !== undefined && (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id))) return badRequest("invalid_body", "id must be the pairing's id");
    const match = code === undefined && id === undefined ? undefined : { ...code !== undefined ? { code } : {}, ...id !== undefined ? { id } : {} };
    return jsonResponse({ ok: true, cancelled: store.endPairing(match) }, 200, { "cache-control": "no-store" });
  }
  if (pathname === "/api/devices/revoke-all") {
    setRequestRoute("/api/devices/revoke-all");
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const revoked = store.revokeAll();
    onRevoked?.(revoked);
    // the caller's own device cookie, if it holds one, names a device that is gone, under either name
    const answer = jsonResponse({ revoked: revoked.length } satisfies DevicesRevokedAll, 200, { "cache-control": "no-store" });
    answer.headers.append("set-cookie", DEVICE_COOKIE_CLEARED);
    answer.headers.append("set-cookie", CLEAR_LEGACY_DEVICE_COOKIE);
    return answer;
  }
  const id = pathname.slice("/api/devices/".length);
  setRequestRoute("/api/devices/:device_id");
  if (!/^[0-9a-f]{16}$/.test(id)) return badRequest("invalid_device", "no such device");
  if (request.method === "DELETE") {
    // `x-ovis-unless-account`: the caller removes the device because it is no member of that account (`ovis add`,
    // of a device its code let in). One that became a member of it since the caller read the list stays. The check
    // and the revoke are one step here, so no link comes between them. Membership is what the row says: a first
    // member linked itself and named its account, which nothing here proves (docs/account.md, rule 4)
    const unless = request.headers.get("x-ovis-unless-account");
    if (unless !== null && store.isMemberOf(id, unless)) return jsonResponse({ error: { code: "account_member", message: "that device is a member of the account by now" } }, 409);
    if (!store.revoke(id, access.level === "full" && access.device ? { device_id: access.device.id, label: access.device.label } : "pc")) return jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
    onRevoked?.([id]);
    return noContent();
  }
  if (request.method === "PATCH") {
    const body = await json();
    if (body instanceof Response) return body;
    const updated = store.update(id, { label: normalizeLabel(body["label"], "Device") });
    return updated ? jsonResponse(updated) : jsonResponse({ error: { code: "not_found", message: "no such device" } }, 404);
  }
  return badRequest("method_not_allowed", "use PATCH or DELETE");
}
