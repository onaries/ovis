/**
 * Signing in from the desktop app (app/electron/src/accountSignIn.ts): the app names the account
 * service and carries the provider's return from the system browser over its loopback server; the
 * page finishes the sign-in itself with the PKCE verifier it kept, as a browser tab does.
 */
import { beginSignIn, finishOwnSignIn } from "./signin.ts";
import { ACCOUNT_PROVIDERS } from "./store.ts";
import type { AccountProvider, AccountSession, AccountStore } from "./store.ts";

/** What the desktop app's preload offers its server's pages, when it names an account service. */
export interface DesktopAccountBridge {
  readonly service: string;
  /** the sign-ins the service offers; GitHub alone when none is named */
  readonly providers?: readonly string[];
  /** a loopback redirect for one sign-in */
  start(): Promise<string>;
  /** opens the sign-in in the system browser; resolves with the callback's query */
  open(url: string): Promise<string>;
}

export function desktopAccount(): DesktopAccountBridge | null {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisAccount?: Partial<DesktopAccountBridge> }).ovisAccount;
  return bridge && typeof bridge.service === "string" && typeof bridge.start === "function" && typeof bridge.open === "function"
    ? bridge as DesktopAccountBridge : null;
}

/** The sign-ins the desktop app was built to offer: GitHub alone unless it names Google or Apple too. */
export function desktopProviders(bridge: DesktopAccountBridge): AccountProvider[] {
  const offered = ACCOUNT_PROVIDERS.filter((provider) => bridge.providers?.includes(provider));
  return offered.length > 0 ? offered : ["github"];
}

/** `link`: adds the provider to the signed-in account (AccountService.addMethod), redeemed with its access token. */
export async function desktopSignIn(provider: AccountProvider, bridge: DesktopAccountBridge, store: AccountStore, link?: { linkToken: string; bearer: string }): Promise<AccountSession> {
  const redirectUri = await bridge.start();
  const url = await beginSignIn(provider, { store, service: bridge.service, redirectUri, ...(link ? { linkToken: link.linkToken } : {}) });
  return finishOwnSignIn(url, await bridge.open(url), { store, ...(link ? { bearer: link.bearer } : {}) });
}
