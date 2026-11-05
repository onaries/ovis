/**
 * Applying account records to this PC's devices.json (docs/account.md, "Account members" and
 * "Records"). The device list stays the only authority: a record changes it only when its signer is
 * a drive member of this PC's account, and never lets a removed key back in.
 */
import { accountDeviceId, AccountRecordError, ACCOUNT_RECORDS_MAX, parseAccountRecord, verifyAccountRecord, type AccountRecord, type LinkRecord } from "../../shared/account-records.ts";
import type { DeviceStore } from "../devices.ts";
import type { PairedDevice } from "../../shared/protocol.ts";

export type RecordRefusal = "record_invalid" | "signature_invalid" | "account_mismatch" | "signer_not_member" | "tombstoned" | "link_not_owner" | "account_unavailable";
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
function apply(store: DeviceStore, record: AccountRecord, serverId: string | null, now: number): RecordOutcome {
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
  if (store.hasKey(record.key)) return { id: record.id, outcome: "unchanged" };
  // the new row's id is derived from this PC's relay id (docs/account.md), so without one there is no row to make
  if (serverId === null) return refused("account_unavailable");
  const id = accountDeviceId(serverId, record.key);
  if (store.has(id)) return refused("record_invalid");
  store.addAccountDevice({ id, key: record.key, label: record.label, role: record.role, account: record.account, addedBy: signer.id }, now);
  return { id: record.id, outcome: "applied" };
}

/** Every record of a batch, in order; one refusal never fails the rest. At most ACCOUNT_RECORDS_MAX. */
export async function applyAccountRecords(store: DeviceStore, values: readonly unknown[], serverId: string | null, now = Date.now()): Promise<RecordOutcome[]> {
  if (values.length > ACCOUNT_RECORDS_MAX) throw new RangeError(`At most ${ACCOUNT_RECORDS_MAX} records at once`);
  const outcomes: RecordOutcome[] = [];
  for (const value of values) {
    const record = await read(value);
    outcomes.push("refused" in record ? { id: record.id, outcome: "refused", code: record.refused } : apply(store, record, serverId, now));
  }
  return outcomes;
}

export type LinkRefusal = RecordRefusal | "key_in_use";

/**
 * A `link` from the device `deviceId` over its own session to the PC `serverId`. It needs no
 * member: the session is its authority, which is how a PC gets its first one.
 */
export async function applyLink(store: DeviceStore, value: unknown, session: { deviceId: string; serverId: string; sessionKey: string; sessionId?: string }): Promise<{ device: PairedDevice } | { refused: LinkRefusal }> {
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
  if (store.keyHeldByOther(link.key, deviceId)) return { refused: "key_in_use" };
  const device = store.linkAccountKey(deviceId, link.old_key, link.key, link.account, sessionId);
  return device ? { device } : { refused: "link_not_owner" };
}
