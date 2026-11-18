import { expect, test } from "bun:test";
import {
  RELAY_PASS_EXPIRED, RELAY_PASS_INVALID, RELAY_PASS_LIFETIME_S, RELAY_PASS_REQUIRED, RELAY_PASS_SKEW_S,
  checkRelayPass, importRelayPassKey, parseRelayPass, relayPassAdmitsNewSessions, signRelayPass,
} from "./relay-pass.ts";

const SID = "0123456789abcdef0123456789abcdef";
const NOW = 1_800_000_000;

async function issuer(kid = "a1b2c3d4") {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const hex = Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const keys = new Map([[kid, await importRelayPassKey(hex)]]);
  return { kid, keys, sign: (sid = SID, now = NOW) => signRelayPass(pair.privateKey, kid, sid, now),
    signAdmitting: (newSessions: boolean) => signRelayPass(pair.privateKey, kid, SID, NOW, undefined, { newSessions }) };
}

const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("a v2 pass says whether new client sessions to the PC are allowed; a v1 pass always allows them", async () => {
  const { keys, sign, signAdmitting } = await issuer();
  const base = { kid: "a1b2c3d4", aud: "ovis-relay", sid: SID, iat: NOW, exp: NOW + RELAY_PASS_LIFETIME_S } as const;
  const closed = await checkRelayPass(await signAdmitting(false), keys, SID, NOW);
  expect(closed).toEqual({ ok: true, payload: { v: 2, ...base, new: 0 } });
  const open = await checkRelayPass(await signAdmitting(true), keys, SID, NOW);
  expect(open).toEqual({ ok: true, payload: { v: 2, ...base, new: 1 } });
  const v1 = await checkRelayPass(await sign(), keys, SID, NOW);
  expect(v1).toEqual({ ok: true, payload: { v: 1, ...base } });
  expect([closed, open, v1].map((check) => check.ok && relayPassAdmitsNewSessions(check.payload))).toEqual([false, true, true]);
});

test("a v2 pass whose new-session field was edited does not hold, and only the exact v2 shape parses", async () => {
  const { keys, signAdmitting } = await issuer();
  const pass = await signAdmitting(false);
  const [, body, sig] = pass.split(".") as [string, string, string];
  const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
  // the signature covers the whole payload: neither flipping the field nor dropping it back to v1 holds
  expect(await checkRelayPass(`ovp1.${encode({ ...payload, new: 1 })}.${sig}`, keys, SID, NOW)).toEqual({ ok: false, reason: RELAY_PASS_INVALID });
  const { new: _new, ...v1 } = payload;
  expect(await checkRelayPass(`ovp1.${encode({ ...v1, v: 1 })}.${sig}`, keys, SID, NOW)).toEqual({ ok: false, reason: RELAY_PASS_INVALID });
  for (const bad of [{ ...payload, new: 2 }, { ...payload, new: true }, { ...payload, new: "0" }, v1, { ...payload, v: 1 }, { ...v1, v: 1, new: 1 }, { ...payload, v: 3 }, { ...payload, extra: 0 }]) {
    expect(parseRelayPass(`ovp1.${encode(bad)}.${sig}`)).toBeNull();
  }
});

test("a pass the service signed holds for its PC until it expires, with the skew allowed", async () => {
  const { keys, sign } = await issuer();
  const pass = await sign();
  expect(pass.length).toBeLessThan(300);
  const check = await checkRelayPass(pass, keys, SID, NOW + 60);
  expect(check).toEqual({ ok: true, payload: { v: 1, kid: "a1b2c3d4", aud: "ovis-relay", sid: SID, iat: NOW, exp: NOW + RELAY_PASS_LIFETIME_S } });
  expect((await checkRelayPass(pass, keys, SID, NOW - RELAY_PASS_SKEW_S)).ok).toBe(true);
  expect((await checkRelayPass(pass, keys, SID, NOW + RELAY_PASS_LIFETIME_S + RELAY_PASS_SKEW_S - 1)).ok).toBe(true);
  expect(await checkRelayPass(pass, keys, SID, NOW + RELAY_PASS_LIFETIME_S + RELAY_PASS_SKEW_S)).toEqual({ ok: false, reason: RELAY_PASS_EXPIRED });
});

test("a pass good for longer than the service issues them is refused", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const keys = new Map([["a1b2c3d4", await importRelayPassKey(Array.from(raw, (byte) => byte.toString(16).padStart(2, "0")).join(""))]]);
  const long = await signRelayPass(pair.privateKey, "a1b2c3d4", SID, NOW, RELAY_PASS_LIFETIME_S + 1);
  expect(await checkRelayPass(long, keys, SID, NOW)).toEqual({ ok: false, reason: RELAY_PASS_INVALID });
  expect((await checkRelayPass(await signRelayPass(pair.privateKey, "a1b2c3d4", SID, NOW, RELAY_PASS_LIFETIME_S), keys, SID, NOW)).ok).toBe(true);
});

test("no pass is required, not invalid", async () => {
  const { keys } = await issuer();
  for (const missing of [null, undefined, ""]) expect(await checkRelayPass(missing, keys, SID, NOW)).toEqual({ ok: false, reason: RELAY_PASS_REQUIRED });
});

test("a pass is refused for another PC, from the future, under an unknown key or another signer", async () => {
  const { keys, sign } = await issuer();
  const other = await issuer();
  const stranger = await issuer("ffffffff");
  const invalid = { ok: false, reason: RELAY_PASS_INVALID } as const;
  expect(await checkRelayPass(await sign(), keys, "f".repeat(32), NOW)).toEqual(invalid);
  expect(await checkRelayPass(await sign(SID, NOW + RELAY_PASS_SKEW_S + 1), keys, SID, NOW)).toEqual(invalid);
  expect(await checkRelayPass(await stranger.sign(), keys, SID, NOW)).toEqual(invalid);
  // same kid, another key: the signature is what fails
  expect(await checkRelayPass(await other.sign(), keys, SID, NOW)).toEqual(invalid);
});

test("an edited payload or signature does not hold", async () => {
  const { keys, sign } = await issuer();
  const pass = await sign();
  const [, body, sig] = pass.split(".") as [string, string, string];
  const payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
  const forged = btoa(JSON.stringify({ ...payload, exp: payload.exp + 3600 })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect((await checkRelayPass(`ovp1.${forged}.${sig}`, keys, SID, NOW)).ok).toBe(false);
  const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
  expect((await checkRelayPass(`ovp1.${body}.${flipped}`, keys, SID, NOW)).ok).toBe(false);
});

test("only the exact shape parses", async () => {
  const { sign } = await issuer();
  const pass = await sign();
  const [, body, sig] = pass.split(".") as [string, string, string];
  const base = { v: 1, kid: "a1b2c3d4", aud: "ovis-relay", sid: SID, iat: NOW, exp: NOW + 10 };
  expect(parseRelayPass(pass)).not.toBeNull();
  for (const bad of [
    `ovp2.${body}.${sig}`, `ovp1.${body}`, `ovp1.${body}.${sig}.x`, `ovp1.${body}.${sig.slice(4)}`, `ovp1.${body}+.${sig}`,
    `ovp1.${encode({ ...base, extra: 1 })}.${sig}`, `ovp1.${encode({ ...base, aud: "other" })}.${sig}`,
    `ovp1.${encode({ ...base, exp: NOW })}.${sig}`, `ovp1.${encode({ ...base, sid: "ABC" })}.${sig}`,
    `ovp1.${encode({ ...base, iat: 1.5 })}.${sig}`, `ovp1.${encode([base])}.${sig}`, "x".repeat(600), 42,
  ]) expect(parseRelayPass(bad)).toBeNull();
});
