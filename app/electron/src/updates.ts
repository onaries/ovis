/**
 * Whether the app updates itself, and from where. A packaged build does when it was built with a
 * feed (OVIS_UPDATE_FEED at build time writes electron-builder's app-update.yml); OVIS_UPDATE_URL
 * only replaces that feed, since electron-updater reads app-update.yml again when it downloads. A
 * development run never updates, and OVIS_UPDATES=0 turns it off. On Linux
 * the AppImage replaces itself, and a .deb install (electron-builder's `package-type` file in the
 * resources says `deb`) installs the downloaded .deb with apt-get behind the system's password prompt.
 *
 * The beta channel (the same setting as the server's: OVIS_UPDATE_CHANNEL, or `beta` in the
 * `update-channel` file of the server's state dir) takes the beta builds CI publishes from green
 * main (.github/workflows/beta.yml) from BETA_FEED instead. It is read when the app starts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppUpdater } from "electron-updater";
import { readUpdateChannel, type UpdateChannel } from "../../../shared/update.ts";

type Env = Record<string, string | undefined>;

/** The rolling `desktop-beta` prerelease the beta workflow uploads each beta build and its feed files to. */
export const BETA_FEED = "https://github.com/devswha/ovis/releases/download/desktop-beta";
/** The setting file in the server's state dir, the one server/updater.ts reads (UPDATE_CHANNEL_FILE). */
const CHANNEL_FILE = "update-channel";

/** which electron-updater class installs the update; "default" is its own pick for the platform */
export type Installer = "default" | "appimage" | "deb";

export type UpdatePlan = { enabled: false; reason: string } | { enabled: true; feed: string | null; channel: UpdateChannel; installer: Installer };

/**
 * How a downloaded .deb is installed (as root, behind the password prompt): apt-get resolves its
 * dependencies in the same command, fails when it did not install, and with --no-remove stops
 * rather than remove another package. No --allow-* flags: the feed only ever offers a newer
 * version, and a local file needs no repository signature.
 *
 * `file` is electron-updater's installerPath, escaped for one shell except for `'`. Behind the
 * prompt (`prompted`) it runs the command as `bash -c '<command>'`, where a `'` would end the
 * quotes: it goes in as `\'\''`. Run as root, one shell reads the command, and `\'` is enough.
 */
export function debInstallCommand(file: string, prompted: boolean): string[] {
  return ["apt-get", "install", "-y", "--no-remove", file.replace(/'/g, prompted ? "\\'\\''" : "\\'")];
}

/** OVIS_UPDATE_CHANNEL when it names a channel, else the state dir's `update-channel` file, else stable. */
export function updateChannel(env: Env, stateDir: string): UpdateChannel {
  const set = readUpdateChannel(env["OVIS_UPDATE_CHANNEL"]);
  if (set) return set;
  try { return readUpdateChannel(readFileSync(join(stateDir, CHANNEL_FILE), "utf8")) ?? "stable"; }
  catch { return "stable"; }
}

export function updatePlan(options: { packaged: boolean; env: Env; platform: string; builtWithFeed: boolean; channel?: UpdateChannel; linuxPackage?: string | null; execPath?: string }): UpdatePlan {
  const { env } = options;
  const channel = options.channel ?? "stable";
  if (["0", "false", "off", "no"].includes(env["OVIS_UPDATES"]?.trim().toLowerCase() ?? "")) return { enabled: false, reason: "turned off with OVIS_UPDATES" };
  if (!options.packaged) return { enabled: false, reason: "a development run" };
  let installer: Installer = "default";
  if (options.platform === "linux") {
    // chosen here, not by electron-updater: it goes by the package-type file alone, and electron-builder
    // writes that file into the folder the AppImage is also built from (whether the AppImage gets it
    // depends on which target builds first). An AppImage only when this program runs from its mount:
    // APPIMAGE alone may be left over from another AppImage that started this one, and the
    // AppImage updater would overwrite that file.
    // (an APPDIR of / would contain every program)
    const mount = env["APPDIR"]?.replace(/\/+$/, "");
    if (env["APPIMAGE"] && mount && options.execPath?.startsWith(`${mount}/`)) installer = "appimage";
    else if (options.linuxPackage === "deb") installer = "deb";
    else return { enabled: false, reason: "only the AppImage and the .deb install update themselves" };
  }
  // without app-update.yml electron-updater finds an update but fails to download it
  if (!options.builtWithFeed) return { enabled: false, reason: "this build has no update feed" };
  const override = env["OVIS_UPDATE_URL"]?.trim();
  if (override) {
    let url: URL;
    try { url = new URL(override); } catch { return { enabled: false, reason: `OVIS_UPDATE_URL is not an address: ${override}` }; }
    if (url.protocol !== "https:") return { enabled: false, reason: "OVIS_UPDATE_URL must be an https address" };
    return { enabled: true, feed: url.href, channel, installer };
  }
  // the beta workflow builds no Windows app yet, so its feed has none: Windows stays on the release
  // feed and its stable channel (latest.yml), since the release publishes no beta.yml
  if (channel === "beta" && options.platform === "win32") return { enabled: true, feed: null, channel: "stable", installer };
  return { enabled: true, feed: channel === "beta" ? BETA_FEED : null, channel, installer };
}

/**
 * One check of the feed, as the app runs it after it starts and every 6 hours. A failed check is
 * logged. A newer version found starts its download, whose failure the updater's error event already
 * reports (a cancelled one is no error): the promise of that download is only caught, where left alone
 * it was logged a second time as an unhandled rejection (#2831).
 */
export async function checkForUpdates(updater: Pick<AppUpdater, "checkForUpdates">, log: (line: string) => void): Promise<void> {
  const result = await updater.checkForUpdates().catch((error: unknown) => {
    log(`Update check failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  result?.downloadPromise?.catch(() => {});
}
