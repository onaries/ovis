/**
 * How each saved PC answers now, for the front page's list (components/RelayShell.tsx): the phone
 * probes it the way it would connect (its direct carriers in the apps, then its relay), with no
 * session, and names the first way the PC answered on with that handshake's round trip.
 */
import type { DeviceRoute } from "../../../shared/access.ts";
import { probePc } from "../../../shared/relay-channel.ts";
import type { PcProbe, RelaySocket } from "../../../shared/relay-channel.ts";
import type { RelayDevice } from "../../../shared/relay-device.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { isTailnetCarrier } from "../../../shared/relay-mux.ts";
import { relayFallback } from "../../../shared/relay-regions.ts";
import { keyIdOf } from "./shellState.ts";

export type PcStatus =
  | { readonly kind: "checking" }
  /** the PC finished the encrypted handshake on `route`; the check stops before signing in, so this device's own admission is not known */
  | { readonly kind: "answered"; readonly route: DeviceRoute; readonly relay?: string; readonly rttMs: number }
  /** `pc`: the relay has nobody for it (off, or Ovis not running); `relay`: no relay answered this device */
  | { readonly kind: "offline"; readonly reason: "pc" | "relay" };

/** Every direct carrier together gets this long, as a connection gives them (transport.ts DIRECT_BUDGET_MS). */
export const DIRECT_PROBE_MS = 1_500;
/** The relay's turn: past it with no answer from the PC, the PC is called offline. */
export const RELAY_PROBE_MS = 8_000;

export interface PcCheckSockets {
  /** a WebSocket to the relay */
  readonly relay: (url: string) => RelaySocket;
  /** the phone apps' socket to a direct carrier; a browser has none */
  readonly direct?: (url: string) => RelaySocket;
}

/**
 * The saved PCs one sweep probes: paired ones whose key is the one their id names (a mismatch is the
 * identity-changed screen's to handle), at most `max`, starting at `cursor` so that past `max` every
 * PC gets its turn. The rows marked as being checked are exactly these.
 */
export function sweepOf(devices: readonly RelayDevice[], cursor: number, max: number): RelayDevice[] {
  const paired = devices.filter((device) => device.device_id !== null && keyIdOf(device.server_public_key) === device.server_id);
  const start = paired.length > max && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor % paired.length : 0;
  return [...paired.slice(start), ...paired.slice(0, start)].slice(0, max);
}

export async function checkPc(device: RelayDevice, sockets: PcCheckSockets, probe: typeof probePc = probePc): Promise<Exclude<PcStatus, { kind: "checking" }>> {
  const offer: RelayOffer = { v: 1, server_id: device.server_id, server_public_key: device.server_public_key, relay: device.relay };
  const carriers = sockets.direct ? device.direct ?? [] : [];
  // as a connection gives them (transport.ts): what an earlier carrier left unused goes to the ones after it
  const deadline = Date.now() + DIRECT_PROBE_MS;
  for (const [index, direct] of carriers.entries()) {
    const found = await probe(offer, { direct }, sockets.direct!, Math.max(0, deadline - Date.now()) / (carriers.length - index));
    if (found.kind === "answered") return { kind: "answered", route: isTailnetCarrier(direct) ? "tailscale" : "lan", rttMs: found.ms };
  }
  let relay = device.relay;
  let found: PcProbe = await probe(offer, { relay }, sockets.relay, RELAY_PROBE_MS);
  // a PC on one of Ovis's regional relays is always on the global one too, and a connection falls back to it
  // whether the regional relay failed or had nobody for the PC (openRelayChannelWithFallback)
  const fallback = relayFallback(relay);
  if (found.kind !== "answered" && fallback !== null) {
    const first: PcProbe = found;
    found = await probe(offer, { relay: fallback }, sockets.relay, RELAY_PROBE_MS);
    if (found.kind === "answered") relay = fallback;
    // silent on both: the PC is on neither; a global relay this device cannot reach leaves the PC unknown, so the relay is the reason
    else if (first.kind === "silent" && found.kind === "silent") found = first;
  }
  return found.kind === "answered" ? { kind: "answered", route: "relay", relay, rttMs: found.ms }
    : { kind: "offline", reason: found.kind === "silent" ? "pc" : "relay" };
}
