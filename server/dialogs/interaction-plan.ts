import { KEY, type AnswerStep, type ParsedPrompt } from "./shared.ts";

export interface InteractionPlan {
  /** Position after the reversible moves sent so far, in the original drawing's rows. */
  cursor: number;
  moves(answer: number): AnswerStep[];
  matches(screen: string): boolean;
  /** The irreversible step that picks the answer's row, from that answer's own key sequence. */
  commit(answer: number): AnswerStep;
  /** Whether the answer's commit has no safe key and is left to the terminal. */
  terminalFallback(answer: number): boolean;
}

/** Bind a reader's existing key sequences to its own row identity, not a card's viewport hash. */
export function pickerPlan(
  parsed: ParsedPrompt,
  read: (screen: string) => ParsedPrompt | null,
  sequences: AnswerStep[][],
  rowIdentity: (prompt: ParsedPrompt, cursor: number) => string | undefined,
): InteractionPlan {
  let seen = parsed;
  const plan: InteractionPlan = {
    cursor: parsed.selectedIndex,
    moves: (answer) => sequences[answer]?.slice(0, -1) ?? [],
    matches: (screen) => {
      const shown = read(screen);
      if (!shown || rowIdentity(shown, shown.selectedIndex) !== rowIdentity(parsed, plan.cursor)) return false;
      seen = shown;
      return true;
    },
    // Codex's footer belongs to the freshly highlighted row, not the row we started on.
    commit: (answer) => {
      const step = sequences[answer]?.at(-1) ?? { pick: true };
      return step.pick ? seen.rowKey ?? { pick: true } : step;
    },
    terminalFallback: (answer) => plan.commit(answer).pick === true,
  };
  return plan;
}

/** Reads after moves and refuses an irreversible step unless the reader still matches. */
export async function executeInteractionPlan(
  plan: InteractionPlan,
  answer: number,
  io: {
    rereadMoves: boolean;
    read(): Promise<string | null>;
    send(step: AnswerStep, commit: boolean): Promise<void>;
    /** Asking identity, checked before each move; cancellation is a separate commit guard. */
    active(): boolean;
    cancelled(): boolean;
  },
): Promise<"answered" | "prompt_changed"> {
  const matches = async (): Promise<boolean> => {
    const screen = await io.read();
    return screen !== null && plan.matches(screen);
  };
  let walked = false;
  for (const step of plan.moves(answer)) {
    if (!io.active() || (walked && io.rereadMoves && !await matches())) return "prompt_changed";
    await io.send(step, false);
    for (const key of step.keys ?? []) {
      plan.cursor = key === KEY.down || key === KEY.right ? plan.cursor + 1 : Math.max(0, plan.cursor - 1);
    }
    walked = true;
  }
  if (!await matches() || !io.active() || io.cancelled() || plan.terminalFallback(answer)) return "prompt_changed";
  await io.send(plan.commit(answer), true);
  return "answered";
}
