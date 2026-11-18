import { randomBytes } from "node:crypto";
import { channelBinding } from "../../shared/relay-e2ee.ts";
import type { SecureChannel } from "../../shared/relay-e2ee.ts";
import { commitmentHolds, fromBase64Url, PAIR_APPROVAL_MS, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { MuxEngine, MuxStreamError } from "../../shared/relay-mux-engine.ts";
import type { HttpStream, MuxClock, SessionFrame, WsStream } from "../../shared/relay-mux-engine.ts";
import { ACCOUNT_FEATURE, DIRECT_CARRIER, DIRECT_TAILNET, FrameType, LARGE_WS_MESSAGES, LIMITS_V1, PAIR_INTENT_ACCOUNT, PAIR_INTENT_PC, PAIR_INTENT_VOUCHED, PAIR_SAS_FEATURE, RELAY_HINTS, RELAY_PROTOCOL, REQUEST_HEADERS, RESPONSE_HEADERS, SERVER_TIME_HEADER, WS_CONTINUATION_CAPACITY } from "../../shared/relay-mux.ts";
import type { HeaderList, SessionError } from "../../shared/relay-mux.ts";
import { PairingRateLimitedError, type DeviceMatch, type PairingPath } from "../devices.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import { SIGN_IN_WAIT_MS } from "../account/mailbox.ts";
import { handleRequest } from "../dispatch.ts";
import type { RequestServices, ServerContext } from "../dispatch.ts";
import { jsonResponse } from "../http.ts";
import type { EventStreamBudget } from "../machine-api.ts";
import { VirtualSocket, type RelaySocketHandlers } from "./virtual-socket.ts";

export const RELAY_ORIGIN = "https://relay.ovis.invalid";
const SOURCE_LIMIT = 3 * 1024 * 1024;
const SESSION_LIMIT = 32 * 1024 * 1024;
export const relayClock: MuxClock = {
  now: () => performance.now(),
  setTimeout: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

/** Shared by HTTP and the WebSocket adapter; client identity headers never become Request headers. */
export function relayHeaders(list: HeaderList): Headers {
  const headers = new Headers();
  const allowed: readonly string[] = REQUEST_HEADERS;
  for (const [name, value] of list) if (allowed.includes(name)) headers.append(name, value);
  headers.set("origin", RELAY_ORIGIN);
  headers.set("sec-fetch-site", "same-origin");
  headers.set("accept-encoding", "identity");
  return headers;
}

/**
 * The two calls a device may make while it waits to link (it paired with a code made for a PC in no account and
 * has not linked; docs/account.md): reading its own account status, and sending its link. This is the whole list.
 * Whatever is not one of the two is refused before any route runs, a path that exists nowhere included.
 */
function linkStep(request: Request): boolean {
  const { pathname } = new URL(request.url);
  return (request.method === "GET" && pathname === "/api/account/status") || (request.method === "POST" && pathname === "/api/account/link");
}

/**
 * How long a session waits for the answers already on their way once its device went before it linked
 * (RelaySession.leave); after that it ends without them.
 */
export const LEAVING_MS = 5_000;

/** What a device that waits to link is answered for everything else. */
function linkRequired(): Response {
  return jsonResponse({ error: { code: "link_required", message: "This device paired with a code that adds this PC to an Ovis account. It gets nothing here until it has linked itself into an account: sign in on it, then scan the code again." } }, 403, { "cache-control": "no-store" });
}

export interface RelaySessionOptions {
  readonly channel: SecureChannel;
  readonly services: RequestServices;
  /** The server's listening port, resolved after binding (including port: 0). */
  readonly port: number;
  readonly serverId: string;
  readonly serverVersion: string;
  readonly minSupportedClient: string;
  readonly routingOverhead: number;
  readonly maxWireMessageBytes: number;
  readonly clock?: MuxClock;
  readonly dispatch?: typeof handleRequest;
  /** The core's SocketLike handlers. Without either adapter, WS_OPEN is refused. */
  readonly websocket?: RelaySocketHandlers;
  /** Owns the upgrade and socket lifecycle, including stream disposal. Absent adapters refuse WS_OPEN. */
  readonly onWs?: (stream: WsStream, exchange: RelayWebSocketRequest) => void;
  readonly onClose?: (code: SessionError) => void;
  readonly onAuthenticated?: (deviceId: string) => void;
  readonly onChosen?: () => void;
  readonly relayHints?: () => readonly string[];
  /**
   * This PC's direct carriers (server/relay/direct.ts), told in AUTH_OK to a phone that offered DIRECT_CARRIER;
   * with `tailnet` (it also offered DIRECT_TAILNET) its Tailscale one too.
   */
  readonly directCarriers?: (tailnet: boolean) => readonly string[];
  /**
   * A carrier that came straight to this PC rather than through the relay: devices sign in on it, and
   * nothing pairs (a code or a comparison), so pairing and its guesses stay on the relay.
   */
  readonly signInOnly?: boolean;
  /**
   * Asked once a pairing on this carrier would make a device new to this PC (a code that holds, or a comparison both
   * people confirmed), before the device is made: true when its relay refuses new client sessions to this PC now
   * (server/relay/link.ts). The session then makes no device and says nothing more: the relay closes the client.
   */
  readonly refuseNewDevice?: () => boolean;
}

export interface RelayWebSocketRequest {
  readonly request: Request;
  readonly context: ServerContext;
  upgrade?: Parameters<ServerContext["upgrade"]>[1];
}

/**
 * One protected carrier, one immutable principal, no replay. The carrier wires its plaintext
 * onmessage callback to receive(); construction requires the Noise handshake to have completed.
 */
export class RelaySession {
  readonly mux: MuxEngine;
  readonly sessionId = randomBytes(16).toString("hex");
  private state: "hello" | "auth" | "pair-commit" | "pair-wait" | "verifying" | "refused" | "ready" | "closed" = "hello";
  private readonly nonce = randomBytes(32);
  /** This session's channel binding, when the phone offered pairing by comparing digits and this PC selected it. */
  private sasBinding: Uint8Array | undefined;
  private intent: "pc" | "account" | "vouched" = "pc";
  private welcomed = false;
  private sas: {
    label: string; publicKey: string; commitment: Uint8Array; pcNonce: Uint8Array; expiresAt: number;
    phoneConfirmed: boolean; approved: boolean; approvedBy?: string; ended: boolean; membersOnly: boolean; localOnly: boolean; closes: number; withdraw?: () => void; cancelDeadline?: () => void; stopRevokeAll?: () => void; stopApprover?: () => void;
  } | undefined;
  private device: DeviceMatch | undefined;
  /** The key this session's device signed in or paired with: a `link` must start from it (docs/account.md). */
  private key = "";
  /** Whether the device signed in with AUTH, the only admission that proves it holds its key. */
  private keyProven = false;
  private hinting = false;
  private directing = false;
  private tailnet = false;
  /** the phone offered SERVER_TIME_HEADER: one that did not refuses the header */
  private serverTime = false;
  private unwatch: (() => void) | undefined;
  private sourceBytes = 0;
  private readonly clock: MuxClock;
  private readonly activity = new Map<number, () => void>();
  private readonly sockets = new Map<WsStream, VirtualSocket | undefined>();
  private readonly requests = new Set<HttpStream>();
  /** The row went before it linked (leave): set while the answers on their way go out, to what calls off their deadline; then the session ends. */
  private leaving: (() => void) | undefined;
  private chosen = false;

  constructor(private readonly options: RelaySessionOptions) {
    if (!options.channel.isOpen() || options.channel.securityMode() !== "protected") {
      throw new Error("Relay sessions require an open protected channel");
    }
    this.clock = options.clock ?? relayClock;
    this.mux = new MuxEngine({
      role: "server", clock: this.clock,
      send: (bytes) => {
        this.touch(bytes);
        return options.channel.send(bytes.slice().buffer);
      },
      outboundWireByteLength: (bytes) => options.channel.outboundWireByteLength(bytes.slice().buffer),
      routingOverhead: options.routingOverhead, maxWireMessageBytes: options.maxWireMessageBytes,
      requestTimeoutMs: () => 0,
      filterRequestHeaders: true,
      close: (code) => options.channel.close(code),
      onClose: (error) => {
        this.state = "closed";
        this.endPairing(false);
        this.unwatch?.();
        this.unwatch = undefined;
        options.onClose?.(error.code);
      },
      onSession: (frame) => {
        void this.admit(frame).catch((error: unknown) => {
          if (error instanceof PairingRateLimitedError) this.mux.fail("auth_failed", error.message);
          else this.close("internal_error");
        });
      },
      onHttp: (stream) => { this.choose(); void this.http(stream); },
      onWs: (stream) => {
        const device = this.principal();
        if (!device) { stream.reset("refused"); return; }
        // a device that waits to link opens no socket: refused here, where every stream of a device starts, on the relay and on a direct carrier alike
        if (device.provisional) {
          void this.refuseSocket(stream, linkRequired()).catch((error: unknown) => { if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error"); });
          return;
        }
        this.choose();
        if (!options.onWs && !options.websocket) { stream.reset("refused"); return; }
        this.sockets.set(stream, undefined);
        const abort = new AbortController();
        let timer: (() => void) | undefined;
        const exchange: RelayWebSocketRequest = {
          request: new Request(RELAY_ORIGIN + stream.request.target, {
            headers: relayHeaders(stream.request.headers), signal: abort.signal,
          }),
          context: this.context(device, (_request, seconds) => {
            timer?.();
            timer = seconds > 0 ? this.clock.setTimeout(() => stream.reset("upstream_lost"), seconds * 1000) : undefined;
          }, (_request, upgrade) => {
            if (!stream.live || this.state !== "ready") return false;
            exchange.upgrade = upgrade;
            return true;
          }),
        };
        stream.onDispose = () => {
          timer?.();
          abort.abort();
          exchange.upgrade?.data.relay?.close();
          this.sockets.delete(stream);
        };
        if (options.onWs) options.onWs(stream, exchange);
        else void this.websocket(stream, exchange);
      },
    });
    options.channel.onClose(() => this.mux.carrierLost());
    // A WELCOME with no feature rides right behind the protected handshake's answer, so a phone signing in
    // gets its nonce one round trip sooner. It is provisional: HELLO is still required, and checked, before
    // AUTH or PAIR, and a HELLO that offers pairing by comparing digits gets the final WELCOME. Only while no
    // comparison can be under way: a phone from before `provisional` reads the first WELCOME as the answer.
    if (!options.services.relay.approvals.windowOpen()) this.welcome([], true);
  }

  private welcome(features: readonly string[], provisional: boolean): void {
    this.welcomed = true;
    this.mux.sendSession({
      type: FrameType.WELCOME, flags: 0, stream_id: 0,
      payload: {
        protocol: "ovis-mux", version: 1, features, limits: LIMITS_V1,
        nonce: this.nonce.toString("base64url"), server_version: this.options.serverVersion,
        relay_protocol: RELAY_PROTOCOL, min_supported_client: this.options.minSupportedClient,
        ...(provisional ? { provisional: true as const } : {}),
      },
    });
  }

  get verifying(): boolean { return this.state === "verifying"; }

  get pairing(): boolean { return this.state === "pair-commit" || this.state === "pair-wait"; }

  get bufferedBytes(): number { return this.sourceBytes + this.mux.stats.bufferedBytes; }

  receive(data: string | ArrayBuffer): void {
    if (typeof data === "string") { this.close("protocol_error"); return; }
    const bytes = new Uint8Array(data);
    this.mux.receive(bytes);
    for (const socket of this.sockets.values()) socket?.drain();
    if (this.mux.active) this.touch(bytes);
  }

  private touch(bytes: Uint8Array): void {
    if (bytes.byteLength >= 8) this.activity.get(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4))?.();
  }

  close(code: SessionError = "auth_revoked"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.endPairing(false);
    this.unwatch?.();
    this.unwatch = undefined;
    this.leaving?.();
    if (code !== "auth_revoked" && code !== "auth_changed") { this.mux.fail(code, code); return; }
    // Stop application work now, but let the known WS policy close reach the peer before
    // SESSION_ERROR tears down the carrier. WsStream bounds both draining and the close exchange.
    for (const stream of this.requests) stream.reset("cancelled");
    const closing: Promise<void>[] = [];
    for (const [stream, socket] of this.sockets) {
      if (!socket) { stream.reset("cancelled"); continue; }
      closing.push(socket.closed);
      socket.close(1008, "Device access revoked");
    }
    if (closing.length) void Promise.all(closing).then(() => this.mux.flush()).then(() => this.mux.fail(code, code));
    else this.mux.fail(code, code);
  }

  /** The pairing would have made a device while new client sessions are refused: nothing is answered from here on. */
  private get refused(): boolean { return this.state === "refused"; }

  /** The device store's last question before a pairing makes a device (server/devices.ts pairRelay): false makes none. */
  private readonly admitNewDevice = (): boolean => {
    if (!this.options.refuseNewDevice?.()) return true;
    this.state = "refused";
    return false;
  };

  private async admit(frame: SessionFrame): Promise<void> {
    if (this.refused) return;
    switch (frame.type) {
      case FrameType.HELLO:
        if (this.state !== "hello") { this.close("protocol_error"); return; }
        if (!frame.payload.versions.includes(1)) { this.close("unsupported_version"); return; }
        // selected only where it can finish: a protected channel to bind the digits to
        if (frame.payload.features.includes(PAIR_SAS_FEATURE) && !this.options.signInOnly) this.sasBinding = channelBinding(this.options.channel);
        this.hinting = this.options.relayHints !== undefined && frame.payload.features.includes(RELAY_HINTS);
        this.directing = this.options.directCarriers !== undefined && frame.payload.features.includes(DIRECT_CARRIER);
        this.tailnet = this.directing && frame.payload.features.includes(DIRECT_TAILNET);
        const large = frame.payload.features.includes(LARGE_WS_MESSAGES);
        if (large) this.mux.sendLargeMessages();
        this.serverTime = frame.payload.features.includes(SERVER_TIME_HEADER);
        // an intent is selected only with pair-sas, and only the one offered (docs/account.md, "Negotiation")
        const intents = frame.payload.features.filter((f) => f === PAIR_INTENT_PC || f === PAIR_INTENT_ACCOUNT || f === PAIR_INTENT_VOUCHED);
        if (intents.length > 1) { this.close("protocol_error"); return; }
        const selected = [...this.sasBinding ? [PAIR_SAS_FEATURE, ...intents] : [], ...frame.payload.features.includes(ACCOUNT_FEATURE) ? [ACCOUNT_FEATURE] : []];
        if (frame.payload.required_features.some((feature) => !selected.includes(feature) && !(feature === RELAY_HINTS && this.hinting) && !(feature === DIRECT_CARRIER && this.directing) && !(feature === DIRECT_TAILNET && this.tailnet) && !(feature === LARGE_WS_MESSAGES && large))) { this.close("unsupported_extension"); return; }
        this.state = "auth";
        if (this.sasBinding && intents[0] === PAIR_INTENT_ACCOUNT) this.intent = "account";
        if (this.sasBinding && intents[0] === PAIR_INTENT_VOUCHED) this.intent = "vouched";
        if (!this.welcomed || selected.length > 0) this.welcome(selected, false);
        return;
      case FrameType.AUTH: case FrameType.PAIR: {
        if (this.state !== "auth") { this.close("protocol_error"); return; }
        // refused before the code is looked at: nothing is spent or counted
        if (frame.type === FrameType.PAIR && this.options.signInOnly) { this.close("auth_failed"); return; }
        this.state = "verifying";
        const devices = this.options.services.devices;
        if (this.options.services.serveOnly) { this.close("auth_failed"); return; }
        if (frame.type === FrameType.AUTH && !await this.pullForRefusedSignIn(frame.payload.device_id, frame.payload.signature)) return;
        this.keyProven = frame.type === FrameType.AUTH;
        const device = frame.type === FrameType.AUTH
          ? await devices.matchRelay(frame.payload.device_id, this.nonce, frame.payload.signature, this.options.serverId)
          : devices.pairRelay(frame.payload.code, frame.payload.label, frame.payload.public_key, undefined, this.admitNewDevice)?.device;
        // no auth_failed: the code held and was not spent, and the relay closes this client for the pass
        if (this.refused) return;
        this.enter(device);
        return;
      }
      case FrameType.PAIR_REQUEST: {
        // a direct carrier pairs nothing, whatever was offered: refused as a sign-in failure, before the binding is looked at
        if (this.options.signInOnly) { this.close("auth_failed"); return; }
        if (this.state !== "auth" || !this.sasBinding) { this.close("protocol_error"); return; }
        if (this.options.services.serveOnly) { this.close("auth_failed"); return; }
        // nobody asked for a link lately: refused before any prompt, and not counted, since no person was asked,
        // unless it is an account join the account service has seen (accountJoin, docs/account.md design 5.3).
        // Another PC of the account's server is taken only that way, window or not: its admission is its whole invitation
        let membersOnly = false;
        // taken under the PC's own add-me screen: this comparison stays the PC's to decide, whenever its digits show
        const localOnly = this.options.services.relay.approvals.localOnlyOpen();
        if (this.intent === "vouched" || !this.options.services.relay.approvals.windowOpen()) {
          this.state = "verifying";
          if (!await this.accountJoin(frame.payload.public_key)) { this.close("auth_failed"); return; }
          if (!this.mux.active) return;
          membersOnly = true;
        }
        this.options.services.devices.assertRelayPairing(this.path);
        this.state = "pair-commit";
        this.sas = {
          label: frame.payload.label, publicKey: frame.payload.public_key, commitment: fromBase64Url(frame.payload.commitment),
          pcNonce: randomPairNonce(), expiresAt: Date.now() + PAIR_APPROVAL_MS, phoneConfirmed: false, approved: false, ended: false, membersOnly, localOnly, closes: this.options.services.relay.approvals.closes,
        };
        this.sas.cancelDeadline = this.clock.setTimeout(() => { if (this.pairing) this.close("timeout"); }, PAIR_APPROVAL_MS);
        // revoking every device also ends a comparison under way, even one the owner already approved
        this.sas.stopRevokeAll = this.options.services.devices.onRevokeAll(() => { if (this.pairing) this.close("auth_failed"); });
        this.mux.extendSetup(PAIR_APPROVAL_MS + 1_000);
        this.mux.sendSession({ type: FrameType.PAIR_CHALLENGE, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(this.sas.pcNonce) } });
        return;
      }
      case FrameType.PAIR_REVEAL: {
        const sas = this.sas;
        if (this.state !== "pair-commit" || !sas || !this.sasBinding) { this.close("protocol_error"); return; }
        const phoneNonce = fromBase64Url(frame.payload.nonce);
        if (!commitmentHolds(sas.commitment, this.sasBinding, sas.publicKey, phoneNonce)) { this.close("auth_failed"); return; }
        // the window it was taken under was closed while this phone held its reveal: no prompt after a close
        // (a join shown to account members only never depended on the window)
        if (!sas.membersOnly && this.options.services.relay.approvals.closes !== sas.closes) { this.close("auth_failed"); return; }
        // a pause that began while this phone held its reveal still keeps its prompt off the owner's screen
        this.options.services.devices.assertRelayPairing(this.path);
        const asked = this.options.services.relay.approvals.ask(sas.label,
          pairDigits(this.sasBinding, sas.publicKey, phoneNonce, sas.pcNonce), sas.expiresAt,
          // a PC vouched for is asked as "pair this PC": it joins this PC alone, and the approver's app signs nothing for it;
          // marked vouched, so that app shows who is asking and checks the admission, as for an account join
          { intent: this.intent === "account" ? "account" : "pc", key: sas.publicKey, deviceId: accountDeviceId(this.options.serverId, sas.publicKey), membersOnly: sas.membersOnly, localOnly: sas.localOnly, vouched: this.intent === "vouched" });
        if (!asked) { this.close("auth_failed"); return; }
        this.state = "pair-wait";
        sas.withdraw = asked.withdraw;
        void asked.decision.then((decision) => {
          if (this.sas !== sas || this.state !== "pair-wait") return;
          if (!decision.approved) { this.close("auth_failed"); return; }
          sas.approved = true;
          sas.approvedBy = decision.by?.id;
          // an approver revoked or given another role before the phone confirms takes the approval with it, for good
          if (decision.by) sas.stopApprover = this.options.services.devices.onRevoke(decision.by.id, () => { if (this.pairing) this.close("auth_failed"); });
          this.finishPairing();
        }).catch(() => this.close("internal_error"));
        return;
      }
      case FrameType.PAIR_CONFIRM: {
        if (this.state !== "pair-wait" || !this.sas || this.sas.phoneConfirmed) { this.close("protocol_error"); return; }
        this.sas.phoneConfirmed = true;
        this.finishPairing();
        return;
      }
      case FrameType.WELCOME: case FrameType.AUTH_OK: case FrameType.PAIR_CHALLENGE:
        this.close("protocol_error");
    }
  }

  /** `provisional`: a row that waits to link is told no direct carrier of this PC. */
  private hints(provisional: boolean): { relays?: readonly string[]; direct?: readonly string[] } {
    const relays = this.hinting ? this.options.relayHints?.() ?? [] : [];
    const direct = this.directing && !provisional ? this.options.directCarriers?.(this.tailnet) ?? [] : [];
    return { ...relays.length ? { relays } : {}, ...direct.length ? { direct } : {} };
  }

  /** Both people said the digits match: the phone on its screen, the owner on this PC. */
  private finishPairing(): void {
    const sas = this.sas;
    if (!sas || !sas.phoneConfirmed || !sas.approved || this.state !== "pair-wait") return;
    // an answer that lands after the deadline, before its timer ran, makes no device either
    if (Date.now() > sas.expiresAt) { this.close("timeout"); return; }
    // approved on this PC, then the window it was taken under was closed before the phone confirmed: no device after a close
    if (!sas.membersOnly && this.options.services.relay.approvals.closes !== sas.closes) { this.close("auth_failed"); return; }
    this.state = "verifying";
    // a member's remote approval never lets in a key this PC holds back (removed elsewhere, or a remove for it waits here);
    // only a pairing approved on this PC itself does
    if (sas.approvedBy !== undefined && this.options.services.accountMailbox.gates().held(sas.publicKey)) { this.close("auth_failed"); return; }
    let device: DeviceMatch | undefined;
    try { device = this.options.services.devices.pairRelayApproved(sas.label, sas.publicKey, { path: this.path, id: accountDeviceId(this.options.serverId, sas.publicKey), ...(sas.approvedBy === undefined ? {} : { addedBy: sas.approvedBy }) }, undefined, this.admitNewDevice)?.device; }
    catch (error) {
      if (error instanceof PairingRateLimitedError) { this.close("auth_failed"); return; }
      throw error;
    }
    // pairRelayApproved counted a refused key itself; one admitNewDevice turned away is not counted
    this.endPairing(true);
    if (this.refused) return;
    this.enter(device);
  }

  /** Once per comparison: one that made no device counts against relay pairing (server/devices.ts), unless admitNewDevice refused it. */
  private endPairing(counted: boolean): void {
    const sas = this.sas;
    if (!sas || sas.ended) return;
    sas.ended = true;
    sas.cancelDeadline?.();
    sas.stopRevokeAll?.();
    sas.stopApprover?.();
    sas.withdraw?.();
    if (!counted) this.options.services.devices.noteRelayFailure(this.path);
  }

  /**
   * An account join outside the pairing window (docs/account.md, design 5.3), or another PC of the account
   * vouched for: only with the account or vouched intent, on a PC in an account with a member to approve, for a
   * key the account service has a fresh admission for, at most 5 a minute between them. Never counted as a
   * failed pairing: nobody was asked.
   */
  private async accountJoin(key: string): Promise<boolean> {
    const { devices, relay, accountMailbox } = this.options.services;
    const allowed = () => (this.intent === "account" || this.intent === "vouched") && devices.account() !== null && devices.hasAccountApprover();
    if (!allowed()) return false;
    this.mux.extendSetup(PAIR_APPROVAL_MS + 1_000);
    if (!await accountMailbox.admitted(key) || !allowed()) return false;
    // counted only once admitted, so refused strangers cannot spend the PC's joins
    return relay.approvals.takeAccountJoin();
  }

  /**
   * A sign-in a PC in an account would refuse: a member may have added the device on another PC a
   * moment ago, so the PC reads its mailbox first (at most once a minute and for at most 5 seconds,
   * server/account/mailbox.ts); the caller then checks the sign-in as ever. Whatever fails, an id with
   * no row here or a signature that does not hold, takes this same way, so how long the refusal takes
   * does not tell which ids have a row. A sign-in that holds calls nothing. False when the session
   * ended meanwhile.
   */
  private async pullForRefusedSignIn(deviceId: string, signature: string): Promise<boolean> {
    const { devices, accountMailbox } = this.options.services;
    if (devices.account() === null) return true;
    if (await devices.matchRelay(deviceId, this.nonce, signature, this.options.serverId) !== null) return this.mux.active;
    this.mux.extendSetup(SIGN_IN_WAIT_MS + 10_000);
    await accountMailbox.pullForRefusedSignIn();
    return this.mux.active;
  }

  private get path(): PairingPath { return this.intent === "account" ? "account" : this.intent === "vouched" ? "vouched" : "code"; }

  /** A verified AUTH, PAIR or approved comparison becomes this session's one principal. */
  private enter(device: DeviceMatch | null | undefined): void {
    const devices = this.options.services.devices;
    if (!this.mux.active) return;
    if (!device) { this.close("auth_failed"); return; }
    const unrevoke = devices.onRevoke(device.id, (waiting) => {
      if (waiting) this.leave();
      else this.close(devices.has(device.id) ? "auth_changed" : "auth_revoked");
    });
    // a link moves the row to another key: a session signed in with the one it had ends, all but the linking one
    const unlinked = devices.onLinked(device.id, (sessionId) => { if (sessionId !== this.sessionId) this.close("auth_changed"); });
    this.unwatch = () => { unrevoke(); unlinked(); };
    // the row as its own session sees it: a device, or one that waits to link. What a waiting row may do is decided
    // anew for every stream (principal), never from the answer below
    const row = devices.sessionRow(device.id);
    if (!row || !this.mux.active) { this.unwatch(); return; }
    if (row.role !== device.role) {
      this.close("auth_changed");
      return;
    }
    this.device = Object.freeze(device);
    // a key sent with a code or a comparison was never signed with: nothing account-side may rest on it
    this.key = this.keyProven ? row.key ?? "" : "";
    // The commit callback runs before the sink: synchronous carriers can immediately OPEN.
    // Until then OPEN is still unauthenticated, even while AUTH_OK waits behind receipt credit.
    this.mux.enqueueControl({
      type: FrameType.AUTH_OK, flags: 0, stream_id: 0,
      payload: { session_id: this.sessionId, device_id: device.id, role: device.role, ...this.hints(row.provisional) },
    }, undefined, () => {
      if (!devices.sessionRow(device.id)) { this.close("auth_revoked"); return; }
      this.mux.authenticate(device.id);
      this.state = "ready";
      this.options.onAuthenticated?.(device.id);
    });
  }

  /**
   * The row went before it linked: its link was refused, its time ran out, its code ended. Nothing more starts on
   * this session (principal finds no row), and the answers already on their way go out first, the refused link's own
   * among them, so the device reads why. Then the session ends `auth_revoked`: at once when nothing is on its way,
   * and after LEAVING_MS whatever still is, so a request the device never finishes keeps no session.
   */
  private leave(): void {
    if (this.state === "closed" || this.leaving) return;
    if (this.requests.size === 0) { this.close("auth_revoked"); return; }
    this.leaving = this.clock.setTimeout(() => this.close("auth_revoked"), LEAVING_MS);
  }

  private choose(): void {
    if (this.chosen || this.state !== "ready") return;
    this.chosen = true;
    this.options.onChosen?.();
  }

  /**
   * The device a stream is for, as its row stands now. One that waits to link is marked `provisional` for this one
   * stream: it may make two calls (linkStep), and the routes that take them read the mark. A row that linked since
   * is a device like any other from its next stream on, in the role its row has.
   */
  private principal(): DeviceMatch | undefined {
    if (this.state === "closed") return;
    if (this.state !== "ready" || !this.device) { this.close("protocol_error"); return; }
    const row = this.options.services.devices.sessionRow(this.device.id);
    // while the last answers of a row that went are on their way, a new stream is refused and they still go out
    if (!row) { if (!this.leaving) this.close("auth_revoked"); return; }
    if (row.provisional) return { ...this.device, provisional: true };
    return row.role === this.device.role ? this.device : { ...this.device, role: row.role };
  }

  /** A socket that is not opened: the answer goes out as an HTTP response on its stream. */
  private async refuseSocket(stream: WsStream, response: Response): Promise<void> {
    const rejection = stream.reject(response.status, this.responseHeaders(response.headers));
    if (response.body) await rejection.sendBody(response.body);
    else rejection.end();
  }

  private async websocket(stream: WsStream, exchange: RelayWebSocketRequest): Promise<void> {
    try {
      const response = await (this.options.dispatch ?? handleRequest)(exchange.request, exchange.context);
      if (!stream.live || this.state !== "ready") {
        exchange.upgrade?.data.relay?.close();
        await response?.body?.cancel();
        return;
      }
      const handlers = this.options.websocket;
      if (exchange.upgrade && handlers) {
        const socket = new VirtualSocket(exchange.upgrade.data, stream, handlers);
        this.sockets.set(stream, socket);
        socket.open();
        return;
      }
      if (!response) { stream.reset("internal_error"); return; }
      await this.refuseSocket(stream, response);
    } catch (error) {
      exchange.upgrade?.data.relay?.close();
      if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error");
    }
  }

  private responseHeaders(headers: Headers): [string, string][] {
    const allowed: readonly string[] = RESPONSE_HEADERS;
    return [...headers].filter(([name]) => allowed.includes(name) && (name !== "x-server-time" || this.serverTime));
  }

  private context(device: DeviceMatch, timeout: ServerContext["timeout"], upgrade: ServerContext["upgrade"],
    relayBodyBudget?: EventStreamBudget): ServerContext {
    return {
      services: this.options.services, port: this.options.port, requestIP: () => null, timeout, upgrade,
      peer: { kind: "relay", device, sessionId: this.sessionId, serverId: this.options.serverId, key: this.key }, relayBodyBudget,
    };
  }

  private async http(stream: HttpStream): Promise<void> {
    const device = this.principal();
    if (!device) { stream.reset("refused"); return; }
    this.requests.add(stream);
    const abort = new AbortController();
    let timer: (() => void) | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let held = 0;
    let queued = 0;
    let seconds = 60;
    const touch = () => {
      timer?.();
      timer = seconds > 0 ? this.clock.setTimeout(() => stream.reset("upstream_lost"), seconds * 1000) : undefined;
    };
    const timeout: ServerContext["timeout"] = (_request, budget) => { seconds = budget; touch(); };
    const id = stream.id;
    if (id !== undefined) this.activity.set(id, touch);
    const budget: EventStreamBudget = {
      reserve: (bytes) => {
        if (queued + bytes > SOURCE_LIMIT || this.sourceBytes + bytes + this.mux.stats.accountedBytes > SESSION_LIMIT) {
          stream.reset("resource_exhausted");
          return false;
        }
        queued += bytes;
        this.sourceBytes += bytes;
        return true;
      },
      release: (bytes) => { queued -= bytes; this.sourceBytes -= bytes; },
    };
    stream.onDispose = async () => {
      this.requests.delete(stream);
      timer?.();
      if (id !== undefined) this.activity.delete(id);
      abort.abort();
      await reader?.cancel();
      // the last answer of a row that went before it linked is out
      if (this.leaving && this.requests.size === 0) void this.mux.flush().then(() => this.close("auth_revoked"));
    };
    touch();
    try {
      const request = new Request(RELAY_ORIGIN + stream.request.target, {
        method: stream.request.method, headers: relayHeaders(stream.request.headers),
        body: stream.request.body === "stream" ? stream.body : undefined, signal: abort.signal,
      });
      const context = this.context(device, timeout, () => false, budget);
      if (stream.request.body === "stream") stream.accept();
      // a device that waits to link gets its two calls and nothing else: refused here, before any route runs
      const response = device.provisional && !linkStep(request) ? linkRequired() : await (this.options.dispatch ?? handleRequest)(request, context);
      if (!stream.live || stream.final) { await response?.body?.cancel(); return; }
      if (!response) { stream.reset("internal_error"); return; }
      reader = response.body?.getReader();
      stream.headers(response.status, this.responseHeaders(response.headers));
      if (!stream.live) return;
      if (!reader || stream.noBody) {
        await reader?.cancel();
        stream.end();
        return;
      }
      while (stream.live) {
        const chunk = await reader.read();
        if (!stream.live) return;
        if (chunk.done) { stream.end(); return; }
        held = chunk.value.byteLength;
        if (held + this.sourceBytes + this.mux.stats.accountedBytes > SESSION_LIMIT) {
          held = 0;
          stream.reset("resource_exhausted");
          return;
        }
        this.sourceBytes += held;
        for (let offset = 0; offset < chunk.value.byteLength && stream.live; offset += WS_CONTINUATION_CAPACITY) {
          await stream.write(chunk.value.subarray(offset, offset + WS_CONTINUATION_CAPACITY));
        }
        this.sourceBytes -= held;
        held = 0;
      }
    } catch (error) {
      if (stream.live) stream.reset(error instanceof MuxStreamError ? error.code : "internal_error");
    } finally {
      this.sourceBytes -= held;
      reader?.releaseLock();
      reader = undefined;
    }
  }
}
