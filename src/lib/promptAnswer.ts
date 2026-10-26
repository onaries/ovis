/**
 * A message typed in the chat while an agent's prompt waits answers that prompt,
 * the way the agent's own menu reads keys: an option's number, its label, or the
 * letter it binds ("Yes, proceed (y)"); several numbers for a multiple choice.
 * Anything else is the prompt's own "type something" answer when it has one.
 */
import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import { t } from "./i18n.ts";
import { promptWords } from "./promptText.ts";

export type TypedAnswer = Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text">;

/** The options a typed number can pick, by the number the agent shows (index + 1). */
function choices(prompt: InteractivePrompt): number[] {
  return prompt.options.flatMap((_, index) => index === prompt.custom_option_index ? [] : [index]);
}

/** "Yes, proceed (y)" binds y; "No, and tell Codex what to do differently (esc)" binds nothing typeable. */
function boundLetter(label: string): string | null {
  return label.match(/\(([a-z])\)$/i)?.[1]?.toLowerCase() ?? null;
}

function bareLabel(label: string): string {
  return label.replace(/\s*\((?:[a-z]|esc|recommended)\)$/i, "").trim().toLowerCase();
}

/** null: the prompt only takes its options, and the text names none of them. */
export function answerFromText(prompt: InteractivePrompt, text: string): TypedAnswer | null {
  const value = text.trim();
  if (!value) return null;
  const valid = choices(prompt);
  const byNumber = (token: string): number | null => {
    if (!/^\d+$/.test(token)) return null;
    const index = Number(token) - 1;
    return valid.includes(index) ? index : null;
  };
  if (prompt.multi_select) {
    const indices = value.split(/[\s,]+/).filter(Boolean).map(byNumber);
    if (indices.every((index) => index !== null)) return { option_indices: [...new Set(indices as number[])] };
    return prompt.custom_option_index !== null ? { custom_text: value } : null;
  }
  const numbered = byNumber(value);
  if (numbered !== null) return { option_index: numbered };
  const lower = value.toLowerCase();
  // a label the bridge wrote is named as the card shows it, in the user's language, or in English
  const words = promptWords(prompt);
  const names = (label: string): boolean => label.toLowerCase() === lower || bareLabel(label) === lower || boundLetter(label) === lower;
  // an option's own words first: a translated label never takes the words another option shows
  const named = valid.find((index) => names(prompt.options[index]!.label)) ?? valid.find((index) => names(words.label(index)));
  if (named !== undefined) return { option_index: named };
  return prompt.custom_option_index !== null ? { custom_text: value } : null;
}

function range(prompt: InteractivePrompt): string {
  const numbers = choices(prompt).map((index) => index + 1);
  return numbers.length > 1 ? `${numbers[0]}–${numbers.at(-1)}` : String(numbers[0] ?? 1);
}

/** Pi switches native tabs, not web-owned drafts. Keep edits visible until sent or cleared. */
export function blocksStepNavigation(prompt: InteractivePrompt, selected: ReadonlySet<number>, custom: string): boolean {
  if (prompt.agent !== "pi" || !prompt.steps?.some(step => step.can_navigate)) return false;
  return custom !== (prompt.default_custom_text ?? "") || prompt.multi_select
    && JSON.stringify([...selected].sort((a, b) => a - b)) !== JSON.stringify(prompt.default_option_indices ?? []);
}

/** How a typed message answers this prompt: the composer's placeholder while it waits. */
export function answerHint(prompt: InteractivePrompt): string {
  if (prompt.multi_select) return t("Type the numbers you choose, e.g. 1 3");
  // a free-form question (Codex's queue) has no options to number
  if (choices(prompt).length === 0) return t("Type your reply…");
  return prompt.custom_option_index !== null
    ? t("Type {range} or your own reply…", { range: range(prompt) })
    : t("Type {range} to choose…", { range: range(prompt) });
}

/** Why a message was not sent: the prompt takes only its options (answerFromText gave null). */
export function answerRefusal(prompt: InteractivePrompt): string {
  return prompt.multi_select
    ? t("Choose with the option numbers above, e.g. 1 3.")
    : t("Choose one of the options above: type {range}.", { range: range(prompt) });
}

/**
 * A typed message picking an approval's option (or a plan's, or a menu's: Claude's
 * "Review your answers" submits every answer at once, Codex's menus continue or stop)
 * could act on a stray "yes" or "1": the card asks for a tap on Confirm first. A tap on
 * an option in the card is explicit already, and a plan's own reply is feedback.
 */
export function needsConfirmation(prompt: InteractivePrompt, answer: TypedAnswer): boolean {
  return (prompt.kind === "approval" || prompt.kind === "plan" || prompt.kind === "menu") && answer.option_index !== undefined;
}

/** What pressed an answer in the card; `unknown` when the browser's click does not say. */
export type PressOrigin = "keyboard" | "mouse" | "touch" | "pen" | "unknown";

/**
 * What made the click that answered. Asked of the press itself and not of the device: a laptop
 * with a touch screen reports a fine pointer and is still tapped, and a tablet with a keyboard
 * reports a coarse one. A click names its pointer in `pointerType`, and so does the pointerdown on
 * that button before it (`downType`): a finger or a pen in either one wins, since iOS Safari has
 * called a tap's click a mouse's (WebKit bug 282988). A key's click (Enter, Space) has no pointer
 * and a `detail` of 0, and so has a script's `click()` or an assistive technology's activation,
 * which is why a key also needs its keydown on that button (`keyed`). No `press` at all is Enter
 * in the card's own field.
 */
export function pressOrigin(press: { pointerType?: string; downType?: string; detail?: number; keyed: boolean } | undefined): PressOrigin {
  if (press === undefined) return "keyboard";
  for (const pointer of ["touch", "pen", "mouse"] as const) {
    if (press.downType === pointer || press.pointerType === pointer) return pointer;
  }
  return press.detail === 0 && press.keyed ? "keyboard" : "unknown";
}

/**
 * After an answer pressed in the card went out: may the keyboard's focus go on to the message box?
 * Only if the card is still there and nothing else took the focus while the answer was on its way
 * (a palette, a held message being edited, another pane): `inCard` and `onPage` say where it is now.
 * After a key or a mouse press, on any device: the card goes, and the focus would fall to the page.
 * Never after a tap or a pen: focus in the message box would raise the on-screen keyboard. A press
 * of unknown origin is a tap where the device's pointer is `coarse`.
 */
export function focusFollowsAnswer({ fromCard, origin, coarse, cardMounted, inCard, onPage }: { fromCard: boolean; origin: PressOrigin; coarse: boolean; cardMounted: boolean; inCard: boolean; onPage: boolean }): boolean {
  const pressed = origin === "keyboard" || origin === "mouse" || (origin === "unknown" && !coarse);
  return fromCard && pressed && cardMounted && (inCard || onPage);
}
