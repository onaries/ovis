import { channelBinding, openClientSecureChannel } from "./relay-e2ee.ts";
import { fromBase64Url, PAIR_APPROVAL_MS, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "./relay-pair-sas.ts";
import type { SecureChannel, Transport } from "./relay-e2ee.ts";
import { ACCOUNT_FEATURE, decodeFrame, DIRECT_CARRIER, DIRECT_TAILNET, FrameType, isDirectCarrier, isTailnetCarrier, LARGE_WS_MESSAGES, LIMITS_V1, MuxProtocolError, PAIR_INTENT_ACCOUNT, PAIR_INTENT_PC, PAIR_INTENT_VOUCHED, PAIR_SAS_FEATURE, RELAY_HINTS, RELAY_PROTOCOL, SERVER_TIME_HEADER } from "./relay-mux.ts";
import { hintedRelay } from "./relay-regions.ts";
import { MuxEngine, MUX_SETUP_MS } from "./relay-mux-engine.ts";
import type { MuxOptions, SessionFrame } from "./relay-mux-engine.ts";
import { isWssOrigin, SERVER_ID_PATTERN } from "./relay-offer.ts";
import type { RelayOffer } from "./relay-offer.ts";
import { relayFallback } from "./relay-regions.ts";
import { getDevice, sign } from "./relay-device.ts";
import { RELAY_NEW_SESSIONS_CLOSE } from "./relay-pass.ts";
import type { RelayDevice, RelayDeviceStore } from "./relay-device.ts";

export class UnsafeRelayDestinationError extends Error {
  readonly code = "unsafe_relay_destination";
  constructor(readonly field: "relay" | "server_id") {
    super(`Invalid relay destination: ${field}`);
    this.name = "UnsafeRelayDestinationError";
  }
}

export class RelayUnreachableError extends Error {
  readonly code = "relay_unreachable";
  constructor(readonly closeCode: number | null, readonly silent = false) {
    super(silent ? "The relay did not answer" : closeCode === null ? "The relay could not be reached"
      // 1006 is the browser's word for a connection that failed or dropped without a close frame
      : closeCode === 1006 ? "The relay connection failed (1006)" : `The relay closed the connection (${closeCode})`);
    this.name = "RelayUnreachableError";
  }
}

export class RelayNewSessionsRefusedError extends Error {
  readonly code = "new_sessions_refused";
  constructor() {
    super("The relay takes no new devices for this PC");
    this.name = "RelayNewSessionsRefusedError";
  }
}

export class RelayAdmissionTimeoutError extends Error {
  readonly code = "admission_timeout";
  constructor(readonly phase: "handshake" | "welcome" | "auth") {
    super(`The PC did not finish the connection (${phase})`);
    this.name = "RelayAdmissionTimeoutError";
  }
}

export class RelayPcOfflineError extends MuxProtocolError {
  constructor() {
    super("timeout", "The PC did not answer through the relay");
    this.name = "RelayPcOfflineError";
  }
}

const OPEN = 1;

export const ASSIGNMENT_MS = 10_000;
export const PC_ANSWER_MS = 15_000;
export const ADMISSION_MS = MUX_SETUP_MS;
const PAIR_APPROVAL_GRACE_MS = 5_000;

export interface RelaySocket {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}
export interface RelayChannelOptions {
  readonly store: RelayDeviceStore;
  readonly socket?: (url: string) => RelaySocket;
  readonly label?: string;
  readonly signal?: AbortSignal;
  readonly onClose?: (error: Error) => void;
  readonly pcAnswerMs?: number;
  readonly carrier?: string;
  readonly requestTimeoutMs?: MuxOptions["requestTimeoutMs"];
  readonly compare?: (digits: string) => Promise<void>;
  readonly accountKey?: { readonly private_key: CryptoKey; readonly public_spki: string };
  readonly intent?: "pc" | "account" | "vouched";
  readonly beforeRequest?: (server: RelayServerInfo) => void;
  readonly direct?: string;
  readonly offerDirect?: boolean;
  readonly offerTailnet?: boolean;
}
export interface RelayChannel {
  readonly mux: MuxEngine;
  readonly device: RelayDevice;
  readonly connectionId: string;
  readonly sessionId: string;
  readonly role: "drive" | "watch";
  readonly server: RelayServerInfo;
  readonly carrierOpen: boolean;
  readonly directCarriers?: readonly string[];
  readonly direct?: string;
  close(): void;
}

export class DirectCarrierUnusableError extends Error {
  readonly code = "direct_unusable";
  constructor() {
    super("Direct connections only sign a paired device in");
    this.name = "DirectCarrierUnusableError";
  }
}
export interface RelayServerInfo {
  readonly version: string;
  readonly relayProtocol: number;
  readonly features?: readonly string[];
}

export async function openRelayChannel(offer: RelayOffer, options: RelayChannelOptions): Promise<RelayChannel> {
  if (typeof offer.relay !== "string" || !isWssOrigin(offer.relay)) throw new UnsafeRelayDestinationError("relay");
  if (options.carrier !== undefined && !isWssOrigin(options.carrier)) throw new UnsafeRelayDestinationError("relay");
  if (typeof offer.server_id !== "string" || !SERVER_ID_PATTERN.test(offer.server_id)) throw new UnsafeRelayDestinationError("server_id");
  const direct = options.direct;
  if (direct !== undefined && (!isDirectCarrier(direct) || offer.code !== undefined)) throw new DirectCarrierUnusableError();
  const url = new URL("/v1/ws", direct ?? options.carrier ?? offer.relay);
  if (direct === undefined) {
    url.searchParams.set("server_id", offer.server_id);
    url.searchParams.set("role", "client");
  }
  url.searchParams.set("v", "1");
  options.signal?.throwIfAborted();
  const store = options.store;
  const device = await getDevice(offer, store, options.label, options.accountKey);
  if (direct !== undefined && device.device_id === null) throw new DirectCarrierUnusableError();
  options.signal?.throwIfAborted();
  const socket = (options.socket ?? ((address) => new WebSocket(address)))(url.href);
  socket.binaryType = "arraybuffer";
  return new Promise<RelayChannel>((resolve, reject) => {
    let phase: "assigned" | "handshake" | "welcome" | "pair" | "auth" | "ready" | "closed" = "assigned";
    const comparing = offer.code === undefined && device.device_id === null && options.compare !== undefined;
    const offered: readonly string[] = comparing
      ? [ACCOUNT_FEATURE, PAIR_SAS_FEATURE, options.intent === "account" ? PAIR_INTENT_ACCOUNT : options.intent === "vouched" ? PAIR_INTENT_VOUCHED : PAIR_INTENT_PC]
      : [ACCOUNT_FEATURE];
    const hinted: readonly string[] = [RELAY_HINTS, ...options.offerDirect ? [DIRECT_CARRIER, ...options.offerTailnet ? [DIRECT_TAILNET] : []] : []];
    let phoneNonce: Uint8Array | undefined;
    let binding: Uint8Array | undefined;
    let challenge: Uint8Array | undefined;
    let confirmed = false;
    let secure: SecureChannel | undefined;
    let mux: MuxEngine | undefined;
    let connectionId = "";
    const limits = { ...LIMITS_V1 };
    let welcome: Uint8Array | undefined;
    let passed: Uint8Array | undefined;
    let provisionalNonce: string | undefined;
    let answered: Uint8Array | undefined;
    let server: RelayServerInfo = { version: "", relayProtocol: RELAY_PROTOCOL };
    let receipt: Uint8Array | undefined;
    let incoming = Promise.resolve();
    const stop = (error: Error): void => {
      if (phase === "closed") return;
      const admitted = phase === "ready";
      phase = "closed";
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", aborted);
      mux?.carrierLost();
      secure?.close(4000, "relay channel closed");
      socket.close(4000, "relay channel closed");
      if (admitted) options.onClose?.(error);
      else reject(error);
    };
    const aborted = (): void => stop(new DOMException("Relay connection aborted", "AbortError"));
    let deadline = setTimeout(() => stop(new RelayUnreachableError(null, true)), ASSIGNMENT_MS);
    let heardPc = false;
    const expect = (ms: number, failure: () => Error): void => {
      clearTimeout(deadline);
      deadline = setTimeout(() => stop(failure()), ms);
    };
    options.signal?.addEventListener("abort", aborted, { once: true });
    const transport: Transport = {
      // a closing socket would drop the frame without an error: fail it, so the mux and its streams end
      send: (data) => {
        if (socket.readyState !== OPEN) throw new MuxProtocolError("internal_error", "Relay socket is not open");
        socket.send(data);
      },
      close: (code = 4000, reason = "") => socket.close(code, reason),
      onmessage: null, onclose: null, onerror: null,
    };
    const send = (frame: SessionFrame): Promise<void> => {
      if (!mux || phase === "closed") throw new MuxProtocolError("protocol_error", "Relay channel is closed");
      mux.sendSession(frame);
      return mux.flush();
    };
    const receive = async (data: string | ArrayBuffer): Promise<void> => {
      if (phase === "closed") return;
      if (typeof data === "string") throw new MuxProtocolError("protocol_error", "Expected binary mux frame");
      const bytes = new Uint8Array(data);
      if (phase === "ready") { mux?.receive(bytes); return; }
      const frame = decodeFrame(bytes);
      if (frame.type === FrameType.SESSION_ERROR) throw new MuxProtocolError(frame.payload.code, frame.payload.message);
      if (frame.type === FrameType.RECEIVED) {
        if (!mux || frame.payload > mux.stats.submitted) throw new MuxProtocolError("protocol_error", "Receipt exceeds submitted frames");
        receipt = bytes;
        return;
      }
      if (phase === "welcome" && frame.type === FrameType.WELCOME) {
        if (comparing && frame.payload.provisional && !passed) { passed = bytes; return; }
        if (frame.payload.relay_protocol !== RELAY_PROTOCOL) throw new MuxProtocolError("unsupported_version", `The PC speaks relay protocol ${frame.payload.relay_protocol}`);
        server = { version: frame.payload.server_version, relayProtocol: frame.payload.relay_protocol, features: frame.payload.features };
        if (frame.payload.features.some((feature) => !offered.includes(feature))) throw new MuxProtocolError("unsupported_extension", "Server selected unoffered features");
        phase = "auth";
        Object.assign(limits, frame.payload.limits);
        welcome = bytes;
        provisionalNonce = frame.payload.provisional ? frame.payload.nonce : undefined;
        if (comparing) {
          options.beforeRequest?.(server);
          if (!frame.payload.features.includes(PAIR_SAS_FEATURE)) throw new MuxProtocolError("unsupported_extension", "The PC cannot pair without a code");
          binding = secure ? channelBinding(secure) : undefined;
          if (!binding) throw new MuxProtocolError("internal_error", "The relay channel has no binding");
          phoneNonce = randomPairNonce();
          phase = "pair";
          expect(PAIR_APPROVAL_MS + PAIR_APPROVAL_GRACE_MS, () => new RelayAdmissionTimeoutError("auth"));
          mux?.extendSetup(PAIR_APPROVAL_MS + PAIR_APPROVAL_GRACE_MS);
          await send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
            payload: { label: device.label, public_key: device.public_spki, commitment: toBase64Url(pairCommitment(binding, device.public_spki, phoneNonce)) } });
        } else if (offer.code !== undefined) {
          await send({ type: FrameType.PAIR, flags: 0, stream_id: 0,
            payload: { code: offer.code, label: device.label, public_key: device.public_spki } });
        } else {
          if (device.device_id === null) throw new MuxProtocolError("auth_failed", "Pair this device first");
          const nonce = Uint8Array.from(atob(frame.payload.nonce.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
          const signature = await sign(device, nonce, offer.server_id);
          await send({ type: FrameType.AUTH, flags: 0, stream_id: 0,
            payload: { scheme: "device-key", device_id: device.device_id, signature } });
        }
        return;
      }
      if (phase === "pair" && frame.type === FrameType.PAIR_CHALLENGE && binding && phoneNonce) {
        challenge = bytes;
        phase = "auth";
        const digits = pairDigits(binding, device.public_spki, phoneNonce, fromBase64Url(frame.payload.nonce));
        await send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(phoneNonce) } });
        void options.compare?.(digits).then(() => {
          if (phase !== "auth") return;
          confirmed = true;
          return send({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
        }).catch(failed);
        return;
      }
      if (phase === "auth" && frame.type === FrameType.WELCOME && !frame.payload.provisional && provisionalNonce !== undefined && !answered) {
        if (frame.payload.nonce !== provisionalNonce || frame.payload.relay_protocol !== RELAY_PROTOCOL) throw new MuxProtocolError("protocol_error", "The PC's answer to HELLO changed its WELCOME");
        if (frame.payload.features.some((feature) => !offered.includes(feature))) throw new MuxProtocolError("unsupported_extension", "Server selected unoffered features");
        server = { version: frame.payload.server_version, relayProtocol: frame.payload.relay_protocol, features: frame.payload.features };
        answered = bytes;
        return;
      }
      if (phase !== "auth" || frame.type !== FrameType.AUTH_OK) {
        throw new MuxProtocolError("protocol_error", "Unexpected frame before AUTH_OK");
      }
      if (comparing && !confirmed) throw new MuxProtocolError("protocol_error", "AUTH_OK before the digits were confirmed");
      if (offer.code === undefined && !comparing && frame.payload.device_id !== device.device_id) {
        throw new MuxProtocolError("auth_failed", "AUTH_OK named a different device");
      }
      const admitted = await store.update(offer.server_id, (current) => {
        const kept = current ?? (device.device_id === null ? device : undefined);
        if (!kept || kept.server_public_key !== device.server_public_key || kept.public_spki !== device.public_spki) {
          throw new MuxProtocolError("auth_changed", "Stored relay identity changed during authentication");
        }
        return { ...kept, device_id: frame.payload.device_id, relay: hintedRelay(kept.relay, frame.payload.relays),
          ...(options.offerDirect ? { direct: frame.payload.direct ?? [] } : {}) };
      });
      if (options.signal?.aborted || !secure?.isOpen() || !mux || !welcome) return;
      if (passed) mux.receive(passed);
      mux.receive(welcome);
      if (answered) mux.receive(answered);
      if (challenge) mux.receive(challenge);
      mux.receive(bytes);
      if (receipt) mux.receive(receipt);
      mux.authenticate(admitted.device_id ?? frame.payload.device_id);
      phase = "ready";
      clearTimeout(deadline);
      resolve({ mux, device: admitted, connectionId, sessionId: frame.payload.session_id, role: frame.payload.role, server,
        directCarriers: options.offerDirect ? frame.payload.direct ?? [] : [],
        ...(direct === undefined ? {} : { direct }),
        get carrierOpen() { return phase === "ready" && socket.readyState === OPEN; },
        close: () => stop(new MuxProtocolError("internal_error", "Relay channel closed")) });
    };
    const failed = (error: unknown): void => stop(error instanceof Error ? error : new Error(String(error)));
    socket.onclose = (event) => {
      const pairing = offer.code !== undefined || device.device_id === null;
      if (event.code === RELAY_NEW_SESSIONS_CLOSE && direct === undefined && pairing) stop(new RelayNewSessionsRefusedError());
      transport.onclose?.(event.code, event.reason);
      stop(phase === "assigned" ? new RelayUnreachableError(event.code) : new MuxProtocolError("internal_error", "Relay socket closed"));
    };
    socket.onerror = () => {
      const error = phase === "assigned" ? new RelayUnreachableError(null) : new MuxProtocolError("internal_error", "Relay socket failed");
      transport.onerror?.(error);
      stop(error);
    };
    socket.onmessage = (event) => {
      if (phase === "closed") return;
      if (phase !== "assigned") {
        if (typeof event.data !== "string" && !(event.data instanceof ArrayBuffer)) {
          stop(new MuxProtocolError("protocol_error", "Invalid relay carrier frame"));
          return;
        }
        if (!heardPc) {
          heardPc = true;
          expect(ADMISSION_MS, () => new RelayAdmissionTimeoutError(phase === "auth" ? "auth" : phase === "welcome" ? "welcome" : "handshake"));
        }
        transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
        return;
      }
      phase = "handshake";
      incoming = incoming.then(async () => {
        if (options.signal?.aborted) return;
        const assigned: unknown = typeof event.data === "string" ? JSON.parse(event.data) : null;
        if (!assigned || typeof assigned !== "object" || !("type" in assigned) || assigned.type !== "assigned"
          || !("connection_id" in assigned) || typeof assigned.connection_id !== "string"
          || !/^[0-9a-f]{32}$/.test(assigned.connection_id)) {
          throw new MuxProtocolError("protocol_error", "Invalid relay assignment");
        }
        connectionId = assigned.connection_id;
        phase = "welcome";
        if (!heardPc) expect(options.pcAnswerMs ?? PC_ANSWER_MS, () => new RelayPcOfflineError());
        const opened = Promise.withResolvers<void>();
        secure = await openClientSecureChannel(transport, {
          daemonPublicKeyB64: offer.server_public_key,
          events: {
            onopen: () => opened.resolve(),
            onmessage: (data) => { incoming = incoming.then(() => receive(data)).catch(failed); },
            onerror: (error) => { opened.reject(error); stop(error); },
            onclose: () => { const error = new MuxProtocolError("internal_error", "Secure relay channel closed"); opened.reject(error); stop(error); },
          },
        });
        await opened.promise;
        if (!secure.isOpen()) return;
        const carrier = secure;
        mux = new MuxEngine({
          role: "client", send: (bytes) => carrier.send(bytes.slice().buffer),
          close: () => stop(new MuxProtocolError("internal_error", "Relay mux closed")),
          clock: { now: () => performance.now(), setTimeout: (callback, ms) => {
            const timer = setTimeout(() => {
              if (phase === "ready") callback();
              else stop(new RelayAdmissionTimeoutError(phase === "auth" ? "auth" : "welcome"));
            }, ms);
            return () => clearTimeout(timer);
          } },
          outboundWireByteLength: (bytes) => carrier.outboundWireByteLength(bytes.slice().buffer),
          routingOverhead: 0, maxWireMessageBytes: 65536, limits, requestTimeoutMs: options.requestTimeoutMs,
          onClose: (error) => stop(error),
        });
        mux.receiveLargeMessages();
        await send({ type: FrameType.HELLO, flags: 0, stream_id: 0,
          payload: { protocol: "ovis-mux", versions: [1], features: [...hinted, LARGE_WS_MESSAGES, SERVER_TIME_HEADER, ...offered], required_features: [] } });
      }).catch(failed);
    };
  });
}

export async function probeDirect(offer: RelayOffer, direct: string, socketFor: (url: string) => RelaySocket, ms: number, signal?: AbortSignal): Promise<boolean> {
  return (await probePc(offer, { direct }, socketFor, ms, signal)).kind === "answered";
}

export type PcProbe = { readonly kind: "answered"; readonly ms: number } | { readonly kind: "silent" } | { readonly kind: "unreachable" };

export function probePc(offer: RelayOffer, via: { readonly direct: string } | { readonly relay: string }, socketFor: (url: string) => RelaySocket, ms: number, signal?: AbortSignal): Promise<PcProbe> {
  const unreachable: PcProbe = { kind: "unreachable" };
  if (signal?.aborted) return Promise.resolve(unreachable);
  if ("direct" in via ? !isDirectCarrier(via.direct) : !isWssOrigin(via.relay) || typeof offer.server_id !== "string" || !SERVER_ID_PATTERN.test(offer.server_id)) return Promise.resolve(unreachable);
  return new Promise<PcProbe>((resolve) => {
    const url = new URL("/v1/ws", "direct" in via ? via.direct : via.relay);
    if ("relay" in via) {
      url.searchParams.set("server_id", offer.server_id);
      url.searchParams.set("role", "client");
    }
    url.searchParams.set("v", "1");
    let socket: RelaySocket;
    try { socket = socketFor(url.href); } catch { resolve(unreachable); return; }
    socket.binaryType = "arraybuffer";
    let secure: SecureChannel | undefined;
    let settled = false;
    let assignedAt: number | undefined;
    const settle = (answer: PcProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      secure?.close(4000, "probe done");
      // a handshake that never finished keeps retrying until its carrier says it closed
      transport.onclose?.(4000, "probe done");
      socket.close(4000, "probe done");
      resolve(answer);
    };
    const failed = (): void => settle(assignedAt === undefined ? unreachable : { kind: "silent" });
    const timer = setTimeout(failed, ms);
    const aborted = (): void => settle(unreachable);
    signal?.addEventListener("abort", aborted, { once: true });
    const transport: Transport = {
      // a send that throws ends the probe from a later turn, once the handshake's retry exists to be stopped
      send: (data) => {
        if (socket.readyState !== OPEN) return;
        try { socket.send(data); } catch { queueMicrotask(failed); }
      },
      close: failed,
      onmessage: null, onclose: null, onerror: null,
    };
    let assigned = false;
    socket.onerror = failed;
    socket.onclose = failed;
    socket.onmessage = (event) => {
      if (settled) return;
      if (assigned) { transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" }); return; }
      assigned = true;
      let value: unknown;
      try { value = typeof event.data === "string" ? JSON.parse(event.data) : null; } catch { value = null; }
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "assigned") { settle(unreachable); return; }
      const started = performance.now();
      assignedAt = started;
      void openClientSecureChannel(transport, {
        daemonPublicKeyB64: offer.server_public_key,
        events: { onopen: () => settle({ kind: "answered", ms: Math.round(performance.now() - started) }), onmessage: () => {}, onerror: () => settle(unreachable), onclose: failed },
      }).then((channel) => { secure = channel; if (settled) channel.close(4000, "probe done"); }, () => settle(unreachable));
    };
  });
}

export function orderDirectRoutes(carriers: readonly string[], worked?: string): string[] {
  const rank = (carrier: string): number => isTailnetCarrier(carrier) ? 1 : 0;
  return carriers.map((carrier, index) => ({ carrier, index }))
    .sort((a, b) => rank(a.carrier) - rank(b.carrier) || Number(b.carrier === worked) - Number(a.carrier === worked) || a.index - b.index)
    .map(({ carrier }) => carrier);
}

export async function openRelayChannelWithFallback<O extends { readonly carrier?: string }>(
  offer: RelayOffer, options: O, open: (offer: RelayOffer, options: O) => Promise<RelayChannel>, first = offer.relay,
): Promise<{ channel: RelayChannel; relay: string }> {
  const attempt = async (relay: string) => ({ channel: await open(offer, relay === offer.relay ? options : { ...options, carrier: relay }), relay });
  try { return await attempt(first); }
  catch (error) {
    const fallback = relayFallback(offer.relay);
    if (!fallback || !(error instanceof RelayUnreachableError || error instanceof RelayPcOfflineError)) throw error;
    return attempt(first === fallback ? offer.relay : fallback);
  }
}
