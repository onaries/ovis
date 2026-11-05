/**
 * Joining the account from this client (docs/account.md, "Account members", "Introductions"):
 * linking a pairing it already has, taking the introduction to the account's other PCs after a
 * remote approval, and, on the approving client, signing the new device in everywhere else. Every
 * call goes through the PC's own session (`fetch` is that PC's transport), so the PC sees which of
 * its devices is asking.
 */
import { ACCOUNT_RECORDS_MAX, AccountRecordError, accountDeviceId, newRecordId, readAccountRecord, signAccountRecord } from "../../../shared/account-records.ts";
import type { AddRecord, LinkRecord, RemoveRecord } from "../../../shared/account-records.ts";
import { isWssOrigin } from "../../../shared/relay-offer.ts";
import type { RemotePairingRequest } from "../../../shared/protocol.ts";
import type { RelayDevice, RelayDeviceStore } from "../relay/device.ts";
import { keyIdOf } from "../relay/shellState.ts";
import type { AccountService } from "./service.ts";
import type { AccountKey, AccountStore } from "./store.ts";

export type PcFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The PC refused an account request; `code` is its error code, never its words. */
export class AccountPcError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`The PC answered ${status} (${code})`);
    this.name = "AccountPcError";
  }
}

async function refusal(response: Response): Promise<AccountPcError> {
  let code = "http_error";
  try {
    const body = await response.json() as { error?: { code?: unknown } };
    if (typeof body.error?.code === "string" && /^[a-z_]{1,40}$/.test(body.error.code)) code = body.error.code;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return new AccountPcError(response.status, code);
}

export async function post(fetch: PcFetch, path: string, body: unknown): Promise<Response> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
  if (!response.ok) throw await refusal(response);
  return response;
}

export interface PcAccountStatus {
  /** the account this PC belongs to; null before its first member */
  readonly account: string | null;
  /** its relay rows that are not members */
  readonly unlinked: readonly string[];
  /** the signed `remove`s behind its tombstones, as it says: unchecked until keepRemovals verifies them */
  readonly removals: readonly unknown[];
}

export async function pcAccountStatus(fetch: PcFetch): Promise<PcAccountStatus> {
  const response = await fetch("/api/account/status");
  if (!response.ok) throw await refusal(response);
  const body = await response.json() as { account?: unknown; unlinked?: unknown; removals?: unknown };
  const unlinked = Array.isArray(body.unlinked) ? body.unlinked.filter((id): id is string => typeof id === "string") : [];
  return { account: typeof body.account === "string" ? body.account : null, unlinked, removals: Array.isArray(body.removals) ? body.removals : [] };
}

/** Whether this device's row on the PC should be linked to `account` now. */
export function needsLink(status: PcAccountStatus, device: RelayDevice, account: string): boolean {
  if (device.device_id === null) return false;
  // a PC of another account keeps this pairing as it is: the account cannot reach it
  if (status.account !== null && status.account !== account) return false;
  return status.account === null || status.unlinked.includes(device.device_id);
}

/**
 * Makes this device's row on the PC an account member: a `link` signed by the account key proves
 * both keys, and the PC swaps the row's key in one write. The device then signs in with the
 * account key there, so the saved pairing takes it too.
 */
export async function linkThisDevice(options: { fetch: PcFetch; device: RelayDevice; key: AccountKey; account: string; store: RelayDeviceStore; now?: () => number }): Promise<RelayDevice> {
  const { device, key } = options;
  if (device.device_id === null) throw new TypeError("Only a device the PC admitted can be linked");
  const record: LinkRecord = await signAccountRecord({
    v: 1, kind: "link", account: options.account, key: key.public_spki, server_id: device.server_id, device_id: device.device_id,
    old_key: device.public_spki, issued_at: new Date((options.now ?? Date.now)()).toISOString(), id: newRecordId(), signer: key.public_spki,
  }, key.private_key);
  // kept before sending: if the answer is lost after the PC swapped the key, the next sign-in tries this one
  await options.store.update(device.server_id, (current) => current === undefined ? device : { ...current, pending_key: { private_key: key.private_key, public_spki: key.public_spki } });
  await post(options.fetch, "/api/account/link", { record });
  return options.store.update(device.server_id, (current) => {
    // only the pairing the link was signed for takes the key: one changed meanwhile is left as it is
    if (current === undefined || current.device_id !== device.device_id || current.public_spki !== device.public_spki || current.server_public_key !== device.server_public_key) {
      throw new TypeError("This PC's pairing changed while it was being linked");
    }
    const { pending_key: _sent, ...rest } = current;
    return { ...rest, private_key: key.private_key, public_spki: key.public_spki, account: options.account };
  });
}

export interface IntroducedPc { readonly server_id: string; readonly server_public_key: string; readonly relay: string; readonly name: string }

/** At most this many PCs come in one introduction (docs/account.md, "Introductions"). */
export const INTRODUCTION_MAX = 32;

/** Only an introduction whose id is its key's (server/relay/identity.ts) and whose relay is a wss origin. */
function parseIntroduced(value: unknown): IntroducedPc | null {
  if (typeof value !== "object" || value === null) return null;
  const pc = value as Record<string, unknown>;
  if (typeof pc.server_id !== "string" || typeof pc.server_public_key !== "string" || typeof pc.relay !== "string" || typeof pc.name !== "string") return null;
  if (keyIdOf(pc.server_public_key) !== pc.server_id || !isWssOrigin(pc.relay) || pc.name.length > 48) return null;
  return { server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay, name: pc.name };
}

/**
 * After a remote approval on PC X: the account's other PCs as the approver checked them, saved so
 * this device signs in to each with the account key and the id the `add` gave it there. A PC this
 * device already has is left as it is. X passes the list on, so only PCs on X's own relay are kept:
 * a list that names another relay would route this device through one X chose. Returns the PCs saved.
 */
export async function takeIntroduction(options: { fetch: PcFetch; key: AccountKey; label: string; store: RelayDeviceStore; relay: string }): Promise<RelayDevice[]> {
  const response = await options.fetch("/api/account/introduction");
  if (response.status === 404) return [];
  if (!response.ok) throw await refusal(response);
  const body = await response.json() as { pcs?: unknown };
  const pcs = (Array.isArray(body.pcs) ? body.pcs.slice(0, INTRODUCTION_MAX) : []).map(parseIntroduced)
    .filter((pc): pc is IntroducedPc => pc !== null && pc.relay === options.relay);
  const saved: RelayDevice[] = [];
  for (const pc of pcs) {
    if (await options.store.get(pc.server_id) !== undefined) continue;
    saved.push(await options.store.update(pc.server_id, (current) => current ?? {
      server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay, name: pc.name,
      device_id: accountDeviceId(pc.server_id, options.key.public_spki), private_key: options.key.private_key, public_spki: options.key.public_spki, label: options.label,
      introduced_at: Date.now(),
    }));
  }
  return saved;
}

/** The account service saw no device of this account ask to join at this PC with that key. */
export class UnverifiedJoinError extends Error {
  readonly code = "unverified_device";
  constructor() {
    super("Could not verify this device");
    this.name = "UnverifiedJoinError";
  }
}

/** An admission counts for this long after the device rang (docs/account.md, "Joining through the account"). */
export const ADMISSION_MS = 10 * 60_000;

/**
 * A member's answer to a device asking through PC X. A request to join the account is approved,
 * and the device added everywhere, only when the account service itself (not X) saw a device of
 * this account ring at X with that key in the last 10 minutes: a PC that shows another key than
 * the one that rang is refused, and declined on X. A request for X alone is just answered on X.
 */
export async function approveJoin(options: {
  request: RemotePairingRequest; digits: string; through: string; service: AccountService;
  decide: (decision: "approve" | "decline", digits?: string) => Promise<void>; admit: () => Promise<unknown>; now?: () => number;
}): Promise<void> {
  const { request } = options;
  if (request.intent !== "account") { await options.decide("approve", options.digits); return; }
  const now = (options.now ?? Date.now)();
  const vouched = (await options.service.recentAdmissions()).some((admission) => admission.server_id === options.through
    && admission.key === request.key && now - Date.parse(admission.at) <= ADMISSION_MS);
  if (!vouched) {
    await options.decide("decline");
    throw new UnverifiedJoinError();
  }
  await options.decide("approve", options.digits);
  await options.admit();
}

/** How long the approver waits for PC X to let the new device in once both sides said yes. */
export const ADMITTED_MS = 120_000;
const ADMITTED_POLL_MS = 2_000;

/**
 * On the approving client, once this client approved on PC X: first the introduction to the PCs
 * this client checked itself, handed to X, which X takes only once the new device's row exists
 * (the new device confirmed too); only then an `add` for its key, put in the mailbox of every other
 * PC of the account. A device that never finishes joining X reaches no other PC.
 */
export async function admitToAccount(options: {
  fetch: PcFetch; service: AccountService; key: AccountKey; account: string;
  joining: { key: string; label: string }; through: string; paired: readonly RelayDevice[]; directory: readonly string[]; now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** where the add waits for the PCs the account service did not take it for; none, and a refusal throws */
  store?: AccountStore;
}): Promise<AddRecord> {
  const now = options.now ?? Date.now;
  // fixed wait: the pause between tries of a poll bounded by ADMITTED_MS
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const pcs = options.paired
    .filter((device) => device.device_id !== null && device.server_id !== options.through && device.public_spki === options.key.public_spki && keyIdOf(device.server_public_key) === device.server_id)
    .slice(0, INTRODUCTION_MAX)
    .map((device) => ({ server_id: device.server_id, server_public_key: device.server_public_key, relay: device.relay, name: (device.name ?? device.server_id.slice(0, 8)).slice(0, 48) }));
  const deadline = now() + ADMITTED_MS;
  for (;;) {
    try { await post(options.fetch, "/api/account/introduce", { key: options.joining.key, pcs }); break; }
    catch (error) {
      // no row for that key on X yet: the new device has not confirmed its digits
      if (!(error instanceof AccountPcError) || error.code !== "introduction_unknown_key" || now() > deadline) throw error;
      await wait(ADMITTED_POLL_MS);
    }
  }
  const add: AddRecord = await signAccountRecord({
    v: 1, kind: "add", account: options.account, key: options.joining.key, label: options.joining.label, role: "drive",
    issued_at: new Date(now()).toISOString(), id: newRecordId(), signer: options.key.public_spki,
  }, options.key.private_key);
  const others = options.directory.filter((serverId) => serverId !== options.through);
  if (!options.store) {
    for (let start = 0; start < others.length; start += 32) await options.service.postRecord(others.slice(start, start + 32), add);
    return add;
  }
  // X already let the device in: kept before it is sent, so a refusal or a lost answer is sent again;
  // and, in the same write, as a device this client checked itself, which a PC it enrolls later gets too
  await options.store.updateMany(["adds", "devices"], (current) => ({
    adds: { ...current.adds, [add.id]: { account: options.account, record: add, to: others } },
    devices: withDevice(current.devices, add),
  }));
  await sendQueuedAdds({ service: options.service, store: options.store, account: options.account });
  return add;
}

type KnownDevices = Readonly<Record<string, AddRecord | RemoveRecord>>;

/** `known` with `record` for its key, unless a record signed later is there (a removal wins a tie). */
function withDevice(known: KnownDevices | undefined, record: AddRecord | RemoveRecord): KnownDevices {
  const current = known?.[record.key];
  const later = current !== undefined && (current.issued_at > record.issued_at || (current.issued_at === record.issued_at && current.kind === "remove"));
  return later ? known! : { ...known, [record.key]: record };
}

/**
 * Keeps a record this client signed for a device of the account, which enrollPc hands a PC this
 * client brings into the account: one entry per key, the later signed one.
 */
export async function rememberDevice(store: AccountStore, record: AddRecord | RemoveRecord): Promise<void> {
  await store.update("devices", (current) => withDevice(current, record));
}

/** At most this many removals of other members are kept to relay (keepRemovals). */
export const KEPT_REMOVALS_MAX = 256;

/**
 * Keeps, verbatim, the signed `remove`s a PC of the account lists (its status' `removals`) that this
 * client can check: each must verify, be for `account`, and be signed by this client's own key, by a
 * device this client approved itself (an `add` it signed), or by one it removed, before that removal,
 * so a PC cannot fill it with removals signed by keys it made up. Nothing is signed for them: enrollPc relays them as they are (#2956).
 */
export async function keepRemovals(options: { store: AccountStore; account: string; removals: readonly unknown[] }): Promise<void> {
  const own = (await options.store.key()).public_spki;
  const known = (await options.store.get("devices")) ?? {};
  const vouched = (record: RemoveRecord) => {
    if (record.signer === own) return true;
    const mine = known[record.signer];
    return mine !== undefined && mine.account === options.account && (mine.kind === "add" || record.issued_at < mine.issued_at);
  };
  const checked: RemoveRecord[] = [];
  // read past the cap, so records that do not check cannot crowd out ones that do
  for (const value of options.removals.slice(0, KEPT_REMOVALS_MAX * 4)) {
    let record;
    try { record = await readAccountRecord(value); } catch (error) {
      if (error instanceof AccountRecordError) continue;
      throw error;
    }
    if (record?.kind === "remove" && record.account === options.account && vouched(record)) checked.push(record);
  }
  if (checked.length === 0) return;
  await options.store.update("removals", (current) => {
    const next = { ...current };
    // a record id already kept keeps its first record
    for (const record of checked) if (next[record.id] === undefined && Object.keys(next).length < KEPT_REMOVALS_MAX) next[record.id] = record;
    return next;
  });
}

/** Marks a PC this client is about to link while it had no account: enrollPc hands it the account's devices. */
export async function planEnroll(store: AccountStore, serverId: string, account: string): Promise<void> {
  await store.update("enrolls", (current) => ({ ...current, [serverId]: { account, done: [] } }));
}

/** A refusal that says nothing final about the record: the PC could not read its tombstones, so it is sent again. */
const UNDECIDED = new Set(["account_unavailable"]);

/**
 * Sends a planned PC (planEnroll) the `remove`s this client signed (docs/account.md, "Account
 * members") and the other members' removals it kept (keepRemovals), as signed, so the PC tombstones
 * those keys: one whose signer is not a member there yet waits on the PC until it is. No `add`: no
 * client can know it holds every removal of the account, so an add it signed could let a device
 * another member removed into that PC (#2956); a new PC admits the account's devices by approval.
 * `fetch` must be a session signed in with the account key on that PC, after the link. Every
 * record's outcome is read; one the PC did not answer, or could not decide on, is sent again on the
 * next call. True once nothing is left to send there.
 */
export async function enrollPc(options: { fetch: PcFetch; store: AccountStore; account: string; serverId: string }): Promise<boolean> {
  const planned = (await options.store.get("enrolls"))?.[options.serverId];
  if (planned === undefined || planned.account !== options.account) return true;
  /** the removals to send: this client's own and the ones it kept, not answered yet */
  const pending = (devices: KnownDevices | undefined, kept: Readonly<Record<string, RemoveRecord>> | undefined) => [
    ...Object.values(devices ?? {}).filter((record): record is RemoveRecord => record.kind === "remove"),
    ...Object.values(kept ?? {}),
  ].filter((record, index, all) => record.account === options.account && !planned.done.includes(record.id) && all.findIndex((other) => other.id === record.id) === index)
    // in the order they were signed: a removal of a member then comes after the removals that member signed before it
    .sort((a, b) => a.issued_at < b.issued_at ? -1 : a.issued_at > b.issued_at ? 1 : 0);
  const removes = pending(await options.store.get("devices"), await options.store.get("removals"));
  const done: string[] = [];
  const send = async (records: readonly { id: string }[]): Promise<boolean> => {
    let all = true;
    for (let start = 0; start < records.length; start += ACCOUNT_RECORDS_MAX) {
      const batch = records.slice(start, start + ACCOUNT_RECORDS_MAX);
      const answer = await (await post(options.fetch, "/api/account/records", { records: batch })).json() as { results?: unknown };
      const results = Array.isArray(answer.results) ? answer.results as { id?: unknown; outcome?: unknown; code?: unknown }[] : [];
      for (const record of batch) {
        const result = results.find((entry) => entry.id === record.id);
        const final = result?.outcome === "applied" || result?.outcome === "unchanged" || (result?.outcome === "refused" && !UNDECIDED.has(String(result.code)));
        if (final) done.push(record.id);
        else all = false;
      }
    }
    return all;
  };
  const sent = await send(removes);
  let finished = false;
  // checked in the same write that ends the plan: a record signed meanwhile (another tab) keeps it for the next call
  await options.store.updateMany(["enrolls", "devices", "removals"], (current) => {
    const entry = current.enrolls?.[options.serverId];
    if (current.enrolls === undefined || entry === undefined || entry.account !== options.account) return current;
    finished = sent && pending(current.devices, current.removals).every((record) => done.includes(record.id));
    const rest = { ...current.enrolls };
    if (finished) delete rest[options.serverId];
    else rest[options.serverId] = { ...entry, done: [...entry.done, ...done] };
    return { devices: current.devices, removals: current.removals, enrolls: Object.keys(rest).length === 0 ? undefined : rest };
  });
  return finished;
}

/**
 * What a connection to a PC of the account does for a PC this client planned to enroll (planEnroll):
 * once the PC says it belongs to the account (the link went through), enrollPc. `fetch` is a session
 * signed in with the account key there. The PC's status gives this client no record to sign.
 */
export async function enrollOnPc(options: { fetch: PcFetch; store: AccountStore; account: string; serverId: string }): Promise<boolean> {
  const status = await pcAccountStatus(options.fetch);
  if (status.account !== options.account) return false;
  return enrollPc(options);
}

/** How long a kept add is sent again: the account service's mailbox keeps a record no longer. */
export const QUEUED_ADD_MS = 30 * 24 * 60 * 60_000;

/**
 * Sends the adds this device signed that some PCs' mailboxes have not taken (admitToAccount), and
 * forgets each PC the account service took it for. A refusal or a failure keeps the rest for the
 * next try; one of another account waits for its sign-in, and one older than the mailbox keeps a record is dropped.
 */
export async function sendQueuedAdds(options: { service: AccountService; store: AccountStore; account: string; now?: () => number }): Promise<void> {
  const now = (options.now ?? Date.now)();
  const queued = Object.values((await options.store.get("adds")) ?? {});
  for (const entry of queued) {
    const sent: string[] = [];
    if (entry.account === options.account && now - Date.parse(entry.record.issued_at) <= QUEUED_ADD_MS) {
      for (let start = 0; start < entry.to.length; start += 32) {
        const batch = entry.to.slice(start, start + 32);
        try { await options.service.postRecord(batch, entry.record); sent.push(...batch); }
        catch (error) { console.warn("Ovis: an approved device's add is kept for the next try", error instanceof Error ? error.name : error); }
      }
    }
    const keep = now - Date.parse(entry.record.issued_at) <= QUEUED_ADD_MS;
    await options.store.update("adds", (current) => {
      const rest = { ...current };
      const left = (rest[entry.record.id]?.to ?? []).filter((serverId) => !sent.includes(serverId));
      if (!keep || left.length === 0) delete rest[entry.record.id];
      else rest[entry.record.id] = { ...entry, to: left };
      return Object.keys(rest).length === 0 ? undefined : rest;
    });
  }
}

