/**
 * My PCs: the account's directory, which this client does not trust, merged with the PCs this
 * client is paired with, which it does. A PC in the directory alone still needs this device
 * approved; its name there is only a label, and its key comes from comparing digits, never from
 * the directory (docs/account.md, rule 6).
 */
import type { RelayDevice } from "../relay/device.ts";
import { enrollmentOf, type EnrollmentState } from "../relay/device.ts";
import { exportPublicKey } from "../../../shared/relay-e2ee.ts";
import { keyIdOf } from "../relay/shellState.ts";
import type { DirectoryPc } from "./service.ts";

function joinRoute(pc: DirectoryPc): MyPc["join"] {
  if (pc.public_key === null || pc.relay === null) return undefined;
  const bytes = Uint8Array.from(pc.public_key.match(/../g) ?? [], (pair) => parseInt(pair, 16));
  const server_public_key = exportPublicKey(bytes);
  return keyIdOf(server_public_key) === pc.server_id ? { server_public_key, relay: pc.relay } : undefined;
}

/** How long a PC new in the directory is offered as a card to add: as long as the PC's own screen keeps its pairing window open. */
export const NEW_PC_MS = 10 * 60_000;

/** PCs that joined the directory lately and wait for this device to add them: offered as a card above the list. */
export function newPcs(pcs: readonly MyPc[], now: number): MyPc[] {
  return pcs.filter((pc) => pc.state === "needs-approval" && pc.join !== undefined && pc.added_at !== null && now - Date.parse(pc.added_at) < NEW_PC_MS);
}

/** The PC pulls its mailbox every five minutes while it belongs to the account; three missed pulls and it is called off. */
export const OFFLINE_AFTER_MS = 15 * 60_000;

export type MyPcState = "paired" | "needs-approval" | "offline" | "needs-update";

export interface MyPc {
  readonly server_id: string;
  readonly name: string;
  readonly state: MyPcState;
  /** when the PC last came by the account service; null when it never has */
  readonly last_seen_at: string | null;
  /** when the account's directory took it; null for a PC only this device's pairings know */
  readonly added_at: string | null;
  /** in the account's directory; false for a PC paired by QR code that the account does not list yet */
  readonly listed: boolean;
  /** this device holds an admitted key for it, so it can open; whatever its state says */
  readonly paired: boolean;
  /**
   * this device signs in to it with the account key, so removing the device through the account
   * reaches it; a pairing from before the account is not covered until it is linked
   */
  readonly linked: boolean;
  readonly enrollment?: EnrollmentState;
  /**
   * For a PC this device is not paired with: its relay key (base64, as an offer carries it) and
   * relay, to compare digits with it. Only when the key is the one the PC's id is derived from,
   * so the directory cannot point this device at another PC (docs/account.md, rule 6).
   */
  readonly join?: { readonly server_public_key: string; readonly relay: string };
}

const ORDER: Record<MyPcState, number> = { paired: 0, "needs-update": 1, "needs-approval": 2, offline: 3 };

/**
 * One row per PC. `outdated`: PCs whose last connection showed an Ovis without accounts. A paired
 * PC is offline only once the directory has seen it and not lately: one that never pulled may just
 * not belong to the account yet.
 */
export function myPcs(directory: readonly DirectoryPc[], paired: readonly RelayDevice[], options: { now: number; outdated?: ReadonlySet<string>; accountKey?: string; account?: string }): MyPc[] {
  const listed = new Map(directory.map((pc) => [pc.server_id, pc]));
  const rows: MyPc[] = [];
  const stateOf = (serverId: string, isPaired: boolean, lastSeen: string | null): MyPcState => {
    if (options.outdated?.has(serverId)) return "needs-update";
    if (lastSeen !== null && options.now - Date.parse(lastSeen) > OFFLINE_AFTER_MS) return "offline";
    return isPaired ? "paired" : "needs-approval";
  };
  for (const device of paired) {
    if (device.device_id === null) continue;
    const entry = listed.get(device.server_id);
    listed.delete(device.server_id);
    const lastSeen = entry?.last_seen_at ?? null;
    const enrollment = enrollmentOf(device, options.account);
    rows.push({ server_id: device.server_id, name: device.name ?? device.server_id.slice(0, 8), state: stateOf(device.server_id, true, lastSeen), last_seen_at: lastSeen, added_at: entry?.added_at ?? null, listed: entry !== undefined, paired: true, linked: enrollment !== "pending" && enrollment !== "failed" && entry !== undefined && device.public_spki === options.accountKey && device.account !== undefined && device.account === (options.account ?? device.account), ...(enrollment ? { enrollment } : {}) });
  }
  for (const pc of listed.values()) {
    rows.push({ server_id: pc.server_id, name: pc.label, state: stateOf(pc.server_id, false, pc.last_seen_at), last_seen_at: pc.last_seen_at, added_at: pc.added_at, listed: true, paired: false, linked: false, ...(joinRoute(pc) ? { join: joinRoute(pc) } : {}) });
  }
  return rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}
