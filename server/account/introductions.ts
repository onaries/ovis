import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { isWssOrigin } from "../../shared/relay-offer.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";

export const INTRODUCTION_TTL_MS = 10 * 60_000;
const MAX_PCS = 32;

export interface IntroducedPc { server_id: string; server_public_key: string; relay: string; name: string }

/** Null unless `value` is a list of PCs whose ids derive from their keys (docs/account.md, "Introductions"). */
export function parseIntroducedPcs(value: unknown): IntroducedPc[] | null {
  if (!Array.isArray(value) || value.length > MAX_PCS) return null;
  const pcs: IntroducedPc[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { server_id, server_public_key, relay, name } = entry as Record<string, unknown>;
    if (typeof server_id !== "string" || typeof server_public_key !== "string" || typeof relay !== "string" || typeof name !== "string") return null;
    if (name.length < 1 || name.length > 48 || !isWssOrigin(relay)) return null;
    try { if (deriveServerId(importPublicKey(server_public_key)) !== server_id) return null; } catch { return null; }
    pcs.push({ server_id, server_public_key, relay, name });
  }
  return pcs;
}

/** The PCs a member introduced to a newly added device, by its key: in memory only, for ten minutes. */
export class AccountIntroductions {
  private readonly waiting = new Map<string, { pcs: IntroducedPc[]; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  set(key: string, pcs: IntroducedPc[]): void {
    this.prune();
    this.waiting.set(key, { pcs, expires: this.now() + INTRODUCTION_TTL_MS });
  }

  get(key: string): IntroducedPc[] | null {
    this.prune();
    return this.waiting.get(key)?.pcs ?? null;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, { expires }] of this.waiting) if (now >= expires) this.waiting.delete(key);
  }
}
