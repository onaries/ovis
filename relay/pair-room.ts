/**
 * The relay's rendezvous for pairing with a typed code (shared/relay-pair-code.ts,
 * docs/relay.md "Pairing with a typed code"): `GET /v1/pair?nameplate=<3>&role=host|guest&v=1`.
 * The PC holds the room for a nameplate (`host`); a device that typed the code joins it (`guest`),
 * one at a time. The two run CPace through it; the relay reads none of it and is not trusted to
 * keep any limit: the PC counts tries itself. These limits only stop abuse through an honest relay.
 *
 * Every guest gets a random attempt id. The host hears `{"type":"guest","attempt"}` and
 * `{"type":"gone","attempt"}`; a guest's binary frame reaches the host prefixed with its attempt
 * id, and a host's binary frame must start with the current guest's id, which is stripped (a frame
 * for an attempt that is over goes nowhere). `{"type":"drop","attempt"}` from the host ends that
 * guest only. A guest's text is never passed on. What each socket is lives in its own info, so a
 * Durable Object evicted between frames picks up as it was.
 */
import { IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG, WIRE_VERSION, type Frame } from "./core.ts";

// The PC's side and the app read these from shared/relay-pair-code.ts (the remote PC bundle carries
// shared/, not relay/); they are copied here so the Worker imports none of the pairing cryptography,
// and relay/pair-room.test.ts holds the two copies equal.
export const ATTEMPT_BYTES = 16;

export const PAIR_CLOSE = {
  /** no PC shows this code */
  NO_HOST: 4404,
  /** another PC holds this nameplate */
  TAKEN: 4409,
  /** another guest is trying, the room took its fill of guests, or they came too fast */
  BUSY: 1013,
  /** the host ended this attempt */
  DROPPED: 1000,
  /** the host is gone */
  HOST_GONE: 1001,
  /** the guest's or host's time ran out, or it was idle */
  EXPIRED: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
} as const;

/** the public part of a typed code: three Crockford base32 characters */
export const NAMEPLATE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{3}$/;
/** the largest frame either side may send */
export const PAIR_MAX_FRAME = 4096;
/** a host's room lasts at most this long: a code lives 10 minutes */
export const PAIR_HOST_MS = 11 * 60_000;
/** a guest has this long to finish its exchange */
export const PAIR_GUEST_MS = 30_000;
/** guests a room takes in its life: the PC's three tries and some that drop before trying */
export const PAIR_GUESTS_PER_ROOM = 12;
/** the shortest gap between two guests of one room */
export const PAIR_GUEST_GAP_MS = 2000;



export interface PairSocketRequest { kind: "pair"; nameplate: string; role: "host" | "guest"; version: string | null }

export function parsePairRequest(url: URL): PairSocketRequest | { error: string } {
  const nameplate = url.searchParams.get("nameplate") ?? "";
  if (!NAMEPLATE_PATTERN.test(nameplate)) return { error: "nameplate must be 3 Crockford base32 characters" };
  const role = url.searchParams.get("role");
  if (role !== "host" && role !== "guest") return { error: "role must be host or guest" };
  return { kind: "pair", nameplate, role, version: url.searchParams.get("v") };
}

/** what a pairing socket is, kept with the socket */
export interface PairInfo {
  pair: "host" | "guest";
  /** a guest's attempt id, 32 hex */
  attempt?: string;
  /** when it is closed whatever it sends */
  deadline: number;
  /** when it last sent something */
  seen: number;
  /** a host: guests it took so far, and when the last one came */
  guests?: number;
  lastGuest?: number;
  ended?: true;
}

export function isPairInfo(value: unknown): value is PairInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  return (info["pair"] === "host" || info["pair"] === "guest") && typeof info["deadline"] === "number" && typeof info["seen"] === "number"
    && (info["attempt"] === undefined || (typeof info["attempt"] === "string" && /^[0-9a-f]{32}$/.test(info["attempt"])))
    && (info["guests"] === undefined || typeof info["guests"] === "number")
    && (info["lastGuest"] === undefined || typeof info["lastGuest"] === "number")
    && (info["ended"] === undefined || info["ended"] === true);
}

export interface PairRoomHost<S extends object> {
  sockets(): Iterable<S>;
  info(socket: S): PairInfo | null;
  setInfo(socket: S, info: PairInfo): void;
  send(socket: S, frame: Frame): void;
  close(socket: S, code: number, reason: string): void;
  wake?(at: number): void;
  /** when the platform last answered this socket's keepalive by itself, if it does (Cloudflare) */
  keepaliveAt?(socket: S): number | null;
  now(): number;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytesOf = (frame: Frame): Uint8Array | null => typeof frame === "string" ? null : frame instanceof Uint8Array ? frame : new Uint8Array(frame);
const sizeOf = (frame: Frame) => typeof frame === "string" ? new TextEncoder().encode(frame).length : frame.byteLength;

export class PairRoom<S extends object> {
  private readonly ended = new WeakSet<S>();

  constructor(private readonly host: PairRoomHost<S>, private readonly guestGapMs = PAIR_GUEST_GAP_MS) {}

  private peers(): { socket: S; info: PairInfo }[] {
    const out: { socket: S; info: PairInfo }[] = [];
    for (const socket of this.host.sockets()) {
      if (this.ended.has(socket)) continue;
      const info = this.host.info(socket);
      if (info && !info.ended) out.push({ socket, info });
    }
    return out;
  }

  private find(pair: "host" | "guest", except?: S) { return this.peers().find((peer) => peer.info.pair === pair && peer.socket !== except); }

  /** whether this room knows the socket: a Durable Object holding both kinds of room asks */
  owns(socket: S): boolean {
    return this.host.info(socket) !== null;
  }

  end(socket: S, code: number, reason: string): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (info?.ended) { this.ended.add(socket); return; }
    if (info) this.host.setInfo(socket, { ...info, ended: true });
    this.host.close(socket, code, reason);
    this.finish(socket, info);
  }

  open(socket: S, request: PairSocketRequest): void {
    const now = this.host.now();
    // a socket the room refuses still needs its info, so its close is this room's to handle
    this.host.setInfo(socket, { pair: request.role, deadline: now, seen: now });
    if (request.version !== WIRE_VERSION) return this.end(socket, PAIR_CLOSE.POLICY, "unsupported wire version");
    if (request.role === "host") {
      if (this.find("host", socket)) return this.end(socket, PAIR_CLOSE.TAKEN, "this code is in use");
      const deadline = now + PAIR_HOST_MS;
      this.host.setInfo(socket, { pair: "host", deadline, seen: now, guests: 0 });
      this.host.wake?.(deadline);
      this.host.send(socket, JSON.stringify({ type: "waiting" }));
      return;
    }
    const host = this.find("host");
    if (!host) return this.end(socket, PAIR_CLOSE.NO_HOST, "no PC shows this code");
    if (this.find("guest", socket)) return this.end(socket, PAIR_CLOSE.BUSY, "another device is trying this code");
    const guests = host.info.guests ?? 0;
    if (guests >= PAIR_GUESTS_PER_ROOM || now - (host.info.lastGuest ?? -Infinity) < this.guestGapMs) return this.end(socket, PAIR_CLOSE.BUSY, "too many tries for this code");
    this.host.setInfo(host.socket, { ...host.info, guests: guests + 1, lastGuest: now });
    const attempt = toHex(crypto.getRandomValues(new Uint8Array(ATTEMPT_BYTES)));
    const deadline = now + PAIR_GUEST_MS;
    this.host.setInfo(socket, { pair: "guest", attempt, deadline, seen: now });
    this.host.wake?.(deadline);
    this.host.send(host.socket, JSON.stringify({ type: "guest", attempt }));
  }

  message(socket: S, frame: Frame): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (!info || info.ended) return;
    if (sizeOf(frame) > PAIR_MAX_FRAME) return this.end(socket, PAIR_CLOSE.TOO_BIG, "frame too big");
    const now = this.host.now();
    // past its deadline a socket passes nothing on, whenever the next sweep comes
    if (now >= info.deadline) return this.end(socket, PAIR_CLOSE.EXPIRED, "time ran out");
    this.host.setInfo(socket, { ...info, seen: now });
    if (frame === KEEPALIVE_PING) return this.host.send(socket, KEEPALIVE_PONG);
    const bytes = bytesOf(frame);
    if (info.pair === "guest") {
      const host = this.find("host");
      if (bytes === null || !host || info.attempt === undefined) return;
      const out = new Uint8Array(ATTEMPT_BYTES + bytes.length);
      out.set(Uint8Array.from(info.attempt.match(/../g)!, (pair) => Number.parseInt(pair, 16)));
      out.set(bytes, ATTEMPT_BYTES);
      return this.host.send(host.socket, out);
    }
    const guest = this.find("guest");
    if (bytes === null) {
      let message: unknown;
      try { message = JSON.parse(frame as string); } catch { return; }
      // `null`, a number or a list is JSON too, and no message of the host's
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;
      const drop = message as { type?: unknown; attempt?: unknown };
      if (drop.type === "drop" && guest && drop.attempt === guest.info.attempt) this.end(guest.socket, PAIR_CLOSE.DROPPED, "the PC ended this try");
      return;
    }
    if (!guest || bytes.length < ATTEMPT_BYTES || toHex(bytes.subarray(0, ATTEMPT_BYTES)) !== guest.info.attempt) return;
    this.host.send(guest.socket, bytes.slice(ATTEMPT_BYTES));
  }

  closed(socket: S): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (info?.ended) { this.ended.add(socket); return; }
    this.finish(socket, info);
  }

  private finish(socket: S, info: PairInfo | null): void {
    this.ended.add(socket);
    if (!info) return;
    if (info.pair === "guest") {
      const host = this.find("host");
      if (host && info.attempt !== undefined) this.host.send(host.socket, JSON.stringify({ type: "gone", attempt: info.attempt }));
      return;
    }
    // a refused second host is no host of this room: the one that holds it stays
    if (this.find("host")) return;
    for (const peer of this.peers()) if (peer.info.pair === "guest") this.end(peer.socket, PAIR_CLOSE.HOST_GONE, "the PC is gone");
  }

  /** Closes sockets past their deadline or idle; returns when the next is due, or null when none is left. */
  sweep(): number | null {
    const now = this.host.now();
    let next: number | null = null;
    for (const peer of this.peers()) {
      const seen = Math.max(peer.info.seen, this.host.keepaliveAt?.(peer.socket) ?? 0);
      if (now >= peer.info.deadline || now - seen >= IDLE_MS) {
        this.end(peer.socket, PAIR_CLOSE.EXPIRED, "time ran out");
        continue;
      }
      next = Math.min(next ?? Infinity, peer.info.deadline, seen + IDLE_MS);
    }
    return next;
  }
}
