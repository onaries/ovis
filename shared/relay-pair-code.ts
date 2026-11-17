/** draft-irtf-cfrg-cpace-21, cipher suite CPACE-RISTR255-SHA512, initiator-responder */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

type RistrettoPoint = InstanceType<typeof ristretto255.Point>;

export const PAIR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_CODE_CHARS = 10;
export const NAMEPLATE_CHARS = 3;
export const NAMEPLATE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{3}$/;
export const PAIR_CODE_TRIES = 3;
export const PAIR_CODE_MAX_FRAME = 4096;

export const PAIR_ATTEMPT_BYTES = 16;

export const PAIR_CLOSE = {
  NO_HOST: 4404,
  TAKEN: 4409,
  BUSY: 1013,
  DROPPED: 1000,
  HOST_GONE: 1001,
  EXPIRED: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
} as const;

const SUITE_DSI = utf8ToBytes("CPaceRistretto255");
const ISK_DSI = utf8ToBytes("CPaceRistretto255_ISK");
/** SHA-512's input block size (draft section 8.1, s_in_bytes) */
const SHA512_BLOCK = 128;
const CI_LABEL = utf8ToBytes("ovis-pair-code/1");
const AD_PC = utf8ToBytes("ovis-pair-code/1 pc");
const AD_DEVICE = utf8ToBytes("ovis-pair-code/1 device");
const CONFIRM_INFO = utf8ToBytes("ovis-pair-code/1 device confirm");
const OFFER_INFO = utf8ToBytes("ovis-pair-code/1 offer key");
const OFFER_AAD = utf8ToBytes("ovis-pair-code/1 offer");
const EXPIRED = "expired";
const SID_BYTES = 16;
const POINT_BYTES = 32;
const ZERO_NONCE = new Uint8Array(12);
const GROUP_ORDER = ristretto255.Point.Fn.ORDER;

export function normalizePairCode(input: string): string | null {
  if (input.length > 32) return null;
  const text = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (text.length !== PAIR_CODE_CHARS) return null;
  for (const char of text) if (!PAIR_CODE_ALPHABET.includes(char)) return null;
  return text;
}

export function formatPairCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function randomPairCode(random: (bytes: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let code = "";
  while (code.length < PAIR_CODE_CHARS) {
    for (const byte of random(16)) {
      if (code.length < PAIR_CODE_CHARS) code += PAIR_CODE_ALPHABET[byte & 31];
    }
  }
  return code;
}

export function splitPairCode(input: string): { nameplate: string; password: string } {
  const code = normalizePairCode(input);
  if (code === null) throw new PairCodeProtocolError("not a pairing code");
  return { nameplate: code.slice(0, NAMEPLATE_CHARS), password: code.slice(NAMEPLATE_CHARS) };
}

/** LEB128 length, then the bytes (draft A.1.1). */
export function prependLen(data: Uint8Array): Uint8Array {
  const length: number[] = [];
  let rest = data.length;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest > 0) byte |= 0x80;
    length.push(byte);
  } while (rest > 0);
  return concatBytes(Uint8Array.from(length), data);
}

export function lvCat(...parts: Uint8Array[]): Uint8Array {
  return concatBytes(...parts.map(prependLen));
}

/** generator_string(DSI, PRS, CI, sid, s_in_bytes) (draft 8.1) */
export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const zpad = Math.max(0, SHA512_BLOCK - prependLen(prs).length - prependLen(SUITE_DSI).length - 1);
  return lvCat(SUITE_DSI, prs, new Uint8Array(zpad), ci, sid);
}

/** G.calculate_generator (draft 8.3): RFC 9496 element derivation of the generator string's SHA-512. */
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): RistrettoPoint {
  return ristretto255_hasher.deriveToCurve!(sha512(generatorString(prs, ci, sid)));
}

/** G.sample_scalar (draft 8.3): 32 random bytes with the bits above 252 cleared, little endian; never 0. */
export function sampleScalar(): bigint {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    bytes[31]! &= 0x0f;
    const scalar = scalarFromLittleEndian(bytes);
    if (scalar !== 0n) return scalar;
  }
}

export function scalarFromLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index]!);
  return value;
}

export function scalarMult(scalar: bigint, point: RistrettoPoint): Uint8Array {
  return point.multiply(scalar % GROUP_ORDER).toBytes();
}

/** G.scalar_mult_vfy: null where the draft returns G.I (an encoding that does not decode, or the identity). */
export function scalarMultVfy(scalar: bigint, encoded: Uint8Array): Uint8Array | null {
  if (encoded.length !== POINT_BYTES) return null;
  let point: RistrettoPoint;
  try { point = ristretto255.Point.fromBytes(encoded); } catch { return null; }
  if (point.is0()) return null;
  const product = point.multiply(scalar % GROUP_ORDER);
  return product.is0() ? null : product.toBytes();
}

/** ISK = H(lv_cat(DSI || "_ISK", sid, K) || transcript_ir(Ya, ADa, Yb, ADb)) (draft 7.2) */
export function cpaceIsk(sid: Uint8Array, k: Uint8Array, ya: Uint8Array, adA: Uint8Array, yb: Uint8Array, adB: Uint8Array): Uint8Array {
  return sha512(concatBytes(lvCat(ISK_DSI, sid, k), lvCat(ya, adA), lvCat(yb, adB)));
}

function channelIdentifier(nameplate: string): Uint8Array {
  return lvCat(CI_LABEL, utf8ToBytes(nameplate));
}

const derive = (isk: Uint8Array, info: Uint8Array) => hkdf(sha256, isk, undefined, info, 32);

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

export class PairCodeProtocolError extends Error {}
export class PairCodeExpiredError extends Error {}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: unknown, length?: number): Uint8Array {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new PairCodeProtocolError("bad field");
  const bytes = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (length !== undefined && bytes.length !== length) throw new PairCodeProtocolError("bad field length");
  return bytes;
}

function encodeMessage(message: Record<string, unknown>): Uint8Array<ArrayBuffer> {
  return new Uint8Array(utf8ToBytes(JSON.stringify(message)));
}

function decodeMessage(frame: Uint8Array): Record<string, unknown> {
  if (frame.length > PAIR_CODE_MAX_FRAME) throw new PairCodeProtocolError("frame too large");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame)); } catch { throw new PairCodeProtocolError("bad frame"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PairCodeProtocolError("bad frame");
  return value as Record<string, unknown>;
}

export class PairCodeHost {
  private readonly scalar = sampleScalar();
  private readonly sid = crypto.getRandomValues(new Uint8Array(SID_BYTES));
  private readonly ya: Uint8Array;
  private done = false;

  constructor(code: string) {
    const { nameplate, password } = splitPairCode(code);
    this.ya = scalarMult(this.scalar, calculateGenerator(utf8ToBytes(password), channelIdentifier(nameplate), this.sid));
  }

  hello(): Uint8Array<ArrayBuffer> {
    return encodeMessage({ v: 1, sid: toBase64Url(this.sid), ya: toBase64Url(this.ya) });
  }

  answer(frame: Uint8Array, offer: string | null): Uint8Array<ArrayBuffer> | null {
    if (this.done) throw new PairCodeProtocolError("this exchange is over");
    this.done = true;
    const message = decodeMessage(frame);
    const yb = fromBase64Url(message.yb, POINT_BYTES);
    const confirm = fromBase64Url(message.confirm, 32);
    const k = scalarMultVfy(this.scalar, yb);
    if (k === null) throw new PairCodeProtocolError("invalid point");
    const isk = cpaceIsk(this.sid, k, this.ya, AD_PC, yb, AD_DEVICE);
    if (!sameBytes(confirm, derive(isk, CONFIRM_INFO))) return null;
    const box = chacha20poly1305(derive(isk, OFFER_INFO), ZERO_NONCE, OFFER_AAD).encrypt(utf8ToBytes(offer ?? EXPIRED));
    return encodeMessage({ box: toBase64Url(box) });
  }
}

export class PairCodeGuest {
  private readonly scalar = sampleScalar();
  private isk: Uint8Array | null = null;

  private readonly code: { nameplate: string; password: string };

  constructor(code: string) {
    this.code = splitPairCode(code);
  }

  answer(frame: Uint8Array): Uint8Array<ArrayBuffer> {
    if (this.isk !== null) throw new PairCodeProtocolError("this exchange is over");
    const message = decodeMessage(frame);
    if (message.v !== 1) throw new PairCodeProtocolError("unsupported version");
    const sid = fromBase64Url(message.sid, SID_BYTES);
    const ya = fromBase64Url(message.ya, POINT_BYTES);
    const { nameplate, password } = this.code;
    const yb = scalarMult(this.scalar, calculateGenerator(utf8ToBytes(password), channelIdentifier(nameplate), sid));
    const k = scalarMultVfy(this.scalar, ya);
    if (k === null) throw new PairCodeProtocolError("invalid point");
    this.isk = cpaceIsk(sid, k, ya, AD_PC, yb, AD_DEVICE);
    return encodeMessage({ yb: toBase64Url(yb), confirm: toBase64Url(derive(this.isk, CONFIRM_INFO)) });
  }

  open(frame: Uint8Array): string {
    if (this.isk === null) throw new PairCodeProtocolError("no exchange yet");
    const message = decodeMessage(frame);
    const box = fromBase64Url(message.box);
    let plain: Uint8Array;
    try { plain = chacha20poly1305(derive(this.isk, OFFER_INFO), ZERO_NONCE, OFFER_AAD).decrypt(box); }
    catch { throw new PairCodeProtocolError("the offer did not open"); }
    this.isk = new Uint8Array(0);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(plain);
    if (text === EXPIRED) throw new PairCodeExpiredError("the PC's pairing code is no longer valid");
    return text;
  }
}
