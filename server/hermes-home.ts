import { existsSync } from "node:fs";
import { join } from "node:path";

import { userHome } from "./user-home.ts";

/**
 * Where Hermes keeps its data when HERMES_HOME is unset, as the pinned 0.21.5 decides it (upstream
 * 354724fb, hermes_constants._get_platform_default_hermes_home): `~/.hermes`, and on Windows
 * `%LOCALAPPDATA%\hermes` (`<home>\AppData\Local\hermes` without LOCALAPPDATA). Earlier Windows
 * builds kept it in `%USERPROFILE%\.hermes`, which upstream still lists as the legacy root: that one
 * is taken only while it holds a session database and the current root does not.
 */
export function platformHermesHome(home = userHome(), env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string {
  if (platform !== "win32") return join(home, ".hermes");
  const current = join(env["LOCALAPPDATA"]?.trim() || join(home, "AppData", "Local"), "hermes");
  const legacy = join(home, ".hermes");
  return !exists(join(current, "state.db")) && exists(join(legacy, "state.db")) ? legacy : current;
}

/** HERMES_HOME when set, otherwise Hermes's own platform default. */
export function hermesHome(home = userHome(), env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string {
  return env["HERMES_HOME"] || platformHermesHome(home, env, platform, exists);
}
