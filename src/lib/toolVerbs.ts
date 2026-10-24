import { patchFiles, patchText } from "../../shared/patch.ts";
import { execSummary } from "../../shared/execSummary.ts";

export type ToolVerbKind = "read" | "edit" | "write" | "run";

/** What a work row says the call did, before its object: "Read src/a.ts", "Ran bun test". */
const VERB_LABEL: Record<ToolVerbKind, string> = {
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  run: "Ran",
};

/**
 * The tool ids a verb stands for, by exact name (case aside): Claude's Read / Edit / MultiEdit /
 * NotebookEdit / Write / Bash, Codex's exec / exec_command / shell / local_shell / apply_patch,
 * and the lowercase read / edit / write / bash / patch of pi, omp, gjc and omo. Anything else
 * (Grep, a web or task tool, a todo or goal call, an MCP tool) keeps its own name: a guess by
 * substring would call `mcp__files__read_all` a read.
 */
const VERB_OF: Record<string, ToolVerbKind> = {
  read: "read",
  edit: "edit", multiedit: "edit", notebookedit: "edit", apply_patch: "edit", patch: "edit",
  write: "write",
  bash: "run", exec: "run", exec_command: "run", shell: "run", shell_command: "run", local_shell: "run",
};

/** The input fields a verb's object can be: a run's command, a file call's path. */
const OBJECT_KEYS: Record<ToolVerbKind, readonly string[]> = {
  read: ["file_path", "path"],
  edit: ["file_path", "notebook_path", "path"],
  write: ["file_path", "path"],
  run: ["cmd", "command"],
};

/** The server cuts a row's summary to this many characters. */
const SUMMARY_LENGTH = 120;

/** The kind of verb a tool id reads as, or null for a tool the table does not know. */
export function toolVerbKind(name: string, input = ""): ToolVerbKind | null {
  const key = name.toLowerCase();
  if (!Object.hasOwn(VERB_OF, key)) return null;
  const kind = VERB_OF[key]!;
  // Codex applies a patch from inside an exec script: the row names the files, so it is an edit.
  // The patch is found by its text, so a `tools.apply_patch("…")` the script only quotes or
  // comments out reads as an edit too, as it already does in the row's file list and diff.
  return kind === "run" && patchText(input) !== null ? "edit" : kind;
}

/**
 * Whether a row's summary is the thing the call acted on: its command or path, or the files of
 * its patch. omp sums a call up by its `intent` ("Checking ports") instead, and a verb in front
 * of that sentence would read "Ran Checking ports".
 */
function isObjectOf(kind: ToolVerbKind, input: string, object: string): boolean {
  const patch = patchText(input);
  if (patch !== null && patchFiles(patch).join(", ").slice(0, SUMMARY_LENGTH) === object) return true;
  if (kind === "run" && execSummary(input) === object) return true;
  let args: unknown;
  try { args = JSON.parse(input); } catch { return false; }
  if (typeof args !== "object" || args === null) return false;
  return OBJECT_KEYS[kind].some((key) => {
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" && value.slice(0, SUMMARY_LENGTH) === object;
  });
}

/** The input fields an agent says a call's purpose in: OmO's eval, Claude's Bash and subagents, omp. */
const NARRATION_KEYS = ["summary", "description", "intent"] as const;

/**
 * Whether a row's summary is the agent's own sentence about the call ("Run the unit tests")
 * rather than its command or path. Such a row says the sentence alone: the tool id in front of
 * it ("eval Run the unit tests") tells the reader nothing, and stays in the title and the detail.
 */
export function isToolNarration(part: { name: string; input: string }, summary: string): boolean {
  if (summary.trim().length === 0 || summary === part.name) return false;
  let args: unknown;
  try { args = JSON.parse(part.input); } catch { return false; }
  if (typeof args !== "object" || args === null) return false;
  return NARRATION_KEYS.some((key) => {
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim().slice(0, SUMMARY_LENGTH) === summary;
  });
}

/**
 * The English verb (an i18n key) a row shows in place of the tool id, or null when the id stays:
 * an unknown tool, a call with no object to follow the verb, or a summary that is not the call's
 * own command or path.
 */
export function toolVerb(part: { name: string; input: string }, object: string): string | null {
  if (object.trim().length === 0 || object === part.name) return null;
  const kind = toolVerbKind(part.name, part.input);
  return kind !== null && isObjectOf(kind, part.input, object) ? VERB_LABEL[kind] : null;
}
