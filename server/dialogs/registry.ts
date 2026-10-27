import { isPiQuestionnaireScreen } from "./pi-questionnaire.ts";
import { readers } from "./index.ts";
import { claudeModelListWaits, CLAUDE_EFFORT_GUARD_RE } from "./claude.ts";
import { codexModelListWaits } from "./codex.ts";
import type { DialogReader, OmoAsk } from "./shared.ts";
export type { DialogReader } from "./shared.ts";

/** One read pass's view of the pane, built once per pass and never changed (onePerPass relies on it). */
export interface ReaderContext {
  readonly agent: string;
  readonly omoAsk: OmoAsk | null;
  readonly omoTrusted: boolean;
  readonly omoOpen: readonly OmoAsk[];
  readonly sent: string | null;
  readonly working: boolean;
}

export function readersFor(agent: string): readonly DialogReader[] {
  return readers.filter((reader) => reader.agents.includes(agent) || reader.agents.includes("*")).sort((a, b) => a.priority - b.priority);
}

export const registry = {
  readersFor,
  readerFor(responder: string): DialogReader | undefined {
    return readers.find((reader) => reader.id === responder);
  },
  waits(agent: string, screen: string): boolean {
    return (agent === "pi" && isPiQuestionnaireScreen(screen)) || claudeModelListWaits(screen) || claudeModelListWaits(screen, CLAUDE_EFFORT_GUARD_RE) || (agent === "codex" && codexModelListWaits(screen));
  },
};
