import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import type { SlashCommand } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import type { useT } from "./i18n.ts";
import { userErrorMessage } from "./userError.ts";

/** how long the agent and folder rest before their skills are asked for: a path is typed one key at a time */
export const SKILLS_MS = 300;
/**
 * The pauses before asking again while the PC answers 503 file_busy (its skill folders are slow to
 * read, #2254); after the last, the error is shown. A request the PC is still scanning for joins that
 * scan, so a later try gets its answer.
 */
export const BUSY_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
/** The longest pause a PC's Retry-After may ask for. */
const MAX_BUSY_WAIT_MS = 60_000;

/** The picked agent's skills in the folder, once listed; null while none were asked for or the answer is on its way. */
export type AgentSkills = { rows: SlashCommand[]; note: string | null } | null;

/** The skills among an agent's commands, as chips the first message takes: `$name`, `@name` or `/name`. */
function skillRows(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter((command) => command.source === "skill" && command.visibility !== "terminal");
}

/**
 * The skills `agent` would offer in `folder` before any process exists (GET /api/agent/commands), asked
 * for once the two rest for `SKILLS_MS` while `open`. A new agent, folder or closing forgets the read
 * under way, and so does a retry it was waiting to make. The setter lets the dialog clear the list at
 * once when the agent changes.
 */
export function useAgentSkills(open: boolean, agent: string, folder: string | null, fetchAgentCommands: (agent: string, cwd: string | null) => Promise<SlashCommand[]>, t: ReturnType<typeof useT>): [AgentSkills, Dispatch<SetStateAction<AgentSkills>>] {
  const [skills, setSkills] = useState<AgentSkills>(null);
  useEffect(() => {
    if (!open || agent === "") return;
    let cancelled = false;
    let tries = 0;
    const ask = (): void => {
      void fetchAgentCommands(agent, folder)
        .then((commands) => {
          if (!cancelled) setSkills({ rows: skillRows(commands), note: null });
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          // the PC is still reading slow skill folders (#2254): the list stays on its way and is asked
          // for again, after as long as the PC asks and no sooner than its own pause, a few times
          if (reason instanceof ApiError && reason.status === 503 && reason.code === "file_busy" && tries < BUSY_RETRY_MS.length) {
            timer = setTimeout(ask, Math.min(Math.max(BUSY_RETRY_MS[tries++]!, reason.retryAfterMs ?? 0), MAX_BUSY_WAIT_MS));
            return;
          }
          // a folder not there yet lists nothing; a PC whose bridge is from before the route cannot list
          const note = reason instanceof ApiError && reason.code === "invalid_cwd" ? t("Skills are listed once the directory exists.")
            : reason instanceof ApiError && reason.status === 404 ? t("This PC's bridge does not list skills yet.")
              : userErrorMessage(reason).message;
          setSkills({ rows: [], note });
        });
    };
    let timer = setTimeout(ask, SKILLS_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, agent, folder]);
  return [skills, setSkills];
}
