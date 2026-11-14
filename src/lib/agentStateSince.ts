/**
 * How long each agent has been in its state (#3505). herdr reports no time of change, so this device
 * stamps a change when it sees one and keeps the stamps, per PC and pane, across reloads. Done and
 * idle are one state here: reading a finished agent turns done into idle, and looking is not the
 * agent doing anything. A state this device did not see begin has no stamp, and its row says no
 * time rather than a wrong one.
 *
 * A pane's ID is not the pane for good: herdr gives a pane it moves to another workspace a new ID,
 * and an ID may come to name another pane (the server reckons with an ended pane's ID being given
 * out again, server/finishes.ts). A pane's terminal is its own for as long as it lives, so a stamp
 * names the terminal of the pane it tells of, and tells of no other.
 *
 * A kept stamp is trusted by a look that did not see its state begin only on proof that the state
 * held meanwhile. Two counters give it together: herdr's `state_change_seq`, which moves with every
 * state of herdr's own, and the server's `finish_id`, which moves whenever the status Ovis shows
 * turns done. The state Ovis shows is not always herdr's (a Claude whose turn ended while a
 * subagent keeps herdr at working rests; server/core/status.ts), and every way back to a state
 * left that way passes a finish. For the agents whose state Ovis reads from their own session
 * files, herdr's counter stands still whatever they do, so nothing proves their stamps. The server
 * counts a pane's finishes by its ID (server/finishes.ts): a count is held against another only
 * where both were counted under the same ID. One thing no counter follows: the hold that a turn's
 * background work puts on a row at rest (`background_wait`, server/background-wait.ts). A hold
 * that began and ended wholly out of sight leaves a kept stamp of that rest standing.
 */
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus } from "../../shared/protocol.ts";
import { agentGroup, type AgentGroup } from "./agentRoster.ts";
import { BLIND_MS } from "./agentStateWatch.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import { stateSeqs } from "./sidebarOrder.ts";
import { knownStatus } from "./status.ts";

/** the states a stamp tells apart: the list's groups, with done filed under idle */
export type StampState = Exclude<AgentGroup, "done">;

export function stampState(group: AgentGroup): StampState {
  return group === "done" ? "idle" : group;
}

export interface StateStamp {
  state: StampState;
  /** when the state began, as this device's clock said it */
  at: number;
  /** the terminal (`terminal_id`) of the pane it tells of: under the same ID, a pane with another terminal is another pane */
  terminal: string;
  /**
   * herdr's `state_change_seq` of the change that began the state. Absent while only a pushed status told of the
   * change (the roster that carries its counter comes after), where the state changed and herdr's counter did not
   * (a status Ovis makes itself), and where herdr gives none: nothing proves such a stamp after a reload.
   */
  seq?: number;
  /** the server's count of the pane's finishes (`finish_id`, counted in the PC's `epoch`) as the stamp last saw it */
  finish?: number;
  /** when its pane was first missing from the roster, while it still is: the stamp is forgotten thirty days after */
  gone?: number;
}

/**
 * One PC's stamps, by pane, under the herdr they were made on (the snapshot's `herdr_lifetime`: another herdr gives
 * its pane ids to other panes) and the server's `finish_epoch` their `finish` counts in (a server that started anew
 * counts from nothing).
 */
export interface PcStamps { lifetime: string | null; epoch: string | null; rows: Readonly<Record<string, StateStamp>> }
export type StateStamps = Readonly<Record<string, PcStamps>>;

export interface SeenRow {
  pane: string;
  /** the pane's terminal (`terminal_id`): herdr gives a pane it moves to another workspace a new ID, and leaves it this */
  terminal: string;
  state: StampState;
  /** herdr's `state_change_seq` as the roster has it: a pushed status changes the state before the roster that carries its counter */
  seq: number | undefined;
  /** the server's count of the pane's finishes (`finish_id`) */
  finish: number | undefined;
  /**
   * The roster says done, whatever the row shows (a finish this device has read shows idle, lib/sidebarOrder.ts):
   * herdr's own turn from done moves its counter, and is no change of a state that reads the same before and after.
   */
  done: boolean;
  /** at rest while its turn's background work still runs (`background_wait`): the row goes on showing working */
  wait: boolean;
  /** an agent whose state Ovis reads from its own session files: herdr's counter says nothing of it */
  own: boolean;
}
/** one look at a PC: its agent rows, or null while it is away or its roster has not come */
export interface PcLook { id: string; lifetime: string | null; epoch: string | null; rows: readonly SeenRow[] | null }
/** a pane's row as this page last saw it */
export interface WatchedRow extends SeenRow {
  /** when this page first saw the pane in this state */
  since: number;
  /** a pushed status told this page of a turn of herdr's own under this state: herdr's counter for it comes with the next roster, and is no new change then */
  owed: boolean;
  /** when this page first found the pane missing from the roster, while it still is */
  left?: number;
}
/**
 * One PC at this page's last look: which herdr and which server's count it was of, when, since when the page has
 * been looking at it without a break (`first`), and the row of each pane the page has seen there: by its ID, or by
 * its terminal once that ID is another pane's (`displaced`: its ID went to another while it was not listed).
 */
export interface PcSeen { lifetime: string | null; epoch: string | null; at: number; first: number; rows: ReadonlyMap<string, WatchedRow>; displaced: ReadonlyMap<string, WatchedRow> }
/** what this page saw at its last look, by PC: a state that differs from it changed in sight */
export type LastLook = ReadonlyMap<string, PcSeen>;
/** what a page carries from one look to the next: the device's stamps, and the states it saw last */
export interface SeenStamps { stamps: StateStamps; last: LastLook }

/**
 * The agents whose state Ovis reads from their own session files in place of herdr's: the names the server's trackers
 * report under (server/omo-status.ts for OmO, and server/gjc-status.ts and server/letta-status.ts, built on it). herdr
 * goes on calling such a pane what it took it for, so its counter stands still while the agent works, waits and
 * rests. The names are kept here by hand: a tracker added on the server is named here too.
 */
const OWN_STATE_AGENTS: ReadonlySet<string> = new Set(["omo", "gjc", "letta"]);

/**
 * A look at every PC: the agent rows the Agents list draws for it (lib/sidebarAgents.ts), each with the state it
 * shows and the two counters. A PC that is away, or whose roster has not come, says nothing of its agents now.
 */
export function stateLooks(machines: readonly Machine[], status: (machineId: string, pane: SidebarAgent["pane"]) => AgentStatus | undefined): PcLook[] {
  return machines.map((machine): PcLook => {
    if (machine.state !== "connected" || machine.snapshot === null) return { id: machine.id, lifetime: null, epoch: null, rows: null };
    const seqs = stateSeqs(machine.snapshot);
    return {
      id: machine.id,
      lifetime: machine.snapshot.herdr_lifetime ?? null,
      epoch: machine.snapshot.finish_epoch ?? null,
      rows: sidebarAgents(machine.snapshot).map(({ pane }) => ({
        pane: pane.pane_id,
        terminal: pane.terminal_id,
        state: stampState(agentGroup(status(machine.id, pane))),
        seq: seqs.get(pane.pane_id),
        finish: pane.finish_id,
        done: knownStatus(pane.agent_status) === "done",
        wait: pane.background_wait === true,
        own: OWN_STATE_AGENTS.has(pane.agent ?? ""),
      })),
    };
  });
}

/** a stamp is kept this long after its pane left the roster, so a pane that leaves it for a moment keeps its time */
const KEPT_UNLISTED_MS = 30 * 86_400_000;

/**
 * The stamp of a pane that is not listed, marked with when it first was not: null once that is thirty days ago. Its
 * finish count goes where the look's server is not the one that counted it (`counted` false).
 */
function unlisted(stamp: StateStamp, now: number, counted = true): StateStamp | null {
  // a clock set back never leaves the mark in the future
  const gone = Math.min(stamp.gone ?? now, now);
  if (now - gone > KEPT_UNLISTED_MS) return null;
  const left = gone === stamp.gone ? stamp : { ...stamp, gone };
  return counted ? left : uncounted(left);
}

/** A stamp without its count of finishes, where that count says nothing of the row it is held against: counted by another server, or under another pane ID. */
function uncounted(stamp: StateStamp): StateStamp {
  if (stamp.finish === undefined) return stamp;
  const { finish: _other, ...rest } = stamp;
  return rest;
}

/**
 * Whether a kept stamp is proven to tell of the row as it is, for a look that did not see the state begin: the same
 * state, and by both counters nothing since. `counted` says the stamp's `finish` counts in this look's epoch. A
 * herdr that counts nothing proves nothing, nor does anything for an agent whose state Ovis reads itself: the state
 * may have gone and come back out of sight.
 */
function proven(stamp: StateStamp | undefined, row: SeenRow, counted: boolean): stamp is StateStamp {
  return stamp !== undefined && stamp.state === row.state && !row.own
    && stamp.seq !== undefined && stamp.seq === row.seq
    && counted && stamp.finish !== undefined && stamp.finish === row.finish;
}

/**
 * Whether a kept stamp is of a later change than this look's roster shows. Both counters only grow, so a greater one
 * is another tab's, ahead of this one: its stamp is not this look's to judge.
 */
function ahead(stamp: StateStamp, row: SeenRow, counted: boolean): boolean {
  return (stamp.seq !== undefined && row.seq !== undefined && stamp.seq > row.seq)
    || (counted && stamp.finish !== undefined && row.finish !== undefined && stamp.finish > row.finish);
}

/** A stamp as a look keeps it for a listed pane: no mark of leaving, never ahead of the clock, and no finish count of another epoch. */
function keptStamp(stamp: StateStamp, now: number, counted: boolean): StateStamp {
  return { state: stamp.state, at: Math.min(stamp.at, now), terminal: stamp.terminal, ...(stamp.seq === undefined ? {} : { seq: stamp.seq }), ...(stamp.finish === undefined || !counted ? {} : { finish: stamp.finish }) };
}

/** A stamp that is not this look's to judge, left as it is: with the mark of a look that missed its pane, which is that look's page's to lift. */
function leftStamp(stamp: StateStamp, now: number, counted: boolean): StateStamp {
  const kept = keptStamp(stamp, now, counted);
  return stamp.gone === undefined ? kept : { ...kept, gone: Math.min(stamp.gone, now) };
}

/**
 * The rows of a look that are a pane this page remembers otherwise than under their ID, each with its memory of the
 * pane. herdr gives a pane it moves to another workspace a new ID and leaves it its terminal (#1503), so a row whose
 * terminal the page saw under another ID is that pane; and so is one whose terminal the page saw before its ID went
 * to another pane, under whatever ID it is back. Only where the roster names that terminal once, and the page
 * remembers it once: a terminal named twice says nothing of which pane is which.
 */
function movedRows(rows: readonly SeenRow[], watched: PcSeen | undefined): Map<string, WatchedRow> {
  const moved = new Map<string, WatchedRow>();
  if (watched === undefined) return moved;
  const listed = new Map<string, number>();
  for (const row of rows) listed.set(row.terminal, (listed.get(row.terminal) ?? 0) + 1);
  const remembered = new Map<string, WatchedRow | null>();
  for (const old of [...watched.rows.values(), ...watched.displaced.values()]) remembered.set(old.terminal, remembered.has(old.terminal) ? null : old);
  for (const row of rows) {
    const old = remembered.get(row.terminal);
    if (old !== undefined && old !== null && old !== watched.rows.get(row.pane) && listed.get(row.terminal) === 1) moved.set(row.pane, old);
  }
  return moved;
}

/**
 * The stamps after a look at every PC, each row by what the page saw of it at its last look.
 *
 * - A state that differs from the last look's began now and is stamped so, unless the kept stamp already tells of
 *   it: another tab of this device stamped the change first (the stamps are read anew at each look). So is the state
 *   of a pane new to this page and to the device, once the page has looked at its PC for longer than the gap a page
 *   bridges (lib/agentStateWatch.ts): sooner, it may be an agent the roster had not listed yet, or had lost sight of.
 *   A look that is not `dated` (the page cannot say when what it finds began) stamps no change.
 * - What the device keeps and the page remembers under an ID is a row's own only where it names the row's terminal:
 *   under an ID that has come to name another pane, the row is a pane the page has not seen, with no stamp, and the
 *   stamp the last pane left there is kept as an unlisted pane's until the row has one of its own. A pane herdr moved
 *   under a new ID (`movedRows`) is the row the page was seeing under the old one: it is judged by what the page saw
 *   of it there, and by the stamp it had there, which goes with it. What was counted of its finishes under the ID it
 *   left is another count than the row's: it neither proves that stamp nor puts it ahead of the roster, and a pane
 *   seen to move is not held to it. A pane whose ID went to another while it was not listed stays one the page has
 *   seen: listed again, under whatever ID, it is no new pane.
 * - A state the page has been seeing keeps its stamp while the counters stand. A finish counted meanwhile, or
 *   herdr's counter moved, means the state was left and come back to out of sight (updates come together, a
 *   subscription has gaps), and the stamp goes. Two moves of herdr's counter are none of the state: the one that
 *   comes for what a pushed status told of first (a change, herdr's own turn from done, the rest of a turn whose
 *   background work holds the row at working), and a move by exactly one, a single turn of herdr's own, which
 *   cannot have left a state that reads the same before and after it. That rest also counts one finish. A row that
 *   such work held at working is not forgiven the single move: the work's end, which no counter tells of, may have
 *   come before it.
 * - A pane missing from a roster and back within that gap is the row the page was seeing where herdr's counter for
 *   it stands: a look that missed it, an agent lost sight of for a moment. Back under another counter, with none, or
 *   an agent whose state Ovis reads itself (the counter says nothing of it), another agent may have been started in
 *   the pane or its state left and come back to, and its time goes. Back after longer, the page did not see what its
 *   state is now begin: it keeps a stamp only on proof.
 * - A row first seen by this page (a reload, a PC back from away, another herdr, a page that was not being told of
 *   its PCs) keeps its stamp only on proof, and has none otherwise: what happened, happened out of sight.
 * - A stamp that is not this look's to judge is left as it is, with its mark where a look missed its pane: one ahead
 *   of this look's roster, or one of another state than the page has been seeing. Both are another tab's, which saw
 *   what this one has not yet.
 *
 * A PC that is away keeps its stamps untouched, and a pane no longer listed keeps its stamp for thirty days from the
 * look that first missed it, as long as the page remembers having seen it. Hands back the very `stamps` it was given
 * when nothing changed.
 */
export function advanceStateStamps({ stamps, last }: SeenStamps, looks: readonly PcLook[], now: number, dated = true): SeenStamps {
  const next: Record<string, PcStamps> = {};
  const seen = new Map<string, PcSeen>();
  let changed = false;
  const looked = new Set(looks.map((look) => look.id));
  for (const look of looks) {
    const kept = stamps[look.id];
    if (look.rows === null) {
      if (kept !== undefined) next[look.id] = kept;
      continue;
    }
    // another herdr: its pane ids start over, so no stamp of the old one tells of a pane of this one, and no state
    // this page saw on the old one is a state this one's pane was in: its rows are first seen
    const sameHerdr = kept !== undefined && kept.lifetime === look.lifetime;
    const before = sameHerdr ? kept.rows : {};
    // the kept stamps' finishes count in this look's epoch: a server that started anew counts from nothing
    const counted = sameHerdr && look.epoch !== null && kept.epoch === look.epoch;
    const lastSeen = last.get(look.id);
    const watched = lastSeen !== undefined && lastSeen.lifetime === look.lifetime ? lastSeen : undefined;
    const recount = watched !== undefined && watched.epoch !== look.epoch;
    const rows: Record<string, StateStamp> = {};
    const memory = new Map<string, WatchedRow>();
    const moved = movedRows(look.rows, watched);
    for (const row of look.rows) {
      const from = moved.get(row.pane);
      // remembered under another ID than the row's: what the server counted of its finishes there is another count
      const elsewhere = from !== undefined && from.pane !== row.pane;
      const own = (candidate: StateStamp | undefined): StateStamp | undefined => candidate !== undefined && candidate.terminal === row.terminal ? candidate : undefined;
      const here = own(before[row.pane]);
      const brought = elsewhere ? own(before[from.pane]) : undefined;
      const there = brought === undefined ? undefined : uncounted(brought);
      // a moved pane is judged by the stamp it had under its old ID, which this page judged at its last look. One under
      // its new ID was not this page's to judge then: it is another tab's, which followed the move first, where the
      // counters say it tells of a later state, or of this one and it carries no mark of leaving. Else it is what the
      // pane left when it last had this ID: the counters stand through a state the server makes itself
      const stamp = !elsewhere || (here !== undefined && (ahead(here, row, counted) || (here.gone === undefined && proven(here, row, counted)))) ? here : there;
      const remembered = watched?.rows.get(row.pane);
      const known = from ?? (remembered !== undefined && remembered.terminal === row.terminal ? remembered : undefined);
      const saw = known !== undefined && known.left !== undefined && now - known.left > BLIND_MS ? undefined : known;
      const began = watched !== undefined && saw?.state !== row.state;
      // herdr's counter moved: two numbers that differ. A roster that names none for a moment says nothing either way
      const counter = saw !== undefined && saw.seq !== undefined && row.seq !== undefined && row.seq !== saw.seq;
      // a pushed status tells of a change before the roster that carries its counter: until then herdr's counter
      // here is the last change's, and says nothing of this one
      const lags = began && saw !== undefined && !counter;
      // two turns of herdr's own leave the state reading the same: from done (a finish read there, or the next turn its
      // background work started), and into the rest of a turn whose background work holds the row at working
      const undone = !began && saw !== undefined && saw.done && !row.done;
      const held = !began && saw !== undefined && row.wait && !saw.wait;
      memory.set(row.pane, { ...row, since: saw !== undefined && !began ? saw.since : now, owed: began ? lags : !counter && (undone || held || saw?.owed === true) });
      const finish = row.finish === undefined ? {} : { finish: row.finish };
      const seq = row.seq === undefined || lags ? {} : { seq: row.seq };
      if (stamp !== undefined && !lags && ahead(stamp, row, counted)) {
        rows[row.pane] = leftStamp(stamp, now, counted);
      } else if (watched === undefined) {
        if (proven(stamp, row, counted)) rows[row.pane] = keptStamp(stamp, now, counted);
      } else if (began) {
        // the stamp was made while this page still had the pane in its last state, and no counter says it is of another
        // change: another tab's, of this one. It takes the counter this look has for the change, where the tab had none
        // yet. A stamp marked as its pane left is of an agent that was there before, whenever it was made
        const told = stamp !== undefined && stamp.gone === undefined && stamp.state === row.state && stamp.at >= (saw?.since ?? watched.at)
          && (lags || stamp.seq === undefined || row.seq === undefined || stamp.seq === row.seq);
        if (stamp !== undefined && told) rows[row.pane] = { state: stamp.state, at: Math.min(stamp.at, now), terminal: row.terminal, ...(lags && stamp.seq !== undefined ? { seq: stamp.seq } : seq), ...finish };
        else if (proven(stamp, row, counted)) rows[row.pane] = keptStamp(stamp, now, counted);
        // a change in sight began now, and so did what a pane shows that neither this page nor the device has seen,
        // where the page has looked long enough to know that the pane was not there
        else if (dated && (saw !== undefined || (known === undefined && stamp === undefined && now - watched.first > BLIND_MS))) rows[row.pane] = { state: row.state, at: now, terminal: row.terminal, ...seq, ...finish };
      } else if (stamp !== undefined && stamp.state !== row.state) {
        // another tab's, of a state this page has not seen the pane in yet
        rows[row.pane] = leftStamp(stamp, now, counted);
      } else if (stamp !== undefined && saw !== undefined) {
        // the rest of a turn whose background work holds the row at working counts one finish. A pane seen to move
        // answers for none: the count it had at the last look was the one of the ID it left
        const recounted = recount || (elsewhere && saw.left === undefined);
        const finished = !recounted && saw.finish !== undefined && row.finish !== undefined && row.finish !== saw.finish && !(held && row.finish === saw.finish + 1);
        // herdr's counter counts every change of state in its session, so a move by one is a single turn of herdr's own,
        // and this pane's: it cannot have left a state that reads the same before and after it. Unless background work
        // held the row at working: that work's end shows the rest, and moves no counter
        const single = !saw.wait && saw.seq !== undefined && row.seq === saw.seq + 1;
        // a move of herdr's counter keeps the time only where the page can account for it: a pushed status told of it,
        // or it is that single turn. Any other may hide a state left and come back to. A row back from a look that
        // missed it has more to answer for: an agent started anew in its pane reads the same, so only herdr's counter
        // standing where it stood says it is the one the page was seeing, and says so only of an agent it counts for
        const stands = saw.left === undefined ? !counter || saw.owed || single : !row.own && saw.seq !== undefined && row.seq === saw.seq;
        if (!finished && stands) {
          const herdrs = counter ? row.seq : stamp.seq;
          rows[row.pane] = { state: stamp.state, at: Math.min(stamp.at, now), terminal: row.terminal, ...(herdrs === undefined ? {} : { seq: herdrs }), ...finish };
        }
      }
    }
    for (const [pane, stamp] of Object.entries(before)) {
      // a listed ID with no stamp of its row keeps what another pane left there, as that pane's: a tab a roster
      // behind, or ahead, may still be seeing it under this ID
      if (memory.has(pane) && (rows[pane] !== undefined || stamp.terminal === memory.get(pane)?.terminal)) continue;
      const left = unlisted(stamp, now, counted);
      if (left !== null) rows[pane] = left;
    }
    // a PC with no stamp has no entry: a look that stamps nothing changes nothing, and is not written
    if (sameHerdr && kept.epoch === look.epoch && sameRows(kept.rows, rows)) next[look.id] = kept;
    else if (Object.keys(rows).length > 0) { next[look.id] = { lifetime: look.lifetime, epoch: look.epoch, rows }; changed = true; }
    else if (kept !== undefined) changed = true;
    // a pane missing from this roster stays in the page's memory, with when it was first missed, for as long as its
    // stamp would be kept: under its ID, or by its terminal while that ID is another pane's
    const carried = new Set(moved.values());
    const displaced = new Map<string, WatchedRow>();
    if (watched !== undefined) for (const old of [...watched.rows.values(), ...watched.displaced.values()]) {
      const taken = memory.get(old.pane);
      // listed in this roster: under another ID, where it is remembered now, or under its own
      if (carried.has(old) || taken?.terminal === old.terminal) continue;
      const left = old.left ?? now;
      if (now - left > KEPT_UNLISTED_MS) continue;
      const missed = old.left === undefined ? { ...old, left } : old;
      if (taken === undefined) memory.set(old.pane, missed);
      else displaced.set(old.terminal, missed);
    }
    seen.set(look.id, { lifetime: look.lifetime, epoch: look.epoch, at: now, first: watched?.first ?? now, rows: memory, displaced });
  }
  // a PC no longer in the roster (removed, or hidden on this device) keeps its stamps as long as a pane that left a roster does
  for (const [id, kept] of Object.entries(stamps)) {
    if (looked.has(id)) continue;
    const rows: Record<string, StateStamp> = {};
    for (const [pane, stamp] of Object.entries(kept.rows)) {
      const left = unlisted(stamp, now);
      if (left !== null) rows[pane] = left;
    }
    if (Object.keys(rows).length === 0) { changed = true; continue; }
    if (sameRows(kept.rows, rows)) next[id] = kept;
    else { next[id] = { lifetime: kept.lifetime, epoch: kept.epoch, rows }; changed = true; }
  }
  return { stamps: changed ? next : stamps, last: seen };
}

function sameRows(left: Readonly<Record<string, StateStamp>>, right: Readonly<Record<string, StateStamp>>): boolean {
  const entries = Object.entries(left);
  return entries.length === Object.keys(right).length && entries.every(([pane, a]) => {
    const b = right[pane];
    return b !== undefined && a.state === b.state && a.at === b.at && a.terminal === b.terminal && a.seq === b.seq && a.finish === b.finish && a.gone === b.gone;
  });
}

/**
 * When the row's state began, if this device saw it: null where nothing was stamped, for a state that differs from the
 * stamp (a change not stamped yet), and for a stamp of another pane that had the ID (a roster not looked at yet).
 */
export function stateSince(stamps: StateStamps, machineId: string, pane: string, terminal: string, state: StampState): number | null {
  const stamp = stamps[machineId]?.rows[pane];
  return stamp !== undefined && stamp.terminal === terminal && stamp.state === state ? stamp.at : null;
}

/** kept on this device, as its folds are: a phone and a desktop each stamp what they saw */
export const STATE_STAMPS_KEY = "ovis:agent-state-since";

const STAMP_STATES = ["blocked", "working", "idle"] as const satisfies readonly StampState[];
const isStampState = (value: unknown): value is StampState => STAMP_STATES.some((state) => state === value);
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
/** stored JSON read as an object of unknown fields, or null for anything else */
const fieldsOf = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

/** The stored stamps, each field checked: anything else stored there is dropped. */
export function parseStateStamps(raw: string | null): StateStamps {
  if (raw === null) return {};
  let stored: unknown;
  try { stored = JSON.parse(raw); } catch { return {}; }
  const record = fieldsOf(stored);
  const pcs = record?.["version"] === 1 ? fieldsOf(record["pcs"]) : null;
  if (pcs === null) return {};
  const stamps: Record<string, PcStamps> = {};
  for (const [id, pc] of Object.entries(pcs)) {
    const rows = fieldsOf(fieldsOf(pc)?.["rows"]);
    if (rows === null) continue;
    const kept: Record<string, StateStamp> = {};
    for (const [pane, value] of Object.entries(rows)) {
      const { state, at, terminal, seq, finish, gone } = fieldsOf(value) ?? {};
      if (!isStampState(state) || !isNumber(at) || typeof terminal !== "string") continue;
      kept[pane] = { state, at, terminal, ...(isNumber(seq) ? { seq } : {}), ...(isNumber(finish) ? { finish } : {}), ...(isNumber(gone) ? { gone } : {}) };
    }
    const { lifetime, epoch } = fieldsOf(pc) ?? {};
    stamps[id] = { lifetime: typeof lifetime === "string" ? lifetime : null, epoch: typeof epoch === "string" ? epoch : null, rows: kept };
  }
  return stamps;
}

/** the stored text this page last read or wrote, and its stamps: they are read at every look, and the same text is not parsed again */
let lastRead: { text: string | null; stamps: StateStamps } | null = null;

/** The stamps this device keeps, or null where its storage cannot be read: the page then goes by its own. */
export function loadStateStamps(): StateStamps | null {
  try {
    const text = window.localStorage.getItem(STATE_STAMPS_KEY);
    if (lastRead === null || lastRead.text !== text) lastRead = { text, stamps: parseStateStamps(text) };
    return lastRead.stamps;
  } catch {
    return null;
  }
}

/** Whether the stamps were kept: false in private mode or over quota, where the page keeps them for its own time. */
export function saveStateStamps(stamps: StateStamps): boolean {
  try {
    const text = JSON.stringify({ version: 1, pcs: stamps });
    window.localStorage.setItem(STATE_STAMPS_KEY, text);
    lastRead = { text, stamps };
    return true;
  } catch {
    return false;
  }
}
