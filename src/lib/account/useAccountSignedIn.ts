import { useEffect, useState } from "react";
import { indexedAccountStore } from "./store.ts";

/** The account this browser is signed in to, or null: the account's actions show only for its own rows. */
export function useAccountSignedIn(): string | null {
  const [signedIn, setSignedIn] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    indexedAccountStore.get("session").then((session) => { if (live) setSignedIn(session?.account ?? null); }, () => undefined);
    return () => { live = false; };
  }, []);
  return signedIn;
}
