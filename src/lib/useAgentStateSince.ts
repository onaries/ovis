/**
 * This device's state stamps (lib/agentStateSince.ts), taken in one place and read by every list
 * that says how long an agent has been in its state. App runs the stamping for as long as the page
 * lives, so a change is stamped whether or not a list is in sight; the lists only read.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { Machine } from "../../shared/machines.ts";
import { advanceStateStamps, loadStateStamps, saveStateStamps, stateLooks, type LastLook, type StateStamps } from "./agentStateSince.ts";
import { stateWatch, type UnseenLook } from "./agentStateWatch.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";

const NONE: StateStamps = {};
let published: StateStamps = NONE;
const listeners = new Set<() => void>();

function publish(stamps: StateStamps): void {
  if (stamps === published) return;
  published = stamps;
  for (const listener of [...listeners]) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const current = (): StateStamps => published;

/** The stamps of the PCs the page's stamping last looked at; none until it has looked at one. */
export function useAgentStateStamps(): StateStamps {
  return useSyncExternalStore(subscribe, current, current);
}

/**
 * Stamps every PC's agents whenever a look at them differs from the one before it. The stored stamps
 * are read anew at each look, so two tabs of one device keep each other's; where the storage cannot
 * be read or written (private mode), the page goes by the stamps it made itself. Where the page was
 * not told of its PCs for too long (lib/agentStateWatch.ts), a look dates nothing: what the page
 * saw before does not tell when a state began.
 *
 * The lists read the stamps of the PCs the last look judged, and no other: what the device keeps
 * of a PC this page has not looked at yet (the roster has not come, or the PC is away) is not known
 * to be true. A look is made in the commit that draws its roster, before the browser paints it: a
 * roster painted before its look would say, for a frame, each time that look then takes back (after
 * a reload, every kept time of a PC whose herdr counts nothing). A list first drawn in that very
 * commit is told of the look a frame late: until then it reads what the look before it left, which
 * at a page's first roster is no time at all.
 */
export function useAgentStateStamping(machines: readonly Machine[], activity: SidebarActivity): void {
  const looks = useMemo(() => stateLooks(machines, (machineId, pane) => activity.status(machineId, pane)), [machines, activity]);
  // everything a look reads: which pane it is, its state, either counter, what the roster says beside them, and whose counts they are
  const signature = useMemo(() => looks.map((look) => `${look.id}|${look.lifetime ?? ""}|${look.epoch ?? ""}|${look.rows === null ? "-" : look.rows.map((row) => `${row.pane}@${row.terminal}=${row.state}${row.done ? "!" : ""}${row.wait ? "~" : ""}${row.own ? "*" : ""}#${row.seq ?? ""}/${row.finish ?? ""}`).join(",")}`).join("\n"), [looks]);
  const latest = useRef(looks);
  latest.current = looks;
  // a roster that cannot date what it brings, told by the watch in the batch that draws it, so it is looked at even when it changed nothing
  const [unseen, setUnseen] = useState<{ round: number; look: UnseenLook }>({ round: 0, look: "first" });
  // what the page carries from one look to the next: its own stamps, the states it saw last, whether the storage still takes them, the last such roster it looked at, and the stamps the lists read
  const carried = useRef<{ own: StateStamps; last: LastLook; kept: boolean; round: number; shown: StateStamps } | null>(null);
  useLayoutEffect(() => {
    const page = carried.current ??= { own: loadStateStamps() ?? NONE, last: new Map(), kept: true, round: unseen.round, shown: NONE };
    // a roster of no PC is the loader's before the first one has come (a roster always has this PC): there is nothing
    // to look at yet, and a look at no PC would mark every kept stamp as its PC's having left the roster, for the
    // device's other tabs to read
    if (latest.current.length === 0) return;
    const told = page.round !== unseen.round ? unseen.look : null;
    page.round = unseen.round;
    if (told === "first" || stateWatch.blind()) page.last = new Map();
    const before = (page.kept ? loadStateStamps() : null) ?? page.own;
    const next = advanceStateStamps({ stamps: before, last: page.last }, latest.current, Date.now(), told !== "undated");
    if (next.stamps !== before) page.kept = saveStateStamps(next.stamps);
    page.own = next.stamps;
    page.last = next.last;
    // a PC's stamps stay one object while neither a look nor the device's other tabs changed what is kept, so a look that changes nothing tells the lists nothing
    const judged = latest.current.flatMap((look) => { const pc = look.rows === null ? undefined : next.stamps[look.id]; return pc === undefined ? [] : [[look.id, pc] as const]; });
    if (judged.length !== Object.keys(page.shown).length || judged.some(([id, pc]) => page.shown[id] !== pc)) page.shown = Object.fromEntries(judged);
    publish(page.shown);
  }, [signature, unseen]);
  // a page that ends leaves nothing behind: the next one reads the device's stamps anew, and a list with no stamping draws no time
  useEffect(() => {
    const end = stateWatch.keep((look) => setUnseen((last) => ({ round: last.round + 1, look })));
    return () => { end(); publish(NONE); };
  }, []);
}
