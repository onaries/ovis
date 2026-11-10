import { newPcs, NEW_PC_MS, type MyPc, type MyPcState } from "../account/myPcs.ts";
import type { PcStatus } from "./pcStatus.ts";
import { REGIONAL_RELAYS } from "../../../shared/relay-regions.ts";

export type DashboardPc = MyPc & { relay: string | null };
export type DashboardState = MyPcState | "unchecked";

/** One readiness decision for every surface; pairing alone is not a readiness observation. */
export function dashboardState(pc: Pick<MyPc, "state" | "listed">, check: PcStatus | null): DashboardState {
  switch (pc.state) {
    case "needs-approval": case "needs-update": return pc.state;
    case "offline": return check?.kind === "answered" ? "paired" : "offline";
    case "paired": return pc.listed || check?.kind === "answered" ? "paired" : "unchecked";
  }
}

/** The PCs table's filters; the strip's Ready, Needs you and Offline cells select the same three. */
export type DashboardFilter = "all" | "ready" | "needs" | "offline";

/**
 * Needs you: whatever the owner has to act on, an approval, an update or a PC gone offline. It
 * overlaps Offline on purpose, so the counts are never added up as a partition.
 */
function needsYou(state: DashboardState): boolean {
  switch (state) {
    case "needs-approval": case "needs-update": case "offline": return true;
    case "paired": case "unchecked": return false;
  }
}

export function inDashboardFilter(state: DashboardState, filter: DashboardFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "ready": return state === "paired";
    case "needs": return needsYou(state);
    case "offline": return state === "offline";
  }
}

/** The table's triage groups: what needs an action, then what is offline, then what is ready. */
const TABLE_GROUP: Record<DashboardState, number> = { "needs-approval": 0, "needs-update": 0, offline: 1, paired: 2, unchecked: 2 };

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byNameThenId = (a: MyPc, b: MyPc): number => a.name.localeCompare(b.name) || byId(a.server_id, b.server_id);
const byTableOrder = (a: MyPc & { displayState: DashboardState }, b: MyPc & { displayState: DashboardState }): number =>
  TABLE_GROUP[a.displayState] - TABLE_GROUP[b.displayState] || byNameThenId(a, b);

/**
 * The PCs with the relay each one goes through: the account directory's `relay` for a PC it lists
 * (the one its `join` route carries, docs/account.md "GET /v1/pcs"), else the relay of this device's
 * own pairing (RelayDevice.relay) for a PC paired without the account, else null, which
 * dashboardModel puts under the shell's default relay. Pure: `saved` is whatever the device store listed.
 */
export function dashboardPcs(pcs: readonly MyPc[], saved: readonly { server_id: string; relay: string }[], directory: readonly { server_id: string; relay: string | null }[] = []): DashboardPc[] {
  const listed = new Map(directory.map((pc) => [pc.server_id, pc.relay]));
  const paired = new Map(saved.map((device) => [device.server_id, device.relay]));
  return pcs.map((pc) => ({ ...pc, relay: listed.get(pc.server_id) ?? pc.join?.relay ?? paired.get(pc.server_id) ?? null }));
}

/** A relay origin as a row names it: its host alone (`relay-ap.ovis.sh`), or the origin as given when it is not a URL. */
export function relayHost(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

/** This device as the dashboard sees from it: its name, its clock, and how each saved PC answered its own latest check. */
export interface DashboardViewer {
  readonly label: string;
  /** defaults to the wall clock; Add windows close against it */
  readonly now?: number;
  readonly status?: ReadonlyMap<string, PcStatus>;
}

/** Attention order: fresh Add windows first (nearest expiry first), then updates, other approvals, offline. */
const ATTENTION_RANK: Record<Exclude<MyPcState, "paired">, number> = { "needs-update": 1, "needs-approval": 2, offline: 3 };

/**
 * Everything the dashboard shows, from one membership: the counts are the filters' lengths and the
 * attention list is the Needs filter in urgency order, so the strip, the filter and the list cannot
 * disagree. Raw `state`/`source` and this device's `check` retain their provenance.
 * `displayState` reconciles them once: a live answer beats stale Offline, while an unlisted
 * pairing without an answer remains unchecked. Pairing membership still controls access.
 */
export function dashboardModel(pcs: readonly DashboardPc[], me: DashboardViewer, defaultRelay: string) {
  const now = me.now ?? Date.now();
  const expiries = new Map(newPcs(pcs, now).flatMap((pc) => pc.added_at === null ? [] : [[pc.server_id, Date.parse(pc.added_at) + NEW_PC_MS] as const]));
  const rows = pcs.map((pc) => {
    const check = (pc.paired ? me.status?.get(pc.server_id) : undefined) ?? null;
    return {
      ...pc,
      displayState: dashboardState(pc, check),
      origin: pc.relay ?? defaultRelay,
      source: pc.listed ? "directory" as const : "this-device" as const,
      check,
    };
  }).sort(byTableOrder);

  const ids = (filter: DashboardFilter): string[] => rows.filter((pc) => inDashboardFilter(pc.displayState, filter)).map((pc) => pc.server_id);
  const filters: Record<DashboardFilter, readonly string[]> = { all: ids("all"), ready: ids("ready"), needs: ids("needs"), offline: ids("offline") };

  const attention = rows
    .flatMap((pc) => pc.displayState === "paired" || pc.displayState === "unchecked" ? [] : [{ pc, reason: pc.displayState, expiresAt: expiries.get(pc.server_id) ?? null }])
    .sort((a, b) => (a.expiresAt === null ? ATTENTION_RANK[a.reason] : 0) - (b.expiresAt === null ? ATTENTION_RANK[b.reason] : 0)
      || (a.expiresAt ?? 0) - (b.expiresAt ?? 0)
      || byNameThenId(a.pc, b.pc))
    .map(({ pc, reason, expiresAt }) => ({ server_id: pc.server_id, reason, expiresAt }));

  const hubs = new Map<string, typeof rows>();
  for (const row of rows) hubs.set(row.origin, [...(hubs.get(row.origin) ?? []), row]);
  const busiestFirst = [...hubs].sort(([a, pcsA], [b, pcsB]) => pcsB.length - pcsA.length || a.localeCompare(b));

  return {
    counts: { ready: filters.ready.length, needsYou: filters.needs.length, offline: filters.offline.length, paired: rows.filter((pc) => pc.paired).length },
    filters,
    rows,
    attention,
    relays: busiestFirst.map(([origin, members]) => ({ origin, regional: REGIONAL_RELAYS.includes(origin), pcs: members.map((pc) => pc.server_id) })),
    map: {
      me: { label: me.label },
      hubs: busiestFirst.map(([origin, members]) => ({
        origin,
        nodes: members.map((pc) => ({
          server_id: pc.server_id,
          name: pc.name,
          state: pc.displayState,
          last_seen_at: pc.last_seen_at,
          seen: pc.state === "offline" ? "stale" as const
            : pc.state === "paired" && pc.last_seen_at !== null ? "lately" as const : "unknown" as const,
          check: pc.check,
        })),
      })),
    },
  };
}
