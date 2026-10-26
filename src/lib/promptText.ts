import type { CardText, InteractivePrompt } from "../../shared/protocol.ts";
import { t as inCurrentLanguage, type Translate } from "./i18n.ts";

/** Card text the bridge wrote itself (shared/card-text.ts), in the user's language: its key translated, its values filled in. */
export function cardText(card: CardText, t: Translate = inCurrentLanguage): string {
  const vars = card.vars === undefined ? undefined
    : Object.fromEntries(Object.entries(card.vars).map(([name, value]) => [name, value !== null && typeof value === "object" ? cardText(value, t) : value]));
  return t(card.key, vars);
}

/** At most `limit` UTF-16 units of `text`, never ending on half of a character (a lone high surrogate). */
function capped(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The words a prompt card shows: the bridge's own (`own_text`: a title it gave the card, the Close an
 * Esc is offered as) in the user's language, and the agent's own text as the agent wrote it.
 */
export function promptWords(prompt: InteractivePrompt, t: Translate = inCurrentLanguage) {
  const own = prompt.own_text;
  const words = (text: string, card: CardText | undefined): string => card === undefined ? text : cardText(card, t);
  return {
    title: words(prompt.title, own?.title),
    question: words(prompt.question, own?.question),
    // the bridge shows at most 12,000 characters of a body (finishPrompt): a translated one too
    body: prompt.body === null ? null : capped(words(prompt.body, own?.body), 12_000),
    label: (index: number): string => words(prompt.options[index]?.label ?? "", own?.labels?.[index]),
    description: (index: number): string | null => {
      const description = prompt.options[index]?.description ?? null;
      return description === null ? null : words(description, own?.descriptions?.[index]);
    },
    step: (index: number): string => words(prompt.steps?.[index]?.label ?? "", own?.steps?.[index]),
  };
}
