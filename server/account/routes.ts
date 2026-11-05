import { ACCOUNT_RECORDS_MAX } from "../../shared/account-records.ts";
import type { Access } from "../access.ts";
import type { ServerContext } from "../dispatch.ts";
import { jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import { parseIntroducedPcs } from "./introductions.ts";
import { applyAccountRecords, applyLink, type LinkRefusal } from "./records.ts";

const LINK_STATUS: Record<LinkRefusal, number> = {
  record_invalid: 400, signature_invalid: 400, account_mismatch: 409, signer_not_member: 403,
  tombstoned: 409, link_not_owner: 403, key_in_use: 409, account_unavailable: 503,
};

/**
 * /api/account/* (docs/account.md, "PC API"): drive access only, directly or through the relay,
 * and the app's own mutation guard for changes.
 */
export async function handleAccountRequest(request: Request, pathname: string, context: ServerContext, access: Access): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  const devices = context.services.devices;
  const peer = context.peer;
  // the one route a watching device may use: its own introduction, over its own session
  if (pathname === "/api/account/introduction" && request.method === "GET") {
    setRequestRoute(pathname);
    const pcs = peer.kind === "relay" ? context.services.accountIntroductions.get(peer.key) : null;
    return pcs ? reply({ pcs }) : fail("introduction_none", "No introduction waits for this device", 404);
  }
  if (access.level !== "full" || access.role !== "drive") return fail("read_only", "this device can only watch", 403);
  if (pathname === "/api/account/status" && request.method === "GET") {
    setRequestRoute(pathname);
    const mailbox = context.services.accountMailbox;
    return reply({ account: devices.account(), ...devices.accountRows(), removals: devices.accountRemovals(), mailbox: { last_pull_at: mailbox.lastPullAt, error: mailbox.error } });
  }
  if (request.method !== "POST") return fail("method_not_allowed", "use POST", 405);
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", "Manage the account from this app", 403);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const serverId = peer.kind === "relay" ? peer.serverId : context.services.relay.currentIdentity()?.server_id ?? null;
  switch (pathname) {
    case "/api/account/introduce": {
      setRequestRoute(pathname);
      if (peer.kind !== "relay" || !devices.isAccountApproverSession(peer.device.id, peer.key)) return fail("account_required", "Introduce devices from a device linked to the account", 403);
      if (typeof body.key !== "string" || !devices.wasAddedByMember(body.key)) return fail("introduction_unknown_key", "No account member added that device here", 404);
      const pcs = parseIntroducedPcs(body.pcs);
      if (!pcs) return fail("introduction_invalid", "List at most 32 PCs, each with a server_id its key derives", 400);
      context.services.accountIntroductions.set(body.key, pcs);
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    case "/api/account/link": {
      setRequestRoute(pathname);
      // a link proves the key of the row whose session sends it, and only the relay carries a row's key
      if (peer.kind !== "relay") return fail("link_not_owner", "Link a device from its own connection through the relay", 403);
      const linked = await applyLink(devices, body.record, { deviceId: peer.device.id, serverId: peer.serverId, sessionKey: peer.key, sessionId: peer.sessionId });
      if ("refused" in linked) return fail(linked.refused, `The link was refused: ${linked.refused}`, LINK_STATUS[linked.refused]);
      return reply({ device: linked.device });
    }
    case "/api/account/records":
    case "/api/account/enroll": {
      setRequestRoute(pathname);
      const records = body.records;
      if (!Array.isArray(records) || records.length > ACCOUNT_RECORDS_MAX) return fail("record_invalid", `Send at most ${ACCOUNT_RECORDS_MAX} records`, 400);
      if (pathname === "/api/account/enroll") {
        // what a member hands a PC it just paired: the caller is a member of that account here already
        const member = peer.kind === "relay" ? devices.isAccountApproverSession(peer.device.id, peer.key) : access.device !== undefined && devices.isAccountApprover(access.device.id);
        if (typeof body.account !== "string" || !member || devices.account() !== body.account) {
          return fail("account_required", "Link this device to the account on this PC first", 403);
        }
        if (!records.every((record) => typeof record === "object" && record !== null && (record as { kind?: unknown }).kind === "add")) {
          return fail("record_invalid", "An enrollment carries add records only", 400);
        }
      }
      const results = await applyAccountRecords(devices, records, serverId);
      // a removal whose signer is not a member here yet waits for it, as one from the mailbox does; only
      // a member's session (a client relaying the account's removals: enrollPc) may leave one waiting
      const member = peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
      results.forEach((result, index) => {
        if (member && result.outcome === "refused" && result.code === "signer_not_member" && (records[index] as { kind?: unknown }).kind === "remove") context.services.accountMailbox.wait(records[index]);
      });
      return reply({ results });
    }
    default: return fail("not_found", "Unknown account action", 404);
  }
}
