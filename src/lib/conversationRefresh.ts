/** With pushes, a lost one still gets a full conversation read. */
const BACKSTOP_MS = 10_000;

/** Pushes start newest-page reads at least 1s apart: a streaming answer moves every second, and
 * a bridge's transcript reads stay bounded while an agent writes continuously. */
const INVALIDATION_MS = 1000;

/** A chat without pushes (an older bridge, a tab that let go of its pane) reads every 2s. */
const POLL_MS = 2000;

/** One serial lane for newest pages and their gap fills; an older page starts in it, after the
 * newest read before it, but never holds the next newest read back. */
export class ConversationRefresh {
  private read: ((signal: AbortSignal) => Promise<void>) | null = null;
  private scope: AbortController | null = null;
  private pending = false;
  private invalidated = false;
  private running = false;
  /** the newest read in flight, which a reconnect may give up on its own */
  private current: AbortController | null = null;
  private timer: number | undefined;
  private newestAt = -Infinity;
  private pushes = false;
  private waiting = false;
  private readonly pages: (() => Promise<void>)[] = [];
  /** refreshed() callers, answered when the next newest read to begin ends */
  private readonly waiters: (() => void)[] = [];

  /** A replaced screen releases its REST read before the new screen enters the serial lane. */
  setRead(read: (signal: AbortSignal) => Promise<void>): void {
    this.scope?.abort();
    this.scope = new AbortController();
    this.clearTimer();
    this.pending = false;
    this.invalidated = false;
    this.newestAt = -Infinity;
    this.read = read;
    for (const done of this.waiters.splice(0)) done();
  }

  /** Whether the bridge pushes this pane's transcript changes; without, the backstop is the poll. */
  setPushes(available: boolean): void {
    if (this.pushes === available) return;
    this.pushes = available;
    // a waiting backstop takes the new cadence; a read in flight schedules it when it ends
    if (this.read !== null && !this.running && !this.invalidated && this.timer !== undefined) {
      this.clearTimer();
      this.timer = window.setTimeout(() => this.refresh(), this.backstop());
    }
  }

  /** Waiting for the pane's activity: no backstop reads; refresh() and invalidate() still read. */
  setWaiting(waiting: boolean): void {
    if (this.waiting === waiting) return;
    this.waiting = waiting;
    if (this.read === null || this.running || this.invalidated) return;
    this.clearTimer();
    if (!waiting) this.timer = window.setTimeout(() => this.refresh(), this.backstop());
  }

  /** A newest-page read is in flight: one requested now would start only after it settles. */
  get reading(): boolean {
    return this.running;
  }

  refresh(): void {
    if (this.read === null) return;
    this.clearTimer();
    this.pending = true;
    this.invalidated = false;
    void this.drain();
  }

  /**
   * A newest read now, answered once a newest read begun after this call has ended (or the screen
   * went); a read a reconnect gave up on answers through the read that replaces it.
   */
  refreshed(): Promise<void> {
    if (this.read === null) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.push(resolve);
    this.refresh();
    return promise;
  }

  /**
   * The connection came back. A newest read sent before it may wait on a connection that died
   * silently until its deadline, holding every push behind it: it is given up and the pane read now.
   */
  restart(): void {
    if (this.read === null) return;
    this.current?.abort(new DOMException("The read was replaced after a reconnect.", "AbortError"));
    this.refresh();
  }

  /** The first push after idle reads immediately; further pushes share a fixed trailing deadline. */
  invalidate(): void {
    if (this.read === null || this.invalidated) return;
    this.invalidated = true;
    this.clearTimer();
    void this.drain();
  }

  /** An explicitly requested older page starts once the newest read in flight (and its gap fill)
   * has settled, so a history change found there drops it first. A slow older page never delays
   * the newest page: a clear or a new turn still shows while it loads, and its caller discards it. */
  page<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const signal = this.scope?.signal;
    this.pages.push(async () => {
      try {
        if (signal === undefined || signal.aborted) throw signal?.reason ?? new DOMException("The read was cancelled.", "AbortError");
        resolve(await read(signal));
      }
      catch (cause) { reject(cause); }
    });
    this.clearTimer();
    void this.drain();
    return promise;
  }

  /** Hidden/unmounted readers leave no timer, pending refresh or REST read holding the lane. */
  stop(): void {
    this.read = null;
    this.pending = false;
    this.invalidated = false;
    this.clearTimer();
    this.scope?.abort();
    this.scope = null;
    for (const done of this.waiters.splice(0)) done();
  }

  private backstop(): number {
    return this.pushes ? BACKSTOP_MS : POLL_MS;
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const page = this.pages.shift();
        if (page !== undefined) {
          void page();
          continue;
        }
        if (this.read === null || (!this.pending && !this.invalidated)) break;
        if (!this.pending && performance.now() < this.newestAt + INVALIDATION_MS) break;
        this.pending = false;
        this.invalidated = false;
        // Monotonic elapsed time keeps wall-clock corrections out of the rate bound.
        this.newestAt = performance.now();
        // its own signal, ended with the screen's: a reconnect gives up this read alone
        const scope = this.scope!.signal;
        const current = new AbortController();
        const end = (): void => current.abort(scope.reason);
        scope.addEventListener("abort", end, { once: true });
        this.current = current;
        const waiters = this.waiters.splice(0);
        try { await this.read(current.signal); }
        finally {
          scope.removeEventListener("abort", end);
          if (this.current === current) this.current = null;
          if (current.signal.aborted && !scope.aborted) this.waiters.unshift(...waiters);
          else for (const done of waiters) done();
        }
      }
    } finally {
      this.running = false;
      if (this.read !== null) {
        this.timer = this.invalidated
          ? window.setTimeout(() => {
            this.timer = undefined;
            void this.drain();
          }, Math.max(0, this.newestAt + INVALIDATION_MS - performance.now()))
          : this.waiting ? undefined : window.setTimeout(() => this.refresh(), this.backstop());
      }
    }
  }
}
