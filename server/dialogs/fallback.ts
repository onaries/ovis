import type { DialogReader } from "./registry.ts";
import { type InteractivePrompt } from "../../shared/protocol.ts";
import { createHash } from "node:crypto";
import { ANSI_RE, type AnswerStep, KEY, type MenuRow, NUMBERED_OPTION_RE, type NumberedRow, type ParsedPrompt, SELECTED_RE, cleanLine, findLastIndex, finishPrompt, isDivider, keySteps, navigationKeys, normalizeText, parseNumberedRows, parsedByPublicPrompt, publicPrompt, sequentialRows } from "./shared.ts";

/**
 * The last resort, for a pane herdr reports blocked that none of the readers above know (a
 * menu a new agent version draws differently, an agent without a reader): the chat must never
 * leave the user without a way to answer. It guesses as little as it can: a numbered menu that
 * still owns the screen's end becomes options answered by number, and GJC's exact unnumbered
 * selector becomes options answered by its cursor keys. Anything else shows the screen's last
 * lines with the keys its hint lines name, plus Enter and Esc.
 */
/** a question, allowing a trailing choice hint such as "(y/n)" */
const ASKED_RE = /\?\s*(?:[([][^)\]]*[)\]])?\s*$/;

/** a (y/n) hint ending its line, as a prompt does; a mention mid-sentence or quoted does not */
const YES_NO_RE = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]\s*[:?]?\s*$/i;

const ARROWS_RE = /[↑↓]|\barrow keys\b/i;

/**
 * what a menu's hint line says to do with it: a way to choose ("Enter to select", "↵ choose",
 * "Enter a number", "Type 1-3", "↑/↓ to move"). A plain Enter or Press asks for something else
 * ("Enter recovery code", "Enter your phone number", "Press any key").
 */
const MENU_HINT_RE = /\b(?:select|choose|pick|confirm|navigate|move|esc|cancel)\b|[↑↓↵⏎]|\b(?:enter|type)\s+(?:(?:a|an|the)\s+)?number\b|\b\d\s*[-–]\s*\d\b/i;

const GJC_SELECT_HINT_RE = /^(?:\[↑↓ to navigate, enter to select, esc to (?:cancel|go back)\]|up\/down navigate\s+enter select(?:\s+←\/→ question)?\s+esc cancel|↑\/↓ select\s+enter(?:\s+←\/→ question)?\s+esc\s+PgUp\/PgDn\/Ctrl\+u\/d: question · Wheel: transcript)$/i;

/** GJC also uses the Nerd Font chevron for its active question row. */
const GJC_SELECTED_RE = /^[❯›>]\s*/;

/** an input field waiting at a line's end ("Password:", "Choice: 2") */
const INPUT_FIELD_RE = /:\s*\S{0,3}$/;

/** a line that reads as a hint of its own, not a label's wrapped words ("…the selected number", "choose one") */
const HINT_LINE_RE = /^(?:[↵⏎]|(?:Press|Enter|Select|Choose|Pick|Type|Esc|ESC)\b)/;

/** how many lines the last row of a menu wraps onto, at most: more reads as output under it */
const MENU_WRAP_LINES = 2;

/** a line that is an input box or quoted output rather than a prompt's own text */
const NOT_PROMPT_TEXT_RE = /^(?:[❯›>"'“]|\$ )/;

/**
 * Claude Code's working line, whole: one of its spinner's frames, what it is doing ending in an
 * ellipsis, and in parentheses the time it has taken and the tokens it has used, then maybe the
 * interrupt hint: "✢ Tempering… (1m 55s · ↓ 10.0k tokens)".
 */
const WORKING_LINE_RE = /^[·✢✳✶✻✽*] (\S(?:.*\S)?…) \((?:\d+h )?(?:\d+m )?\d+s · [↑↓] [\d.,]+[kKmM]? tokens( · esc to interrupt)?\)$/u;

/**
 * How a fallback card's id reads a line of the screen. Claude Code keeps its working line on the
 * screen while it waits on a prompt, and the line's spinner, time and token count change every
 * second or so. An id that took them in refused each answer tapped after a tick as stale (#365).
 *
 * They are blanked on that one line, and only when it is known to be it: the pane runs Claude,
 * the line is its working line to the letter, token count with its arrow included, and no other
 * line of the screen has that shape. Without the token count a time in parentheses may be one
 * that is offered ("Restart service… (300s)"), and two such lines may be a menu's rows with their
 * marker ("· Delete all…" / "* Cancel…"): those screens are hashed as they are, like every other
 * line and every other agent's screen. The words stay in the id, so "Deleting staging…" is never
 * "Deleting production…".
 */
function steadyReader(agent: string, shown: string[]): SteadyReader {
  const working = agent === "claude" ? shown.flatMap((line, at) => WORKING_LINE_RE.test(line) ? [at] : []) : [];
  const [at] = working;
  if (working.length !== 1 || at === undefined) return { read: (other) => other, working: null };
  const line = shown[at]!;
  const steady = line.replace(WORKING_LINE_RE, (_all, doing: string, hint: string | undefined) => `* ${doing} (<time> · <tokens>${hint ?? ""})`);
  return { read: (other) => other === line ? steady : other, working: at };
}

interface SteadyReader {
  read(line: string): string;
  /** which of the shown lines was read as the working line; it goes into the id beside the text, so
   * that a screen holding the blanked form as its own text ("* Tempering… (<time> · <tokens>)") is
   * another card */
  working: number | null;
}

export function parseFallbackPrompt(agent: string, screen: string): InteractivePrompt {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.flatMap((line, index) => cleanLine(line) && !isDivider(line) ? [index] : []);
  const steady = steadyReader(agent, shown.map((index) => cleanLine(lines[index]!)));
  // GJC's exact selector first: a label of its that starts with a number is still moved to, never typed
  const selectionMenu = fallbackGjcSelectionMenu(agent, lines, shown);
  const menu = selectionMenu ? null : fallbackMenu(lines, shown);
  if (menu) {
    const above = shown.filter((index) => index < menu.start).map((index) => cleanLine(lines[index]!));
    const question = [...above].reverse().find((line) => ASKED_RE.test(line)) ?? above.at(-1);
    // a row's number is typed alone, as a menu reading keys takes it; a program reading a whole
    // line ("Enter a number >") still waits for the Enter after it, and Esc backs out
    const choices: { label: string; steps: AnswerStep[] }[] = [
      ...menu.rows.map((row) => ({ label: row.label, steps: [{ text: String(row.number) }] })),
      { label: "Enter", steps: keySteps([KEY.enter]) },
      { label: "Esc", steps: keySteps([KEY.escape]) },
    ];
    const body = withoutLine(above, question);
    return screenCard(lines, shown, steady, finishPrompt(agent, {
      // the body is every other line above the rows, so a changed command above a same-looking
      // menu is another card; the display cap applies after the hash
      kind: "menu", fallback: true, title: "Waiting for your answer", question: question ?? "The agent is waiting for your answer.",
      body,
      options: choices.map(({ label }) => ({ label, description: null })),
      multi_select: false, custom_option_index: null,
    }, {
      responder: "fallback-menu", menuLabels: choices.map(({ label }) => label), selectedIndex: 0,
      checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
      optionSteps: choices.map(({ steps }) => steps),
    }, steadyFields(question, body, steady.read)));
  }
  if (selectionMenu) {
    // the selector's own heading: the block of lines right above its rows, never an earlier question
    let headEnd = selectionMenu.start;
    while (headEnd > 0 && (!cleanLine(lines[headEnd - 1]!) || isDivider(lines[headEnd - 1]!))) headEnd -= 1;
    // GJC's question dialog has its own opening border before the title. The transcript and
    // ticking status above it do not belong to this asking. Its outer borders are unindented
    // and identical; Markdown title rules have left padding. Keep every title paragraph inside,
    // including approval details; without the matching frame keep the whole screen.
    const closing = lines[findLastIndex(lines, (line) => Boolean(line.trim()))]?.trimEnd();
    const border = closing && isDivider(closing) && !/^\s/.test(closing)
      ? findLastIndex(lines.slice(0, headEnd), (line) => line.trimEnd() === closing)
      : -1;
    const dialogShown = border < 0 ? shown : shown.filter((index) => index > border);
    const above = dialogShown.filter((index) => index < selectionMenu.start).map((index) => cleanLine(lines[index]!));
    let headStart = headEnd;
    while (headStart > 0 && cleanLine(lines[headStart - 1]!) && !isDivider(lines[headStart - 1]!)) headStart -= 1;
    const heading = lines.slice(headStart, headEnd).map((line) => cleanLine(line));
    const question = [...heading].reverse().find((line) => ASKED_RE.test(line)) ?? heading.at(-1);
    const choiceRows = new Set(selectionMenu.rows.map((row) => row.lineIndex));
    const customRows = selectionMenu.rows.flatMap((row, index) => /^(?:\d+\.\s*)?Other \(type your own\)$/i.test(row.label) ? [index] : []);
    const customIndex = customRows.length === 1 ? customRows[0]! : null;
    const choices = [
      ...selectionMenu.rows.map((row, index) => ({
        label: row.label,
        steps: keySteps([...navigationKeys(index - selectionMenu.selectedIndex), KEY.enter]),
      })),
      { label: "Esc", steps: keySteps([KEY.escape]) },
    ];
    const body = withoutLine(above, question);
    return screenCard(lines, dialogShown, steady, finishPrompt(agent, {
      kind: "menu", fallback: true, title: "Waiting for your answer", question: question ?? "The agent is waiting for your answer.",
      body,
      options: choices.map(({ label }) => ({ label, description: null })),
      multi_select: false, custom_option_index: customIndex,
    }, {
      responder: "fallback-gjc-menu", menuLabels: choices.map(({ label }) => label), selectedIndex: selectionMenu.selectedIndex,
      checkedOptionIndices: [], customMenuIndex: customIndex, rejectWithEscapeIndex: null,
      optionSteps: choices.map(({ steps }) => steps),
    }, steadyFields(question, body, steady.read)), choiceRows);
  }
  const last = shown.slice(-16).map((index) => cleanLine(lines[index]!));
  // letters and arrows only for the prompt's own last lines, never while an input box ends the
  // screen (the agent's composer owns the keys then) or for a line of quoted output
  const hints = NOT_PROMPT_TEXT_RE.test(last.at(-1) ?? "") ? [] : last.slice(-2).filter((line) => !NOT_PROMPT_TEXT_RE.test(line));
  const question = [...last].reverse().find((line) => ASKED_RE.test(line)) ?? last.at(-1);
  // a (y/n) letter is offered only for the prompt at the screen's end, never for a mention
  // above it; it is typed without an Enter: a program reading a whole line still waits for
  // one, and the card that follows offers it
  const choices: { label: string; steps: AnswerStep[] }[] = [
    ...(hints.some((line) => YES_NO_RE.test(line)) ? [{ label: "Yes (y)", steps: [{ text: "y" }] }, { label: "No (n)", steps: [{ text: "n" }] }] : []),
    ...(hints.some((line) => ARROWS_RE.test(line)) ? [{ label: "↑", steps: keySteps([KEY.up]) }, { label: "↓", steps: keySteps([KEY.down]) }] : []),
    { label: "Enter", steps: keySteps([KEY.enter]) },
    { label: "Esc", steps: keySteps([KEY.escape]) },
  ];
  const body = withoutLine(last, question);
  return screenCard(lines, shown, steady, finishPrompt(agent, {
    kind: "menu", fallback: true, title: "Waiting for input", question: question ?? "The agent is waiting for input.",
    body,
    options: choices.map(({ label }) => ({ label, description: null })),
    multi_select: false, custom_option_index: null,
  }, {
    responder: "fallback-keys", menuLabels: choices.map(({ label }) => label), selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: null,
    optionSteps: choices.map(({ steps }) => steps),
  }, steadyFields(question, body, steady.read)));
}

/** A fallback card's question and body as its id reads them: with the working line's ticking parts blanked. */
function steadyFields(question: string | undefined, body: string | null, steady: (line: string) => string): Partial<Pick<InteractivePrompt, "question" | "body">> {
  return { ...(question === undefined ? {} : { question: steady(question) }), body: body === null ? null : body.split("\n").map(steady).join("\n") };
}

const gjcMenuIdentities = new WeakMap<ParsedPrompt, string>();

/**
 * A fallback card's id covers the whole visible screen, not just the lines it shows: a changed
 * command, footer or wrapped label anywhere on it makes an answer to the old card stale. A working
 * line's spinner, time and token count are the one thing it leaves out (steadyReader).
 */
function screenCard(lines: string[], shown: number[], steady: SteadyReader, parsed: ParsedPrompt, cursorRows?: ReadonlySet<number>): InteractivePrompt {
  // Preserve the card hash before adding the selector footer's screen hash. The inline editor
  // has a different footer, but must retain the full question body hashed before its display cap.
  if (parsed.responder === "fallback-gjc-menu") gjcMenuIdentities.set(parsed, parsed.id);
  // A cmd heredoc's indentation and separators can change which text is executable.
  const screen = parsed.agent === "cmd" ? lines.join("\n") : shown.map((index) => {
    const line = cleanLine(lines[index]!);
    // GJC moves its cursor within the same menu; the selectedIndex is checked separately on reread.
    return steady.read(cursorRows?.has(index) ? line.replace(GJC_SELECTED_RE, "") : line);
  }).join("\n");
  parsed.id = createHash("sha256").update(JSON.stringify({ card: parsed.id, screen, ...(steady.working === null ? {} : { working: steady.working }) })).digest("hex").slice(0, 12);
  return publicPrompt(parsed);
}

/** the screen lines shown under the card's question, without the question itself */
function withoutLine(lines: string[], question: string | undefined): string | null {
  const at = question === undefined ? -1 : lines.lastIndexOf(question);
  return lines.filter((_, index) => index !== at).join("\n") || null;
}

/**
 * A numbered menu (`1.` … `n.`, 2 to 9 rows, at most one marked) that still owns the screen's
 * end: its hint, a line that says to choose, is the screen's last, and between the last row and
 * it are only the lines that row wraps onto (right under it, indented past its number). Anything
 * else there (another hint, a new prompt, an input box) may be what takes the keys now, so it is
 * no menu. A wrapped label is no guess here, since every row starts with its own number.
 */
function fallbackMenu(lines: string[], shown: number[]): { start: number; rows: NumberedRow[] } | null {
  const lastRow = [...shown].reverse().find((index) => NUMBERED_OPTION_RE.test(cleanLine(lines[index]!)));
  const hintIndex = shown.at(-1);
  if (lastRow === undefined || hintIndex === undefined || hintIndex === lastRow) return null;
  const hint = cleanLine(lines[hintIndex]!);
  // a hint that says to choose, and no input field ("Password:", "Choice: 2"): a numbered
  // list in the agent's output is not a menu
  if (!MENU_HINT_RE.test(hint) || SELECTED_RE.test(hint) || NOT_PROMPT_TEXT_RE.test(hint) || INPUT_FIELD_RE.test(hint)) return null;
  let end = lastRow + 1;
  const numberAt = lines[lastRow]!.search(/\d/);
  while (end < hintIndex && cleanLine(lines[end]!) && !isDivider(lines[end]!) && lines[end]!.search(/\S/) > numberAt) end += 1;
  if (shown.some((index) => index >= end && index < hintIndex) || end - lastRow - 1 > MENU_WRAP_LINES) return null;
  // up from the last row, through rows and the lines they wrap onto, to a blank line or a rule
  let start = lastRow;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  while (start < lastRow && !NUMBERED_OPTION_RE.test(cleanLine(lines[start]!))) start += 1;
  const rows = parseNumberedRows(lines, start, end);
  if (!sequentialRows(rows) || rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length > 1) return null;
  // the lines a row wraps onto belong to its label; an input box or quote between rows, or a
  // row with its own letter key ("Read only (r)"), means the number may not be the key
  for (const [at, row] of rows.entries()) {
    const wrapped = lines.slice(row.lineIndex + 1, rows[at + 1]?.lineIndex ?? end).map(cleanLine).filter(Boolean);
    // a hint or an input field inside the last row's wrap may be an older prompt, with a new one under it
    if (wrapped.some((line) => NOT_PROMPT_TEXT_RE.test(line) || (at === rows.length - 1 && (HINT_LINE_RE.test(line) || /:\s*$/.test(line))))) return null;
    // the key may end the row's first line, with a description wrapped under it
    if ([row.label, ...wrapped].some((line) => /\(\w\)$/.test(line))) return null;
    row.label = [row.label, ...wrapped].join(" ");
  }
  return { start, rows };
}

/** GJC's unnumbered selector: a cursor-marked row, two-space rows, and its own selection footer. */
function fallbackGjcSelectionMenu(agent: string, lines: string[], shown: number[]): { start: number; rows: MenuRow[]; selectedIndex: number } | null {
  if (agent !== "gjc" || shown.length === 0) return null;
  let hintStart = -1;
  for (let length = 1; length <= Math.min(3, shown.length); length += 1) {
    const suffix = shown.slice(-length).map((index) => cleanLine(lines[index]!)).join(" ");
    if (GJC_SELECT_HINT_RE.test(suffix)) {
      hintStart = shown[shown.length - length]!;
      break;
    }
  }
  if (hintStart < 0) return null;

  // GJC's standard selector separates the footer with a spacer and can outline its rows.
  // The provider wizard puts its footer directly below them.
  let end = hintStart;
  while (end > 0 && (!cleanLine(lines[end - 1]!) || isDivider(lines[end - 1]!))) end -= 1;
  let start = end;
  while (start > 0 && cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!)) start -= 1;
  if (start === 0 || (cleanLine(lines[start - 1]!) && !isDivider(lines[start - 1]!))) return null;
  const rows: MenuRow[] = [];
  for (let index = start; index < end; index += 1) {
    const text = cleanLine(lines[index]!);
    const selected = GJC_SELECTED_RE.test(text);
    const label = normalizeText(text.replace(GJC_SELECTED_RE, ""));
    // A windowed/truncated list is not a complete set of choices. Keep its manual keys.
    if (!label || /^\(\d+\/\d+\)$/.test(label) || /…|\.\.\./.test(label)) return null;
    rows.push({ label, selected, checked: false, lineIndex: index });
  }
  const selectedIndex = rows.findIndex((row) => row.selected);
  if (rows.length < 2 || selectedIndex < 0 || rows.filter((row) => row.selected).length !== 1) return null;
  return { start, rows, selectedIndex };
}

/** The same framed question must still own the inline Other editor before any text is sent. */
export function gjcCustomEditorMatches(screen: string, expected: ParsedPrompt, draft: string): boolean {
  if (expected.responder !== "fallback-gjc-menu" || expected.customMenuIndex === null) return false;
  const identity = gjcMenuIdentities.get(expected);
  if (!identity || /[\r\n]/.test(draft)) return false;
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const shown = lines.flatMap((line, index) => cleanLine(line) && !isDivider(line) ? [index] : []);
  const footer = "enter submit esc back to options ctrl+g external editor PgUp/PgDn: question · Wheel: transcript";
  let footerStart = -1;
  let footerEnd = -1;
  for (let count = 1; count <= Math.min(3, shown.length); count++) {
    const tail = shown.slice(-count);
    if (normalizeText(tail.map((index) => cleanLine(lines[index]!)).join(" ")) === footer) {
      footerStart = tail[0]!;
      footerEnd = tail.at(-1)!;
      break;
    }
  }
  if (footerStart < 0) return false;
  const text = draft.normalize("NFC").replace(/\t/g, "    ");
  const draftCharacters = text.replace(/\s/g, "").length;
  // Normalize the rows once, not the entire suffix again for every quoted body row.
  const editorLines = lines.slice(0, footerStart).map((line) => line.normalize("NFC").replace(/\t/g, "    ").trimEnd());
  while (editorLines.at(-1) === "") editorLines.pop();
  let characters = 0;
  // A wrapped draft can itself start a row with "> ". Only the start that restores the
  // original selector identity belongs to its editor, rather than to the draft or transcript.
  for (let input = editorLines.length - 1; input >= 0; input--) {
    characters += editorLines[input]!.replace(/\s/g, "").length;
    // The editor marker adds exactly one non-whitespace character to the draft. Once the
    // suffix has more, no earlier start can spell it; each "> " candidate adds another.
    if (characters > draftCharacters + 1) break;
    if (characters !== draftCharacters + 1 || !/^>(?:\s|$)/.test(cleanLine(editorLines[input]!))) continue;
    // Like claudeRestoredDraft, walk exact row contents: a soft wrap can split a word or
    // consume one separating space. Do not flatten internal whitespace or accept missing text.
    let positions = new Set([0]);
    for (let index = input; index < editorLines.length; index++) {
      // Keep leading spaces in continuation rows: a wrap can split two adjacent spaces.
      const row = index === input ? editorLines[index]!.replace(/^\s*> ?/, "") : editorLines[index]!;
      const next = new Set<number>();
      for (const from of positions) {
        const starts = index > input && text[from] === " " ? [from, from + 1] : [from];
        for (const start of starts) if (text.startsWith(row, start)) next.add(start + row.length);
      }
      positions = next;
      if (positions.size === 0) break;
    }
    if (!positions.has(text.length)) continue;
    // At most one candidate has the draft's character count. Check its spelling before
    // rebuilding and parsing the uncapped question, so quoted bodies cost one parse, not N.
    const restored = [...lines.slice(0, input), "↑/↓ select enter esc PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript", ...lines.slice(footerEnd + 1)].join("\n");
    const parsed = parsedByPublicPrompt.get(parseFallbackPrompt("gjc", restored));
    return parsed?.responder === expected.responder && parsed.selectedIndex === expected.customMenuIndex
      && gjcMenuIdentities.get(parsed) === identity;
  }
  return false;
}

/**
 * The fallback cards' answer behaviour, found by their responder when one is answered. They read no
 * screen here: parseFallbackPrompt draws a fallback card only once herdr reports the pane blocked
 * and no reader knows its screen (prompt.ts).
 */
export const readers: readonly DialogReader[] = [
  { id: "fallback-menu", agents: ["*"], priority: 1000, reread: "none", list: "none", parse: () => null },
  { id: "fallback-gjc-menu", agents: ["*"], priority: 1000, reread: "before-commit", list: "none", parse: () => null },
  { id: "fallback-keys", agents: ["*"], priority: 1000, reread: "none", list: "none", parse: () => null },
];
