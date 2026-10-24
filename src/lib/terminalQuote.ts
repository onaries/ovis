/** A stretch of terminal output quoted into the chat draft: a label, the rows it came from, the text. */
export interface TerminalQuote {
  /** the pane's name */
  label: string;
  /** herdr's history rows, 0-based, both ends inclusive; null when herdr gave no rows */
  range: { start: number; end: number } | null;
  text: string;
}

/** CRLF to LF, and the blank lines around the selection dropped; null when nothing is left */
export function quotedText(text: string): string | null {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  return normalized.trim() === "" ? null : normalized;
}

/** "build lines 12-15" (line numbers count from 1, as an editor does) */
export function quoteHeading(label: string, range: TerminalQuote["range"]): string {
  if (!range) return label;
  const start = Math.max(1, Math.floor(range.start) + 1);
  const end = Math.max(start, Math.floor(range.end) + 1);
  return start === end ? `${label} line ${start}` : `${label} lines ${start}-${end}`;
}

/** A code fence longer than every backtick run in the text, so nothing inside can close it. */
function fenceFor(text: string): string {
  let fence = "```";
  for (const run of text.match(/`{3,}/g) ?? []) if (run.length >= fence.length) fence = "`".repeat(run.length + 1);
  return fence;
}

/** A heading and the text in a code fence that no backtick run inside the text can close. */
export function formatTerminalQuote(quote: TerminalQuote): string | null {
  const text = quotedText(quote.text);
  if (text === null) return null;
  const label = quote.label.replace(/\s+/g, " ").trim() || "terminal";
  const fence = fenceFor(text);
  return `${quoteHeading(label, quote.range)}:\n${fence}\n${text}\n${fence}`;
}

/** The heading of a passage quoted from the agent's reply: plain, with no lines or anchor to keep. */
export const REPLY_QUOTE_LABEL = "From your reply";

/**
 * A passage of an assistant reply as the browser shows it selected (the text a copy would carry),
 * fenced like a terminal quote. The draft is ordinary text: no line numbers, no range identity.
 */
export function formatReplyQuote(selected: string): string | null {
  const text = quotedText(selected);
  if (text === null) return null;
  const fence = fenceFor(text);
  return `${REPLY_QUOTE_LABEL}:\n${fence}\n${text}\n${fence}`;
}

/**
 * The draft with the quote added after what is there, set apart by a blank line and followed by a
 * line break so the user types below it. Null when the result would pass `max` characters.
 */
export function appendQuote(draft: string, block: string, max: number): string | null {
  const gap = draft === "" ? "" : draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  const next = `${draft}${gap}${block}\n`;
  return next.length > max ? null : next;
}
