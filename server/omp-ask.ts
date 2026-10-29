import { askedQuestions } from "../shared/askQuestions.ts";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { parseInline, parseMarkdown, shownText, type InlineNode, type MarkdownBlock } from "../shared/markdown.ts";
import { parsedByPublicPrompt, publicPrompt } from "./dialogs/shared.ts";
import type { OmoAsks } from "./omo-ask.ts";

/**
 * omp's Ask card in the agent's own Markdown (#1644). The terminal draws the call's text through
 * its Markdown renderer (pi-tui `ask-dialog.ts`, omp 18.12.6 to 18.13.2), and the card read off the
 * screen gets only that drawn text: emphasis, code and links are lost, and a question past four
 * rows is cut with `…`.
 *
 * The session's one open `ask` call (ompAsksAfter) gives its text back only when that call
 * is provably the menu on screen: one of its questions, drawn as omp draws it, is the question
 * shown, with the same options in the same order, labels and descriptions included. Anything else
 * leaves the card as drawn: no open call or more than one, no question or more than one that
 * matches, Markdown omp draws in a way not followed here (a table, a quote, a task list), an option
 * with a preview (omp draws it into the option's rows), a description omp cut at its two rows. The
 * terminal's menu stays the authority: the card keeps its id and the keys read for it, so an
 * answer goes where it did.
 */
export function ompMarkdownPrompt(prompt: InteractivePrompt, open: OmoAsks): InteractivePrompt {
  const parsed = parsedByPublicPrompt.get(prompt);
  if (parsed?.responder !== "omp-question" || open.length !== 1) return prompt;
  const matches = (askedQuestions("ask", open[0]!.args) ?? []).filter((asked) => asked.multi === prompt.multi_select
    && asked.options.length === prompt.options.length
    && asked.options.every((option, index) => {
      const shown = prompt.options[index]!;
      const description = option.description?.trim() ? option.description : null;
      return option.preview === null && shows(shown.label, drawn(label(option.label), false))
        && (description === null ? shown.description === null : shown.description !== null && shows(shown.description, drawn(description, false)));
    })
    && shows(prompt.question, drawn(asked.question, true), parsed.ompQuestionCut === true));
  if (matches.length !== 1) return prompt;
  const asked = matches[0]!;
  const options = asked.options.map((option) => ({ label: label(option.label), description: option.description?.trim() ? option.description : null }));
  // options the card would show alike (`Keep **production**` and `Keep  **production**`, one link's words to two addresses):
  // the terminal's rows tell them apart by place alone, and so does the card as drawn (#2233)
  const shown = options.map((option) => alike(cardDrawn(option.label, false) ?? option.label));
  if (new Set(shown).size !== shown.length) return prompt;
  return publicPrompt({ ...parsed, question: asked.question, options, text_format: "markdown" });
}

/** a name as a page shows it, for telling the card's options apart: one Unicode form by look, spacing collapsed, any case (src/lib/promptAnswer.ts `spaced`) */
const alike = (text: string): string => flat(text.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")).toLowerCase();

/** omp adds ` (Recommended)` to the recommended option's label; the card read off the screen drops it (dialogs/omp.ts), and so does this one */
const label = (text: string): string => text.replace(/ \(Recommended\)$/i, "");

/** text with every run of spaces and line breaks as one space */
const flat = (text: string): string => text.replace(/\s+/gu, " ").trim();

/**
 * Whether the screen's text is `drawn`, character for character but for how much spacing there is:
 * omp wraps at the pane's width and pads its rows, so a run of spaces or a line break is one space
 * (flat). The space itself counts (`Use local socket` is not `Use localsocket`), as do case, digits
 * and every mark, so a call that differs from the menu by one `/`, `*`, `_` or letter is another call. Only a question omp says it cut (`cut`, dialogs/omp.ts)
 * may show just the start of the call's question, followed by omp's `…`.
 */
function shows(screen: string, drawn: string | null, cut = false): boolean {
  if (drawn === null) return false;
  const shown = flat(screen);
  const asked = flat(drawn);
  if (shown === asked) return true;
  const start = shown.replace(/\s*…$/u, "");
  return cut && start !== shown && asked.length > start.length && asked.startsWith(start);
}

/**
 * `markdown` as omp draws it, when the card draws the same characters: the card's Markdown scanner
 * (shared/markdown.ts, the chat's) is not CommonMark. It takes `*.log and *.tmp` for emphasis and keeps
 * a backslash before an escaped mark, so the card would show other words than omp, and an option could
 * read as another one. Where they part, null: the card stays as drawn.
 */
function drawn(markdown: string, question: boolean): string | null {
  const omp = ompDrawn(markdown, question);
  const card = cardDrawn(markdown, question);
  return omp !== null && card !== null && flat(omp) === flat(card) ? omp : null;
}

/**
 * `markdown` as the card draws it (src/components/PromptCard.tsx), put in omp's terms to compare: the
 * question through the chat's block scanner, with a link's address after its words; a label or a
 * description through its inline scanner, links as their words. Null for what has no such text
 * (math, a picture, a table, a quote, a task box).
 */
function cardDrawn(markdown: string, question: boolean): string | null {
  try {
    return question ? parseMarkdown(markdown, 0, false).map(cardBlock).join("\n") : cardInline(parseInline(markdown, false), false);
  } catch (error) {
    if (error instanceof Undrawn) return null;
    throw error;
  }
}

function cardBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case "paragraph": return block.lines.map((line) => cardInline(line, true)).join("\n");
    case "heading": return `${block.level > 2 ? `${"#".repeat(block.level)} ` : ""}${cardInline(block.content, true)}`;
    // the chat draws a ```mermaid fence as a diagram (src/components/Markdown.tsx), not the code omp shows (#2233)
    case "code": return block.language === "mermaid" ? undrawn() : block.value;
    case "list": return block.items.map((item, index) => item.checked !== undefined ? undrawn()
      : `${block.ordered ? `${(block.start ?? 1) + index}. ` : "- "}${cardInline(item.content, true)}\n${(item.blocks ?? []).map(cardBlock).join("\n")}`).join("\n");
    default: return undrawn();
  }
}

/** omp draws a picture's alt text, the card the picture or `!` and its address; math too is drawn otherwise (shownText's null) */
function cardInline(nodes: InlineNode[], addresses: boolean): string {
  return shownText(nodes, addresses) ?? undrawn();
}

class Undrawn extends Error {}
const undrawn = (): never => { throw new Undrawn(); };

/**
 * `markdown` as omp draws it, read by a CommonMark parser (Bun's), as omp's own is: emphasis,
 * strikethrough and code show their text, a picture its alt text, a link its words; an escaped or
 * unpaired mark (`\*`, `*.log`, `_cache/`) stays. A question (`question`) is a Markdown block: its
 * links show their address after their words unless the words are the address, a heading of
 * level 3 or more keeps its `#`s, list items take omp's `- ` or `N. `, code blocks their code. A label
 * or description is one line of inline Markdown. Null for what omp draws otherwise (a table, a
 * quote, a rule, HTML, a task list, a block inside a label): the card then stays as drawn.
 */
function ompDrawn(markdown: string, question: boolean): string | null {
  // where Bun's parser and omp's part: Bun decodes every HTML entity and takes `~x~` as strikethrough,
  // while omp draws them as written
  if (/&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(markdown) || /(?<!~)~(?!~)[^~\n]*(?<!~)~(?!~)/.test(markdown)) return null;
  const block = <T>(draw: (children: string, meta: T) => string) => question ? draw : undrawn;
  try {
    return Bun.markdown.render(markdown, {
      text: (children) => children,
      strong: (children) => children,
      emphasis: (children) => children,
      strikethrough: (children) => children,
      codespan: (children) => children,
      image: (children) => children,
      link: (children, { href }) => question && href && children !== href && children !== href.replace(/^mailto:/, "") ? `${children} (${href})` : children,
      paragraph: (children) => `${children}\n`,
      heading: block<{ level: number }>((children, { level }) => `${level > 2 ? `${"#".repeat(level)} ` : ""}${children}\n`),
      code: block((children) => children),
      list: block((children) => children),
      listItem: block<{ index: number; ordered: boolean; start?: number; checked?: boolean }>((children, { index, ordered, start, checked }) =>
        checked === undefined ? `${ordered ? `${(start ?? 1) + index}. ` : "- "}${children}\n` : undrawn()),
      blockquote: undrawn, hr: undrawn, table: undrawn, html: undrawn,
    });
  } catch (error) {
    if (error instanceof Undrawn) return null;
    throw error;
  }
}
