import type { DeviceConnection, DeviceRoute } from "../../shared/access.ts";

/** What a signed-in session tells of its way in (SignedInSessions.connections). */
export interface SessionLine {
  readonly route: DeviceRoute;
  /** the relay it came through, for `relay` */
  readonly relay?: string;
  /** when it signed in, ms since the epoch */
  readonly since: number;
  /** its mux: the keepalive's latest round trip, and a probe on demand (MuxEngine) */
  readonly mux: { readonly active: boolean; readonly rttMs: number | undefined; measure(): Promise<number | undefined> };
}

/** A check this soon after the last one answers with what that one measured. */
export const CHECK_GAP_MS = 5_000;

/** nearest first: of a device's sessions, the one it is best connected by is the one shown */
const NEAR: Record<DeviceRoute, number> = { lan: 0, tailscale: 1, relay: 2 };

/**
 * The signed-in sessions one PC serves, whichever way they came: the relay links (global and regional)
 * and the direct carriers count against the same limits, so no way in adds places of its own.
 */
export class SignedInSessions {
  private order = 0;
  private readonly entries = new Set<{ readonly deviceId: string; order: number; chosen: boolean; readonly close: () => void; readonly line?: SessionLine }>();

  /**
   * at most `max` at once, and `perDevice` chosen for one device key, whose oldest gives way; at most `perDeviceCandidates`
   * not chosen yet for one device key (an app races its carriers: two direct ones and the relay)
   */
  constructor(private readonly max = 8, private readonly perDevice = 4, private readonly perDeviceCandidates = 3) {}

  get size(): number { return this.entries.size; }

  /** Counts a session that just signed in and is used at once: `candidate`, then `chosen`. */
  admit(deviceId: string, close: () => void, line?: SessionLine): () => void {
    const admission = this.candidate(deviceId, close, line);
    admission.chosen();
    return admission.release;
  }

  private chosenOf(deviceId: string): number {
    return [...this.entries].filter((other) => other.deviceId === deviceId && other.chosen).length;
  }

  /**
   * Counts a session that just signed in but may be one of an app's racing carriers, which it closes again if
   * another came up first (src/lib/relay/transport.ts): it takes a place, but no other session of its device
   * gives way for it until `chosen` (its first stream). One past every place is closed itself; past its device's
   * candidates, the oldest of them is. `release` ends its count (idempotent).
   */
  candidate(deviceId: string, close: () => void, line?: SessionLine): { readonly release: () => void; readonly chosen: () => void } {
    const entry = { deviceId, order: ++this.order, chosen: false, close, ...(line ? { line } : {}) };
    this.entries.add(entry);
    const release = (): void => { this.entries.delete(entry); };
    // past its device's racing carriers, the oldest of them gives way: one that never opened a stream was dropped,
    // or lost on its way (a newest-gives-way rule would keep such a dead one and shut the device out)
    const waiting = [...this.entries].filter((other) => other.deviceId === deviceId && !other.chosen).sort((left, right) => left.order - right.order);
    for (const oldest of waiting.slice(0, Math.max(0, waiting.length - this.perDeviceCandidates))) {
      this.entries.delete(oldest);
      oldest.close();
    }
    // with every place taken, a device at its share still gets in (once used, its own oldest gives way), but never
    // more than one device's racing carriers past every place
    const over = this.entries.size - this.max;
    if (over > 0 && (this.chosenOf(deviceId) < this.perDevice || over > this.perDeviceCandidates)) {
      release();
      close();
    }
    return {
      release,
      chosen: () => {
        if (entry.chosen || !this.entries.has(entry)) return;
        entry.chosen = true;
        entry.order = ++this.order;
        // the device's own oldest give way, so a device at its share always gets its new session in
        const own = [...this.entries].filter((other) => other.deviceId === deviceId && other.chosen).sort((a, b) => a.order - b.order);
        for (const oldest of own.slice(0, Math.max(0, own.length - this.perDevice))) {
          this.entries.delete(oldest);
          oldest.close();
        }
      },
    };
  }

  /** Each device with a session up, by its nearest way in (the newest of equals). */
  connections(): Map<string, DeviceConnection> {
    const best = new Map<string, { order: number; chosen: boolean; line: SessionLine }>();
    for (const { deviceId, order, line, chosen } of this.entries) {
      // a mux that ended counts until its socket closes, and is no way in meanwhile
      if (!line?.mux.active) continue;
      const held = best.get(deviceId);
      // a session in use before a racing carrier the app may still drop, then the nearest, then the newest
      const better = !held || (chosen !== held.chosen ? chosen
        : NEAR[line.route] !== NEAR[held.line.route] ? NEAR[line.route] < NEAR[held.line.route] : order > held.order);
      if (better) best.set(deviceId, { order, chosen, line });
    }
    return new Map([...best].map(([deviceId, { line }]) => [deviceId, {
      route: line.route, ...(line.relay === undefined ? {} : { relay: line.relay }),
      rtt_ms: line.mux.rttMs === undefined ? null : Math.round(line.mux.rttMs), since: new Date(line.since).toISOString(),
    }]));
  }

  private checking: Promise<void> | undefined;
  private checkedAt = -Infinity;

  /**
   * Measures every session's round trip now; one that has not answered within `timeoutMs` keeps its last one.
   * Callers at once share one check, and one within CHECK_GAP_MS of the last measures nothing again.
   */
  check(timeoutMs: number, now = Date.now()): Promise<void> {
    if (this.checking) return this.checking;
    if (now - this.checkedAt < CHECK_GAP_MS) return Promise.resolve();
    this.checkedAt = now;
    this.checking = this.measureAll(timeoutMs).finally(() => { this.checking = undefined; });
    return this.checking;
  }

  private async measureAll(timeoutMs: number): Promise<void> {
    let stop = (): void => {};
    const late = new Promise<void>((resolve) => { const timer = setTimeout(resolve, timeoutMs); stop = () => { clearTimeout(timer); resolve(); }; });
    await Promise.race([Promise.all([...this.entries].map((entry) => entry.line?.mux.measure())), late]);
    stop();
  }
}