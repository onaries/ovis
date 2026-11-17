/**
 * The desktop app's `ovis://open` links (app/electron/src/openLink.ts): its preload tells the server's
 * page the query of the place a link names, in the deep link's own names (`ovisLink`,
 * app/electron/src/preload.ts), and the page lands it as its own address's link lands
 * (lib/notificationTarget.ts linkLanding, lib/deepLink.ts resolveLink). A browser tab has no such bridge.
 */

/** What the desktop app's preload offers its server's page. */
export type DesktopLinks = { onOpen(listener: (query: string) => void): void };

export function desktopLinks(): DesktopLinks | undefined {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisLink?: Partial<DesktopLinks> }).ovisLink;
  return typeof bridge?.onOpen === "function" ? bridge as DesktopLinks : undefined;
}
