/**
 * Applying account records to this PC's devices.json (docs/account.md, "Account members" and
 * "Records"). The device list stays the only authority: a record changes it only when its signer is
 * a drive member of this PC's account, and never lets a removed key back in.
 */
import { accountDeviceId, AccountRecordError, ACCOUNT_RECORDS_MAX, parseAccountRecord, verifyAccountRecord, type AccountRecord, type LinkRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import type { PairedDevice } from "../../shared/protocol.ts";

export type RecordRefusal = "record_invalid" | "signature_invalid" | "account_mismatch" | "signer_not_member" | "tombstoned" | "link_not_owner" | "account_unavailable" | "enrolling" | "removal_pending";

/** What holds an `add` back on this PC (mailbox.ts `gates`, docs/account.md "Enrolling a PC"). */
export interface AddGates {
  /** the PC waits for the member that linked it first to hand it the account's devices */
  enrolling(): boolean;
  /** a waiting remove or a held key names `key`, or what waits cannot be trusted to be complete */
  held(key: string): boolean;
  /** a remove waiting here names `key` (an add it signed waits until that settles) */
  removing?(key: string): boolean;
}
export type RecordOutcome = { id: string | null; outcome: "applied" | "unchanged" } | { id: string | null; outcome: "refused"; code: RecordRefusal };

async function read(value: unknown): Promise<AccountRecord | { refused: RecordRefusal; id: string | null }> {
  const id = typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : null;
  let record: AccountRecord;
  try { record = parseAccountRecord(value); } catch (error) {
    if (error instanceof AccountRecordError) return { refused: "record_invalid", id };
    throw error;
  }
  return await verifyAccountRecord(record) ? record : { refused: "signature_invalid", id: record.id };
}

/** One `add` or `remove`, after its signature held. A `link` never applies here: only its own row's session sends it. */
function apply(store: DeviceStore, record: AccountRecord, serverId: string | null, now: number, gates?: AddGates): RecordOutcome {
  const refused = (code: RecordRefusal): RecordOutcome => ({ id: record.id, outcome: "refused", code });
  if (record.kind === "link") return refused("link_not_owner");
  if (store.accountError !== null) return refused("account_unavailable");
  const account = store.account();
  if (account !== null && account !== record.account) return refused("account_mismatch");
  // a member of any role may sign the remove of its own key: that is how a device leaves (docs/account.md)
  const leaving = record.kind === "remove" && record.signer === record.key;
  const signer = store.accountSigner(record.signer, record.account, leaving);
  if (!signer) return refused("signer_not_member");
  if (record.kind === "remove") return { id: record.id, outcome: store.removeAccountKey(record.key, record.account, { id: record.id, issuedAt: record.issued_at, by: { device_id: signer.id, label: signer.label }, signed: record }, now) ? "applied" : "unchanged" };
  // the signature covers the signer only: a key off the curve would leave a devices.json no store can read
  if (!store.acceptsRelayKey(record.key)) return refused("record_invalid");
  if (store.isTombstoned(record.key)) return refused("tombstoned");
  if (store.hasKey(record.key)) {
    // kept on the row this signer's approval made here, so a client can hand it to a PC it enrolls later
    store.keepAccountAdd(record, signer.id);
    return { id: record.id, outcome: "unchanged" };
  }
  if (gates?.enrolling()) return refused("enrolling");
  // a key this PC holds back, or a signer it holds back (a remove for it waits here): the add waits for that to settle
  if (gates?.held(record.key) || gates?.removing?.(record.signer)) return refused("removal_pending");
  // the new row's id is derived from this PC's relay id (docs/account.md), so without one there is no row to make
  if (serverId === null) return refused("account_unavailable");
  const id = accountDeviceId(serverId, record.key);
  if (store.has(id)) return refused("record_invalid");
  store.addAccountDevice({ id, key: record.key, label: record.label, role: record.role, account: record.account, addedBy: signer.id, record }, now);
  return { id: record.id, outcome: "applied" };
}

/**
 * A remove refused only because its signer is not a member here yet, handed to `wait` before the next
 * record applies, so an add for the same key later in the batch already meets it (AddGates.held).
 * One `wait` could not keep is undecided (`account_unavailable`): its sender tries again.
 */
function waited(outcome: RecordOutcome, record: AccountRecord, value: unknown, wait: ((record: unknown) => boolean) | undefined, undecided: Set<string>): RecordOutcome {
  if (wait === undefined || record.kind !== "remove" || outcome.outcome !== "refused" || outcome.code !== "signer_not_member") return outcome;
  if (wait(value)) return outcome;
  // not kept anywhere: the rest of the batch still treats its key as removed
  undecided.add(record.key);
  return { id: outcome.id, outcome: "refused", code: "account_unavailable" };
}

/** `gates` with the keys of this batch's removes that could not be kept: an add for one is held back too. */
function withUndecided(gates: AddGates | undefined, undecided: ReadonlySet<string>): AddGates {
  return { enrolling: () => gates?.enrolling() ?? false, held: (key) => undecided.has(key) || (gates?.held(key) ?? false), removing: (key) => undecided.has(key) || (gates?.removing?.(key) ?? false) };
}

/** Every record of a batch, in order; one refusal never fails the rest. At most ACCOUNT_RECORDS_MAX. */
export async function applyAccountRecords(store: DeviceStore, values: readonly unknown[], serverId: string | null, now = Date.now(), gates?: AddGates, wait?: (record: unknown) => boolean): Promise<RecordOutcome[]> {
  if (values.length > ACCOUNT_RECORDS_MAX) throw new RangeError(`At most ${ACCOUNT_RECORDS_MAX} records at once`);
  const outcomes: RecordOutcome[] = [];
  const undecided = new Set<string>();
  const batchGates = withUndecided(gates, undecided);
  for (const value of values) {
    const record = await read(value);
    outcomes.push("refused" in record ? { id: record.id, outcome: "refused", code: record.refused } : waited(apply(store, record, serverId, now, batchGates), record, value, wait, undecided));
  }
  return outcomes;
}

/**
 * An enrollment (POST /api/account/enroll, docs/account.md "Enrolling a PC"), in the server's order
 * whatever the client's: every `remove` first, in the order signed, then the `add`s in rounds, so an
 * add whose signer another add of the batch lets in applies in the next round. After each round
 * `settle` retries what waits here, so a remove whose signer just became a member applies before the
 * next round's adds. `wait` keeps a remove refused only for its signer; false when it could not.
 */
export async function applyEnrollment(store: DeviceStore, values: readonly unknown[], serverId: string | null, options: {
  gates: AddGates; wait: (record: unknown) => boolean; settle: () => Promise<unknown>; now?: number;
}): Promise<RecordOutcome[]> {
  const now = options.now ?? Date.now();
  const undecided = new Set<string>();
  const gates = withUndecided(options.gates, undecided);
  const outcomes: (RecordOutcome | undefined)[] = values.map(() => undefined);
  const records = await Promise.all(values.map(read));
  const removes: number[] = [];
  let adds: number[] = [];
  records.forEach((record, index) => {
    if ("refused" in record) outcomes[index] = { id: record.id, outcome: "refused", code: record.refused };
    else if (record.kind === "remove") removes.push(index);
    else adds.push(index);
  });
  const record = (index: number): AccountRecord => {
    const value = records[index];
    if (value === undefined || "refused" in value) throw new Error("Only a record that verified is applied");
    return value;
  };
  const signed = (index: number) => record(index).issued_at;
  for (const index of removes.sort((a, b) => signed(a) < signed(b) ? -1 : signed(a) > signed(b) ? 1 : 0)) {
    outcomes[index] = waited(apply(store, record(index), serverId, now, gates), record(index), values[index], options.wait, undecided);
  }
  for (let progress = true; progress && adds.length;) {
    progress = false;
    const next: number[] = [];
    for (const index of adds) {
      const outcome = apply(store, record(index), serverId, now, gates);
      outcomes[index] = outcome;
      if (outcome.outcome === "refused" && outcome.code === "signer_not_member") next.push(index);
      else if (outcome.outcome === "applied") progress = true;
    }
    adds = next;
    if (progress) await options.settle();
  }
  return outcomes.map((outcome) => {
    if (outcome === undefined) throw new Error("Every record of an enrollment has an outcome");
    return outcome;
  });
}

export type LinkRefusal = RecordRefusal | "key_in_use";

/**
 * A `link` from the device `deviceId` over its own session to the PC `serverId`. It needs no
 * member: the session is its authority, which is how a PC gets its first one.
 */
export async function applyLink(store: DeviceStore, value: unknown, session: { deviceId: string; serverId: string; sessionKey: string; sessionId?: string }, gates?: AddGates): Promise<{ device: PairedDevice } | { refused: LinkRefusal }> {
  const { deviceId, serverId, sessionKey, sessionId } = session;
  const record = await read(value);
  if ("refused" in record) return { refused: record.refused };
  if (record.kind !== "link") return { refused: "record_invalid" };
  const link: LinkRecord = record;
  // a session signed in with an older key of the row cannot move it on: only the key it proved may be replaced
  if (link.server_id !== serverId || link.device_id !== deviceId || link.old_key !== sessionKey) return { refused: "link_not_owner" };
  if (store.accountError !== null) return { refused: "account_unavailable" };
  const account = store.account();
  if (account !== null && account !== link.account) return { refused: "account_mismatch" };
  if (store.isTombstoned(link.key)) return { refused: "tombstoned" };
  // a row moving to a key this PC holds back would let that key in without anyone approving it here
  if (link.key !== link.old_key && gates?.held(link.key)) return { refused: "removal_pending" };
  if (store.keyHeldByOther(link.key, deviceId)) return { refused: "key_in_use" };
  const device = store.linkAccountKey(deviceId, link.old_key, link.key, link.account, sessionId);
  return device ? { device } : { refused: "link_not_owner" };
}
