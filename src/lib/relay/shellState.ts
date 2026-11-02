/**
 * What the hosted shell shows before the app: the screens between opening app.ovis.sh and a
 * connected PC, and which one a failed connection lands on. Pure, so the mapping from the
 * channel's errors to a screen is tested without a browser; the screens themselves are
 * components/RelayShell.tsx, and lib/relay/shell.tsx drives them.
 */
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import type { UpdateStep } from "../../../shared/update.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { inNativeApp } from "../nativeApp.ts";
import { serverIdOfPath } from "../shellMode.ts";
import { RelayAdmissionTimeoutError, RelayUnreachableError, UnsafeRelayDestinationError } from "./channel.ts";
import { ServerIdentityChangedError } from "./device.ts";
import type { RelayDevice } from "./device.ts";

/** Why a connection did not come up; each is a screen with its own `data-relay-state`. */
export type RelayFailure = "pc-offline" | "pc-unresponsive" | "relay-unreachable" | "needs-update" | "revoked" | "identity-changed" | "code-expired" | "bad-offer";

/**
 * Where a PC below MIN_SERVER_VERSION is in its update (skew.ts): its update status being read, an
 * Update button for a managed install, the steps to update by hand for any other, an install
 * under way, the wait for the restarted server, or an install that did not finish.
 */
export type PcUpdate =
  | { phase: "reading" }
  | { phase: "offer" }
  | { phase: "manual" }
  | { phase: "installing"; step: UpdateStep | null }
  | { phase: "restarting" }
  | { phase: "failed"; detail: string | null };

export type RelayShellState =
  | { kind: "list"; devices: RelayDevice[] }
  | { kind: "outdated"; name: string | null; serverVersion: string; minVersion: string; update: PcUpdate }
  | { kind: "empty" }
  | { kind: "confirm"; offer: RelayOffer }
  | { kind: "connecting"; name: string | null }
  /** the phone's key for a PC whose identity changed is gone; only a new QR code from the PC pairs it again */
  | { kind: "forgotten"; name: string | null }
  /** a link with another key under a PC's id (forgedOffer): refused every time, and no saved key is touched */
  | { kind: "forged"; name: string | null }
  | { kind: "failed"; failure: RelayFailure; name: string | null; detail: string | null };

/** The page a shell load is: the PC its path names and the offer its fragment carried, if any. */
export interface ShellEntry {
  serverId: string | null;
  offer: RelayOffer | null;
  /** the fragment held an offer that does not parse, or one for another PC than the path's */
  damaged: boolean;
}

export function shellEntry(url: string): ShellEntry {
  const serverId = serverIdOfPath(new URL(url).pathname);
  try {
    const offer = decodeOffer(url);
    return { serverId, offer, damaged: false };
  } catch {
    return { serverId, offer: null, damaged: true };
  }
}

/**
 * An offer whose key is not the one its PC's id is derived from (server/relay/identity.ts): never
 * that PC's own link, whatever it says, so it is refused like a changed identity, every time it is
 * opened. A PC's own QR code always passes, so only a pairing from the PC itself gets through.
 */
export function forgedOffer(offer: RelayOffer): boolean {
  try { return deriveServerId(importPublicKey(offer.server_public_key)) !== offer.server_id; } catch { return true; }
}

/** The offer a saved PC connects with again: what the pairing offer said, less its one-time code. */
export function offerOf(device: RelayDevice): RelayOffer {
  return { v: 1, server_id: device.server_id, server_public_key: device.server_public_key, relay: device.relay, ...(device.name === undefined ? {} : { name: device.name }) };
}

/**
 * The screen a failed connection lands on. `code`: the attempt carried a pairing code; `paired`:
 * it signed with a key the PC had admitted before. The channel's own codes (shared/relay-mux.ts)
 * say what the PC refused; the channel's deadlines (channel.ts) say who stalled: a relay that
 * never assigned the connection could not be reached, a PC that never answered once it had is
 * offline, and a PC that answered but never finished admitting the device is unresponsive.
 */
export function failureOf(error: unknown, attempt: { code: boolean; paired: boolean }): RelayFailure {
  if (error instanceof UnsafeRelayDestinationError) return "bad-offer";
  if (error instanceof ServerIdentityChangedError) return "identity-changed";
  if (error instanceof RelayUnreachableError) return "relay-unreachable";
  if (error instanceof RelayAdmissionTimeoutError) return "pc-unresponsive";
  if (!(error instanceof MuxProtocolError)) return "relay-unreachable";
  switch (error.code) {
    case "timeout": case "internal_error": case "auth_changed": return "pc-offline";
    case "auth_revoked": return "revoked";
    case "auth_failed": return attempt.code || !attempt.paired ? "code-expired" : "revoked";
    case "unsupported_version": case "unsupported_extension": case "unsupported_transport": return "needs-update";
    default: return "relay-unreachable";
  }
}

/** The failures after which the saved key is no good: the PC removed this phone, or never admitted it. */
export function forgetsDevice(failure: RelayFailure): boolean {
  return failure === "revoked";
}

/** An iPhone or iPad browser tab, where the page's storage may be cleared after a week unvisited; the installed app's is kept. */
export function iosBrowserTab(env: { userAgent: string; maxTouchPoints: number; standalone: boolean | undefined }): boolean {
  const ios = /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
  return ios && env.standalone !== true && !inNativeApp();
}
