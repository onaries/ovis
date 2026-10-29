/**
 * The mode a new Claude Code or Codex agent starts in (Settings > Chat > New agents), as the
 * arguments herdr's `agent start` passes after `--`. "default" adds none, so the agent follows
 * its own configuration; an older agent that lacks a mode refuses to start and says why.
 *
 * Besides its mode, a launch from the new workspace and tab dialogs may name a model and an
 * effort level, turn on Claude Code's Ultracode, and start on a first prompt (#774, #1311, #2232),
 * each only where the agent's own CLI reference documents the flag or argument (launchCapabilities);
 * nothing is guessed for the rest. The bridge checks them again by the same rules
 * (shared/launch-rules.ts).
 */
import { argumentText, CLAUDE_EFFORTS, CLAUDE_ULTRACODE_SETTINGS, CODEX_EFFORTS, MODEL_NAME } from "../../shared/launch-rules.ts";

export { CLAUDE_EFFORTS, CODEX_EFFORTS };

/** Claude Code's `--permission-mode` choices; "default" leaves the flag out */
export const CLAUDE_LAUNCH_MODES = ["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"] as const;
export type ClaudeLaunchMode = (typeof CLAUDE_LAUNCH_MODES)[number];

/** Codex's `/approvals` presets, each a sandbox and an approval policy; "default" leaves both out */
export const CODEX_LAUNCH_MODES = ["default", "readOnly", "auto", "fullAccess"] as const;
export type CodexLaunchMode = (typeof CODEX_LAUNCH_MODES)[number];

const CODEX_ARGS: Record<Exclude<CodexLaunchMode, "default">, string[]> = {
  readOnly: ["--sandbox", "read-only", "--ask-for-approval", "on-request"],
  auto: ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
  fullAccess: ["--sandbox", "danger-full-access", "--ask-for-approval", "never"],
};

/** What a new agent's launch takes besides its mode, as its own CLI reference documents it. */
export interface LaunchCapabilities {
  /** a model name goes on the command line (`--model`) */
  model: boolean;
  /** the effort levels the agent names; empty: its launch takes none */
  efforts: readonly string[];
  /** Claude Code's Ultracode switch goes on the command line as one inline `--settings` object */
  ultracode: boolean;
  /**
   * the first prompt goes on the command line after an end-of-options separator, which the agent's
   * parser verifiably takes as the prompt and never as a subcommand or a flag; otherwise the bridge
   * queues the message for the agent's first ready turn (POST .../create `first_message`)
   */
  positionalPrompt: boolean;
}

const NO_CAPABILITIES: LaunchCapabilities = { model: false, efforts: [], ultracode: false, positionalPrompt: false };

const CAPABILITIES: Readonly<Record<string, LaunchCapabilities>> = {
  // `claude "query"` starts an interactive session with that prompt; `--model` takes an alias (sonnet,
  // opus, haiku) or a full name; `--effort` a level (code.claude.com/docs/en/cli-reference, 2026-10-20).
  // The prompt never goes on its command line: Claude Code's parser (commander) dispatches the first
  // operand to a subcommand of that name even after `--` (commander's parseOptions pushes what follows
  // `--` to the operands, and _parseCommand dispatches operands[0]); verified on claude 2.1.304 in an
  // isolated HOME on 2026-10-20: `claude -- update` ran the updater, while `claude -- --help` and
  // `claude -- '-p x'` were prompts. So a first message for Claude Code is the bridge's pending message.
  // Ultracode is a setting, not a level, since 2.1.284 (shared/launch-rules.ts CLAUDE_EFFORTS). Its key in
  // 2.1.311's settings schema: "Enable ultracode for the session: standing dynamic-workflow orchestration
  // at any effort level. Session-scoped — typically provided via --settings or the apply_flag_settings
  // control request; interactive toggles never persist it." `--settings <file-or-json>` reads a value that
  // starts with `{` and ends with `}` as JSON, adds it over the settings files for this session only, and
  // keeps only the last of two; nothing in Ovis or herdr passes another. Verified on 2.1.311 on 2026-10-28:
  // `claude --effort medium --settings '{"ultracode":true}'` started at medium with Ultracode on, and a
  // model or a configuration without Ultracode ignores the key without an error. On a Windows PC the bridge
  // passes the same object as a settings file's path (server/claude-settings-file.ts).
  claude: { model: true, efforts: CLAUDE_EFFORTS, ultracode: true, positionalPrompt: false },
  // `codex [OPTIONS] [PROMPT]`: "Optional user prompt to start the session" (codex-rs/tui/src/cli.rs);
  // `--model`/`-m` (codex-rs/utils/cli/src/shared_options.rs); `-c model_reasoning_effort=<level>` is
  // a config.toml override on the command line (codex-rs/utils/cli/src/config_override.rs), 2026-10-20.
  // The prompt goes after `--`: clap matches a subcommand only `if !trailing_values`, and `--` sets
  // `trailing_values = true` (clap_builder/src/parser/parser.rs, get_matches_with), so what follows is
  // the PROMPT positional whatever it says; verified on codex 0.163.0 in an isolated CODEX_HOME on
  // 2026-10-20: `codex -- logout`, `-- update`, `-- --help` and `-- '-p x'` all started the TUI, and
  // `codex -- logout extra` failed with the root `[PROMPT]` usage, `codex logout extra` with the subcommand's
  codex: { model: true, efforts: CODEX_EFFORTS, ultracode: false, positionalPrompt: true },
};

/**
 * Model names an agent documents as aliases, offered as the model field's suggestions; any other name is
 * typed. Claude Code: "a model alias such as sonnet, opus, haiku, or fable, or a model's full name"
 * (code.claude.com/docs/en/cli-reference, 2026-10-20). Codex names no alias: its models are typed whole.
 */
const MODEL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  claude: ["sonnet", "opus", "haiku"],
};

export function modelSuggestions(kind: string): readonly string[] {
  return Object.hasOwn(MODEL_ALIASES, kind) ? MODEL_ALIASES[kind]! : [];
}

/** What `kind`'s launch takes; a shell ("") and every agent without a verified flag take nothing. */
export function launchCapabilities(kind: string): LaunchCapabilities {
  return Object.hasOwn(CAPABILITIES, kind) ? CAPABILITIES[kind]! : NO_CAPABILITIES;
}

/**
 * The dialog's choices for a launch; an empty model or effort, and Ultracode off, leave it to the agent's
 * own configuration.
 */
export interface LaunchChoices {
  model?: string;
  effort?: string;
  ultracode?: boolean;
  prompt?: string;
}

/**
 * Why `choices` cannot start `kind`: the first choice the launch does not take, or null when it takes them
 * all. The dialog disables what this would refuse; the launch itself refuses it again.
 */
export function launchChoiceFault(kind: string, choices: LaunchChoices): "model" | "effort" | "ultracode" | "prompt" | null {
  const can = launchCapabilities(kind);
  const model = choices.model?.trim() ?? "";
  if (model !== "" && (!can.model || !MODEL_NAME.test(model))) return "model";
  if (choices.effort && !can.efforts.includes(choices.effort)) return "effort";
  if (choices.ultracode && !can.ultracode) return "ultracode";
  // a shell runs no agent to send a prompt to
  if ((choices.prompt?.trim() ?? "") !== "" && kind === "") return "prompt";
  return null;
}

/**
 * Where a first prompt for `kind` goes: `positional` as the agent's own argument after `--`, `pending` as
 * the create request's `first_message`, which the bridge queues for the agent's first ready turn
 * (server/core/pending.ts); null for no prompt. A prompt with a tab or a line break is no one-line
 * argument: it goes as the first message, which keeps them.
 */
export function firstPromptDelivery(kind: string, prompt: string | undefined): "positional" | "pending" | null {
  const text = prompt?.trim() ?? "";
  if (text === "" || kind === "") return null;
  return launchCapabilities(kind).positionalPrompt && argumentText(text) ? "positional" : "pending";
}

/** The arguments a new agent of `kind` starts with; undefined when there are none to add. */
export function launchArgs(kind: string, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }, choices: LaunchChoices = {}): string[] | undefined {
  const args: string[] = [];
  if (kind === "claude" && modes.claudeLaunchMode !== "default") args.push("--permission-mode", modes.claudeLaunchMode);
  if (kind === "codex" && modes.codexLaunchMode !== "default") args.push(...CODEX_ARGS[modes.codexLaunchMode]);
  const can = launchCapabilities(kind);
  const model = choices.model?.trim() ?? "";
  if (model !== "" && can.model && MODEL_NAME.test(model)) args.push("--model", model);
  if (choices.effort && can.efforts.includes(choices.effort)) {
    args.push(...(kind === "codex" ? ["-c", `model_reasoning_effort=${choices.effort}`] : ["--effort", choices.effort]));
  }
  // after the effort, which it keeps: off adds nothing, so the agent's own settings decide, as "Agent default" does
  if (choices.ultracode && can.ultracode) args.push("--settings", CLAUDE_ULTRACODE_SETTINGS);
  // the prompt last, after the end-of-options separator: nothing it says can be a flag or a subcommand there
  if (firstPromptDelivery(kind, choices.prompt) === "positional") args.push("--", choices.prompt!.trim());
  return args.length === 0 ? undefined : args;
}

/** The `agent` of a create request: the kind and the arguments its mode and choices add; null for a plain shell. */
export function launchAgent(kind: string, modes: { claudeLaunchMode: ClaudeLaunchMode; codexLaunchMode: CodexLaunchMode }, choices: LaunchChoices = {}): { kind: string; args?: string[] } | null {
  if (!kind) return null;
  const args = launchArgs(kind, modes, choices);
  return args === undefined ? { kind } : { kind, args };
}
