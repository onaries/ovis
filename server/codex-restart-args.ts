const values = new Set(["-c", "--config", "--enable", "--disable", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-a", "--ask-for-approval", "-C", "--cd", "--add-dir", "--remote", "--remote-auth-token-env", "--local-provider"]);
const flags = new Set(["--oss", "--strict-config", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--full-auto", "--search", "--no-alt-screen", "--no-daemon"]);
const headless = new Set(["exec", "e", "review", "app-server", "mcp", "mcp-server", "login", "logout", "queue", "help", "completion", "debug", "apply", "cloud"]);
const binary = /(?:^|[\\/])codex(?:-(?:x86_64|aarch64)-[a-z0-9_-]+)?(?:\.js|\.exe|\.opencodex-real)?$/i;

/** Keep launch settings, never an initial prompt, image, picker selection or new-worktree request. */
export function codexRestartArgs(argv: readonly string[], sessionId: string): string[] | null {
  let at = binary.test(argv[0] ?? "") ? 1
    : /(?:^|[\\/])(?:node|bun|sh|bash|dash|zsh)(?:\.exe)?$/i.test(argv[0] ?? "") && binary.test(argv[1] ?? "") ? 2 : -1;
  if (at < 0) return null;
  const kept: string[] = [];
  const positional: string[] = [];
  while (at < argv.length) {
    const word = argv[at++];
    if (word === undefined || (word === "" && at === argv.length)) continue;
    if (word === "--last" || word === "--all") continue;
    const key = word.split("=", 1)[0] ?? word;
    if (values.has(key)) {
      kept.push(word);
      if (!word.includes("=")) {
        const value = argv[at++];
        if (value === undefined || value === "") return null;
        kept.push(value);
      }
    } else if (flags.has(word)) kept.push(word);
    else if (word.startsWith("-")) return null;
    else positional.push(word);
  }
  const command = positional[0];
  if (command !== undefined && headless.has(command)) return null;
  if (positional.length > (command === "resume" || command === "fork" ? 3 : 1)) return null;
  return [...kept, "resume", sessionId];
}
