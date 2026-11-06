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
import type { MyPc } from "../account/myPcs.ts";
import type { AccountProvider } from "../account/store.ts";
import { inNativeApp } from "../nativeApp.ts";
import { serverIdOfPath } from "../shellMode.ts";
import { RelayAdmissionTimeoutError, RelayUnreachableError, UnsafeRelayDestinationError } from "./channel.ts";
import { ServerIdentityChangedError } from "./device.ts";
import type { TypedCodeFailure } from "./pairCode.ts";
import type { RelayDevice } from "./device.ts";

/** Where a relay key the phone holds came from: the link it opened, or the pairing it saved. */
export type KeySource = "link" | "saved";

/**
 * A key that is not the one a PC id names, as the phone can show it: the id named (a PC's id is a
 * SHA-256 of its real key, server/relay/identity.ts), the id the other key would have (null for a
 * key that does not even parse) and where that key came from. Neither is vouched for here: a link
 * names any id it likes, so the person compares them with the id the PC itself shows. Both come
 * from what the phone holds already, so telling them apart sends nothing to the relay or the PC.
 */
export interface KeyMismatch { expected: string; received: string | null; from: KeySource }

/** The id a relay key would have, or null for a key that does not parse. */
export function keyIdOf(publicKey: string): string | null {
  try { return deriveServerId(importPublicKey(publicKey)); } catch { return null; }
}

/** The first of `keys` that is not the key `serverId` names; null when every one is. */
export function keyMismatch(serverId: string, keys: readonly { key: string; from: KeySource }[]): KeyMismatch | null {
  for (const { key, from } of keys) {
    const received = keyIdOf(key);
    if (received !== serverId) return { expected: serverId, received, from };
  }
  return null;
}

/** Why a connection did not come up; each is a screen with its own `data-relay-state`. */
export type RelayFailure = "pc-offline" | "pc-unresponsive" | "relay-unreachable" | "needs-update" | "revoked" | "identity-changed" | "code-expired" | "pair-declined" | "pair-unavailable" | "bad-offer"
  /** a PC an introduction named just now refused this device: its mailbox has not brought the add yet */
  | "not-added-yet";

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

/**
 * The front page's account part: the sign-in buttons, the wait while the provider's pages are up,
 * or the account's PCs (null while they load). Null on a PC's own page, which has no account part.
 */
export type AccountView =
  | { kind: "signed-out"; error: string | null }
  | { kind: "signing-in" }
  | { kind: "signed-in"; provider: AccountProvider; pcs: MyPc[] | null; error: string | null };

export type RelayShellState =
  | { kind: "list"; devices: RelayDevice[]; account?: AccountView | null }
  | { kind: "outdated"; name: string | null; serverVersion: string; minVersion: string; update: PcUpdate }
  | { kind: "empty"; account?: AccountView | null }
  | { kind: "confirm"; offer: RelayOffer }
  | { kind: "connecting"; name: string | null }
  /** Pair with a code: the field to type it in, with why the last code gave no PC */
  | { kind: "code-entry"; failure: TypedCodeFailure | null }
  | { kind: "code-looking" }
  /** a typed code found a PC: its full ID to compare with the PC's screen before anything is paired */
  | { kind: "code-compare"; offer: RelayOffer }
  /** pairing without a code: the digits to compare with the PC's screen; `confirmed` once this phone said they match */
  | { kind: "compare"; name: string | null; digits: string; confirmed: boolean; /** the digits are typed from the PC's screen, never shown here */ typed?: boolean; /** the typed digits were not the PC's: the comparison ended */ wrong?: boolean }
  /** the phone's key for a PC whose identity changed is gone; only a new QR code from the PC pairs it again */
  | { kind: "forgotten"; name: string | null }
  /** a link with another key under a PC's id (forgedOffer): refused every time, and no saved key is touched */
  | { kind: "forged"; name: string | null; mismatch: KeyMismatch | null }
  /** `mismatch`: on identity-changed, the key that is not the PC's, when the phone can name it */
  | { kind: "failed"; failure: RelayFailure; name: string | null; detail: string | null; mismatch?: KeyMismatch | null };

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
  return keyIdOf(offer.server_public_key) !== offer.server_id;
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
export function failureOf(error: unknown, attempt: { code: boolean; paired: boolean; compared?: boolean; codeless?: boolean }): RelayFailure {
  if (error instanceof UnsafeRelayDestinationError) return "bad-offer";
  // a link without a code that the PC refused before any digits: no code to blame, and the wire does not say why
  // (pairing paused after failures, three phones already waiting, a serve-only PC)
  if (attempt.codeless && !attempt.code && !attempt.paired && !attempt.compared
    && error instanceof MuxProtocolError && error.code === "auth_failed") return "pair-unavailable";
  // once digits were shown, the PC answered: a refusal or a deadline there means it was not approved in time
  if (attempt.compared && (error instanceof RelayAdmissionTimeoutError
    || error instanceof MuxProtocolError && (error.code === "auth_failed" || error.code === "timeout"))) return "pair-declined";
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

/**
 * A link without a code that this phone opened while it still held a key for that PC, refused at
 * sign-in: the PC no longer knows the key (it removed this phone). The link is there to pair again
 * by comparing digits, so the old key goes and the attempt runs once more without it. A code
 * attempt, one already compared, or one that already did this never does.
 */
export function pairsAgainWithoutKey(error: unknown, attempt: { code: boolean; paired: boolean; compared?: boolean; refreshed?: boolean; codeless: boolean }): boolean {
  return attempt.codeless && !attempt.code && !attempt.compared && !attempt.refreshed
    && error instanceof MuxProtocolError && error.code === "auth_failed";
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
