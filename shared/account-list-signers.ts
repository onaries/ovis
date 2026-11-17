import {
  ListEntryError, entryFromText, entryHash, entryHolds, firstState, isListHash, isListKeyEncoding, readBody,
  type Entry, type EntryBody, type HeldEntry, type ListField, type ListRefusalCode, type SignerPower,
} from "./account-list-entry.ts";

export type PassedOverCode = "signer_unknown" | "signer_not_allowed" | "key_reused" | "already_out";

export interface ListPlace {
  readonly seq: number;
  readonly hash: string;
}

export interface SignerRow {
  readonly power: SignerPower;
  readonly seq: number;
  readonly by: string | null;
  readonly ended: number | null;
}

export interface SignersState {
  readonly level: number;
  readonly list: string;
  readonly footing: ListPlace;
  readonly needs: number;
  readonly behind: number | null;
  readonly signers: { readonly [key: string]: SignerRow };
  readonly needs_replay?: ListPlace;
}

export interface ListMember {
  readonly entries: readonly string[];
  readonly state: SignersState;
}

export type KeyProof = (entry: HeldEntry, state: SignersState) => { readonly key: string; readonly power: SignerPower } | null;

export type TakenOutcome =
  | { readonly outcome: "passed_over"; readonly code: PassedOverCode; readonly loose: boolean }
  | { readonly outcome: "cannot_read"; readonly power: SignerPower; readonly behind: boolean }
  | { readonly outcome: "reads"; readonly power: SignerPower | null; readonly behind: boolean };

export type StopsOutcome = { readonly outcome: "stops"; readonly code: "needs_replay" };

export interface TakenEntry {
  readonly held: HeldEntry;
  readonly outcome: TakenOutcome;
}

export interface ListStop {
  readonly seq: number;
  readonly code: ListRefusalCode | "needs_replay";
}

export interface ShownAnswer {
  readonly after: number;
  readonly entries: readonly string[];
  readonly head: ListPlace;
}

export interface ShownResult {
  readonly member: ListMember;
  readonly dropped_from: number | null;
  readonly took: readonly TakenEntry[];
  readonly stopped: ListStop | null;
  readonly stuck: boolean;
  readonly asks_after: number | null;
}

export interface ReplayResult {
  readonly member: ListMember | null;
  readonly took: readonly TakenEntry[];
  readonly stopped: ListStop | null;
  readonly stuck: boolean;
}

function rowOf(signers: SignersState["signers"], key: string): SignerRow | null {
  return Object.hasOwn(signers, key) ? (signers[key] ?? null) : null;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isLevel = (value: unknown): value is number => isCount(value) && value >= 1;
function mustBeLevel(level: number): void {
  if (!isLevel(level)) throw new RangeError(`A level is a whole number from 1, not ${level}`);
}

const plainPlace = ({ seq, hash }: ListPlace): ListPlace => Object.freeze({ seq, hash });

const plainRow = ({ power, seq, by, ended }: SignerRow): SignerRow => Object.freeze({ power, seq, by, ended });

function plainRows(signers: SignersState["signers"]): SignersState["signers"] {
  const rows: (readonly [string, SignerRow])[] = [];
  for (const key of Object.getOwnPropertyNames(signers)) {
    const row = signers[key] ?? null;
    if (row !== null) rows.push([key, plainRow(row)]);
  }
  return Object.freeze(Object.fromEntries(rows));
}

function plainState(state: SignersState): SignersState {
  const { level, list, footing, needs, behind, signers, needs_replay } = state;
  mustBeLevel(level);
  const plain = { level, list, footing: plainPlace(footing), needs, behind, signers: plainRows(signers) };
  return needs_replay === undefined ? Object.freeze(plain) : stoppedAt(plain, needs_replay);
}

function stoppedAt({ level, list, footing, needs, behind, signers }: SignersState, { seq, hash }: ListPlace): SignersState {
  return Object.freeze({ level, list, footing, needs, behind, signers, needs_replay: Object.freeze({ seq, hash }) });
}

function plainTexts(texts: readonly string[]): readonly string[] {
  const { length } = texts;
  return Object.freeze(Array.from({ length }, (_, at) => texts[at] ?? ""));
}

function plainMember(member: ListMember): ListMember {
  const { entries, state } = member;
  return Object.freeze({ entries: plainTexts(entries), state: plainState(state) });
}

function plainAnswer(answer: ShownAnswer): ShownAnswer {
  const { after, entries, head } = answer;
  return Object.freeze({ after, entries: plainTexts(entries), head: plainPlace(head) });
}

function plainHeld(held: HeldEntry): HeldEntry {
  const { entry, body, hash, list } = held;
  const { body: bytes, signature } = entry;
  const { issued_at, kind, list: of, prev, seq, signer, v, adds, ends, own } = body;
  const { length } = own;
  const fields: ListField[] = [];
  for (let at = 0; at < length; at++) {
    const field = own[at];
    if (field === undefined) continue;
    const { name, value } = field;
    fields.push(Object.freeze({ name, value: new Uint8Array(value) }));
  }
  const plain: { -readonly [Name in keyof EntryBody]: EntryBody[Name] } = { issued_at, kind, list: of, prev, seq, signer, v, own: Object.freeze(fields) };
  if (adds !== undefined) {
    const { key, power } = adds;
    plain.adds = Object.freeze({ key, power });
  }
  if (ends !== undefined) plain.ends = ends;
  return Object.freeze({ entry: Object.freeze({ body: new Uint8Array(bytes), signature: new Uint8Array(signature) }), body: Object.freeze(plain), hash, list });
}

export function signerPower(state: SignersState, key: string): SignerPower | null {
  const { signers, needs_replay } = plainState(state);
  if (needs_replay !== undefined) return null;
  const row = rowOf(signers, key);
  return row !== null && row.ended === null ? row.power : null;
}

export function isBehind(state: SignersState): boolean {
  const { behind, needs_replay } = plainState(state);
  return behind !== null || needs_replay !== undefined;
}

function stateOfFirst({ body, hash }: HeldEntry, level: number): SignersState {
  const { signer, v } = body;
  return Object.freeze({ level, list: hash, footing: Object.freeze({ seq: 0, hash }), needs: v, behind: v > level ? 0 : null, signers: Object.freeze({ [signer]: Object.freeze({ power: "full", seq: 0, by: signer, ended: null }) }) });
}

export function firstSignersState(first: HeldEntry, level: number): SignersState {
  const held = plainHeld(first);
  mustBeLevel(level);
  return stateOfFirst(held, level);
}

function unlawful(power: SignerPower, signer: string, adds: EntryBody["adds"], added: SignerRow | null, ends: string | undefined, going: SignerRow | null): PassedOverCode | null {
  if (adds !== undefined) {
    if (power !== "full") return "signer_not_allowed";
    if (added !== null && (added.by !== null || added.ended !== null)) return "key_reused";
  }
  if (ends !== undefined) {
    if (power !== "full" && ends !== signer) return "signer_not_allowed";
    if (going === null || going.ended !== null) return "already_out";
  }
  return null;
}

interface Judged {
  readonly outcome: TakenOutcome | StopsOutcome;
  readonly loose: boolean;
  readonly needs: number;
  readonly behind: number | null;
  readonly rows: readonly (readonly [string, SignerRow])[];
}

const STOPS: StopsOutcome = Object.freeze({ outcome: "stops", code: "needs_replay" });

function judge(state: SignersState, held: HeldEntry, proof: KeyProof | undefined): Judged {
  const { adds, ends, seq, signer, v } = held.body;
  const { level, needs, behind, signers } = state;
  const own = rowOf(signers, signer);
  const added = adds === undefined ? null : rowOf(signers, adds.key);
  const going = ends === undefined ? null : rowOf(signers, ends);
  const power = own !== null && own.ended === null ? own.power : null;
  const reads = v <= level;
  if (power === null) {
    const passedOver: Judged = { outcome: { outcome: "passed_over", code: "signer_unknown", loose: true }, loose: true, needs, behind, rows: [] };
    if (own !== null || v <= 1 || v > needs || adds !== undefined || ends !== undefined) return passedOver;
    if (behind !== null) return { outcome: STOPS, loose: false, needs, behind, rows: [] };
    const asked = reads && proof !== undefined ? proof(plainHeld(held), plainState(state)) : null;
    if (asked === null) return passedOver;
    const { key, power: lets } = asked;
    if (key !== signer) return passedOver;
    return { outcome: { outcome: "reads", power: null, behind: false }, loose: false, needs, behind, rows: [[signer, Object.freeze({ power: lets, seq, by: null, ended: null })]] };
  }
  const code = unlawful(power, signer, adds, added, ends, going);
  if (code !== null) return { outcome: { outcome: "passed_over", code, loose: false }, loose: false, needs, behind, rows: [] };

  const rows: (readonly [string, SignerRow])[] = [];
  let comes: SignerRow | null = null;
  if (adds !== undefined) {
    comes = Object.freeze({ power: adds.power, seq, by: signer, ended: null });
    rows.push([adds.key, comes]);
  }
  if (ends !== undefined) {
    const goes = adds?.key === ends ? comes : going;
    if (goes !== null) rows.push([ends, Object.freeze({ power: goes.power, seq: goes.seq, by: goes.by, ended: seq })]);
  }
  const counts = power === "full";
  const behindAfter = behind ?? (counts && !reads ? seq : null);
  return {
    outcome: reads ? { outcome: "reads", power, behind: behind !== null } : { outcome: "cannot_read", power, behind: behindAfter !== null },
    loose: false,
    needs: counts && v > needs ? v : needs,
    behind: behindAfter,
    rows,
  };
}

function stateAfter(state: SignersState, held: HeldEntry, judged: Judged, signers: SignersState["signers"]): SignersState {
  const footing = judged.loose ? state.footing : Object.freeze({ seq: held.body.seq, hash: held.hash });
  return Object.freeze({ level: state.level, list: state.list, footing, needs: judged.needs, behind: judged.behind, signers });
}

export function judgeEntry(state: SignersState, held: HeldEntry, proof?: KeyProof): { readonly outcome: TakenOutcome | StopsOutcome; readonly state: SignersState } {
  const given = plainState(state);
  const entry = plainHeld(held);
  if (entry.list !== given.list) throw new RangeError("The entry is of another list than the state");
  if (entry.body.seq <= given.footing.seq) throw new RangeError("The entry lies at or under the state's footing");
  if (given.needs_replay !== undefined) return { outcome: STOPS, state: given };
  const judged = judge(given, entry, proof);
  if (judged.outcome.outcome === "stops") return { outcome: judged.outcome, state: stoppedAt(given, { seq: entry.body.seq, hash: entry.hash }) };
  const signers = judged.rows.length === 0 ? given.signers : Object.freeze(Object.fromEntries([...Object.entries(given.signers), ...judged.rows]));
  return { outcome: judged.outcome, state: stateAfter(given, entry, judged, signers) };
}

type Rows = { [key: string]: SignerRow };

function takeEntry(state: SignersState, rows: Rows | null, held: HeldEntry, proof: KeyProof | undefined): { readonly state: SignersState; readonly rows: Rows | null; readonly outcome: TakenOutcome } | null {
  const judged = judge(state, held, proof);
  const { outcome } = judged;
  if (outcome.outcome === "stops") return null;
  let written = rows;
  if (judged.rows.length > 0) {
    written ??= Object.fromEntries(Object.entries(state.signers));
    for (const [key, row] of judged.rows) written[key] = row;
  }
  return { state: stateAfter(state, held, judged, written ?? state.signers), rows: written, outcome };
}

function ownEntry(entries: readonly string[], seq: number, list: string): HeldEntry {
  const text = entries[seq];
  if (text === undefined) throw new RangeError(`The member holds no entry ${seq}`);
  const entry = entryFromText(text);
  return { entry, body: readBody(entry.body), hash: entryHash(entry.body), list };
}

export function listHead(member: ListMember): ListPlace {
  const { entries, state } = plainMember(member);
  const seq = entries.length - 1;
  return { seq, hash: ownEntry(entries, seq, state.list).hash };
}

function refusalOf(error: unknown): ListRefusalCode {
  if (error instanceof ListEntryError) return error.code;
  throw error;
}

type Fit =
  | { readonly fit: "holds"; readonly held: HeldEntry }
  | { readonly fit: "elsewhere" }
  | { readonly fit: "no"; readonly code: ListRefusalCode };

async function fits(entry: Entry, before: HeldEntry): Promise<Fit> {
  let code: ListRefusalCode;
  try {
    return { fit: "holds", held: plainHeld(await entryHolds(entry, before)) };
  } catch (error) {
    code = refusalOf(error);
  }
  if (code !== "chain_broken") return { fit: "no", code };
  const { prev } = readBody(entry.body);
  if (prev === "" || prev === before.hash) return { fit: "no", code };
  try {
    await entryHolds(entry, { entry: before.entry, body: before.body, hash: prev, list: before.list });
    return { fit: "elsewhere" };
  } catch (error) {
    if (!(error instanceof ListEntryError)) throw error;
    return { fit: "no", code };
  }
}

export async function shownEntries(member: ListMember, answer: ShownAnswer, proof?: KeyProof): Promise<ShownResult> {
  const given = plainMember(member);
  const { after, entries: shown, head } = plainAnswer(answer);
  const entries = Array.from(given.entries);
  let state = given.state;
  let rows: Rows | null = null;
  const { list } = state;
  const top = entries.length - 1;
  if (!Number.isInteger(after) || after < 0 || after > top) throw new RangeError(`The member holds no entry ${after} for the answer to follow`);
  if (ownEntry(entries, state.footing.seq, list).hash !== state.footing.hash) throw new RangeError(`The member's entry ${state.footing.seq} is not its footing: this state is not that of these entries`);
  const took: TakenEntry[] = [];
  let dropped: number | null = null;
  const done = (rest: Partial<Pick<ShownResult, "stopped" | "stuck" | "asks_after">> = {}): ShownResult => {
    if (rows !== null) Object.freeze(rows);
    return { member: { entries, state }, dropped_from: dropped, took, stopped: null, stuck: false, asks_after: null, ...rest };
  };
  const stops = (seq: number, code: ListRefusalCode) => done({ stopped: { seq, code } });
  const stuck = (seq: number) => done({ stopped: { seq, code: "chain_broken" }, stuck: true });
  if (state.needs_replay !== undefined) return done({ stopped: { seq: state.needs_replay.seq, code: "needs_replay" }, stuck: true });

  const headSeq = Number.isInteger(head.seq) && head.seq >= 0 ? head.seq : -1;
  let atHead = headSeq >= 0 && headSeq <= top ? ownEntry(entries, headSeq, list).hash : null;
  const byHead = (follows: number): ShownResult | null => {
    if (atHead === null || atHead === head.hash) return null;
    if (headSeq <= state.footing.seq) return stuck(headSeq);
    return follows === entries.length - 1 ? done({ asks_after: state.footing.seq }) : null;
  };

  let before = ownEntry(entries, after, list);
  let caught = byHead(after);
  for (const [index, text] of shown.entries()) {
    if (caught !== null) return caught;
    const seq = after + 1 + index;
    let entry: Entry;
    try {
      entry = entryFromText(text);
    } catch (error) {
      return stops(seq, refusalOf(error));
    }
    const own = seq < entries.length ? ownEntry(entries, seq, list) : null;
    if (own !== null && entryHash(entry.body) === own.hash) {
      before = own;
      continue;
    }
    const fit = await fits(entry, before);
    if (fit.fit === "no") return stops(seq, fit.code);
    if (fit.fit === "elsewhere") return seq - 1 <= state.footing.seq ? stuck(seq) : done({ asks_after: state.footing.seq });
    if (seq <= state.footing.seq) return stuck(seq);
    const taken = takeEntry(state, rows, fit.held, proof);
    if (own !== null) {
      entries.length = seq;
      dropped = seq;
    }
    if (taken === null) {
      state = stoppedAt(state, { seq, hash: fit.held.hash });
      return done({ stopped: { seq, code: "needs_replay" }, stuck: true });
    }
    state = taken.state;
    rows = taken.rows;
    entries.push(text);
    took.push({ held: fit.held, outcome: taken.outcome });
    before = fit.held;
    if (seq <= headSeq) atHead = seq === headSeq ? fit.held.hash : null;
    caught = byHead(seq);
  }
  return caught ?? done();
}

export async function replayEntries(entries: readonly string[], level: number, options: { readonly saved: SignersState | null; readonly given?: string; readonly proof?: KeyProof }): Promise<ReplayResult> {
  const texts = plainTexts(entries);
  const [text, ...rest] = texts;
  const { given, proof, saved: told } = options;
  mustBeLevel(level);
  const saved = toldSaved(told, level);
  const stop = saved?.needs_replay ?? null;
  const reach = saved === null ? -1 : Math.max(saved.footing.seq, stop === null ? 0 : stop.seq - 1);
  if (texts.length <= reach) throw new RangeError("The entries end before the saved member's history: they are not its own");
  if (text === undefined) return { member: null, took: [], stopped: null, stuck: false };
  const none = (stopped: ListStop): ReplayResult => ({ member: null, took: [], stopped, stuck: true });
  let before: HeldEntry;
  try {
    before = plainHeld((await firstState(entryFromText(text), given)).first);
  } catch (error) {
    const refused: ListStop = { seq: 0, code: refusalOf(error) };
    return saved === null ? { member: null, took: [], stopped: refused, stuck: false } : none(refused);
  }
  if (saved !== null && before.hash !== saved.list) return none({ seq: 0, code: "list_mismatch" });
  let state = stateOfFirst(before, level);
  let rows: Rows | null = null;
  const kept = [text];
  const took: TakenEntry[] = [{ held: before, outcome: before.body.v > level ? { outcome: "cannot_read", power: "full", behind: true } : { outcome: "reads", power: "full", behind: false } }];
  const replayed = (refused: ListStop | null): ReplayResult => {
    if (rows !== null) Object.freeze(rows);
    if (stop !== null && kept.length <= stop.seq) state = stoppedAt(state, stop);
    const at = state.needs_replay;
    return { member: { entries: kept, state }, took, stopped: refused ?? (at === undefined ? null : { seq: at.seq, code: "needs_replay" }), stuck: at !== undefined };
  };
  for (const [index, next] of rest.entries()) {
    const seq = index + 1;
    let held: HeldEntry;
    try {
      held = plainHeld(await entryHolds(entryFromText(next), before));
    } catch (error) {
      const refused: ListStop = { seq, code: refusalOf(error) };
      return seq <= reach ? none(refused) : replayed(refused);
    }
    if (saved !== null && seq === saved.footing.seq && held.hash !== saved.footing.hash) return none({ seq, code: "chain_broken" });
    if (stop !== null && seq === stop.seq && held.hash !== stop.hash) return replayed({ seq, code: "chain_broken" });
    const taken = takeEntry(state, rows, held, proof);
    if (taken === null) {
      if (seq <= reach) return none({ seq: stop === null ? seq : stop.seq, code: "needs_replay" });
      state = stoppedAt(state, { seq, hash: held.hash });
      return replayed(null);
    }
    state = taken.state;
    rows = taken.rows;
    kept.push(next);
    took.push({ held, outcome: taken.outcome });
    before = held;
  }
  return replayed(null);
}

export function signingPlace(member: ListMember, shown: ListPlace): { readonly list: string; readonly prev: string; readonly seq: number } | null {
  const { entries, state } = plainMember(member);
  const { seq, hash } = plainPlace(shown);
  const { footing, list } = state;
  if (state.needs_replay !== undefined) return null;
  if (!Number.isInteger(seq) || seq < 0 || seq > footing.seq || ownEntry(entries, seq, list).hash !== hash) return null;
  return { list, prev: footing.hash, seq: footing.seq + 1 };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readStop(value: unknown): ListPlace | null {
  if (!isRecord(value)) return null;
  const { seq, hash } = value;
  return isCount(seq) && typeof hash === "string" && isListHash(hash) ? Object.freeze({ seq, hash }) : null;
}

function toldSaved(told: SignersState | null, level: number): SignersState | null {
  if (told === null) return null;
  const saved = readSignersState(told, level);
  if (saved === null) throw new RangeError("A replay is told the member's saved state, or null for a first replay of a member that has none");
  return saved;
}

function readSignerRow(key: string, value: unknown, footing: number): SignerRow | null {
  if (!isListKeyEncoding(key) || !isRecord(value)) return null;
  const { power, seq, by, ended } = value;
  if (power !== "full" && power !== "bound") return null;
  if (!isCount(seq) || seq > footing) return null;
  if (by !== null && typeof by !== "string") return null;
  if (ended !== null && !(isCount(ended) && ended >= seq && ended <= footing)) return null;
  if (seq === 0 && (by !== key || power !== "full")) return null;
  return Object.freeze({ power, seq, by, ended });
}

function madeByItsSigner(rows: SignersState["signers"], row: SignerRow, level: number): boolean {
  if (row.seq === 0) return true;
  if (row.by === null) return level > 1;
  const signer = rowOf(rows, row.by);
  if (signer === null) return false;
  if (signer.seq < row.seq) return signer.power === "full" && (signer.ended === null || signer.ended >= row.seq);
  return level > 1 && signer.by !== null;
}

export function readSignersState(value: unknown, level: number): SignersState | null {
  mustBeLevel(level);
  if (!isRecord(value)) return null;
  const { level: made, list, footing, needs, behind, signers, needs_replay } = value;
  if (!isLevel(made) || !isCount(needs) || needs < 1) return null;
  if (typeof list !== "string" || !isListHash(list)) return null;
  if (!isRecord(footing)) return null;
  const { seq, hash } = footing;
  if (!isCount(seq) || typeof hash !== "string" || !isListHash(hash)) return null;
  if (seq === 0 && hash !== list) return null;
  if (behind !== null && !(isCount(behind) && behind <= seq)) return null;
  if ((behind !== null) !== (needs > made)) return null;
  if (!isRecord(signers)) return null;
  const rows: { [key: string]: SignerRow } = {};
  for (const key of Object.getOwnPropertyNames(signers)) {
    const row = readSignerRow(key, signers[key], seq);
    if (row === null) return null;
    rows[key] = row;
  }
  const all = Object.values(rows);
  if (all.filter((row) => row.seq === 0).length !== 1) return null;
  if (!all.every((row) => madeByItsSigner(rows, row, made))) return null;
  const read = { level: made, list, footing: Object.freeze({ seq, hash }), needs, behind, signers: Object.freeze(rows) };
  let state: SignersState = Object.freeze(read);
  if (needs_replay !== undefined) {
    const stop = readStop(needs_replay);
    if (stop === null || stop.seq < seq || (stop.seq === seq && stop.hash !== hash)) return null;
    state = stoppedAt(read, stop);
  }
  return made > level && state.needs_replay === undefined ? stoppedAt(state, state.footing) : state;
}
