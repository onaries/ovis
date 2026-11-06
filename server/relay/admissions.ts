/**
 * The signed-in sessions one PC serves, whichever way they came: the relay links (global and regional)
 * and the direct carriers count against the same limits, so no way in adds places of its own.
 */
export class SignedInSessions {
  private order = 0;
  private readonly entries = new Set<{ readonly deviceId: string; readonly order: number; readonly close: () => void }>();

  /** at most `max` at once, and `perDevice` for one device key, whose oldest gives way */
  constructor(private readonly max = 8, private readonly perDevice = 4) {}

  get size(): number { return this.entries.size; }

  /**
   * Counts a session that just signed in, and returns what ends its count (idempotent). With every place
   * taken it is closed itself; past its device's share, that device's oldest sessions are closed.
   */
  admit(deviceId: string, close: () => void): () => void {
    const entry = { deviceId, order: ++this.order, close };
    this.entries.add(entry);
    const release = (): void => { this.entries.delete(entry); };
    // the device's own oldest give way first, so a device at its share always gets its new session in
    const own = [...this.entries].filter((other) => other.deviceId === deviceId).sort((a, b) => a.order - b.order);
    for (const oldest of own.slice(0, Math.max(0, own.length - this.perDevice))) {
      this.entries.delete(oldest);
      oldest.close();
    }
    if (this.entries.size > this.max) {
      release();
      close();
    }
    return release;
  }
}
