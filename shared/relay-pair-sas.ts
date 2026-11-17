import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export const PAIR_APPROVAL_MS = 90_000;
export const PAIR_NONCE_BYTES = 32;

const COMMIT_DOMAIN = utf8ToBytes("ovis-relay-pair-commit/1");
const DIGITS_DOMAIN = utf8ToBytes("ovis-relay-pair-digits/1");

export function fromBase64Url(text: string): Uint8Array {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function checkInputs(binding: Uint8Array, nonces: readonly Uint8Array[]): void {
  if (binding.length !== 32 || nonces.some((nonce) => nonce.length !== PAIR_NONCE_BYTES)) throw new TypeError("Invalid pairing input");
}

export function pairCommitment(binding: Uint8Array, devicePublicKey: string, phoneNonce: Uint8Array): Uint8Array {
  checkInputs(binding, [phoneNonce]);
  return sha256(concatBytes(COMMIT_DOMAIN, binding, utf8ToBytes(devicePublicKey), phoneNonce));
}

export function commitmentHolds(commitment: Uint8Array, binding: Uint8Array, devicePublicKey: string, phoneNonce: Uint8Array): boolean {
  if (commitment.length !== 32) return false;
  const expected = pairCommitment(binding, devicePublicKey, phoneNonce);
  let difference = 0;
  for (let index = 0; index < 32; index++) difference |= (expected[index] ?? 0) ^ (commitment[index] ?? 0);
  return difference === 0;
}

export function pairDigits(binding: Uint8Array, devicePublicKey: string, phoneNonce: Uint8Array, pcNonce: Uint8Array): string {
  checkInputs(binding, [phoneNonce, pcNonce]);
  const digest = sha256(concatBytes(DIGITS_DOMAIN, binding, utf8ToBytes(devicePublicKey), phoneNonce, pcNonce));
  const value = new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0);
  return String(value % 1_000_000n).padStart(6, "0");
}

export function randomPairNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(PAIR_NONCE_BYTES));
}
