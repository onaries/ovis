/**
 * Signing in from a PC's own page (docs/account.md, "Signing in"): the account service cannot send
 * a sign-in back to an address it does not know, so the page uses the provider's device flow (RFC
 * 8628). It shows the provider's code, the person types it at the provider's device page
 * (github.com/login/device, google.com/device), and the page polls the service until it says yes. The sign-in is bound to a verifier that never leaves this page's
 * memory, so the device code alone redeems nothing, and a service that does not say it bound the
 * sign-in is not used.
 */
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { failure, sessionOf, type DeviceProvider } from "./service.ts";
import { SignInError } from "./signin.ts";
import { accountLock } from "./store.ts";
import type { AccountLock, AccountSession, AccountStore } from "./store.ts";

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** RFC 8628 section 3.5: each slow_down adds five seconds to the interval. */
const SLOW_DOWN_MS = 5_000;
export const GITHUB_DEVICE_PAGE = "https://github.com/login/device";
/** Each provider's own device page: the only address the page links to for typing the code. */
export const DEVICE_PAGES: Readonly<Record<DeviceProvider, string>> = { github: GITHUB_DEVICE_PAGE, google: "https://www.google.com/device" };

export interface DeviceSignIn {
  /** the code the person types at GitHub */
  readonly userCode: string;
  /** the provider's device page, and never another address */
  readonly verificationUri: string;
  /** when the code runs out, in ms since the epoch */
  readonly expiresAt: number;
  /** Polls until GitHub answers; the session is kept only if `signal` was not aborted by then. */
  finish(signal: AbortSignal): Promise<AccountSession>;
}

export interface DeviceSignInOptions {
  readonly service: string;
  readonly store: AccountStore;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  /** waits between polls; aborting `signal` ends the wait */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly lock?: AccountLock;
  /** GitHub unless named */
  readonly provider?: DeviceProvider;
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    // fixed wait: the poll interval the service sets (RFC 8628), not a guess at when something is ready
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The provider's own device page, parsed: a service that names another address is not followed there. */
function devicePage(value: unknown, provider: DeviceProvider): string {
  const own = new URL(DEVICE_PAGES[provider]);
  if (typeof value !== "string") return own.href;
  // new URL in a try: an older WebView has no URL.canParse
  try {
    const url = new URL(value);
    return url.origin === own.origin && url.pathname === own.pathname ? url.href : own.href;
  } catch (error) {
    if (error instanceof TypeError) return own.href;
    throw error;
  }
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function retryAfterMs(response: Response, fallback: number): number {
  const header = Number(response.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? Math.max(header * 1000, fallback) : fallback;
}

export async function startDeviceSignIn(options: DeviceSignInOptions): Promise<DeviceSignIn> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitFor;
  const lock = options.lock ?? accountLock;
  const provider = options.provider ?? "github";
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const response = await fetchImpl(new URL(`/v1/signin/${provider}/device`, options.service), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code_challenge: challenge, code_challenge_method: "S256" }),
  });
  if (!response.ok) throw await failure(response);
  const started: unknown = await response.json();
  const body = typeof started === "object" && started !== null ? started as Record<string, unknown> : {};
  if (body["code_challenge_method"] !== "S256") throw new SignInError("unsupported", "This account service cannot sign in a browser on a PC yet");
  const deviceCode = body["device_code"];
  const userCode = body["user_code"];
  if (typeof deviceCode !== "string" || deviceCode === "" || typeof userCode !== "string" || !/^[A-Z0-9-]{4,16}$/.test(userCode)) {
    throw new SignInError("unsupported", "The account service started no device sign-in");
  }
  const expiresAt = now() + seconds(body["expires_in"], 900) * 1000;
  const firstInterval = seconds(body["interval"], 5) * 1000;

  return {
    userCode,
    verificationUri: devicePage(body["verification_uri"], provider),
    expiresAt,
    async finish(signal) {
      let interval = firstInterval;
      let pause = interval;
      for (;;) {
        // never past the code's lifetime, however long a 429 asked to wait
        await wait(Math.min(pause, Math.max(0, expiresAt - now())), signal);
        if (now() >= expiresAt) throw new SignInError("expired", "The code ran out");
        pause = interval;
        let answer: Response;
        try {
          answer = await fetchImpl(new URL("/v1/token", options.service), {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: deviceCode, code_verifier: verifier }),
            signal,
          });
        } catch (error) {
          // offline for a moment: the code is still good, so the next poll tries again
          if (error instanceof TypeError) continue;
          throw error;
        }
        if (answer.ok) {
          const session = sessionOf(await answer.json(), options.service, now());
          // under the lock sign-out and refresh take, and never once this sign-in was cancelled
          const kept = await lock(async () => {
            if (signal.aborted) return false;
            await options.store.set("session", session);
            if (!signal.aborted) return true;
            // cancelled while it was being written: take back exactly this session, never a newer one
            await options.store.update("session", (current) => current?.refresh_token === session.refresh_token ? undefined : current);
            return false;
          });
          if (kept) return session;
          // a sign-in nobody keeps ends at the service too, so its tokens do not outlive the page
          await fetchImpl(new URL("/v1/signout", options.service), { method: "POST", headers: { authorization: `Bearer ${session.access_token}` } })
            .catch((error: unknown) => console.warn("Ovis: a cancelled sign-in was not ended at the account service", error instanceof Error ? error.name : error));
          signal.throwIfAborted();
          return session;
        }
        if (answer.status === 429) { pause = retryAfterMs(answer, interval); continue; }
        const refused = await failure(answer);
        switch (refused.code) {
          case "authorization_pending": continue;
          case "slow_down": interval += SLOW_DOWN_MS; pause = interval; continue;
          case "access_denied": throw new SignInError("denied", "The sign-in was refused at the provider");
          case "expired_token": throw new SignInError("expired", "The code ran out");
          default: throw refused;
        }
      }
    },
  };
}
