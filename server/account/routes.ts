import { ACCOUNT_ENROLL_MAX, ACCOUNT_RECORDS_MAX, isAccountKey } from "../../shared/account-records.ts";
import type { Access } from "../access.ts";
import type { ServerContext } from "../dispatch.ts";
import { jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import { parseIntroducedPcs } from "./introductions.ts";
import { ACCOUNT_HELD_MAX } from "./holds.ts";
import { applyAccountRecords, applyEnrollment, applyLink, type LinkRefusal } from "./records.ts";

const LINK_STATUS: Record<LinkRefusal, number> = {
  record_invalid: 400, signature_invalid: 400, account_mismatch: 409, signer_not_member: 403,
  tombstoned: 409, link_not_owner: 403, key_in_use: 409, account_unavailable: 503, enrolling: 409, removal_pending: 409,
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
    // a client about to enroll another PC reads this one's removals after its mailbox, so one waiting there counts too
    const fresh = new URL(request.url).searchParams.get("fresh") === "1" ? await mailbox.freshen() : undefined;
    const blocked = [...new Set([...devices.tombstoneKeys(), ...mailbox.waitingRemoveKeys(), ...context.services.accountHolds.list()])];
    return reply({
      account: devices.account(), ...devices.accountRows(), removals: devices.accountRemovals(), adds: devices.accountAdds(), blocked,
      enrolling: context.services.accountHolds.enrolling(), blocked_all: mailbox.holdsEveryAdd(), ...(fresh === undefined ? {} : { fresh }), mailbox: { last_pull_at: mailbox.lastPullAt, error: mailbox.error },
    });
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
      // a link that may bring this PC into an account: account adds wait until its member enrolls it. On disk
      // first, so a stop keeps them waiting; never lifted by a refused link, as another may be on its way
      // (with no account here no add applies anyway, and the next first member takes the barrier over)
      if (context.services.accountHolds.error !== null) return fail("account_unavailable", context.services.accountHolds.error, 503);
      const first = devices.account() === null;
      // a barrier confirmed by a member who has since left (the PC has no account again) is this link's to take over
      if (first) context.services.accountHolds.startEnrolling(peer.device.id, { stale: true });
      const linked = await applyLink(devices, body.record, { deviceId: peer.device.id, serverId: peer.serverId, sessionKey: peer.key, sessionId: peer.sessionId }, context.services.accountMailbox.gates());
      if ("refused" in linked) return fail(linked.refused, `The link was refused: ${linked.refused}`, LINK_STATUS[linked.refused]);
      // the wait is this device's to end: a link refused meanwhile may have named another; the first link that succeeds keeps it
      if (first) context.services.accountHolds.confirmEnrolling(peer.device.id);
      return reply({ device: linked.device });
    }
    case "/api/account/records": {
      setRequestRoute(pathname);
      const records = body.records;
      if (!Array.isArray(records) || records.length > ACCOUNT_RECORDS_MAX) return fail("record_invalid", `Send at most ${ACCOUNT_RECORDS_MAX} records`, 400);
      const mailbox = context.services.accountMailbox;
      // a removal whose signer is not a member here yet waits for it, as one from the mailbox does; only
      // a member's session (a client relaying the account's removals) may leave one waiting
      const member = peer.kind === "relay" && devices.isAccountApproverSession(peer.device.id, peer.key);
      return reply({ results: await applyAccountRecords(devices, records, serverId, Date.now(), mailbox.gates(), member ? (record) => mailbox.wait(record) : undefined) });
    }
    case "/api/account/enroll": {
      setRequestRoute(pathname);
      const { records, held, held_full: heldFull, last } = body;
      if (!Array.isArray(records) || records.length > ACCOUNT_ENROLL_MAX) return fail("record_invalid", `Send at most ${ACCOUNT_ENROLL_MAX} records`, 400);
      if ((last !== undefined && typeof last !== "boolean") || (heldFull !== undefined && typeof heldFull !== "boolean")) return fail("record_invalid", "last and held_full are true or false", 400);
      if (held !== undefined && (!Array.isArray(held) || held.length > ACCOUNT_HELD_MAX || !held.every(isAccountKey))) return fail("record_invalid", `Hold at most ${ACCOUNT_HELD_MAX} account keys`, 400);
      // what a member hands a PC it brought into the account: the caller is a member of that account here already
      if (peer.kind !== "relay" || !devices.isAccountApproverSession(peer.device.id, peer.key) || typeof body.account !== "string" || devices.account() !== body.account) {
        return fail("account_required", "Link this device to the account on this PC first", 403);
      }
      const holds = context.services.accountHolds;
      const mailbox = context.services.accountMailbox;
      if (holds.error !== null) return fail("account_unavailable", holds.error, 503);
      // before any add, and before the barrier lifts: the keys the member found removed elsewhere stay out of every path
      holds.hold(held ?? []);
      // more keys than one enrollment carries: every add is held back from now on, rather than one let in by the cut
      if (heldFull === true) holds.overflow();
      const gates = mailbox.gates();
      // only the member whose link brought this PC in hands over its adds during the wait; another member's wait with the mailbox's
      // the member whose link brought this PC in, or any member once that one is no longer a drive member here (revoked, say)
      const named = holds.enrollingMember();
      const linker = named === peer.device.id || (named !== null && !devices.isAccountApprover(named));
      const results = await applyEnrollment(devices, records, serverId, { gates: { enrolling: () => !linker && holds.enrolling(), held: gates.held, ...(gates.removing ? { removing: gates.removing } : {}) }, wait: (record) => mailbox.wait(record), settle: () => mailbox.settle() });
      // only the member that linked this PC ends its wait, with the last part of its enrollment, once every remove was decided
      const undecided = results.some((result) => result.outcome === "refused" && result.code === "account_unavailable");
      if (last !== false && !undecided && linker) {
        holds.endEnrolling();
        // adds the barrier held back now pass every gate in their turn
        await mailbox.settle();
      }
      return reply({ results });
    }
    default: return fail("not_found", "Unknown account action", 404);
  }
}
