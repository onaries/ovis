/**
 * Adding the PC this page is on to the account (docs/account.md, "Adding a PC"): signed in on its
 * own screen, the PC lists itself in the account's directory with its relay key, and opens a
 * pairing window whose comparisons only this PC approves. A device already in the account then
 * adds it with one approval: it types the number this PC shows, and the owner approves here.
 */
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { decodeOffer } from "../../../shared/relay-offer.ts";
import { requestRelayLink } from "../api.ts";
import { apiFetch } from "../api-request-id.ts";
import { pcAccountStatus } from "./join.ts";
import { NEW_PC_MS } from "./myPcs.ts";
import type { AccountService } from "./service.ts";

/** Whether this PC belongs to no account yet: only such a PC offers to be added. */
export async function thisPcInNoAccount(): Promise<boolean> {
  return (await pcAccountStatus(apiFetch)).account === null;
}

/**
 * Lists this PC in the account's directory and opens its approve-here pairing window; its name as
 * listed. An entry the card would stop showing before the next relist (`RELIST_MS`) is listed anew,
 * which shows the card again and rings the account's devices, so the card lasts as long as this screen waits.
 */
export async function listThisPc(service: AccountService, options: { relistMs: number }): Promise<string> {
  const offer = decodeOffer((await requestRelayLink({ localOnly: true })).url);
  if (offer === null) throw new Error("This PC's pairing link did not parse");
  const listed = (await service.listPcs()).find((pc) => pc.server_id === offer.server_id);
  if (listed !== undefined && Date.now() - Date.parse(listed.added_at) >= NEW_PC_MS - options.relistMs) await service.deletePc(offer.server_id);
  const name = (offer.name ?? offer.server_id.slice(0, 8)).slice(0, 48);
  const publicKey = Array.from(importPublicKey(offer.server_public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await service.putPc(offer.server_id, { label: name, public_key: publicKey, relay: offer.relay });
  return name;
}
