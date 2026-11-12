/**
 * A phone's bottom sheet is a history entry, so the system Back closes it instead of going to the
 * pane before (deep links make each pane its own entry). The entry keeps the address it opened on.
 * What an item of the sheet does with the history takes the sheet's entry over: a navigation it
 * pushes (another pane, Settings, a file) replaces the entry, a sheet it opens reuses it, and an
 * address it changes on the entry (the New tab dialog) keeps it. A sheet closed any other way steps
 * back off its entry once whatever it ran has written its own history. A sheet closed by Back
 * leaves its entry ahead of the app; Forward onto it goes on to the next. A sheet opened while
 * that step back is on its way (the browser runs a traversal later) is not closed by the step's
 * popstate: its entry is made again over where the step landed. A sheet still up under one opened
 * over it (the drawer under a row's ⋯ menu, a dialog under a confirmation) stays up: the sheets
 * are a stack, Back closes the one on top, and that one's own close comes back to the one under
 * it. So does a sheet made to stay up under a navigation opened over it (a terminal peek under
 * Settings), whose entry the navigation took: the Back that leaves it does not close the sheet.
 * Nor does a step back that another part of the app takes by itself (Settings, a file or a diff
 * closing by its own controls) close a sheet: one that opened as Settings closed (Add PC) gets its
 * entry where the step lands, and Files has its own again once a file opened from it has closed.
 *
 * No entry is made where Back would not keep it. Chromium's Back skips every entry of a page that
 * added one with no tap since it loaded or since the user's last Back or Forward (its history
 * manipulation intervention; a step the page takes by itself ends nothing), and on a phone that
 * leaves the app with the sheet still up. So a sheet that closes itself over one that stays hands
 * its entry back to it with no step; there, a Back that leaves a sheet up (it refused, or what
 * covered it went) goes again onto the entry it left, which is still in the history, instead of
 * making one; the file list, in front again once Back closed the file or the diff opened from it,
 * goes onto the entry that Back left and takes it (`returns`); and any other sheet that opens
 * with no tap behind it waits for the next one to make its entry.
 */
import { useEffect, useRef } from "react";
import { SHEET_HISTORY_KEY, SHEET_UNDER_KEY, overCopiedEntry, sheetStep } from "./historyKeys.ts";
import { SHEET_QUERY } from "./sheets.ts";
import { useMediaQuery } from "./useMediaQuery.ts";

const KEY = SHEET_HISTORY_KEY;

/**
 * Where Back is the system's own and is expected to close what is open: a phone's width, where the
 * dialogs are bottom sheets, and any screen worked by touch alone (a phone on its side, a tablet),
 * where the same dialogs are drawn as on a desktop but Back is still a button or a gesture of the
 * device. A desktop's Back stays the panes'.
 */
export const BACK_QUERY = `${SHEET_QUERY}, (hover: none) and (pointer: coarse)`;

/** what Back does to each open sheet: false refuses it (the sheet is busy), and the sheet keeps its entry */
const open = new Map<string, () => boolean | void>();
const leaving = new Map<string, ReturnType<typeof setTimeout>>();
/** the address each sheet's entry was made on */
const addresses = new Map<string, string>();
/** the sheets that stay up under a navigation opened over them (a terminal peek under Settings) */
const staying = new Set<string>();
/**
 * The sheets whose entry a sheet opened over them took, or a navigation when they stay under one:
 * the next traversal leaves what covered them, not them, so it does not ask them to close.
 */
const covered = new Set<string>();
/** the sheet still up under each sheet, whose entry it took: straight, or through a sheet that closed as it opened */
const heirs = new Map<string, string>();
/**
 * Whether the browser's Back skips entries made with no tap behind them: Chromium's does, and it
 * tells of activations. Elsewhere every moment counts as a tap, and entries are made as they come.
 */
const SKIPS = typeof navigator !== "undefined" && "userActivation" in navigator && /Chrome\/|Chromium\//.test(navigator.userAgent);
/** whether a tap came since the page loaded or since the user's last Back or Forward: an entry made now is one Back keeps */
let tapped = !SKIPS;
/** the sheets that are up with no entry yet: theirs is made at the next tap */
const waiting = new Set<string>();
/** the sheet whose entry the history is on, as far as this module wrote it or landed on it */
let seen: string | null = null;
/**
 * The way back onto the entry a Back just left, for the sheets that Back did not close: the entry
 * it left (by its sheet), the sheet it is for now, and the address the app showed under it.
 */
let returning: { entry: string; owner: string; href: string } | null = null;
/** The Navigation API as this module uses it: the browser's own key and count for the entry the history is on, and the way onto an entry by its key. */
interface NavigationApi {
  currentEntry?: { key: string; index: number } | null;
  traverseTo(key: string): { committed: Promise<unknown>; finished: Promise<unknown> };
}
const navigation = (): NavigationApi | undefined => (window as unknown as { navigation?: NavigationApi }).navigation;
/** where the history stands by that key and count, as this module last saw it: a traversal is read against it */
let here: { key: string; index: number } | null = null;
function where(): { key: string; index: number } | null {
  const entry = navigation()?.currentEntry;
  return entry ? { key: entry.key, index: entry.index } : null;
}
/**
 * The entry the user's last Back left, right ahead of the one it landed on, while it is still
 * there: nothing was pushed and no other traversal came since. Where the browser skips an entry
 * made now, a sheet that comes back in front with that Back goes onto this one instead (climb).
 */
let ahead: string | null = null;
/** such a sheet on its way onto that entry: the entry's key, the sheet, and the state and address of the entry it opens over */
let climbing: { key: string; owner: string; state: unknown; href: string } | null = null;
/** whether the popstate being dispatched lands there: the entry's old owner is told so (sheetStep.taking) */
let took = false;
/** each sheet's entry by that key, where the browser gives one */
const entryKeys = new Map<string, string>();
function keep(id: string): void {
  const key = navigation()?.currentEntry?.key;
  if (key !== undefined) entryKeys.set(id, key);
}
/** the staying sheet whose entry `state` is, when it is still up: a navigation is about to take its entry over */
function cover(state: unknown): void {
  const id = sheetOf(state);
  if (id !== null && open.has(id) && staying.has(id)) covered.add(id);
}
let pushing = false;
/**
 * while a closed sheet's step back is on its way: the sheets that made their entry meanwhile, which
 * its popstate leaves open. The step always lands somewhere (a sheet's entry is made over another),
 * so its popstate comes and clears this; the next step starts a set of its own.
 */
let stepping: Set<string> | null = null;
/** whether the popstate being dispatched is such a step: this module listens first, so the app's Back reads it for the same event */
let steppedOff = false;
/**
 * While a step back that another part of the app asked for is on its way (sheetStep.goingBack):
 * no Back of the user's, so its popstate closes no sheet. A sheet that opens meanwhile makes no
 * entry yet (it would lie over the entries that step is leaving): its entry is made where it lands.
 * A step the browser drops lands nowhere: the wait ends by itself (LANDING_MS), so the next Back is
 * the user's again.
 */
let asked: ReturnType<typeof setTimeout> | null = null;
/** how long a step the app asked for is waited for, as lib/settingsHistory.ts waits for its own */
const LANDING_MS = 1000;
/** The sheets that waited for a tap, or for that step, make their entries. */
function makeWaiting(): void {
  for (const id of [...waiting]) { waiting.delete(id); if (open.has(id)) write(id); }
}

/**
 * Whether the popstate the app is handling is a closed sheet stepping off its own entry, or a Back
 * that the sheets took for themselves and left one up, not a Back for the app. The entry it lands
 * on is the one the sheet opened over, whose address may not say yet what the sheet's item opened
 * (a pane the roster does not list yet): the app stays where it is.
 */
export function sheetSteppedOff(): boolean {
  return steppedOff;
}

function sheetOf(state: unknown): string | null {
  if (state === null || typeof state !== "object") return null;
  const id = (state as Record<string, unknown>)[KEY];
  return typeof id === "string" ? id : null;
}

function without(state: unknown): unknown {
  if (state === null || typeof state !== "object") return state;
  const { [KEY]: _, ...rest } = state as Record<string, unknown>;
  return rest;
}

/**
 * A sheet's entry left as an ordinary one: a copy of a web page's entry counts as one more of the page's,
 * and so does a copy of a file's or a diff's while the entry under it is still the one it copied (`overlays`).
 */
function ordinary(state: unknown, overlays: boolean): unknown {
  const rest = without(state);
  return rest !== null && typeof rest === "object" ? overCopiedEntry(rest as Record<string, unknown>, overlays) : rest;
}

/** whether the entry the state names belongs to a sheet that is up, or just closed and not yet stepped off */
function owned(state: unknown): boolean {
  const id = sheetOf(state);
  return id !== null && (open.has(id) || leaving.has(id));
}

/**
 * Makes the sheet's entry (RowMenu's effect on mount; exported for its test). `stays`: the sheet
 * stays up under a navigation opened over it too, and its going comes back to the sheet.
 * `returns`: the sheet comes back in front when the user's Back closes what it opened over itself,
 * and takes the entry that Back left.
 */
export function enterSheet(onBack: () => boolean | void, reuse: string | null, stays = false, returns = false): string {
  // StrictMode's second mount, or a sheet reopened before its entry went: the same entry, or the same way onto one
  const timer = reuse === null ? undefined : leaving.get(reuse);
  if (reuse !== null && timer !== undefined && (sheetOf(window.history.state) === reuse || climbing?.owner === reuse)) {
    clearTimeout(timer);
    leaving.delete(reuse);
    open.set(reuse, onBack);
    if (stays) staying.add(reuse);
    return reuse;
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  open.set(id, onBack);
  if (stays) staying.add(id);
  stepping?.add(id);
  // an entry taken over from the sheet it opened from is no new one; a new one waits for a tap,
  // and for a step back the app asked for to land. A sheet back in front with the user's Back, with
  // no tap since, has the entry that Back left to take
  if (asked === null && (tapped || owned(window.history.state))) write(id);
  else if (returns && asked === null && stepping === null && returning === null && climbing === null && ahead !== null) climb(id, ahead);
  else waiting.add(id);
  return id;
}

/**
 * Sends a sheet that came back in front with the user's Back onto the entry that Back left, which
 * becomes the sheet's own once the traversal lands (the popstate handler): going onto an entry
 * makes none, so the browser's Back keeps it.
 */
function climb(id: string, key: string): void {
  ahead = null;
  climbing = { key, owner: id, state: window.history.state, href: window.location.href };
  // a traversal the browser drops leaves the sheet with no entry: the next tap makes one
  const dropped = (): void => {
    if (climbing?.owner !== id) return;
    climbing = null;
    if (open.has(id)) waiting.add(id);
  };
  const way = navigation()!.traverseTo(key);
  way.committed.catch(dropped);
  way.finished.catch(() => undefined);
}

/** Writes the sheet's entry: the one of the sheet it opened from, taken over, or a new one over the entry the history is on. */
function write(id: string): void {
  const base = window.history.state;
  const fields = base !== null && typeof base === "object" ? base : {};
  const state = { ...fields, [KEY]: id };
  pushing = true;
  try {
    // a sheet opened from another sheet takes that sheet's entry: one Back closes it. The sheet it
    // opened over, when that one is still up (it did not close as this one opened), is covered,
    // and comes back once the new sheet goes
    if (owned(base)) {
      const under = sheetOf(base)!;
      const heir = open.has(under) ? under : heirs.get(under);
      if (heir !== undefined && open.has(heir)) { heirs.set(id, heir); covered.add(heir); }
      window.history.replaceState(state, "");
    }
    else {
      // the entry the sheet opens over is marked with it, as is the sheet's own: a navigation that
      // takes the sheet's entry over (Settings from the palette) can tell the entry it began from
      window.history.replaceState({ ...fields, [SHEET_UNDER_KEY]: id }, "");
      window.history.pushState({ ...state, [SHEET_UNDER_KEY]: id }, "");
    }
  } finally { pushing = false; }
  addresses.set(id, window.location.href);
  seen = id;
  keep(id);
}

/**
 * Makes the sheet's entry again over the one the history is on, for a sheet a traversal left up
 * (Back refused, a step that was not Back for it, or what covered it went). A browser that skips
 * such an entry is sent onto the sheet's old one instead where it can be (the popstate handler),
 * and else gets the new one at the next tap.
 */
function remake(id: string, onBack: () => boolean | void): void {
  open.set(id, onBack);
  if (!tapped) { waiting.add(id); return; }
  waiting.delete(id);
  const base = window.history.state;
  pushing = true;
  try { window.history.pushState({ ...(base !== null && typeof base === "object" ? base : {}), [KEY]: id }, ""); }
  finally { pushing = false; }
  addresses.set(id, window.location.href);
  seen = id;
  keep(id);
}

/** Steps off the sheet's entry once the closing click's effects are through (RowMenu's effect on unmount). */
export function leaveSheet(id: string): void {
  covered.delete(id);
  staying.delete(id);
  waiting.delete(id);
  if (!open.delete(id)) return;
  // after the closing click's commit and effects, which may write history of their own
  leaving.set(id, setTimeout(() => {
    leaving.delete(id);
    const address = addresses.get(id);
    addresses.delete(id);
    const heir = heirs.get(id);
    heirs.delete(id);
    const key = entryKeys.get(id);
    entryKeys.delete(id);
    if (sheetOf(window.history.state) !== id) return;
    // an item that changed the address on the sheet's entry (the New tab dialog) keeps the entry as its own
    if (window.location.href !== address) { window.history.replaceState(ordinary(window.history.state, true), ""); seen = null; }
    else if (heir !== undefined && open.has(heir) && covered.delete(heir)) {
      // the sheet this one opened over stays up: the entry is that sheet's again, as it stands
      window.history.replaceState({ ...(window.history.state as Record<string, unknown>), [KEY]: heir }, "");
      addresses.set(heir, window.location.href);
      if (key !== undefined) entryKeys.set(heir, key);
      seen = heir;
    } else {
      // the traversal runs later: a sheet that opens before its popstate keeps its entry
      stepping = new Set();
      window.history.back();
    }
  }, 0));
}

if (typeof window !== "undefined") {
  const history = window.history;
  const push = history.pushState.bind(history);
  history.pushState = ((state: unknown, ...rest: [string, (string | URL | null)?]) => {
    try {
      if (pushing) return push(state, ...rest);
      // a navigation made from a sheet (an item that opened another pane, Settings, a file) takes the
      // sheet's entry: Back from there goes to the pane before the sheet, and no entry is left between.
      // A staying sheet still up under it is covered
      seen = null;
      if (owned(history.state)) { cover(history.state); return history.replaceState(without(state), ...rest); }
      // an entry pushed over a sheet's copies its state (the file viewer's does): only the sheet's own carries its mark
      return push(without(state), ...rest);
    } finally {
      // a new entry drops the ones ahead, and what a navigation wrote is no place to go onto again
      here = where();
      ahead = null;
    }
  }) as History["pushState"];
  here = where();
  // a tap the browser counts as one (a scroll, or Escape, is none): entries made from here are kept,
  // and the sheets that waited for one get theirs, once no step the app asked for is on its way
  const onTap = (): void => {
    if (navigator.userActivation?.isActive !== true) return;
    tapped = true;
    if (asked === null) makeWaiting();
  };
  if (SKIPS) for (const type of ["pointerup", "touchend", "mousedown", "keydown", "click"]) window.addEventListener(type, onTap, true);
  /** the popstate this module last handled: one asked about before it is handled is answered by the step on its way */
  let heard: Event | null = null;
  sheetStep.lands = (event) => event === heard ? steppedOff : stepping !== null;
  sheetStep.taking = (event) => event === heard ? took : climbing !== null && where()?.key === climbing.key;
  sheetStep.dropped = () => {
    if (asked === null) return;
    clearTimeout(asked);
    asked = null;
    if (tapped) makeWaiting();
  };
  sheetStep.goingBack = (state) => {
    if (asked !== null) clearTimeout(asked);
    asked = setTimeout(() => {
      asked = null;
      // what waited for the step alone: a sheet with a tap behind it
      if (tapped) makeWaiting();
    }, LANDING_MS);
    const id = sheetOf(state);
    if (id === null) return false;
    const timer = leaving.get(id);
    // a sheet that is up on that entry took it from the sheet that closed as the caller did: the
    // caller's step leaves it, and its popstate makes the sheet's entry again
    if (timer === undefined) return open.has(id);
    // a closed sheet's own step is the caller's now: it goes back past every entry down to where the sheet
    // opened, an address the sheet's item wrote on its entry included (leaveSheet would keep that entry as the item's own)
    clearTimeout(timer);
    leaving.delete(id);
    addresses.delete(id);
    return true;
  };
  window.addEventListener("popstate", (event) => {
    heard = event;
    const was = here;
    here = where();
    ahead = null;
    took = climbing !== null && here?.key === climbing.key;
    if (climbing !== null && took) {
      // on the entry the user's Back left, for the sheet that came back in front: no Back or Forward
      // of the user's. The entry is rewritten as the sheet's own, over the one it opened on; what it
      // held is not shown again (sheetStep.taking)
      const { owner, state, href } = climbing;
      climbing = null;
      steppedOff = true;
      if (open.has(owner)) {
        window.history.replaceState({ ...(state !== null && typeof state === "object" ? state : {}), [KEY]: owner }, "", href);
        addresses.set(owner, href);
        seen = owner;
        keep(owner);
      } else {
        // the sheet went meanwhile: back off the entry, as a closed sheet steps off its own
        seen = sheetOf(event.state);
        stepping = new Set();
        window.history.back();
      }
      return;
    }
    // a step back another part of the app took by itself
    const own = asked !== null;
    if (asked !== null) { clearTimeout(asked); asked = null; }
    // what the last tap allowed ends with the user's own Back or Forward: Chromium counts a tap until
    // then, through any step the page takes by itself (that one, or a closed sheet's off its entry)
    if (!own && stepping === null) tapped = !SKIPS;
    const from = seen;
    seen = sheetOf(event.state);
    if (returning !== null) {
      const { entry, owner, href } = returning;
      returning = null;
      if (seen === entry) {
        // back on the entry the Back left, for the sheets it did not close: no Back of the user's
        steppedOff = true;
        if (!open.has(owner)) {
          // the sheet it came back for closed meanwhile: off the entry again, as a closed sheet steps off its own
          stepping = new Set();
          window.history.back();
        } else if (owner !== entry) {
          // what covered the sheet that stays is gone: the entry is that sheet's own again, at the address shown under it
          window.history.replaceState({ ...(event.state as Record<string, unknown>), [KEY]: owner }, "", href);
          addresses.set(owner, href);
          seen = owner;
          keep(owner);
        }
        return;
      }
    }
    const landed = seen;
    // the step off a closed sheet's entry: not a Back for the sheets that opened while it was on its way
    const step = stepping;
    stepping = null;
    steppedOff = step !== null;
    const heir = from === null ? undefined : heirs.get(from);
    // the entry just left, by the browser's key: where it skips an entry made now, the sheets that stay go onto it again
    const left = SKIPS && from !== null ? entryKeys.get(from) : undefined;
    // the sheets that stay: one whose entry was taken over (`under`: the traversal left what covered
    // it) and one that opened during the step were never asked; one busy at Back refuses it (`refused`)
    const again: Array<{ id: string; onBack: () => boolean | void; under: boolean; refused: boolean }> = [];
    for (const [id, onBack] of [...open]) {
      if (id === landed) continue;
      open.delete(id);
      if (covered.delete(id)) again.push({ id, onBack, under: true, refused: false });
      else if (own || step?.has(id)) again.push({ id, onBack, under: false, refused: false });
      else if (onBack() === false) again.push({ id, onBack, under: false, refused: true });
      else { heirs.delete(id); waiting.delete(id); entryKeys.delete(id); }
    }
    // a Back off a sheet's entry that leaves a sheet up was the sheets' own (one refused it, or the one
    // on top closed over one still up): the app under them stays where it is, as for a step. The entry
    // it landed on is the one they opened over, whose address may say less than is shown (a dialog
    // the address names, still up under the list that closed). A step the app asked for is answered
    // for by the one that asked (settingsSteppedOff)
    if (from !== null && again.length > 0 && !own) steppedOff = true;
    // the entry of a sheet that Back closed lies ahead of the app: Forward lands on it and goes on,
    // and the entry is an ordinary one from here
    const retired = landed !== null && !open.has(landed) && !leaving.has(landed);
    if (retired) { window.history.replaceState(ordinary(event.state, false), ""); seen = null; }
    // the entry just left is still in the history, and is theirs: the entry of the sheet that refused,
    // or of the sheet that closed over one still up under it
    // (never after a step the app asked for: the entry it left is one of those it meant to leave)
    const owner = own || left === undefined || from === null ? undefined
      : (again.find((kept) => kept.refused && kept.id === from) ?? again.find((kept) => kept.under && kept.id === heir))?.id;
    if (owner !== undefined && left !== undefined && from !== null) {
      // going onto it again makes no entry
      for (const kept of again) { open.set(kept.id, kept.onBack); if (kept.under && kept.id !== owner) covered.add(kept.id); }
      returning = { entry: from, owner, href: window.location.href };
      // a traversal the browser drops (another one overtook it) leaves them up with no entry: the next tap makes theirs
      const dropped = (): void => {
        if (returning?.entry !== from) return;
        returning = null;
        for (const kept of again) { covered.delete(kept.id); waiting.add(kept.id); }
      };
      const way = navigation()!.traverseTo(left);
      way.committed.catch(dropped);
      way.finished.catch(() => undefined);
      return;
    }
    // their entries are made again over where the history landed
    for (const kept of again) remake(kept.id, kept.onBack);
    if (retired && again.length === 0) window.history.forward();
    // the user's own Back, by one entry: the one it left lies right ahead
    else if (!own && step === null && was !== null && here !== null && here.index === was.index - 1) ahead = was.key;
  });
  // a reload keeps the history and not the sheet: its entry is an ordinary one now
  if (sheetOf(window.history.state) !== null) window.history.replaceState(ordinary(window.history.state, true), "");
}

/**
 * While `active`, the sheet holds a history entry; Back calls `onBack`, which may return false to
 * refuse (a busy sheet keeps its entry). `stays`: the sheet stays up under a navigation opened
 * over it too (under another sheet it always does). `returns`: it is active again when the user's
 * Back closes what it opened over itself, and takes the entry that Back left.
 */
export function useSheetHistory(active: boolean, onBack: () => boolean | void, stays = false, returns = false): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  const id = useRef<string | null>(null);
  const staysRef = useRef(stays);
  staysRef.current = stays;
  const returnsRef = useRef(returns);
  returnsRef.current = returns;
  useEffect(() => {
    if (!active) return;
    const entry = enterSheet(() => latest.current(), id.current, staysRef.current, returnsRef.current);
    id.current = entry;
    return () => leaveSheet(entry);
  }, [active]);
}

/**
 * A surface that opens over the app: on a phone, or any screen worked by touch (BACK_QUERY), while
 * `open`, Back closes it (`onBack`) as it does a ⋯ menu; `onBack` returning false (the surface is
 * busy) keeps it and its entry. A desktop keeps Back for the panes, with the dialog over them.
 * Every such surface calls this (src/conventions.test.ts): one that does not is skipped by Back,
 * which then leaves the app or the pane with it still open. Surfaces stack: one still up under
 * another opened over it stays, and Back, or the other's own close, comes back to it. A dialog
 * under a file it opened (the file list under a file, whose entry is the viewer's own) passes
 * `open` false meanwhile, so the file has the entry, and `returns`: once Back has closed the file
 * the list is in front again with no tap behind it, and takes the entry that Back left, where a
 * browser would skip one made then. One that stays up under a navigation opened over it (a
 * terminal peek under Settings) passes `stays`.
 */
export function usePhoneSheetBack(onBack: () => boolean | void, open = true, stays = false, returns = false): void {
  useSheetHistory(useMediaQuery(BACK_QUERY) && open, onBack, stays, returns);
}
