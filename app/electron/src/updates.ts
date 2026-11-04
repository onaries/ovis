/**
 * Whether the app updates itself, and from where. A packaged build does when it was built with a
 * feed (OVIS_UPDATE_FEED at build time writes electron-builder's app-update.yml) or is started
 * with OVIS_UPDATE_URL; a development run never does, and OVIS_UPDATES=0 turns it off.
 */
type Env = Record<string, string | undefined>;

export type UpdatePlan = { enabled: false; reason: string } | { enabled: true; feed: string | null };

export function updatePlan(options: { packaged: boolean; env: Env; platform: string; builtWithFeed: boolean }): UpdatePlan {
  const { env } = options;
  if (["0", "false", "off", "no"].includes(env["OVIS_UPDATES"]?.trim().toLowerCase() ?? "")) return { enabled: false, reason: "turned off with OVIS_UPDATES" };
  if (!options.packaged) return { enabled: false, reason: "a development run" };
  // electron-updater replaces only an AppImage on Linux
  if (options.platform === "linux" && !env["APPIMAGE"]) return { enabled: false, reason: "only the AppImage updates itself" };
  const override = env["OVIS_UPDATE_URL"]?.trim();
  if (override) {
    let url: URL;
    try { url = new URL(override); } catch { return { enabled: false, reason: `OVIS_UPDATE_URL is not an address: ${override}` }; }
    if (url.protocol !== "https:") return { enabled: false, reason: "OVIS_UPDATE_URL must be an https address" };
    return { enabled: true, feed: url.href };
  }
  if (options.builtWithFeed) return { enabled: true, feed: null };
  return { enabled: false, reason: "this build has no update feed" };
}
