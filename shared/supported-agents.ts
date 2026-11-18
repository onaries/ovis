/**
 * herdr's manifests name more; any of those still runs from a pane's shell.
 *
 * Its own file: the browser imports the value, and shared/protocol.ts reads `process.env` as it loads.
 */
export const SUPPORTED_AGENT_KINDS: ReadonlySet<string> = new Set(["claude", "codex", "copilot", "omp", "omo", "gjc", "pi", "opencode", "devin", "grok", "hermes", "agy", "letta", "dsh-tui"]);
