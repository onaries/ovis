import { importPublicKey, importSecretKey, openDaemonSecureChannel } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import type { RequestServices } from "../dispatch.ts";
import type { RelayIdentity } from "./identity.ts";
import { PAIR_APPROVAL_MS } from "../../shared/relay-pair-sas.ts";
import { RelaySession, relayClock } from "./session.ts";
import type { RelaySocketHandlers } from "./virtual-socket.ts";
import { version } from "../../package.json";
import { bytesToHex } from "@noble/hashes/utils.js";
import { answerServerChallenge, PERMANENT_SERVER_PROOF_REFUSALS, SERVER_PROOF_CLOSE } from "../../shared/relay-server-proof.ts";
import { SignedInSessions } from "./admissions.ts";

/** Signed-in sessions this PC serves at once, as many as the relay lets in (relay/core.ts MAX_CLIENTS). */
const MAX_SESSIONS = 8;
/** Clients still signing in beyond those, as many as the relay holds waiting (relay/core.ts MAX_PENDING). */
const MAX_PENDING = 4;
/** A relay control message is a short JSON object (a sync names at most 8 ids). */
const CONTROL_MESSAGE_BYTES = 4096;
/** A client whose sign-in or pairing is being verified at its deadline gets this long to finish. */
const SIGN_IN_GRACE_MS = 5_000;

export interface RelayLinkOptions {
  readonly relay: string;
  readonly identity: RelayIdentity;
  readonly services: RequestServices;
  /** The server's listening port, resolved after binding (including port: 0). */
  readonly port: number;
  readonly connect?: (url: string) => WebSocket;
  readonly clock?: MuxClock;
  readonly random?: () => number;
  /** The version WELCOME tells the shell (src/lib/relay/skew.ts); package.json's by default. */
  readonly serverVersion?: string;
  readonly onState: (phase: "connecting" | "online" | "error", error: string | null) => void;
  /** The relays a phone is told to reach this PC through (RelaySession relayHints). */
  readonly relayHints?: () => readonly string[];
  /** This PC's direct carriers (RelaySession directCarriers). */
  readonly directCarriers?: () => readonly string[];
  /** The PC's signed-in sessions over every way in (admissions.ts); this link's own when not given. */
  readonly sessions?: SignedInSessions;
}

interface DataConnection {
  readonly socket: WebSocket;
  cancelTimeout: () => void;
  readonly sockets: Set<Parameters<RelaySocketHandlers["open"]>[0]>;
  session?: RelaySession;
  cancelKeepalive?: () => void;
  /** Set once the client signed in or paired; until then the connection holds no session place. */
  deviceId?: string;
  /** Gives its signed-in place back (SignedInSessions.admit). */
  release?: () => void;
}

/** The relay's word on a warm socket that a client took: `{"type":"bound","connection_id":"<32 hex>"}`. */
function boundConnection(frame: unknown): string | null {
  if (typeof frame !== "string" || frame.length > 128) return null;
  try {
    const value: unknown = JSON.parse(frame);
    return typeof value === "object" && value !== null && "type" in value && value.type === "bound" && "connection_id" in value
      && typeof value.connection_id === "string" && /^[0-9a-f]{32}$/.test(value.connection_id) ? value.connection_id : null;
  } catch { return null; }
}

/** Physical relay I/O only: admission and dispatch remain in RelaySession. */
export class RelayLink {
  private control: WebSocket | undefined;
  /**
   * A data socket opened and proven before any client came, for the relay to hand the next client
   * (relay/core.ts): that client's handshake then waits for no socket of ours. Only while the current
   * control socket's relay said it takes one.
   */
  private warm: WebSocket | undefined;
  /** The control socket a warm socket is opened under, and the generation its relay named for it. */
  private warmControl: { socket: WebSocket; generation: string } | undefined;
  private warmAttempts = 0;
  private cancelWarmRetry: (() => void) | undefined;
  private readonly data = new Map<string, DataConnection>();
  private stopped = false;
  private attempts = 0;
  private readonly signedIn: SignedInSessions;
  private cancelRetry: (() => void) | undefined;
  private cancelKeepalive: (() => void) | undefined;
  private readonly clock: MuxClock;

  constructor(private readonly options: RelayLinkOptions) {
    this.clock = options.clock ?? relayClock;
    this.signedIn = options.sessions ?? new SignedInSessions(MAX_SESSIONS);
  }

  get sessions(): number { return [...this.data.values()].filter((entry) => entry.deviceId && entry.session?.mux.active).length; }

  start(): void { if (!this.stopped && !this.control) this.openControl(); }

  private socket(connectionId?: string, warm?: string): WebSocket {
    const url = new URL("/v1/ws", this.options.relay);
    url.searchParams.set("server_id", this.options.identity.server_id);
    url.searchParams.set("role", "server");
    url.searchParams.set("v", "1");
    url.searchParams.set("proof", "1");
    url.searchParams.set("public_key", bytesToHex(importPublicKey(this.options.identity.public_key)));
    if (connectionId) url.searchParams.set("connection_id", connectionId);
    if (warm) url.searchParams.set("warm", warm);
    return (this.options.connect ?? ((address) => new WebSocket(address)))(url.href);
  }

  private openControl(): void {
    if (this.stopped) return;
    this.options.onState("connecting", null);
    let socket: WebSocket;
    try { socket = this.socket(); }
    catch { this.retry(); return; }
    this.control = socket;
    let proofAnswered = false;
    let lastPong = this.clock.now();
    // An upgrade that never answers is also a lost relay.
    this.cancelKeepalive = this.clock.setTimeout(() => socket.close(), 15_000);
    socket.onopen = () => {
      if (this.stopped || this.control !== socket) { socket.close(); return; }
      this.cancelKeepalive?.();
      lastPong = this.clock.now();
      const heartbeat = () => {
        if (this.stopped || this.control !== socket) return;
        if (this.clock.now() - lastPong >= 30_000) { socket.close(); return; }
        if (proofAnswered) socket.send('{"type":"ping"}');
        this.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
      };
      this.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.control !== socket || typeof event.data !== "string") return;
      // Bounded before parsing; no rate limit, since client arrivals and departures drive this traffic.
      if (event.data.length > CONTROL_MESSAGE_BYTES) { socket.close(); return; }
      if (!proofAnswered) {
        proofAnswered = this.prove(socket, event.data, "control", null);
        return;
      }
      let value: unknown;
      try { value = JSON.parse(event.data); } catch { socket.close(); return; }
      if (typeof value !== "object" || value === null || !("type" in value)) { socket.close(); return; }
      if (value.type === "pong") { lastPong = this.clock.now(); return; }
      if (value.type === "sync" && "connection_ids" in value && Array.isArray(value.connection_ids)
        && value.connection_ids.length <= 8 && value.connection_ids.every((id) => typeof id === "string" && /^[0-9a-f]{32}$/.test(id))) {
        this.attempts = 0;
        this.options.onState("online", null);
        for (const id of value.connection_ids) this.openData(id);
        if ("warm" in value && typeof value.warm === "string" && /^[0-9a-f]{32}$/.test(value.warm)) {
          this.warmControl = { socket, generation: value.warm };
          this.openWarm();
        }
      } else if ("connection_id" in value && typeof value.connection_id === "string" && /^[0-9a-f]{32}$/.test(value.connection_id)) {
        if (value.type === "connected") this.openData(value.connection_id);
        else if (value.type === "disconnected") this.data.get(value.connection_id)?.socket.close();
        else socket.close();
      } else socket.close();
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (this.control !== socket) return;
      this.control = undefined;
      this.cancelKeepalive?.();
      this.endWarm();
      // The relay also uses 4401 for late answers. Only an explicit key mismatch is permanent.
      if (event.code === SERVER_PROOF_CLOSE && PERMANENT_SERVER_PROOF_REFUSALS.includes(event.reason)) {
        console.error(JSON.stringify({ event: "relay.server_proof.failed", code: event.code, reason: event.reason }));
        this.options.onState("error", `Relay refused the server proof (${event.code}): ${event.reason}`);
        return;
      }
      if (!this.stopped) this.retry();
    };
  }

  private prove(socket: WebSocket, frame: unknown, role: "control" | "data" | "warm", connectionId: string | null): boolean {
    const answer = answerServerChallenge(frame, importSecretKey(this.options.identity.secret_key), {
      server_id: this.options.identity.server_id, role, connection_id: connectionId,
    });
    if (!answer) { socket.close(4000, "invalid relay server challenge"); return false; }
    socket.send(answer);
    return true;
  }

  private retry(): void {
    if (this.stopped) return;
    this.options.onState("error", "Relay connection lost; reconnecting.");
    const delay = Math.round(Math.min(++this.attempts, 30) * 1000 * (0.8 + (this.options.random ?? Math.random)() * 0.4));
    this.cancelRetry = this.clock.setTimeout(() => this.openControl(), delay);
  }

  /** Whether one more client may start signing in; the relay bounds who reaches this PC (relay/core.ts: MAX_CLIENTS answered, MAX_PENDING waiting). */
  private hasRoom(id: string): boolean {
    if (this.stopped || this.data.has(id)) return false;
    // a client still signing in holds no session place and is closed at its deadline (serveData)
    if (this.data.size >= MAX_SESSIONS + MAX_PENDING) return false;
    return [...this.data.values()].filter((entry) => entry.deviceId).length < MAX_SESSIONS;
  }

  private openData(id: string): void {
    if (!this.hasRoom(id)) return;
    let socket: WebSocket;
    try { socket = this.socket(id); } catch { return; }
    socket.binaryType = "arraybuffer";
    this.serveData(id, socket, false);
  }

  private openWarm(): void {
    const control = this.warmControl;
    if (this.stopped || this.warm || this.cancelWarmRetry || !control || control.socket !== this.control) return;
    let socket: WebSocket;
    try { socket = this.socket(undefined, control.generation); } catch { this.retryWarm(); return; }
    socket.binaryType = "arraybuffer";
    this.warm = socket;
    let proofAnswered = false;
    let lastHeard = this.clock.now();
    let cancelKeepalive: (() => void) | undefined;
    // Given up on (it stalled, or closed): another is opened after a pause, without waiting for a close
    // event a half-open socket may never deliver.
    const abandon = () => {
      cancelKeepalive?.();
      if (this.warm !== socket) return;
      this.warm = undefined;
      socket.close();
      if (this.control === control.socket) this.retryWarm();
    };
    // As the control socket: a socket the relay has not answered for 30 s (its upgrade, challenge or pong) is lost.
    const heartbeat = () => {
      if (this.warm !== socket) return;
      if (this.clock.now() - lastHeard >= 30_000) { abandon(); return; }
      if (proofAnswered) socket.send('{"type":"ping"}');
      cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    };
    cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    socket.onmessage = (event) => {
      if (this.warm !== socket) return;
      lastHeard = this.clock.now();
      if (!proofAnswered) {
        proofAnswered = this.prove(socket, event.data, "warm", control.generation);
        return;
      }
      if (event.data === '{"type":"pong"}') return;
      const id = boundConnection(event.data);
      if (!id) { socket.close(); return; }
      cancelKeepalive?.();
      this.warm = undefined;
      this.warmAttempts = 0;
      // the client's frames follow on this socket: its handshake consumer is installed before this returns
      if (this.hasRoom(id)) this.serveData(id, socket, true);
      else socket.close();
      this.openWarm();
    };
    socket.onerror = abandon;
    socket.onclose = abandon;
  }

  /** Another warm socket after a pause that grows as the control link's does; clients are served through `connected` meanwhile. */
  private retryWarm(): void {
    if (this.stopped || this.cancelWarmRetry) return;
    const delay = Math.round(Math.min(++this.warmAttempts, 30) * 1000 * (0.8 + (this.options.random ?? Math.random)() * 0.4));
    this.cancelWarmRetry = this.clock.setTimeout(() => { this.cancelWarmRetry = undefined; this.openWarm(); }, delay);
  }

  private endWarm(): void {
    this.cancelWarmRetry?.();
    this.cancelWarmRetry = undefined;
    this.warmControl = undefined;
    this.warmAttempts = 0;
    const warm = this.warm;
    this.warm = undefined;
    warm?.close();
  }

  /** One client's data socket, whether opened for it or a warm socket it took (`proven`, already open). */
  private serveData(id: string, socket: WebSocket, proven: boolean): void {
    // Runs until the client signs in or pairs, not just until the protected channel opens.
    const deadline = () => {
      // A pairing may already be saved: let its acknowledgment through once, then close regardless.
      if (entry.session?.verifying) entry.cancelTimeout = this.clock.setTimeout(() => socket.close(), SIGN_IN_GRACE_MS);
      // a comparison of digits ends the session itself at PAIR_APPROVAL_MS; this is only the backstop
      else if (entry.session?.pairing) entry.cancelTimeout = this.clock.setTimeout(deadline, PAIR_APPROVAL_MS);
      else socket.close();
    };
    const entry: DataConnection = { socket, sockets: new Set(), cancelTimeout: this.clock.setTimeout(deadline, 15_000) };
    this.data.set(id, entry);
    // The relay refuses a client outright once 8 are answered, before this PC hears of it, so a room full
    // of clients that never sign in would turn everyone away. Keep a place free: the oldest client not
    // signed in gives way to a new one. A signed-in session is never evicted.
    if (this.data.size >= MAX_SESSIONS) {
      // a phone comparing digits waits for a person: it gives way last
      const waiting = [...this.data].filter(([other, candidate]) => other !== id && !candidate.deviceId);
      const oldest = waiting.find(([, candidate]) => !candidate.session?.pairing) ?? waiting[0];
      if (oldest) {
        this.data.delete(oldest[0]);
        oldest[1].socket.close();
      }
    }
    let proofAnswered = proven;
    const transport: Transport = {
      onmessage: null, onclose: null, onerror: null,
      send: (data) => { socket.send(data); },
      close: (code, reason) => socket.close(code, reason),
    };
    socket.onmessage = (event) => {
      if (!proofAnswered) {
        proofAnswered = this.prove(socket, event.data, "data", id);
        return;
      }
      if (event.data === '{"type":"pong"}') return;
      if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
        transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
      } else socket.close();
    };
    socket.onerror = () => { transport.onerror?.(new Error("Relay data connection failed")); socket.close(); };
    socket.onclose = (event) => {
      entry.cancelTimeout();
      entry.cancelKeepalive?.();
      transport.onclose?.(event.code, event.reason);
      entry.release?.();
      if (this.data.get(id) === entry) this.data.delete(id);
    };
    const heartbeat = () => {
      if (this.stopped || this.data.get(id) !== entry) return;
      if (proofAnswered) socket.send('{"type":"ping"}');
      entry.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    };
    if (proven) entry.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    else socket.onopen = () => { entry.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000); };
    // Install the handshake consumer before the data socket can receive held client frames.
    void openDaemonSecureChannel(transport, {
      daemonKeyPair: {
        publicKey: importPublicKey(this.options.identity.public_key),
        secretKey: importSecretKey(this.options.identity.secret_key),
      },
      events: { onmessage: (data) => { if (!this.stopped) entry.session?.receive(data); } },
    }).then((channel) => {
      if (this.stopped || this.data.get(id) !== entry || !channel.isOpen()) { channel.close(); return; }
      const handlers = this.options.services.core.socketHandlers;
      entry.session = new RelaySession({
        channel, services: this.options.services, port: this.options.port, serverId: this.options.identity.server_id,
        serverVersion: this.options.serverVersion ?? version, minSupportedClient: "0.4.20",
        routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
        onAuthenticated: (deviceId) => this.authenticated(id, entry, deviceId),
        ...(this.options.relayHints ? { relayHints: this.options.relayHints } : {}),
        ...(this.options.directCarriers ? { directCarriers: this.options.directCarriers } : {}),
        websocket: {
          ...handlers,
          open: (peer) => { entry.sockets.add(peer); return handlers.open(peer); },
          close: (peer, code, reason) => { entry.sockets.delete(peer); handlers.close(peer, code, reason); },
        },
      });
    }).catch(() => socket.close());
  }

  private authenticated(id: string, entry: DataConnection, deviceId: string): void {
    if (this.data.get(id) !== entry) return;
    entry.cancelTimeout();
    entry.deviceId = deviceId;
    entry.release = this.signedIn.admit(deviceId, () => entry.session?.close("resource_exhausted"));
  }

  /** Cancel retries synchronously; finish queued policy closes before ending protected carriers. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelKeepalive?.();
    this.endWarm();
    const control = this.control;
    this.control = undefined;
    await Promise.all([...this.data.values()].map(async (entry) => {
      entry.cancelTimeout();
      entry.cancelKeepalive?.();
      for (const socket of entry.sockets) socket.close(1001, "Relay stopped");
      if (entry.session) {
        await entry.session.mux.flush();
        entry.session.mux.goAway("shutdown", 0);
        await entry.session.mux.flush();
      }
      entry.socket.close();
      entry.release?.();
    }));
    control?.close();
    this.data.clear();
  }
}
