export const RELAY_PASS_HEADER = "x-ovis-relay-pass";
export const RELAY_PASS_LIFETIME_S = 48 * 3600;
export const RELAY_PASS_REFRESH_S = 12 * 3600;
export const RELAY_PASS_SKEW_S = 300;
export const RELAY_PASS_AUDIENCE = "ovis-relay";

export const RELAY_PASS_CLOSE = 4402;
export const RELAY_PASS_REQUIRED = "relay pass required";
export const RELAY_PASS_EXPIRED = "relay pass expired";
export const RELAY_PASS_INVALID = "relay pass invalid";
export const RELAY_NEW_SESSIONS_CLOSE = 4403;
export const RELAY_NEW_SESSIONS_REFUSED = "no new sessions for this server";

const PREFIX = "ovp1.";
const SIGNING_PREFIX = "ovis-relay-pass/1.";
const MAX_LENGTH = 512;
const HEX32 = /^[0-9a-f]{32}$/;
const KID = /^[0-9a-f]{8}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

interface RelayPassFields {
  readonly kid: string;
  readonly aud: typeof RELAY_PASS_AUDIENCE;
  readonly sid: string;
  readonly iat: number;
  readonly exp: number;
}
export type RelayPassPayload = (RelayPassFields & { readonly v: 1 }) | (RelayPassFields & { readonly v: 2; readonly new: 0 | 1 });

export function relayPassAdmitsNewSessions(payload: RelayPassPayload): boolean {
  return payload.v === 1 || payload.new === 1;
}

export type RelayPassCheck =
  | { readonly ok: true; readonly payload: RelayPassPayload }
  | { readonly ok: false; readonly reason: typeof RELAY_PASS_REQUIRED | typeof RELAY_PASS_EXPIRED | typeof RELAY_PASS_INVALID };

const encoder = new TextEncoder();

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch { return null; }
}

function isPayload(value: unknown): value is RelayPassPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  const version = keys.length === 6 && fields["v"] === 1
    || keys.length === 7 && fields["v"] === 2 && (fields["new"] === 0 || fields["new"] === 1);
  return version && typeof fields["kid"] === "string" && KID.test(fields["kid"])
    && fields["aud"] === RELAY_PASS_AUDIENCE && typeof fields["sid"] === "string" && HEX32.test(fields["sid"])
    && Number.isSafeInteger(fields["iat"]) && Number.isSafeInteger(fields["exp"])
    && (fields["exp"] as number) > (fields["iat"] as number);
}

export function parseRelayPass(text: unknown): { payload: RelayPassPayload; signed: Uint8Array<ArrayBuffer>; signature: Uint8Array<ArrayBuffer> } | null {
  if (typeof text !== "string" || text.length > MAX_LENGTH || !text.startsWith(PREFIX)) return null;
  const parts = text.slice(PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const json = fromBase64url(body);
  const signature = fromBase64url(sig);
  if (!json || !signature || signature.length !== 64) return null;
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(json)); } catch { return null; }
  if (!isPayload(payload)) return null;
  return { payload, signed: encoder.encode(SIGNING_PREFIX + body), signature };
}

export function importRelayPassKey(hex: string): Promise<CryptoKey> {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("A relay pass key is 64 lowercase hex digits");
  const raw = Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
}

export interface RelayPassSignOptions { readonly newSessions?: boolean }

export async function signRelayPass(key: CryptoKey, kid: string, sid: string, now: number, lifetime = RELAY_PASS_LIFETIME_S, options: RelayPassSignOptions = {}): Promise<string> {
  const fields = { kid, aud: RELAY_PASS_AUDIENCE, sid, iat: now, exp: now + lifetime } as const;
  const payload: RelayPassPayload = options.newSessions === undefined ? { v: 1, ...fields } : { v: 2, ...fields, new: options.newSessions ? 1 : 0 };
  if (!isPayload(payload)) throw new Error("Invalid relay pass fields");
  const body = toBase64url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, encoder.encode(SIGNING_PREFIX + body)));
  return `${PREFIX}${body}.${toBase64url(signature)}`;
}

export async function checkRelayPass(text: string | null | undefined, keys: ReadonlyMap<string, CryptoKey>, serverId: string, now: number): Promise<RelayPassCheck> {
  if (text === null || text === undefined || text === "") return { ok: false, reason: RELAY_PASS_REQUIRED };
  const pass = parseRelayPass(text);
  const key = pass ? keys.get(pass.payload.kid) : undefined;
  if (!pass || !key || pass.payload.sid !== serverId || pass.payload.iat > now + RELAY_PASS_SKEW_S) return { ok: false, reason: RELAY_PASS_INVALID };
  if (pass.payload.exp - pass.payload.iat > RELAY_PASS_LIFETIME_S) return { ok: false, reason: RELAY_PASS_INVALID };
  if (pass.payload.exp + RELAY_PASS_SKEW_S <= now) return { ok: false, reason: RELAY_PASS_EXPIRED };
  try {
    if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, pass.signature, pass.signed))) return { ok: false, reason: RELAY_PASS_INVALID };
  } catch { return { ok: false, reason: RELAY_PASS_INVALID }; }
  return { ok: true, payload: pass.payload };
}
