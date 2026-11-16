/**
 * The first-run setup guide's opener: the guide listens, and Settings → Agents' Setup guide and the sidebar's
 * Setup: N left row ask. A request is a window event, so the page that opens it needs no handle on the
 * component that draws it.
 */
import type { GuideState } from "./setupGuideFlow.ts";

const OPEN_EVENT = "ovis:open-setup-guide";

/** Opens the setup guide again, at its first step or at `at`; what was set up before stays as it is. */
export function openSetupGuide(at?: GuideState["at"]): void {
  window.dispatchEvent(new CustomEvent<GuideState["at"]>(OPEN_EVENT, { detail: at }));
}

/** Calls `listener` on every request to open the guide, with the step asked for; returns the unsubscribe. */
export function onSetupGuideRequest(listener: (at: GuideState["at"]) => void): () => void {
  const handle = (event: Event): void => listener(event instanceof CustomEvent && (event.detail === "theme" || event.detail === "phone") ? event.detail : undefined);
  window.addEventListener(OPEN_EVENT, handle);
  return () => window.removeEventListener(OPEN_EVENT, handle);
}
