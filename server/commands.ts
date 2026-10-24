import type { CommandForm, HerdrPane, SlashCommand } from "../shared/protocol.ts";
import { AGENT_SOURCES } from "./skills/index.ts";
import type { AgentCommandSource, ProcessRoots } from "./skills/index.ts";
import { ancestorsToRepoRoot } from "./skills/walk.ts";

const DESCRIPTIONS: Record<string, string> = {
  clear: "Clear the conversation", compact: "Compact conversation context", config: "Open configuration",
  cost: "Show token usage and cost", help: "Show available commands", init: "Initialize project instructions",
  memory: "Edit agent memory", model: "Choose a model", permissions: "Manage tool permissions", review: "Review changes",
  status: "Show session status", doctor: "Check the installation", login: "Sign in", logout: "Sign out",
  "pr-comments": "Fetch pull request comments", "release-notes": "Show release notes", "terminal-setup": "Configure terminal integration",
  vim: "Toggle Vim mode", new: "Start a new session", sessions: "List sessions", exit: "Exit the agent",
  diff: "Show the current diff", quit: "Exit the agent",
  goal: "[condition|clear] — Keep working until a condition is met",
  effort: "Set effort level for model usage",
};

const UNKNOWN_FORMS: readonly CommandForm[] = [{ match: "bare", interaction: "unknown" }];

const majorMinor = (version: string | null | undefined): string | null => version?.match(/^(\d+)\.(\d+)(?:\D|$)/)?.slice(1, 3).join(".") ?? null;

function visibility(source: AgentCommandSource, name: string): NonNullable<SlashCommand["visibility"]> {
  if (source.terminalBound?.includes(name)) return "terminal";
  if (source.agentHidden?.includes(name)) return "agent-hidden";
  return "offered";
}

/** Static metadata only: safe on the delivery path, with no filesystem or process discovery. */
export function builtinCommands(agent: string | null | undefined, version?: string | null): SlashCommand[] {
  if (!agent || !Object.hasOwn(AGENT_SOURCES, agent)) return [];
  const source = AGENT_SOURCES[agent];
  if (!source) return [];
  const running = majorMinor(version);
  const verified = running !== null && [source.pin ?? []].flat().some((pin) => majorMinor(pin) === running);
  const builtinNames = [...new Set([...source.builtins, ...(source.terminalBound ?? []), ...(source.agentHidden ?? [])])];
  return builtinNames.map((name) => ({
    name, description: source.descriptions?.[name] ?? DESCRIPTIONS[name] ?? `Run /${name}`, source: "builtin",
    forms: [...(source.forms?.[name] ?? UNKNOWN_FORMS)], visibility: visibility(source, name), provenance: { transport: "static", verified },
  }));
}

const paneCatalogs = new Map<string, { identity: string; agent: string | null; commands: SlashCommand[] }>();
const catalogIdentity = (pane: HerdrPane): string => JSON.stringify([pane.terminal_id, pane.agent_session, pane.agent, pane.foreground_cwd ?? pane.cwd]);

/** Remember only catalogs already requested by the browser; never discover during a send. */
export function rememberPaneCommands(pane: HerdrPane, agent: string | null, commands: SlashCommand[]): void {
  paneCatalogs.delete(pane.pane_id);
  paneCatalogs.set(pane.pane_id, { identity: catalogIdentity(pane), agent, commands });
  if (paneCatalogs.size > 128) paneCatalogs.delete(paneCatalogs.keys().next().value!);
}

export function cachedPaneCommands(pane: HerdrPane): { agent: string | null; commands: SlashCommand[] } | undefined {
  const cached = paneCatalogs.get(pane.pane_id);
  return cached?.identity === catalogIdentity(pane) ? cached : undefined;
}

export function paneCommands(agent: string | null | undefined, cwd: string | null | undefined, home = globalThis.process.env.HOME ?? "", process: ProcessRoots = {}, version?: string | null): SlashCommand[] {
  if (!agent || !Object.hasOwn(AGENT_SOURCES, agent)) return [];
  const source = AGENT_SOURCES[agent];
  if (!source) return [];
  const builtins = new Map(builtinCommands(agent, version).map((command) => [command.name, command]));
  const ancestors = cwd ? ancestorsToRepoRoot(cwd) : [];
  const discovered = source.discover({ home, cwd, repoRoot: ancestors.at(-1) ?? null, env: process.environ ?? null, roots: process, version });
  const commands: SlashCommand[] = [];
  // one row per file: the same (trigger, name, id) reached twice, e.g. through a link; a row without an id is its own
  const seen = new Set<string>();
  for (const found of discovered) {
    const trigger = found.trigger ?? "/";
    if (found.id !== undefined) {
      const key = JSON.stringify([trigger, found.name, found.id]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const command: SlashCommand = { ...found, forms: found.forms ?? [...UNKNOWN_FORMS], visibility: found.visibility ?? "offered", provenance: found.provenance ?? { transport: "scan", verified: false } };
    // typed the same way as a builtin, a skill replaces it only where the agent says its skills win
    if (trigger === "/" && source.skillsOverrideBuiltins && builtins.delete(found.name)) command.shadows = "builtin";
    commands.push(command);
  }
  return [...builtins.values(), ...commands].sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}
