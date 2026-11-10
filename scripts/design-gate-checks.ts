/**
 * The design gate's decisions that do not need a browser (scripts/design-gate-qa.ts): the focus walk's
 * cycle, the layout comparison and the effective target square. `targetVerdict` is also handed to the
 * page as source text, so it stays self-contained (no imports, no outer names).
 */

export interface Rect { x: number; y: number; w: number; h: number }
export type Layout = Record<string, Record<string, Rect>>;

/** Where Tab left focus: nowhere the page owns (`id` null: the body, the start sentinel), or one element and its verdict. */
export type FocusStop<Verdict> = { id: null } | { id: number; verdict: Verdict };
export interface FocusDriver<Verdict> {
  /** The element focused before any Tab (a dialog's first control). */
  current(): Promise<FocusStop<Verdict>>;
  tab(): Promise<FocusStop<Verdict>>;
}
export interface FocusWalk<Verdict> {
  /** Every element focus visited, with its last verdict (the cycle's closing stop re-measures the start under keyboard focus). */
  verdicts: Map<number, Verdict>;
  /** Focus came back to an element it had visited (or found nothing to stop on) before the ceiling. */
  complete: boolean;
  presses: number;
}

/** Tabs from the focused element until focus returns to one already visited, at most `ceiling` presses. */
export async function walkFocus<Verdict>(driver: FocusDriver<Verdict>, ceiling: number): Promise<FocusWalk<Verdict>> {
  const verdicts = new Map<number, Verdict>();
  const start = await driver.current();
  if (start.id !== null) verdicts.set(start.id, start.verdict);
  let outside = 0;
  for (let presses = 1; presses <= ceiling; presses += 1) {
    const stop = await driver.tab();
    if (stop.id === null) {
      // past the last stop focus leaves the page once; twice in a row means the page has nothing to stop on
      outside += 1;
      if (outside >= 2) return { verdicts, complete: true, presses };
      continue;
    }
    outside = 0;
    const seen = verdicts.has(stop.id);
    verdicts.set(stop.id, stop.verdict);
    if (seen) return { verdicts, complete: true, presses };
  }
  return { verdicts, complete: false, presses: ceiling };
}

/**
 * Every anchor of the baseline's visits that moved past `tolerance`, is missing or is new. A baseline visit this
 * run did not make is missing anchor by anchor, unless the run was narrowed (`--surfaces`) and did not ask for it;
 * a visit this run made that the baseline does not have is added anchor by anchor.
 */
export function moves(before: Layout, now: Layout, scope: { requested: ReadonlySet<string>; narrowed: boolean; tolerance: number }): string[] {
  const lines: string[] = [];
  for (const [visitKey, was] of Object.entries(before)) {
    const anchors = now[visitKey];
    const where = visitKey.split("|").join(" ");
    if (!anchors) {
      if (scope.narrowed && !scope.requested.has(visitKey)) continue;
      for (const name of Object.keys(was)) lines.push(`MOVED ${name} ${where} missing missing`);
      continue;
    }
    for (const [name, rect] of Object.entries(was)) {
      const at = anchors[name];
      if (!at) { lines.push(`MOVED ${name} ${where} missing missing`); continue; }
      const dx = Math.round((at.x - rect.x) * 10) / 10, dy = Math.round((at.y - rect.y) * 10) / 10;
      if (Math.abs(dx) > scope.tolerance || Math.abs(dy) > scope.tolerance) lines.push(`MOVED ${name} ${where} ${dx} ${dy}`);
    }
    for (const name of Object.keys(anchors)) if (!was[name]) lines.push(`MOVED ${name} ${where} added added`);
  }
  // a visit the baseline never recorded: each of its anchors is new, as a new anchor of a recorded visit is
  for (const [visitKey, anchors] of Object.entries(now)) {
    if (before[visitKey]) continue;
    const where = visitKey.split("|").join(" ");
    for (const name of Object.keys(anchors)) lines.push(`MOVED ${name} ${where} added added`);
  }
  return lines;
}

/** A ring's computed parts, each as one comparable string. */
export interface RingRead { outline: string; boxShadow: string; border: string }
export type RingOwner = { on: "self" } | { on: "ancestor"; index: number; changed: (keyof RingRead)[] } | { on: null };

/**
 * Who draws the focused control's ring: the control itself, or else the first wrapper with an outline, box-shadow or
 * border that is drawn while focused and differs blurred (a :focus-within ring). Handed to the page as source text.
 */
export function ringOwner(selfDrawn: boolean, wrappers: readonly { focused: RingRead; blurred: RingRead; drawn: Record<keyof RingRead, boolean> }[]): RingOwner {
  if (selfDrawn) return { on: "self" };
  for (const [index, wrapper] of wrappers.entries()) {
    const changed = (["outline", "boxShadow", "border"] as const).filter((part) => wrapper.drawn[part] && wrapper.focused[part] !== wrapper.blurred[part]);
    if (changed.length) return { on: "ancestor", index, changed };
  }
  return { on: null };
}

/**
 * How a control meets the `min` x `min` target size: by its own box, or by its effective hit area (a ::before or
 * ::after expander). The hit area is found along the axes through the box's centre (`owns`: elementFromPoint lands
 * on the control or a descendant). Both measured extents must reach `min`;
 * then the square's 1px-inset corners and centre must hit the control. `hits` counts the five points that did.
 */
export function targetVerdict(box: { left: number; top: number; width: number; height: number }, min: number, owns: (x: number, y: number) => boolean): { method: "box" | "effective" | null; hits: number } {
  if (box.width >= min - 0.5 && box.height >= min - 0.5) return { method: "box", hits: 5 };
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2, near = min / 2 - 1;
  const reach = (dx: number, dy: number): number => {
    let step = 0;
    while (step < min && owns(cx + dx * (step + 1), cy + dy * (step + 1))) step += 1;
    // Bracket each edge to 0.25px and use its midpoint (at most 0.25px error per axis).
    // Do not add the box rule's tolerance: browser hit testing already rounds at edges.
    while (step + 0.25 <= min && owns(cx + dx * (step + 0.25), cy + dy * (step + 0.25))) step += 0.25;
    return Math.min(step + 0.125, min);
  };
  const left = reach(-1, 0), right = reach(1, 0), top = reach(0, -1), bottom = reach(0, 1);
  const reachesFloor = left + right >= min && top + bottom >= min;
  const mx = cx + (right - left) / 2, my = cy + (bottom - top) / 2;
  const points: [number, number][] = [[mx - near, my - near], [mx + near, my - near], [mx - near, my + near], [mx + near, my + near], [mx, my]];
  const hits = points.filter(([x, y]) => owns(x, y)).length;
  return { method: reachesFloor && hits === points.length ? "effective" : null, hits };
}
