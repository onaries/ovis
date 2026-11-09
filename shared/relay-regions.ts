/**
 * Ovis's own relay endpoints. A PC that names no relay of its own stays connected to the global
 * one and, when a regional one answers much faster, also to that one and puts it in new pairing
 * offers (server/relay/service.ts). A phone whose saved relay is one of the regional ones falls
 * back to the global one when it cannot get through (src/lib/relay/transport.ts). The browser
 * imports this file, so it reads no environment.
 */
export const GLOBAL_RELAY = "wss://relay.ovis.sh";

/** Ovis's relay in Seoul: shown by its place where a connection names its way (src/components/ConnectionLine.tsx). */
export const SEOUL_RELAY = "wss://relay-ap.ovis.sh";

export const REGIONAL_RELAYS: readonly string[] = [SEOUL_RELAY];

/** The relay to try when `relay` does not get through, or null: only Ovis's regional relays fall back. */
export function relayFallback(relay: string, regional: readonly string[] = REGIONAL_RELAYS): string | null {
  return regional.includes(relay) ? GLOBAL_RELAY : null;
}

/** The hosted app's address, and its copy served beside each regional relay (relay/shell-mirror.ts). */
export const GLOBAL_APP = "https://app.ovis.sh";
export const REGIONAL_APPS: Readonly<Record<string, string>> = { "wss://relay-ap.ovis.sh": "https://app-ap.ovis.sh" };

/**
 * Where a browser that opened a pairing link on `app.ovis.sh` should open it instead: the regional
 * copy of the app beside the regional relay the link names, or null. Only a link with a pairing
 * code moves, since a phone keeps a PC's key in the origin it paired on and a saved PC has none in
 * the other; the native apps, which allow `app.ovis.sh` only, stay. Run by the page's first
 * script, before the app's bundle loads (src/theme-bootstrap.ts), so it parses no more than it needs.
 */
export function regionalAppUrl(location: { origin: string; pathname: string; hash: string }, nativeApp: boolean): string | null {
  if (nativeApp || location.origin !== GLOBAL_APP || !location.hash.startsWith("#offer=") || !/^\/s\/[0-9a-f]{32}\/$/.test(location.pathname)) return null;
  try {
    const offer: unknown = JSON.parse(atob(location.hash.slice("#offer=".length).replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof offer !== "object" || offer === null) return null;
    const { relay, code } = offer as { relay?: unknown; code?: unknown };
    const app = typeof relay === "string" && typeof code === "string" ? REGIONAL_APPS[relay] : undefined;
    return app === undefined ? null : app + location.pathname + location.hash;
  } catch { return null; }
}

/**
 * Whether `app` serves the same build as `app.ovis.sh` right now: a regional copy that is down,
 * still empty or a release behind is not moved to, and pairing goes on where it is.
 */
export async function regionalAppReady(app: string, fetcher: typeof fetch = fetch, timeoutMs = 3000): Promise<boolean> {
  const revision = async (origin: string): Promise<string | null> => {
    const response = await fetcher(`${origin}/build.json`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    const body: unknown = response.ok ? await response.json() : null;
    const value = typeof body === "object" && body !== null ? (body as { revision?: unknown }).revision : undefined;
    return typeof value === "string" ? value : null;
  };
  try {
    const [here, there] = await Promise.all([revision(GLOBAL_APP), revision(app)]);
    return here !== null && here === there;
  } catch { return false; }
}

/**
 * The relay a phone saves for a PC that named `hints` in AUTH_OK (the preferred one first): only
 * one of Ovis's own relays, and only in place of one of Ovis's own, so a self-hosted relay is never
 * traded and a PC can only move its phones between Ovis's relays.
 */
export function hintedRelay(saved: string, hints: readonly string[] | undefined, regional: readonly string[] = REGIONAL_RELAYS): string {
  const ours = (relay: string): boolean => relay === GLOBAL_RELAY || regional.includes(relay);
  const preferred = hints?.[0];
  return preferred !== undefined && ours(saved) && ours(preferred) ? preferred : saved;
}
