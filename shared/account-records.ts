/**
 * Account records (docs/account.md, "Records"): `add`, `remove` and `link`, each signed on its own
 * by a client's account key. The PC and the apps both import this file, so it reads no environment
 * and uses WebCrypto only.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

/** Signing bytes start with this; `AUTH` signs `ovis-relay-auth/1 ...`, which differs at the sixth byte. */
export const ACCOUNT_RECORD_PREFIX = "ovis-account/1";
/** Records one `/api/account/records` request may carry. */
export const ACCOUNT_RECORDS_MAX = 32;
/** Records one `/api/account/enroll` request may carry: the account's removes and adds, in one ordered batch. */
export const ACCOUNT_ENROLL_MAX = 512;
export const ACCOUNT_LABEL_MAX = 48;

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;
/** DER of SubjectPublicKeyInfo { id-ecPublicKey, prime256v1 } and the BIT STRING header of an uncompressed point. */
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
  0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
]);
const SPKI_BYTES = 91;

export type AccountRecordKind = "add" | "remove" | "link";

interface Common {
  readonly v: 1;
  readonly account: string;
  readonly key: string;
  readonly issued_at: string;
  readonly id: string;
  readonly signer: string;
  readonly signature: string;
}
export interface AddRecord extends Common { readonly kind: "add"; readonly label: string; readonly role: "drive" | "watch" }
export interface RemoveRecord extends Common { readonly kind: "remove" }
export interface LinkRecord extends Common { readonly kind: "link"; readonly server_id: string; readonly device_id: string; readonly old_key: string }
export type AccountRecord = AddRecord | RemoveRecord | LinkRecord;

type Unsigned<T> = T extends AccountRecord ? Omit<T, "signature"> : never;
export type UnsignedAccountRecord = Unsigned<AccountRecord>;

/** Every field after `v` that the signature covers, in signing order. */
const FIELDS = {
  add: ["kind", "account", "key", "label", "role", "issued_at", "id", "signer"],
  remove: ["kind", "account", "key", "issued_at", "id", "signer"],
  link: ["kind", "account", "key", "server_id", "device_id", "old_key", "issued_at", "id", "signer"],
} as const satisfies Record<AccountRecordKind, readonly string[]>;

export class AccountRecordError extends Error {
  readonly code = "record_invalid";
}

function fail(message: string): never {
  throw new AccountRecordError(message);
}

/** Whether `text` is a P-256 public key as SPKI in canonical base64url; whether the point is on the curve is WebCrypto's to say. */
export function isAccountKey(text: unknown): text is string {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{122}$/.test(text)) return false;
  const bytes = fromBase64Url(text);
  return bytes.length === SPKI_BYTES && toBase64Url(bytes) === text && SPKI_PREFIX.every((byte, index) => bytes[index] === byte);
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const checks: Record<string, (value: unknown) => boolean> = {
  account: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v),
  key: isAccountKey,
  signer: isAccountKey,
  old_key: isAccountKey,
  // the form normalizeLabel (server/devices.ts) leaves, so a PC stores exactly what was signed
  // a lone surrogate encodes as U+FFFD, so two labels would share one signature
  label: (v) => typeof v === "string" && v.length >= 1 && v.length <= ACCOUNT_LABEL_MAX
    && !/[\p{Cc}\p{Cs}]/u.test(v) && v === v.replace(/\s+/g, " ").trim(),
  role: (v) => v === "drive" || v === "watch",
  server_id: (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v),
  device_id: (v) => typeof v === "string" && /^[0-9a-f]{16}$/.test(v),
  issued_at: (v) => typeof v === "string" && ISO_MS.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v,
  id: (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v),
  signature: (v) => typeof v === "string" && /^[A-Za-z0-9_-]{86}$/.test(v) && toBase64Url(fromBase64Url(v)) === v,
};

/** A record from the wire, with every field checked and nothing extra; throws AccountRecordError. Says nothing about the signature. */
export function parseAccountRecord(value: unknown): AccountRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("A record is a JSON object");
  const object = value as Record<string, unknown>;
  const kind = object.kind;
  if (kind !== "add" && kind !== "remove" && kind !== "link") fail("Unknown record kind");
  if (object.v !== 1) fail("Unknown record version");
  const fields: readonly string[] = FIELDS[kind];
  const expected = new Set(["v", "signature", ...fields]);
  for (const name of Object.keys(object)) if (!expected.has(name)) fail(`Unexpected field ${name}`);
  for (const name of [...fields, "signature"]) {
    if (name === "kind") continue;
    if (!checks[name]?.(object[name])) fail(`Invalid ${name}`);
  }
  if (kind === "link" && object.signer !== object.key) fail("A link is signed by the key it links to");
  if (kind === "add" && object.signer === object.key) fail("A key cannot add itself");
  return object as unknown as AccountRecord;
}

/** `ovis-account/1`, then `v` and every field in signing order, each as a 4-byte big-endian length and its UTF-8 bytes. */
export function recordSigningBytes(record: UnsignedAccountRecord): Uint8Array {
  const encoder = new TextEncoder();
  const fields = FIELDS[record.kind] as readonly (keyof typeof record)[];
  const parts = [encoder.encode(String(record.v)), ...fields.map((name) => encoder.encode(String(record[name])))];
  const prefix = encoder.encode(ACCOUNT_RECORD_PREFIX);
  const bytes = new Uint8Array(prefix.length + parts.reduce((sum, part) => sum + 4 + part.length, 0));
  bytes.set(prefix);
  const view = new DataView(bytes.buffer);
  let offset = prefix.length;
  for (const part of parts) {
    view.setUint32(offset, part.length);
    bytes.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return bytes;
}

/** Signs with the client's account key; `record.signer` must be that key's public half. */
export async function signAccountRecord<T extends UnsignedAccountRecord>(record: T, privateKey: CryptoKey): Promise<T & { signature: string }> {
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN, privateKey, recordSigningBytes(record) as Uint8Array<ArrayBuffer>));
  const signed = { ...record, signature: toBase64Url(signature) };
  parseAccountRecord(signed);
  return signed;
}

/** Whether `record.signature` is `record.signer`'s over its signing bytes. False, never a throw, for a key off the curve. */
export async function verifyAccountRecord(record: AccountRecord): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", fromBase64Url(record.signer) as Uint8Array<ArrayBuffer>, P256, false, ["verify"]);
    const { signature, ...unsigned } = record;
    return await crypto.subtle.verify(SIGN, key, fromBase64Url(signature) as Uint8Array<ArrayBuffer>, recordSigningBytes(unsigned as UnsignedAccountRecord) as Uint8Array<ArrayBuffer>);
  } catch (error) {
    if (error instanceof DOMException || error instanceof TypeError) return false;
    throw error;
  }
}

/** Parses and verifies; throws AccountRecordError for a malformed record and returns null for a bad signature. */
export async function readAccountRecord(value: unknown): Promise<AccountRecord | null> {
  const record = parseAccountRecord(value);
  return await verifyAccountRecord(record) ? record : null;
}

export function newRecordId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function exportAccountKey(publicKey: CryptoKey): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", publicKey)));
}

/** The id a PC gives a device an `add` puts there; the client works out the same to sign in (docs/account.md, "Account members"). */
export function accountDeviceId(serverId: string, devicePublicKey: string): string {
  return bytesToHex(sha256(utf8ToBytes(`ovis-account-device/1${serverId}${devicePublicKey}`))).slice(0, 16);
}
