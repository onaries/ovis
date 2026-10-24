import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import { source as omo } from "./omo.ts";
import { source as claude } from "./claude.ts";
import { source as codex } from "./codex.ts";
import { source as pi } from "./pi.ts";
import { source as cmd } from "./cmd.ts";
import { source as omp } from "./omp.ts";
import { source as gjc } from "./gjc.ts";
import { source as opencode } from "./opencode.ts";
import { source as devin } from "./devin.ts";
import { source as grok } from "./grok.ts";
import { source as hermes } from "./hermes.ts";
import { source as agy } from "./agy.ts";
import { source as dsh } from "./dsh.ts";

export interface ProcessRoots {
  readonly agentDir?: string | null;
  readonly pluginDir?: string | null;
  readonly environ?: readonly string[] | null;
}
export interface AgentCommandContext {
  readonly home: string;
  readonly cwd: string | null | undefined;
  readonly repoRoot: string | null;
  readonly env: readonly string[] | null;
  readonly roots: ProcessRoots;
  /** the running agent's version, read from its own store; null or absent when unknown */
  readonly version?: string | null;
}
export interface AgentCommandSource {
  readonly builtins: readonly string[];
  readonly descriptions?: Readonly<Record<string, string>>;
  readonly discover: (ctx: AgentCommandContext) => SlashCommand[];
  /** how each builtin behaves per typed form; a name without an entry is `[{ match: "bare", interaction: "unknown" }]` */
  readonly forms?: Record<string, CommandForm[]>;
  /** builtins that only work in the terminal: listed with visibility `terminal` */
  readonly terminalBound?: readonly string[];
  /** builtins the agent's own menu hides: listed with visibility `agent-hidden`, still sent when typed */
  readonly agentHidden?: readonly string[];
  /** the agent version the builtin list was checked against (compared by major.minor); one per TUI when the agent ships two */
  readonly pin?: string | readonly string[];
  /** a skill or custom command named like a builtin replaces it when typed the same way */
  readonly skillsOverrideBuiltins?: boolean;
}
/** omo loads the first skill of a name, in root order (its own, ~/.agents, then the bundled one). */
const omoFirstByName: AgentCommandSource = {
  ...omo,
  discover(ctx) {
    const names = new Set<string>();
    return omo.discover(ctx).filter(({ name }) => !names.has(name) && Boolean(names.add(name)));
  },
};
export const AGENT_SOURCES: Record<string, AgentCommandSource> = { omo: omoFirstByName, claude, codex, pi, cmd, omp, gjc, opencode, devin, grok, hermes, agy, "dsh-tui": dsh };
