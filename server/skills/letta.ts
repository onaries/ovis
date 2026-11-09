import { existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { CommandForm, SlashCommand } from "../../shared/protocol.ts";
import type { AgentCommandSource } from "./index.ts";
import { createWalkBudget, environValue, walkSkills } from "./walk.ts";

/**
 * Letta Code 0.34.44: the commands of its own registry (src/cli/commands/registry.ts, the same list from
 * 0.34.41 to upstream main at 0.34.45), with its descriptions. The ones it marks `hidden` stay out of its menu but still run when typed.
 */
const descriptions = {
  agents: "Browse agents (pinned, Letta Code, all)",
  model: "Switch model",
  init: "Initialize (or re-init) your agent's memory",
  doctor: "Investigate an agent issue in this conversation",
  memory: "View your agent's memory",
  search: "Search messages across all agents (/search [query])",
  sleeptime: "Configure sleep-time reflection trigger and merge settings",
  compaction: "Configure compaction mode settings",
  "context-limit": "Set or reset the max context window",
  palace: "Open the Memory Palace in your browser",
  connect: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
  clear: "Clear in-context messages",
  chdir: "Change working directory for this TUI session (/chdir <path>)",
  resume: "Resume a previous conversation",
  new: "Start a new conversation (keep agent memory)",
  fork: "Fork the current conversation",
  btw: "Fork conversation and ask a side question (/btw <question>)",
  pin: "Pin current agent (/pin [name])",
  unpin: "Unpin current agent",
  rename: "Rename agent or conversation (/rename agent [name]|convo [name])",
  description: "Update the current agent's description (/description <text>)",
  toolset: "Switch toolset (replaces /link and /unlink)",
  experiments: "Toggle experiments",
  reload: "Reload settings and local mods",
  mods: "Run mod learning targets",
  memfs: "Manage filesystem-backed memory (/memfs [enable|sync|reset])",
  skills: "Browse available skills",
  ade: "Open agent in ADE (browser)",
  "skill-creator": "Enter skill creation mode (/skill-creator [description])",
  system: "Switch system prompt",
  personality: "Switch personality",
  subagents: "Manage custom subagents",
  mcp: "Manage MCP servers (add, connect with OAuth)",
  secret: "Manage secrets for shell commands",
  usage: "Show session usage statistics and balance",
  "memory-repository": "Push this agent's memory repo to an additional git remote",
  context: "Show context window usage",
  recompile: "Recompile current agent + conversation (warning: this will evict the cache and increase costs)",
  feedback: "Send feedback to the Letta team",
  hooks: "Manage hooks configuration",
  statusline: "Customize the bottom statusline",
  title: "Configure terminal window title",
  "reasoning-tab": "Toggle Tab shortcut for reasoning tiers (/reasoning-tab on|off|status)",
  "system-reminders": "Show or hide system reminders",
  terminal: "Setup terminal shortcuts [--revert]",
  "install-github-app": "Setup Letta Code GitHub Action in this repo",
  bg: "Show background shell processes",
  workflows: "Show workflow runs, their agents, and token usage",
  exit: "Exit this session",
  login: "Sign in with Letta",
  logout: "Clear saved credentials and exit",
  dream: "Reflect on memory (alias for /reflect; Cloud reflects this conversation)",
  reflect: "Launch reflection (/reflect [--recent N | --conversation ID ... | --auto] [--instruction TEXT])",
  "reflect-arena": "Experimental blind A/B reflection model comparison",
  compact: "Summarize conversation history (compaction) with optional mode",
  reflection: "Alias for /reflect",
  "clear-messages": "Reset all agent messages (destructive)",
  cd: "Alias for /chdir",
  help: "Show available commands",
  stream: "Toggle token streaming on/off",
  "set-max-context": "Alias for /context-limit",
  link: "Attach all Letta Code tools to agent (deprecated, use /toolset instead)",
  unlink: "Remove all Letta Code tools from agent (deprecated, use /toolset instead)",
  pinned: "Browse pinned agents",
  profiles: "Browse pinned agents",
} as const;
const agentHidden = ["reflection", "clear-messages", "cd", "help", "stream", "set-max-context", "link", "unlink", "pinned", "profiles"] as const;

/**
 * Sent bare, these open one of Letta's own panels, pickers or a browser page and wait there for
 * keys (their handlers say so: "Opening …", or App.tsx draws an overlay). `/login`, `/logout` and
 * `/exit` sign in, sign out or end the session. `/model` opens its model picker, which Chat
 * answers from a card (dialogs/letta.ts). `/feedback` opens its dialog with or without a message.
 */
const terminalBare = [
  "agents", "skills", "memory", "palace", "sleeptime", "compaction", "connect", "toolset", "system",
  "personality", "subagents", "hooks", "title", "experiments", "ade", "resume", "search", "mcp", "pin",
  "help", "install-github-app", "login", "logout", "exit", "pinned", "profiles",
] as const;
const forms: Record<string, CommandForm[]> = {
  ...Object.fromEntries(terminalBare.map((name) => [
    name, [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "unknown" }],
  ])),
  feedback: [{ match: "bare", interaction: "terminal" }, { match: "other", interaction: "terminal" }],
  model: [{ match: "bare", interaction: "dialog", dialog: "letta-model" }],
};

/** a skill named like a builtin is left out of the menu, as Letta's own leaves it out (SlashCommandAutocomplete.tsx) */
const builtinNames: ReadonlySet<string> = new Set(Object.keys(descriptions));
const isDirectory = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };

/**
 * The skills Letta's `/` menu lists, by the rules of its discovery (src/agent/skills.ts): a
 * SKILL.md anywhere under a root, also below another skill's folder, named by its frontmatter `id`,
 * else `name`, else its folder's path under the root (`root` for one right in the root); a later root wins over an earlier one for the same name; a skill with
 * `user-invocable: false` is left out, and so is one named like a builtin. The roots, lowest
 * first: `<config dir>/skills` (`LETTA_CONFIG_DIR`, else `~/.letta`), then the project's
 * `.skills` and `.agents/skills`. Letta's bundled skills and the agent's own memory skills are
 * not read here: their folders are the installed package's and the agent's, which the pane's
 * folder does not name.
 */
export const source: AgentCommandSource = {
  builtins: Object.keys(descriptions).filter((name) => !(agentHidden as readonly string[]).includes(name)),
  descriptions,
  pin: "0.34.44",
  agentHidden,
  forms,
  discover({ home, cwd, env }) {
    const override = environValue(env, "LETTA_CONFIG_DIR")?.trim();
    const config = override ? override : join(home, ".letta");
    const roots: [string, SlashCommand["origin"]][] = [
      [join(config, "skills"), "user"],
      ...(cwd ? [[join(cwd, ".skills"), "project"], [join(cwd, ".agents", "skills"), "project"]] as [string, SlashCommand["origin"]][] : []),
    ];
    const budget = createWalkBudget();
    const found = new Map<string, SlashCommand | null>();
    for (const [root, origin] of roots) {
      if (!existsSync(root) || !isDirectory(root)) continue;
      for (const skill of walkSkills(root, { depth: "recursive", looseMarkdown: "none", ignoreFiles: false, requireDescription: false, belowSkills: true, budget })) {
        const field = (key: string): string => typeof skill.fields[key] === "string" ? (skill.fields[key] as string).trim() : "";
        const folder = relative(root, join(skill.path, "..")).split(sep).join("/");
        // a SKILL.md right in the root has no folder: Letta names it "root"
        const name = field("id") || field("name") || folder || "root";
        if (!/^\S+$/.test(name)) continue;
        const flag = skill.fields["user-invocable"];
        const invocable = flag !== false && !(typeof flag === "string" && flag.trim().replace(/^(["'])(.*)\1$/, "$2").toLowerCase() === "false");
        found.delete(name);
        found.set(name, invocable && !builtinNames.has(name) ? { name, description: skill.description, source: "skill", origin, id: skill.id } : null);
      }
    }
    return [...found.values()].filter((command): command is SlashCommand => command !== null);
  },
};
