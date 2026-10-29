import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { environmentHome } from "./user-home.ts";

export interface OmoStateOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}

export const OMO_RUNNING: ReadonlySet<string> = new Set(["pending", "running"]);

/** OmO hashes the canonical session cwd, not the pane's display path. */
export function projectStateKey(projectDir: string): string {
  let absolute = resolve(projectDir);
  try { absolute = realpathSync.native(absolute); } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
  }
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  const name = basename(absolute).replace(/[^\p{L}\p{N}._-]/gu, "_") || "root";
  return `${name}-${hash}`;
}

const gone = (error: unknown): boolean => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

/** As OmO decides it: anything it cannot read as an empty tree holds records, so the legacy store is never passed over. */
function holdsRecords(path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return true;
    return readdirSync(path, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() && !entry.name.includes(".") ? holdsRecords(join(path, entry.name)) : true);
  } catch (error) { return !gone(error); }
}

/**
 * Read-only counterpart of OmO's project state directory rule: populated legacy directories
 * (including a .in-project marker) win; empty scaffolding does not. task.state_dir config
 * overrides are out of scope: this bridge does not load OmO's session configuration.
 */
export function omoStateDir(cwd: string, options: OmoStateOptions = {}): string {
  const inProject = join(resolve(cwd), ".omo", "senpi-task");
  if (existsSync(inProject) && holdsRecords(inProject)) return inProject;
  const env = options.env ?? process.env;
  let agentDir: string | undefined;
  for (const name of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) {
    const value = env[name]?.trim();
    if (value) { agentDir = resolve(value); break; }
  }
  agentDir ??= join(environmentHome(env) || options.home || homedir(), ".omo", "agent");
  return join(agentDir, "projects", projectStateKey(cwd), "senpi-task");
}
