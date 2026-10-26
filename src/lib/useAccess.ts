
import { useCallback, useRef, useState } from "react";
import type { AccessRefusal, HealthAuth, SecuritySummary } from "../../shared/protocol.ts";
import { fetchBridgeHealth } from "./api.ts";
import { takePairCode } from "./phone.ts";
import { sameData } from "./useMachineRoster.ts";

/** What Settings → Phone & devices shows of the server's access facts: `absent` is an older server that sends none. */
export type SecurityFacts = { state: "loading" } | { state: "error" } | { state: "absent" } | { state: "known"; summary: SecuritySummary };

export function useAccessState() {
  // null until the server has said whether it wants a token: the shell, and with it
  // the WebSocket, never mounts before that is known
  const [locked, setLocked] = useState<boolean | null>(null);
  const [lockReason, setLockReason] = useState<AccessRefusal | null>(null);
  /** the code a scanned QR brought along (`?pair=CODE`), taken off the address at once */
  const [pairCode] = useState(() => takePairCode());
  const [auth, setAuth] = useState<HealthAuth | null>(null);
  const [security, setSecurity] = useState<SecurityFacts>({ state: "loading" });
  // a token a proxy sends with every request comes back right after signing out: signing out is the proxy's
  const canSignOut = auth?.authenticated === true && (auth.via === "device" || (auth.via === "token" && auth.bearer !== true));
  // a device that is in only because nothing is paired yet still pairs from the QR code's address
  const pairedFromAddress = useRef(false);
  // the newest read to settle, answer or failure, decides the facts: an older one that lands after
  // it changes nothing, and a failure clears them even while a newer read is still out
  const started = useRef(0);
  const settled = useRef(0);
  const readBridgeHealth = useCallback(async () => {
    const read = ++started.current;
    const newest = () => { if (read < settled.current) return false; settled.current = read; return true; };
    try {
      const next = await fetchBridgeHealth(); setLocked(next.auth.required && !next.auth.authenticated); setLockReason(next.auth.reason ?? null); setAuth(next.auth);
      // the bridge scope answers without herdr; a server that sends no facts is older, never "fine"
      const summary = next.security;
      if (newest()) setSecurity((previous) => summary === undefined ? (previous.state === "absent" ? previous : { state: "absent" })
        : previous.state === "known" && sameData(previous.summary, summary) ? previous : { state: "known", summary });
    }
    // retain the gate while the connection server restarts, but not the facts it last reported
    catch { if (newest()) setSecurity((previous) => previous.state === "error" ? previous : { state: "error" }); }
  }, []);
  return { locked, setLocked, lockReason, setLockReason, pairCode, auth, setAuth, canSignOut, pairedFromAddress, security, readBridgeHealth };
}

export function useLockedRef({ locked }: { locked: boolean | null }) {
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  return { lockedRef };
}
