import { describe, expect, test } from "bun:test";
import {
  AccountRecordError, accountDeviceId, exportAccountKey, newRecordId, parseAccountRecord, readAccountRecord, recordSigningBytes,
  signAccountRecord, verifyAccountRecord, type AccountRecord, type UnsignedAccountRecord,
} from "./account-records.ts";
import { fromBase64Url, toBase64Url } from "./relay-pair-sas.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIGN = { name: "ECDSA", hash: "SHA-256" } as const;

async function accountKey() {
  const pair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  return { pair, spki: await exportAccountKey(pair.publicKey) };
}

const signer = await accountKey();
const other = await accountKey();
const third = await accountKey();
const issued = "2026-11-05T01:02:03.456Z";

const unsigned: { [K in AccountRecord["kind"]]: Extract<UnsignedAccountRecord, { kind: K }> } = {
  add: { v: 1, kind: "add", account: "acct_1", key: other.spki, label: "Mac app", role: "drive", issued_at: issued, id: newRecordId(), signer: signer.spki },
  remove: { v: 1, kind: "remove", account: "acct_1", key: other.spki, issued_at: issued, id: newRecordId(), signer: signer.spki },
  link: { v: 1, kind: "link", account: "acct_1", key: signer.spki, server_id: "0123456789abcdef0123456789abcdef", device_id: "0123456789abcdef", old_key: other.spki, issued_at: issued, id: newRecordId(), signer: signer.spki },
};

/** Another valid value for each field, so a mutation still parses and only the signature can refuse it. */
const alternatives: Record<string, string> = {
  account: "acct_2", key: third.spki, label: "Windows app", role: "watch", server_id: "f".repeat(32),
  device_id: "f".repeat(16), old_key: third.spki, issued_at: "2026-11-05T01:02:03.457Z", id: newRecordId(), signer: third.spki,
};

describe("account records", () => {
  for (const kind of ["add", "remove", "link"] as const) {
    test(`a signed ${kind} survives JSON and verifies`, async () => {
      const record = await signAccountRecord(unsigned[kind], signer.pair.privateKey);
      const read = await readAccountRecord(JSON.parse(JSON.stringify(record)));
      expect(read).toEqual(record);
    });

    test(`a ${kind}'s signature covers every field`, async () => {
      const record = await signAccountRecord(unsigned[kind], signer.pair.privateKey);
      const fields = Object.keys(record).filter((name) => name !== "signature" && name !== "v" && name !== "kind");
      for (const name of fields) {
        const changed = { ...record, [name]: alternatives[name] } as AccountRecord;
        // a link's signer is its key; moving one without the other is refused before the signature
        if (kind === "link" && (name === "key" || name === "signer")) {
          expect(() => parseAccountRecord(changed)).toThrow(AccountRecordError);
          continue;
        }
        expect({ name, verified: await verifyAccountRecord(parseAccountRecord(changed)) }).toEqual({ name, verified: false });
      }
      const otherKind = kind === "remove"
        ? { ...record, kind: "add", label: "Mac app", role: "drive" }
        : { v: 1, kind: "remove", account: record.account, key: record.kind === "link" ? other.spki : record.key, issued_at: record.issued_at, id: record.id, signer: record.signer, signature: record.signature };
      expect(await verifyAccountRecord(parseAccountRecord(otherKind))).toBe(false);
    });
  }

  test("malformed records are refused before any signature check", async () => {
    const add = await signAccountRecord(unsigned.add, signer.pair.privateKey);
    const link = await signAccountRecord(unsigned.link, signer.pair.privateKey);
    const { label: _label, ...missingLabel } = add;
    const flipped = fromBase64Url(add.key);
    flipped[0] = 0x31;
    const bad: unknown[] = [
      null, [], "add", { ...add, v: 2 }, { ...add, kind: "rename" }, { ...add, extra: 1 }, missingLabel,
      { ...add, key: add.key.slice(0, -1) }, { ...add, key: toBase64Url(flipped) }, { ...add, key: `${add.key}=` },
      { ...add, label: "" }, { ...add, label: " Mac" }, { ...add, label: "Mac  app" }, { ...add, label: "Mac\u0007" }, { ...add, label: "Mac\ud800" }, { ...add, label: "x".repeat(49) },
      { ...add, role: "owner" }, { ...add, account: "acct 1" }, { ...add, account: "a".repeat(65) },
      { ...add, issued_at: "2026-11-05T01:02:03Z" }, { ...add, issued_at: "2026-02-30T01:02:03.000Z" },
      { ...add, id: "A".repeat(32) }, { ...add, signature: "A".repeat(85) }, { ...add, signer: add.key },
      { ...link, signer: other.spki }, { ...link, server_id: "F".repeat(32) }, { ...link, device_id: "0".repeat(15) },
    ];
    for (const value of bad) expect(() => parseAccountRecord(value)).toThrow(AccountRecordError);
  });

  test("a key off the curve verifies as false instead of throwing", async () => {
    const record = await signAccountRecord(unsigned.remove, signer.pair.privateKey);
    const offCurve = toBase64Url(Uint8Array.from([...fromBase64Url(record.signer).subarray(0, 27), ...new Uint8Array(64).fill(1)]));
    expect(await verifyAccountRecord({ ...record, signer: offCurve })).toBe(false);
  });

  test("record and AUTH signatures cannot stand in for each other", async () => {
    const serverId = "0123456789abcdef0123456789abcdef";
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    // AUTH as server/devices.ts matchRelay verifies it: `ovis-relay-auth/1 || nonce || server_id`
    const auth = new Uint8Array([...new TextEncoder().encode("ovis-relay-auth/1"), ...nonce, ...new TextEncoder().encode(serverId)]);
    const authSignature = new Uint8Array(await crypto.subtle.sign(SIGN, signer.pair.privateKey, auth));
    for (const kind of ["add", "remove", "link"] as const) {
      const record = await signAccountRecord(unsigned[kind], signer.pair.privateKey);
      expect(await verifyAccountRecord({ ...record, signature: toBase64Url(authSignature) })).toBe(false);
      expect(await crypto.subtle.verify(SIGN, signer.pair.publicKey, fromBase64Url(record.signature) as Uint8Array<ArrayBuffer>, auth)).toBe(false);
      const bytes = recordSigningBytes(unsigned[kind]);
      const firstDifference = bytes.findIndex((byte, index) => byte !== auth[index]);
      expect(firstDifference).toBeLessThan(new TextEncoder().encode("ovis-account/1").length);
    }
  });

  test("fields are length-delimited, so moving bytes across a boundary changes the signed bytes", () => {
    const a = recordSigningBytes({ ...unsigned.remove, account: "ab", key: "c" });
    const b = recordSigningBytes({ ...unsigned.remove, account: "a", key: "bc" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

test("an added device's id is the first 16 hex of SHA-256 over the domain, the PC and the key, so both ends agree", async () => {
  const serverId = "0123456789abcdef0123456789abcdef";
  const expected = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ovis-account-device/1${serverId}${other.spki}`))).toString("hex").slice(0, 16);
  expect(accountDeviceId(serverId, other.spki)).toBe(expected);
  expect(accountDeviceId(serverId, other.spki)).toMatch(/^[0-9a-f]{16}$/);
  expect(accountDeviceId("f".repeat(32), other.spki)).not.toBe(expected);
});
