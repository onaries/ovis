/**
 * The hosted shell's first step, run by main.tsx in place of the app when the page is the shell
 * (lib/shellMode.ts). Light on purpose: the screens, the cryptography and the mux come in a chunk
 * of their own (lib/relay.ts loadRelayShell), after the one thing that must happen first.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { AppCrash } from "../../components/AppCrash.tsx";
import { loadRelayShell } from "../relay.ts";

interface Page {
  location: { href: string; pathname: string; search: string; hash: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
}

/**
 * The address the page loaded with, and the address bar without its fragment. The pairing offer
 * travels in the fragment, which no request carries; taking it off the address before anything
 * else runs keeps it out of the history entry, a bookmark, a shared tab and a screenshot of the
 * address bar, and a reload then lands on the saved PC instead of pairing again.
 */
export function takeEntryUrl(page: Page): string {
  const href = page.location.href;
  if (page.location.hash !== "") page.history.replaceState(null, "", page.location.pathname + page.location.search);
  return href;
}

/** `load` brings in the shell's chunk; tests hand in their own to see what boot did before it. */
export function bootRelayShell(container: HTMLElement, renderApp: () => Root, load: typeof loadRelayShell = loadRelayShell): void {
  const entryUrl = takeEntryUrl(window);
  void load().then(({ mountRelayShell }) => mountRelayShell({ container, entryUrl, renderApp })).catch((error: unknown) => {
    console.error("Ovis: the relay shell did not start", error);
    createRoot(container).render(createElement(AppCrash, { error }));
  });
}
