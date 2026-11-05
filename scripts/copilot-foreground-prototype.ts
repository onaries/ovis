import { readCopilotForeground, forgetCopilotForeground } from "../server/copilot-foreground.ts";

export async function observeCopilotForeground(pid: number) {
  const result = await readCopilotForeground(pid);
  return result.state === "selected"
    ? { state: "observed" as const, sessionId: result.sessionId, authorization: "unproven" as const }
    : result;
}

if (import.meta.main) {
  try {
    const result = await observeCopilotForeground(Number(process.argv[2]));
    console.log(JSON.stringify(result.state === "observed"
      ? { state: result.state, foreground_present: true, authorization: result.authorization }
      : result));
    process.exitCode = result.state === "observed" ? 0 : 1;
  } finally { forgetCopilotForeground(); }
}
