import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { encodeOffer } from "../../shared/relay-offer.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { GLOBAL_RELAY, REGIONAL_RELAYS } from "../../shared/relay-regions.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import type { RequestServices } from "../dispatch.ts";
import { isJsonObject } from "../http.ts";
import { writePrivateState } from "../private-state.ts";
import { loadRelayIdentity, relayIdentityPath, RelayIdentityError, rotateRelayIdentity, savedServerId } from "./identity.ts";
import type { RelayIdentity } from "./identity.ts";
import { RelayLink } from "./link.ts";
import type { RelayLinkOptions } from "./link.ts";
import { RelayPairingApprovals } from "./pairing-approvals.ts";
import { RelayPairCodes } from "./pair-code.ts";

export interface RelayServiceOptions {
  readonly stateDir: string;
  readonly relay?: string;
  readonly app?: string;
  /** Physical socket factory; tests connect the advertised TLS origin to a local Bun relay. */
  readonly connect?: RelayLinkOptions["connect"];
  readonly clock?: RelayLinkOptions["clock"];
  readonly random?: RelayLinkOptions["random"];
  /** The version WELCOME tells the shell; package.json's by default. The skew QA reports another. */
  readonly serverVersion?: RelayLinkOptions["serverVersion"];
  /**
   * Regional relays to measure against `relay`. Ovis's own (shared/relay-regions.ts) when neither
   * `relay` nor OVIS_RELAY_URL names a relay; none otherwise, so a self-hosted relay stays the only one.
   */
  readonly regionalRelays?: readonly string[];
  /** The round trip to a relay in ms, or null when it does not answer; `/health` over HTTPS by default. */
  readonly probe?: (relay: string, signal: AbortSignal) => Promise<number | null>;
  /**
   * The relay typed pairing codes meet on (server/relay/pair-code.ts): Ovis's global one, where the
   * hosted app looks for them, when this PC is on it; none on a relay of its own. Tests name theirs.
   */
  readonly pairCodeRelay?: string;
}

/** A regional relay is advertised only when it answers in at most this share of the global one's round trip. */
const REGIONAL_SHARE = 0.5;
const PROBE_TIMEOUT_MS = 5_000;

/** The best of three `/health` round trips; the first one opens the connection and is not counted. */
async function probeRelay(relay: string, signal: AbortSignal): Promise<number | null> {
  const url = new URL("/health", relay.replace(/^wss:/, "https:"));
  let best: number | null = null;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]), cache: "no-store" });
      await response.arrayBuffer();
      if (!response.ok) return null;
      const elapsed = performance.now() - started;
      if (attempt > 0) best = best === null ? elapsed : Math.min(best, elapsed);
    }
  } catch { return null; }
  return best;
}

/** The phone lists the PC under the name Ovis shows for it (server/machines.ts), not its scope URL. */
function offerName(): { name?: string } {
  const name = hostname().slice(0, 64);
  return name ? { name } : {};
}

/** Only secure origins, without credentials, paths, query, fragments or host lists. */
export function relayEndpoint(input: string, protocol: "wss:" | "https:"): string {
  const url = new URL(input);
  if (url.protocol !== protocol || url.username || url.password || url.search || url.hash
    || url.pathname !== "/" || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error(`Invalid ${protocol} relay origin`);
  return url.origin;
}

export class RelayService {
  private phase: RelayStatus["phase"] = "off";
  private error: string | null = null;
  private blocked: RelayStatus["blocked"] = null;
  private link: RelayLink | undefined;
  /** The regional relay's link, besides the global one, once it was chosen. */
  private regionalLink: RelayLink | undefined;
  private regionalPhase: RelayStatus["phase"] = "off";
  private regionalRelay: string | null = null;
  /** Cancels the measurement of the current start: turning the relay off leaves no request to it. */
  private measuring: AbortController | undefined;
  private readonly regionalRelays: readonly string[];
  /** A regional relay named by OVIS_RELAY_URL: used with no measuring, and still beside the global one. */
  private readonly pinned: string | null;
  private services: RequestServices | undefined;
  private port = 0;
  private identity: RelayIdentity | undefined;
  /** the saved identity's server_id read before the relay started (serverId); null: there was none */
  private saved: string | null | undefined;
  private enabled = false;
  private shuttingDown = false;
  private resetting = false;
  private ending: Promise<void> = Promise.resolve();
  readonly relay: string;
  readonly app: string;
  /** Phones that compared digits with this PC and wait for the owner's approval. */
  readonly approvals = new RelayPairingApprovals();
  private pairCodes: RelayPairCodes | undefined;

  constructor(private readonly options: RelayServiceOptions) {
    const named = options.relay ?? process.env["OVIS_RELAY_URL"];
    const origin = named === undefined ? undefined : relayEndpoint(named, "wss:");
    // A phone falls back from Ovis's regional relays to the global one, so a PC on one is always on both.
    this.pinned = origin !== undefined && REGIONAL_RELAYS.includes(origin) ? origin : null;
    this.relay = origin === undefined || this.pinned ? GLOBAL_RELAY : origin;
    this.app = relayEndpoint(options.app ?? process.env["OVIS_RELAY_APP_URL"] ?? "https://app.ovis.sh", "https:");
    this.regionalRelays = this.pinned ? [this.pinned]
      : (options.regionalRelays ?? (origin === undefined ? REGIONAL_RELAYS : []))
        .map((relay) => relayEndpoint(relay, "wss:")).filter((relay) => relay !== this.relay);
  }

  /** This PC's relay identity once the relay has started: what the account service knows it by (server/account/mailbox.ts). */
  currentIdentity(): RelayIdentity | undefined {
    if (this.identity) return this.identity;
    // one already on disk (the relay off since a restart) still names the PC; none is ever made here
    if (!existsSync(relayIdentityPath(this.options.stateDir))) return undefined;
    try { return loadRelayIdentity(this.options.stateDir); } catch (error) {
      if (error instanceof RelayIdentityError) return undefined;
      throw error;
    }
  }


  /** The relay new pairing offers name: the regional one while its link is online, else the global one. */
  private get advertised(): string {
    return this.regionalRelay !== null && this.regionalPhase === "online" ? this.regionalRelay : this.relay;
  }

  /** What a phone is told to save for this PC: the relay new offers name, then the global one it falls back to. */
  private relayHints(): readonly string[] {
    return [...new Set([this.advertised, this.relay])];
  }

  /**
   * This PC's relay ID: the identity in use, else the one saved (read once), also while the relay is off, as a
   * phone that subscribed to alerts through it still gets them. Undefined where it never had one.
   */
  serverId(): string | undefined {
    if (this.identity) return this.identity.server_id;
    if (this.saved === undefined) this.saved = savedServerId(this.options.stateDir) ?? null;
    return this.saved ?? undefined;
  }

  /** Phase and error are the global link's: every phone can reach the PC there. */
  status(): RelayStatus {
    return { phase: this.phase, relay: this.advertised, app: this.app,
      sessions: (this.link?.sessions ?? 0) + (this.regionalLink?.sessions ?? 0),
      blocked: this.blocked, error: this.error };
  }

  private regionPath(): string { return join(this.options.stateDir, "relay", "region.json"); }

  /** A saved regional choice is kept (`save` false); with none, the relays are measured on every start. */
  private async chooseRegion(signal: AbortSignal): Promise<{ relay: string; save: boolean } | null> {
    if (this.pinned) return { relay: this.pinned, save: false };
    try {
      const saved: unknown = JSON.parse(readFileSync(this.regionPath(), "utf8"));
      if (isJsonObject(saved) && typeof saved.relay === "string" && this.regionalRelays.includes(saved.relay)) return { relay: saved.relay, save: false };
    } catch { /* none saved, or unreadable: measure again */ }
    const probe = this.options.probe ?? probeRelay;
    const [global, ...regional] = await Promise.all([this.relay, ...this.regionalRelays].map((relay) => probe(relay, signal)));
    let chosen: string | null = null;
    let fastest = Infinity;
    for (const [index, rtt] of regional.entries()) {
      if (rtt !== null && rtt < fastest) { chosen = this.regionalRelays[index]!; fastest = rtt; }
    }
    // The choice is kept, so it needs both answers: a global relay briefly down says nothing of where the PC is.
    if (chosen === null || global == null || fastest > global * REGIONAL_SHARE) return null;
    return { relay: chosen, save: true };
  }

  private startRegional(link: RelayLink, services: RequestServices, identity: RelayIdentity): void {
    if (this.regionalRelays.length === 0) return;
    this.measuring = new AbortController();
    void this.chooseRegion(this.measuring.signal).catch(() => null).then((choice) => {
      // stopped, restarted or reset meanwhile: that start chooses again, and this measurement is not kept
      if (!choice || this.link !== link || this.regionalLink) return;
      const { relay } = choice;
      // An unsaved choice only means measuring again at the next start; the link opens either way.
      if (choice.save) try { writePrivateState(this.regionPath(), { relay }); } catch { /* measured again next start */ }
      const regional = new RelayLink({
        relay, identity, services, port: this.port,
        connect: this.options.connect, clock: this.options.clock, random: this.options.random, serverVersion: this.options.serverVersion,
        relayHints: () => this.relayHints(),
        onState: (phase) => { if (this.regionalLink === regional) this.regionalPhase = phase; },
      });
      this.regionalLink = regional;
      this.regionalRelay = relay;
      this.regionalPhase = "connecting";
      regional.start();
    });
  }

  /** Boot never enables a missing or damaged state file and never replaces a damaged identity. */
  resume(services: RequestServices, port: number): void {
    this.services = services;
    this.port = port;
    this.blocked = services.serveOnly ? "serve_only" : null;
    try {
      let saved: unknown;
      try { saved = JSON.parse(readFileSync(join(this.options.stateDir, "relay", "state.json"), "utf8")); }
      catch (error) {
        if (isJsonObject(error) && error.code === "ENOENT") return;
        throw new Error("Could not read saved relay state.");
      }
      if (!isJsonObject(saved) || typeof saved.enabled !== "boolean") throw new Error("Saved relay state is invalid.");
      if (saved.enabled) this.start();
    } catch (error) { this.failed(error); }
  }

  private failed(error: unknown): void {
    // without a link nothing retries: the relay is off, and the error says why
    this.phase = this.link ? "error" : "off";
    this.error = error instanceof RelayIdentityError ? error.message : "Could not start the relay.";
    if (error instanceof RelayIdentityError) this.blocked = "identity_unreadable";
  }

  start(): RelayStatus {
    const services = this.services;
    if (!services || this.shuttingDown) throw new Error("Relay service is not available.");
    if (this.resetting) throw new Error("Relay identity reset is in progress.");
    if (services.serveOnly) { this.blocked = "serve_only"; return this.status(); }
    if (this.link) return this.status();
    try {
      this.identity = loadRelayIdentity(this.options.stateDir);
      // Authorization reaches disk before the first outbound socket.
      if (services.token === "" && !services.devices.gated) services.devices.closeGate();
      writePrivateState(join(this.options.stateDir, "relay", "state.json"), { enabled: true });
      this.enabled = true;
      this.blocked = null;
      this.error = null;
      this.phase = "connecting";
      const link = new RelayLink({
        relay: this.relay, identity: this.identity, services, port: this.port,
        connect: this.options.connect, clock: this.options.clock, random: this.options.random, serverVersion: this.options.serverVersion,
        relayHints: () => this.relayHints(),
        onState: (phase, error) => { if (this.link === link) { this.phase = phase; this.error = error; } },
      });
      this.link = link;
      link.start();
      this.startRegional(link, services, this.identity);
    } catch (error) { this.failed(error); }
    return this.status();
  }

  /** A link exists from a successful start until stop; transient failures retry, explicit key refusals do not. */
  get linked(): boolean { return this.link !== undefined; }

  private disconnect(): Promise<void> {
    const link = this.link;
    const regional = this.regionalLink;
    this.link = undefined;
    this.regionalLink = undefined;
    this.regionalPhase = "off";
    this.regionalRelay = null;
    this.measuring?.abort();
    this.measuring = undefined;
    this.phase = "off";
    this.error = null;
    // a code names this PC's key: it goes with the link
    this.pairCodes?.cancel();
    this.ending = Promise.all([this.ending, link?.stop(), regional?.stop()]).then(() => undefined);
    return this.ending;
  }

  async stop(): Promise<RelayStatus> {
    writePrivateState(join(this.options.stateDir, "relay", "state.json"), { enabled: false });
    this.enabled = false;
    await this.disconnect();
    return this.status();
  }

  /** Shutdown preserves the user's saved choice for the next process. */
  shutdown(): Promise<void> {
    this.shuttingDown = true;
    return this.disconnect();
  }

  /** The offer a QR code shows, for a given six-digit code. */
  private offerFor(code: string): RelayOffer {
    // the phone lists the PC under the name Ovis shows for it (server/machines.ts), not its scope URL
    const name = hostname().slice(0, 64);
    return { v: 1, server_id: this.identity!.server_id, server_public_key: this.identity!.public_key,
      relay: this.advertised, code, ...(name ? { name } : {}) };
  }

  /**
   * A code to type on the device being paired (server/relay/pair-code.ts), replacing any showing; null
   * when this PC's relay has none (it is not Ovis's own).
   */
  async pairCode(): Promise<{ code: string; expires_at: string; server_id: string } | null> {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    const relay = this.options.pairCodeRelay ?? (this.relay === GLOBAL_RELAY ? GLOBAL_RELAY : null);
    if (relay === null) return null;
    this.pairCodes ??= new RelayPairCodes({ relay, devices: this.services.devices, offer: (code) => this.offerFor(code), connect: this.options.connect });
    return { ...await this.pairCodes.mint(), server_id: this.identity.server_id };
  }

  /** Takes the code showing off the relay. */
  cancelPairCode(): void {
    this.pairCodes?.cancel();
  }

  offer(): { url: string; expires_at: string } {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    const pairing = this.services.devices.activePairing() ?? this.services.devices.startPairing();
    return {
      url: encodeOffer({ v: 1, server_id: this.identity.server_id, server_public_key: this.identity.public_key,
        relay: this.advertised, code: pairing.code, ...offerName() }, this.app),
      expires_at: pairing.expires_at,
    };
  }

  /**
   * A pairing link without a code: the phone that opens it pairs by comparing six digits with this
   * PC, and the owner approves it here (server/relay/session.ts). It holds nothing secret; asking for it
   * opens the window in which this PC takes comparisons (pairing-approvals.ts PAIRING_WINDOW_MS).
   */
  pairingLink(options: { localOnly?: boolean } = {}): { url: string } {
    if (!this.enabled || !this.identity || !this.services || this.blocked) throw new Error("Start the relay before pairing.");
    this.approvals.openWindow(Date.now(), options);
    return { url: encodeOffer({ v: 1, server_id: this.identity.server_id, server_public_key: this.identity.public_key, relay: this.advertised, ...offerName() }, this.app) };
  }

  async resetIdentity(): Promise<RelayStatus> {
    const services = this.services;
    if (!services || this.shuttingDown) throw new Error("Relay service is not available.");
    if (services.serveOnly) { this.blocked = "serve_only"; return this.status(); }
    // Close old admissions before revoking or replacing the key they authenticated against.
    if (this.resetting) throw new Error("Relay identity reset is in progress.");
    this.resetting = true;
    try {
      await this.disconnect();
      for (const device of services.devices.list(null)) if (device.via_relay) services.devices.revoke(device.id);
      this.identity = rotateRelayIdentity(this.options.stateDir);
      this.blocked = null;
    } finally { this.resetting = false; }
    return this.enabled ? this.start() : this.status();
  }
}
