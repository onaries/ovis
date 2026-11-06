/**
 * The relay's channel without the relay (docs/relay.md, "Direct on the same network"): a plain
 * WebSocket listener on this PC's private IPv4 addresses that a phone, told them in AUTH_OK
 * (DIRECT_CARRIER), opens instead of relay.ovis.sh. It speaks what the relay speaks to a client
 * (`/v1/ws`, an `assigned` frame, then the client's Noise records) and hands the socket to the same
 * RelaySession a relay data socket gets. No TLS: Noise against the PC key the phone pinned at pairing
 * proves this PC and protects the records, so an address is only ever a hint where to try.
 *
 * Narrower than the relay: devices sign in here, nothing pairs (RelaySession signInOnly). Clients
 * that have not signed in are bounded per source address and in total, apart from the relay's, so
 * nobody on the network can crowd out relay service; signed-in sessions keep the relay's limits.
 */
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { importPublicKey, importSecretKey, MAX_CARRIER_TEXT_BYTES, openDaemonSecureChannel } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import { isDirectCarrier, MAX_DIRECT_CARRIERS } from "../../shared/relay-mux.ts";
import type { RequestServices } from "../dispatch.ts";
import { privateLanPeer } from "../lan-https.ts";
import { SignedInSessions } from "./admissions.ts";
import type { RelayIdentity } from "./identity.ts";
import { RelaySession, relayClock } from "./session.ts";
import type { RelaySocketHandlers } from "./virtual-socket.ts";
import { version } from "../../package.json";

/** The port asked for first; another one when it is taken (AUTH_OK says which). */
export const DIRECT_PORT = 7319;
/** Carriers not yet signed in: per source address, and in total across every address listened on. */
const MAX_PENDING_PER_SOURCE = 2;
const MAX_PENDING = 8;
/** From upgrade to an open protected channel, and from there to a signed-in device. */
const HANDSHAKE_MS = 5_000;
const SIGN_IN_MS = 15_000;
const REFRESH_MS = 30_000;

/** Adapters a phone on the PC's network is not on: containers, VMs, VPNs and tunnels. */
const VIRTUAL_INTERFACE = /^(docker|br-|virbr|veth|vmnet|vboxnet|vnic|utun|tun|tap|tailscale|zt|wg|lxc|lxd|podman|cni|flannel|cali|vethernet|vmware|virtualbox|hyper-v|wsl|bridge)/i;

/**
 * The private IPv4 addresses to listen on and name, at most MAX_DIRECT_CARRIERS: the one the PC's
 * default route leaves from first, then the others in the system's order, leaving out virtual
 * adapters (unless the route leaves from one).
 */
export function rankLanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, routed: string | null): string[] {
  const found = Object.entries(interfaces).flatMap(([name, list]) => (list ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && privateLanPeer(entry.address))
    .map((entry) => ({ name, address: entry.address })));
  const real = found.filter((entry) => entry.address === routed || !VIRTUAL_INTERFACE.test(entry.name)).map((entry) => entry.address);
  const ordered = routed !== null && real.includes(routed) ? [routed, ...real] : real;
  return [...new Set(ordered)].slice(0, MAX_DIRECT_CARRIERS);
}

/** The address the default route leaves from: a UDP socket "connected" to a public address, which sends nothing. */
function routedAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const done = (address: string | null): void => { try { socket.close(); } catch { /* already closed */ } resolve(address); };
    socket.once("error", () => done(null));
    socket.connect(9, "1.1.1.1", () => {
      try { done(socket.address().address); } catch { done(null); }
    });
  });
}

async function lanAddresses(): Promise<string[]> {
  return rankLanAddresses(networkInterfaces(), await routedAddress());
}

export interface DirectCarrierOptions {
  readonly identity: RelayIdentity;
  readonly services: RequestServices;
  /** The main listener's port, as RelaySession takes it. */
  readonly port: number;
  readonly serverVersion?: string;
  readonly clock?: MuxClock;
  /** The private addresses to listen on; this PC's own by default (rankLanAddresses). Tests name loopback. */
  readonly addresses?: () => readonly string[];
  /** The PC's signed-in sessions over every way in (admissions.ts); its own when not given. */
  readonly sessions?: SignedInSessions;
  /** The port to try first (DIRECT_PORT); 0 lets the system pick. */
  readonly preferredPort?: number;
  /** Whether a peer may connect; private IPv4 only by default. Tests on loopback widen it. */
  readonly peerAllowed?: (address: string | undefined) => boolean;
  readonly refreshMs?: number;
  /** What AUTH_OK names for the port listened on, in place of the addresses: tests on loopback name a private one. */
  readonly advertise?: (port: number) => readonly string[];
}

interface SocketData {
  readonly source: string;
  readonly id: string;
}

interface Carrier {
  readonly socket: Bun.ServerWebSocket<SocketData>;
  readonly source: string;
  readonly transport: Transport;
  readonly sockets: Set<Parameters<RelaySocketHandlers["open"]>[0]>;
  cancelTimeout: () => void;
  session?: RelaySession;
  deviceId?: string;
  /** Gives its signed-in place back (SignedInSessions.admit). */
  release?: () => void;
}

export class DirectCarrier {
  private listeners: Bun.Server<SocketData>[] = [];
  private bound: { addresses: readonly string[]; port: number } | null = null;
  private readonly carriers = new Map<string, Carrier>();
  private stopped = false;
  private cancelRefresh: (() => void) | undefined;
  private readonly clock: MuxClock;
  private readonly signedIn: SignedInSessions;

  constructor(private readonly options: DirectCarrierOptions) {
    this.clock = options.clock ?? relayClock;
    this.signedIn = options.sessions ?? new SignedInSessions();
  }

  /**
   * Listens and follows the PC's addresses; settles once the first bind was tried. A failure leaves it
   * off (and the relay as it is) with a message.
   */
  async start(): Promise<void> {
    if (this.stopped) return;
    await this.refresh();
    const again = (): void => {
      if (this.stopped) return;
      void this.refresh().finally(() => { if (!this.stopped) this.cancelRefresh = this.clock.setTimeout(again, this.options.refreshMs ?? REFRESH_MS); });
    };
    if (!this.stopped) this.cancelRefresh = this.clock.setTimeout(again, this.options.refreshMs ?? REFRESH_MS);
  }

  private async refresh(): Promise<void> {
    const addresses = this.options.addresses?.() ?? await lanAddresses();
    if (!this.stopped) this.bind(addresses);
  }

  /** What AUTH_OK tells a phone: `ws://<address>:<port>` for each address listened on, at most MAX_DIRECT_CARRIERS. */
  advertised(): readonly string[] {
    if (!this.bound) return [];
    const { addresses, port } = this.bound;
    const named = this.options.advertise?.(port) ?? addresses.map((address) => `ws://${address}:${port}`);
    return named.filter(isDirectCarrier).slice(0, MAX_DIRECT_CARRIERS);
  }

  /** The port listened on, or null while nothing is. */
  get port(): number | null { return this.bound?.port ?? null; }

  get sessions(): number { return [...this.carriers.values()].filter((carrier) => carrier.deviceId && carrier.session?.mux.active).length; }

  /** (Re)binds when the addresses changed: every one on one port, or none. Carriers already open stay. */
  private bind(listed: readonly string[]): void {
    const addresses = [...new Set(listed)];
    if (this.bound && addresses.join() === this.bound.addresses.join()) return;
    const previous = this.listeners;
    // the port in use is kept across a change, so phones told it a moment ago still find this PC
    const wanted = this.bound?.port ?? this.options.preferredPort ?? DIRECT_PORT;
    this.listeners = [];
    this.bound = null;
    // released before the new ones bind: an address that stayed may hold the port
    for (const listener of previous) void listener.stop(false);
    if (addresses.length === 0) return;
    for (const port of wanted === 0 ? [0] : [wanted, 0]) {
      const made: Bun.Server<SocketData>[] = [];
      try {
        let chosen = port;
        for (const address of addresses) {
          const listener = this.listen(address, chosen);
          made.push(listener);
          chosen = listener.port ?? chosen;
        }
        this.listeners = made;
        this.bound = { addresses, port: chosen };
        return;
      } catch (error) {
        for (const listener of made) void listener.stop(true);
        if (port === 0) console.error(`Direct connections on this network are off: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private listen(address: string, port: number): Bun.Server<SocketData> {
    return Bun.serve<SocketData>({
      hostname: address, port,
      // an upgrade request that never finishes holds nothing for long
      idleTimeout: 10,
      fetch: (request, server) => {
        const source = server.requestIP(request)?.address;
        if (!(this.options.peerAllowed ?? privateLanPeer)(source) || source === undefined) return new Response(null, { status: 403 });
        if (new URL(request.url).pathname !== "/v1/ws") return new Response(null, { status: 404 });
        if (this.stopped) return new Response(null, { status: 503 });
        const pending = [...this.carriers.values()].filter((carrier) => !carrier.deviceId);
        if (pending.length >= MAX_PENDING || pending.filter((carrier) => carrier.source === source).length >= MAX_PENDING_PER_SOURCE) {
          return new Response(null, { status: 503 });
        }
        return server.upgrade(request, { data: { source, id: randomBytes(16).toString("hex") } })
          ? undefined : new Response(null, { status: 426 });
      },
      websocket: {
        // Bun's own pings find a phone that left without closing
        idleTimeout: 60, sendPings: true,
        // one protected mux frame is the largest message there is (relay-e2ee.ts); Bun refuses more before buffering it
        maxPayloadLength: MAX_CARRIER_TEXT_BYTES,
        open: (socket) => this.open(socket),
        message: (socket, message) => this.message(socket, message),
        close: (socket, code, reason) => this.closed(socket, code, reason),
      },
    });
  }

  private open(socket: Bun.ServerWebSocket<SocketData>): void {
    const { id, source } = socket.data;
    if (this.stopped) { socket.close(1001, "Direct connections stopped"); return; }
    const transport: Transport = {
      onmessage: null, onclose: null, onerror: null,
      // a record Bun dropped (0) would break the protected stream after it: the carrier ends instead
      send: (data) => { if (socket.send(data) === 0) socket.close(1011, "Send dropped"); },
      close: (code, reason) => socket.close(code, reason),
    };
    const carrier: Carrier = { socket, source, transport, sockets: new Set(), cancelTimeout: this.clock.setTimeout(() => socket.close(), HANDSHAKE_MS) };
    this.carriers.set(id, carrier);
    // the relay's word to a client that it reached the PC (shared/relay-channel.ts)
    socket.send(JSON.stringify({ type: "assigned", connection_id: id }));
    const { identity, services } = this.options;
    void openDaemonSecureChannel(transport, {
      daemonKeyPair: { publicKey: importPublicKey(identity.public_key), secretKey: importSecretKey(identity.secret_key) },
      events: { onmessage: (data) => { if (!this.stopped) carrier.session?.receive(data); } },
    }).then((channel) => {
      if (this.stopped || this.carriers.get(id) !== carrier || !channel.isOpen()) { channel.close(); return; }
      carrier.cancelTimeout();
      carrier.cancelTimeout = this.clock.setTimeout(() => {
        if (carrier.session?.verifying) carrier.cancelTimeout = this.clock.setTimeout(() => socket.close(), 5_000);
        else socket.close();
      }, SIGN_IN_MS);
      const handlers = services.core.socketHandlers;
      carrier.session = new RelaySession({
        channel, services, port: this.options.port, serverId: identity.server_id,
        serverVersion: this.options.serverVersion ?? version, minSupportedClient: "0.4.20",
        routingOverhead: 0, maxWireMessageBytes: 64 * 1024, signInOnly: true,
        directCarriers: () => this.advertised(),
        onAuthenticated: (deviceId) => this.authenticated(id, carrier, deviceId),
        websocket: {
          ...handlers,
          open: (peer) => { carrier.sockets.add(peer); return handlers.open(peer); },
          close: (peer, code, reason) => { carrier.sockets.delete(peer); handlers.close(peer, code, reason); },
        },
      });
    }).catch(() => socket.close());
  }

  private message(socket: Bun.ServerWebSocket<SocketData>, message: string | Buffer): void {
    const carrier = this.carriers.get(socket.data.id);
    if (!carrier) { socket.close(); return; }
    const data = typeof message === "string" ? message : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
    carrier.transport.onmessage?.({ data, isBinary: typeof message !== "string" });
  }

  private closed(socket: Bun.ServerWebSocket<SocketData>, code: number, reason: string): void {
    const carrier = this.carriers.get(socket.data.id);
    if (!carrier) return;
    carrier.cancelTimeout();
    carrier.release?.();
    this.carriers.delete(socket.data.id);
    carrier.transport.onclose?.(code, reason);
  }

  private authenticated(id: string, carrier: Carrier, deviceId: string): void {
    if (this.carriers.get(id) !== carrier) return;
    carrier.cancelTimeout();
    carrier.deviceId = deviceId;
    carrier.release = this.signedIn.admit(deviceId, () => carrier.session?.close("resource_exhausted"));
  }

  /** Stops listening and ends every carrier, signed in or not. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRefresh?.();
    // no new connections; the carriers' GOAWAY goes out before their sockets close
    const listeners = this.listeners.splice(0);
    for (const listener of listeners) void listener.stop(false);
    this.bound = null;
    await Promise.all([...this.carriers.values()].map(async (carrier) => {
      carrier.cancelTimeout();
      for (const socket of carrier.sockets) socket.close(1001, "Direct connections stopped");
      if (carrier.session) {
        await carrier.session.mux.flush();
        carrier.session.mux.goAway("shutdown", 0);
        await carrier.session.mux.flush();
      }
      carrier.socket.close();
      carrier.release?.();
    }));
    this.carriers.clear();
    for (const listener of listeners) void listener.stop(true);
  }
}
