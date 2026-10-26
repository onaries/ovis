import type { DialogReader } from "./registry.ts";
import { pickerPlan } from "./interaction-plan.ts";
import { type InteractivePromptAnswer } from "../../shared/protocol.ts";
import { ANSI_RE, KEY, type MenuRow, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, isDivider, own, keySteps, navigationKeys, nearestQuestion, normalizeText, wrapped } from "./shared.ts";

const OMP_OPTION_MARKER_RE = /^([ \t]*)(?:[❯›>]\s*)?([○●◉◯☐☑☒✓])/;

export const OMP_SINGLE_HINT_RE = /(?:enter|⏎)\s+select.*↑\/↓\s*move.*(?:esc|⎋)\s*cancel/i;

// A legacy single-question footer can clip after the Tab keys or inside the cancel label.
export const OMP_SINGLE_CLIPPED_HINT_RE = /enter select.*n note.*↑\/↓ move.*(?:tab\/←\/→|esc(?: c(?:a(?:n(?:c(?:e(?:l)?)?)?)?)?)?)(?:…|\.{3})$/i;

// A narrow footer can cut the question-navigation word at any letter, followed by an ellipsis.
export const OMP_CLIPPED_SINGLE_HINT_RE = /(?:enter|⏎)\s+select.*\bn\s+note.*↑\/↓\s*move.*(?:tab|⇥).*\b(?:question…?|(?:q|qu|que|ques|quest|questi|questio)…)(?=\s|$)/i;

export const OMP_MULTI_HINT_RE = /(?:space\/enter toggle|(?:space|␠|␣)\s+toggle.*(?:enter|⏎)\s+(?:submit|next)).*↑\/↓\s*move.*(?:esc|⎋)\s*cancel/i;

// A narrow multi-select footer clips inside the cancel label after its question keys (omp 18.12.6 at 60 columns: `⎋ cance…`).
export const OMP_MULTI_CLIPPED_HINT_RE = /(?:space|␠|␣)\s+toggle.*(?:enter|⏎)\s+(?:submit|next).*↑\/↓\s*move.*(?:esc|⎋)(?:\s+c(?:a(?:n(?:c(?:e(?:l)?)?)?)?)?)?(?:…|\.{3})(?=\s|$)/i;

export const OMP_REVIEW_HINT_RE = /(?:enter|⏎)\s+submit.*↑\/↓\s*scroll.*(?:esc|⎋)\s*cancel/i;

const OMP_TABS_HINT_RE = /(?:tab|⇥).*?(?:←|left).*?(?:→|right)|(?:←|left).*?(?:→|right).*?(?:tab|⇥)/i;

/** OMP options have a marker; their descriptions and wrapped labels are indented below them. */
function parseOmpRows(lines: string[], startDivider: number, endDivider: number): MenuRow[] | null {
  const rows: MenuRow[] = [];
  const marker = "○●◉◯☐☑☒✓";
  const selectedRows = lines.slice(startDivider + 1, endDivider).map((line, index) => {
    const raw = line.replace(ANSI_RE, "").replace(/^\s*│/, "").replace(/│\s*$/, "");
    const match = raw.match(/^\s*(?:❯|›|>)\s*[○●◉◯☐☑☒✓]/);
    return match ? { raw, lineIndex: startDivider + 1 + index, markerColumn: match[0].search(/[○●◉◯☐☑☒✓]/) } : null;
  }).filter((row): row is { raw: string; lineIndex: number; markerColumn: number } => row !== null);
  if (selectedRows.length !== 1) return null;
  const markerColumn = selectedRows[0]!.markerColumn;
  for (let index = startDivider + 1; index < endDivider; index += 1) {
    const raw = lines[index]!.replace(ANSI_RE, "").replace(/^\s*│/, "").replace(/│\s*$/, "");
    const prefix = raw.slice(0, markerColumn);
    const glyph = raw[markerColumn] ?? "";
    const option = marker.includes(glyph) && (/^\s*$/.test(prefix) || /^\s*(?:❯|›|>)\s*$/.test(prefix));
    if (option) {
      const label = normalizeText(raw.slice(markerColumn + 1));
      if (label) rows.push({
        label, selected: /(?:❯|›|>)\s*$/.test(prefix), checked: /^[☑☒✓]/.test(glyph), lineIndex: index,
      });
      continue;
    }
    const row = rows.at(-1);
    if (!row) continue;
    const description = raw.match(/^\s*↳\s*(.*)$/);
    const indentation = raw.match(/^\s*/)?.[0].length ?? 0;
    const continuation = raw.trim();
    if (description) row.description = normalizeText([row.description, description[1]!].filter(Boolean).join(" "));
    else if (row.description && indentation >= markerColumn + 4 && continuation) row.description = normalizeText(`${row.description} ${continuation}`);
    else if (!row.description && indentation >= markerColumn + 4 && continuation) row.description = normalizeText(continuation);
    else if (!row.description && indentation >= markerColumn + 2 && continuation) row.label = normalizeText(`${row.label} ${continuation}`);
    else if (continuation) return null;
  }
  return rows;
}

function ompQuestionText(lines: string[], startDivider: number, hasQuestionTabs: boolean): string | null {
  const panelTop = findLastIndex(lines, (_, index) => index < startDivider && /^\s*╭/.test(lines[index]!));
  const headerDivider = panelTop >= 0 ? panelTop
    : findLastIndex(lines, (_, index) => index < startDivider && isDivider(lines[index]!));
  if (headerDivider < 0) return nearestQuestion(lines, startDivider);
  const headerRows = lines.slice(headerDivider + 1, startDivider);
  // With question navigation, OMP draws its tab bar before the question title. Drop its leading
  // rows by position and the tab cells' extra left padding, not by their text: the strip can wrap
  // to one cell per row or clip its final tab, and the question can itself end in `Submit`.
  const firstHeaderRow = headerRows.findIndex((line) => cleanLine(line));
  let tabRows = 0;
  if (hasQuestionTabs) {
    for (let index = firstHeaderRow; index >= 0 && index < headerRows.length; index += 1) {
      if (!isOmpTabStripRow(headerRows[index]!)) break;
      tabRows += 1;
      if (isOmpSubmitTabRow(headerRows[index]!)) break;
    }
  }
  const header = headerRows.map((line, index) => ({ line: cleanLine(line), index })).filter(({ line, index }) => line
    && !(hasQuestionTabs && index >= firstHeaderRow && index < firstHeaderRow + tabRows)
    && !/^[←→].*Submit/i.test(line) && !/^[☐☑✔]\s+\S/.test(line) && !/^Question \d+\/\d+/i.test(line)).map(({ line }) => line);
  return header.length > 0 ? normalizeText(header.join(" ")) : nearestQuestion(lines, startDivider);
}

/** The panel adds one space; TabBar cells start with one space, plus a wrapped separator when present. */
function isOmpTabStripRow(rawLine: string): boolean {
  const raw = ompTabRowText(rawLine);
  const indentation = raw.match(/^\s*/)?.[0].length ?? 0;
  return (indentation === 2 || indentation === 4) && Boolean(raw.trim());
}

/** Stop at the final visible tab so following indented question text is never consumed as tabs. */
function isOmpSubmitTabRow(rawLine: string): boolean {
  const cells = ompTabRowText(rawLine).trim().split(/\s{2,}/).map((cell) => cell.trim());
  return cells.at(-1) === "Submit";
}

function ompTabRowText(rawLine: string): string {
  return rawLine.replace(ANSI_RE, "").replace(/^\s*│/, "").replace(/│\s*$/, "");
}

const OMP_REVIEW_ROW_RE = /^\d+\.\s+(.*?):(?:\s+(.*))?$/;

const OMP_REVIEW_NOTE_RE = /^Note:\s*(.*)$/;

/**
 * omp's review: a row per question (`1. Transport: Remote relay`), a `Note: …` under an answer
 * given one. omp cuts a long row at the pane's edge instead of wrapping it. Null when a line is
 * neither, so the panel is shown as drawn.
 */
function ompReviewAnswers(panel: string[]): InteractivePromptAnswer[] | null {
  const answers: InteractivePromptAnswer[] = [];
  for (const line of panel) {
    const row = OMP_REVIEW_ROW_RE.exec(line);
    const note = OMP_REVIEW_NOTE_RE.exec(line);
    if (row) answers.push({ question: row[1]!.trim(), answer: row[2]?.trim() || null });
    else if (note && answers.length > 0 && answers.at(-1)!.note === undefined) answers.at(-1)!.note = note[1]!.trim();
    // the warning over the rows ("1 unanswered question; Enter still submits.") stays the body
    else if (answers.length > 0) return null;
  }
  return answers.length > 0 ? answers : null;
}

/** The Submit tab is a separate review state: Enter submits, Esc cancels the native dialog. */
function parseOmpSubmit(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = findLastIndex(lines, (_, index) => OMP_REVIEW_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const panelTop = findLastIndex(lines, (_, index) => index < hintIndex && /^\s*╭/.test(lines[index]!));
  if (panelTop < 0) return null;
  const heading = findLastIndex(lines, (line, index) => index > panelTop && index < hintIndex && cleanLine(line) === "Review answers");
  if (heading < 0) return null;
  const submitRows = lines.flatMap((line, index) => {
    if (index <= heading || index >= hintIndex) return [];
    return /^\s*[❯›>]\s*Submit\s*$/i.test(cleanLine(line)) ? [index] : [];
  });
  if (submitRows.length !== 1) return null;
  const submitRow = submitRows[0]!;
  const panel = lines.slice(heading + 1, submitRow).map(cleanLine).filter((line) => line && !isDivider(line));
  const answers = ompReviewAnswers(panel);
  // without answers read, the panel as it is drawn; with them, only what is not an answer (the
  // unanswered-questions warning)
  const body = (answers ? panel.filter((line) => !OMP_REVIEW_ROW_RE.test(line) && !OMP_REVIEW_NOTE_RE.test(line)) : panel).join("\n");
  return finishPrompt("omp", {
    kind: "menu", title: own("Review answers"), question: own("Submit these answers?"), body: body || null,
    ...(answers ? { answers } : {}),
    options: [{ label: own("Submit"), description: null }, { label: own("Cancel"), description: null }],
    multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-submit", menuLabels: ["Submit", "Cancel"], selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: 1,
  });
}

/** A clipped legacy footer is enough to identify a menu only when every parsed row
 * starts with an option marker in the cursor row's physical column. */
function ompRowsHaveAlignedMarkers(lines: string[], rows: MenuRow[]): boolean {
  const markerColumn = (lineIndex: number): number | null => {
    let line = lines[lineIndex]?.replace(ANSI_RE, "") ?? "";
    if (line.startsWith("│")) line = line.slice(1);
    const match = OMP_OPTION_MARKER_RE.exec(line);
    return match ? match[1]!.length + (match[0].length - match[1]!.length - match[2]!.length) : null;
  };
  const selected = rows.filter((row) => row.selected);
  if (selected.length !== 1) return false;
  const selectedColumn = markerColumn(selected[0]!.lineIndex);
  return selectedColumn !== null && rows.every((row) => markerColumn(row.lineIndex) === selectedColumn);
}

function findMenuDividers(lines: string[], hintIndex: number): [number, number] | null {
  let end = -1;
  for (let index = hintIndex - 1; index >= 0; index -= 1) {
    if (!isDivider(lines[index]!)) continue;
    if (end < 0) end = index;
    else return [index, end];
  }
  return null;
}

function parseOmpQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const clippedHintIndex = findLastIndex(lines, (_, index) => OMP_SINGLE_CLIPPED_HINT_RE.test(wrapped(lines, index)));
  const hintIndex = findLastIndex(lines, (_, index) => OMP_SINGLE_HINT_RE.test(wrapped(lines, index))
    || OMP_CLIPPED_SINGLE_HINT_RE.test(wrapped(lines, index)) || OMP_SINGLE_CLIPPED_HINT_RE.test(wrapped(lines, index)) || OMP_MULTI_HINT_RE.test(wrapped(lines, index))
    || OMP_MULTI_CLIPPED_HINT_RE.test(wrapped(lines, index)));
  if (hintIndex < 0) return null;
  const dividers = findMenuDividers(lines, hintIndex);
  if (!dividers) return null;
  const [startDivider, endDivider] = dividers;
  const rows = parseOmpRows(lines, startDivider, endDivider);
  if (!rows) return null;
  const selectedIndex = rows.findIndex((row) => row.selected);
  if (rows.filter((row) => row.selected).length !== 1) return null;
  const customIndex = rows.findIndex((row) => /^Other \(type your own\)$/i.test(row.label));
  const optionRows = rows.filter((_, index) => index !== customIndex);
  const hint = wrapped(lines, hintIndex);
  const multiSelect = OMP_MULTI_HINT_RE.test(hint) || OMP_MULTI_CLIPPED_HINT_RE.test(hint);
  const currentMulti = /(?:space|␠|␣)\s+toggle.*(?:enter|⏎)\s+(?:submit|next)/i.test(hint);
  const question = ompQuestionText(lines, startDivider, OMP_TABS_HINT_RE.test(hint));
  if (!question || selectedIndex < 0 || optionRows.length === 0 || customIndex !== rows.length - 1
    || (hintIndex === clippedHintIndex && !ompRowsHaveAlignedMarkers(lines, rows))) return null;
  return finishPrompt("omp", {
    kind: "question", title: own(multiSelect ? "Multiple choice" : "Question"), question, body: null,
    options: optionRows.map((row) => ({ label: row.label.replace(/ \(Recommended\)$/i, ""), description: row.description ?? null })),
    multi_select: multiSelect, custom_option_index: multiSelect ? null : optionRows.length,
  }, {
    responder: "omp-question", menuLabels: rows.map((row) => row.label), selectedIndex,
    checkedOptionIndices: optionRows.flatMap((row, index) => row.checked ? [index] : []),
    customMenuIndex: customIndex, rejectWithEscapeIndex: null,
    // OMP's Other row opens its own text prompt on Enter. The ordinary Enter in
    // the question dialog selects an option, so keep the activation step explicit.
    ...(!multiSelect ? { customSteps: (text: string) => [
      ...keySteps(navigationKeys(customIndex - selectedIndex)),
      ...keySteps([KEY.enter]), { text }, ...keySteps([KEY.enter]),
    ] } : {}),
    ...(currentMulti ? { multiSteps: (choices: number[]) => {
      const desired = new Set(choices);
      const checked = new Set(optionRows.flatMap((row, index) => row.checked ? [index] : []));
      const toggles = optionRows.flatMap((_, index) => desired.has(index) !== checked.has(index) ? [index] : []);
      let cursor = selectedIndex;
      const keys: string[] = [];
      for (const index of toggles) {
        keys.push(...navigationKeys(index - cursor), KEY.space);
        cursor = index;
      }
      // Current OMP advances/finishes the active question on Enter. Tab changes
      // the active question and would make that Enter answer a different row.
      // Enter on the Other row opens its text editor instead of advancing.
      if (cursor === customIndex) keys.push(KEY.up);
      keys.push(KEY.enter);
      return keySteps(keys);
    } } : {}),
  });
}

function parseOmpApproval(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const headerIndex = findLastIndex(lines, (line) => /^\s*Allow tool:\s*\S+/i.test(cleanLine(line)));
  if (headerIndex < 0) return null;
  const rows: MenuRow[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const match = cleanLine(lines[index]!).match(/^([›>❯•])?\s*(Approve|Deny)$/i);
    if (match) rows.push({ label: match[2]!, selected: Boolean(match[1]), checked: false, lineIndex: index });
  }
  if (rows.length !== 2 || rows.filter((row) => row.selected).length !== 1) return null;
  return finishPrompt("omp", {
    kind: "approval", title: cleanLine(lines[headerIndex]!), question: cleanLine(lines[headerIndex]!),
    body: lines.slice(headerIndex + 1, rows[0]!.lineIndex).map(cleanLine).filter(Boolean).join("\n") || null,
    options: rows.map((row) => ({ label: row.label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-approval", menuLabels: rows.map((row) => row.label),
    selectedIndex: rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

/**
 * omp's session-only model picker (omp 18.11.1), which `/switch` and Alt+P open: a box over the
 * bottom of the screen, with the screen's last line its bottom border —
 *
 *   ╭─ Switch Model ─────────────────────────────────────────────╮
 *   │  Session-only switch — role models stay unchanged           │
 *   │  🔍 >                                                       │
 *   │                                                             │
 *   │ ❯ anthropic/claude-opus-5-5 ●       5.5s 49t/s  1m ◫  $4/20█ │
 *   │   openai/gpt-6-sol                        1.1m ◫     $2/10│ │
 *   │   ───────────────────────────────────────────────────────   │
 *   │   openai/gpt-oss-120b                      131k ◫ $0.35/0.75│ │
 *   │                                                             │
 *   │   Claude Opus 5.5 · 1m ctx · 128k out · $4/20 per M · …     │
 *   │   ● current · ● default ⟳ · ○ smol · ○ slow                 │
 *   │ ↑/↓ models · ⏎ use for this session · type to search · @ quick roles · ⎋ close │
 *   ╰─────────────────────────────────────────────────────────────╯
 *
 * The rows are a window on the list, padded with blank lines to its height and followed by a
 * blank and two lines on the row under the cursor. A list longer than the window draws a
 * scrollbar after every row. `●` marks the model the session runs; a rule sets recent and role
 * models apart, and ↑/↓ step over it. A model whose window the conversation already overflows
 * says `⦸ context>131k`: omp compacts the conversation with the model in use before it switches.
 * Typing in the box filters the list. A leading `@` lists quick roles and Alt+P lists models for
 * task subagents: both change the status line or the title, and are not read here. omp's
 * `/model` opens its Models hub instead, which assigns roles, the default one saved for later
 * sessions, so no card answers it.
 */
const OMP_MODEL_TOP_RE = /^╭─ Switch Model ─/;
const OMP_MODEL_STATUS_RE = /^Session-only switch\b/;
/** the search box: omp's search icon, then what was typed */
const OMP_MODEL_SEARCH_RE = /^\S+ >(?: .*)?$/;
/** the footer, cut at the pane's edge on a phone */
const OMP_MODEL_HINT_RE = /^\S+ models · \S+ use for this session(?: ·|…|$)/;
const OMP_MODEL_BOTTOM_RE = /^╰─+╯$/;
/** a row: the cursor, `provider/id`, `●` on the model in use, then its figures */
const OMP_MODEL_ROW_RE = /^(❯ )?(\S+\/\S+)( ●)?(?: |$)/;
/** the scrollbar's thumb or track after a row */
const OMP_MODEL_SCROLLBAR_RE = /[█│]$/;
const OMP_MODEL_OVER_CONTEXT_RE = /⦸ context>(\S+)/;

function ompModelPicker(lines: string[]): { rows: { label: string; cursor: boolean; current: boolean; overContext: string | null }[]; more: boolean } | null {
  // the bottom border is the screen's last line: the picker is drawn over everything else
  let bottom = lines.length - 1;
  while (bottom >= 0 && !lines[bottom]!.trim()) bottom -= 1;
  if (bottom < 5 || !OMP_MODEL_BOTTOM_RE.test(lines[bottom]!.trim())) return null;
  const hint = bottom - 1;
  if (!OMP_MODEL_HINT_RE.test(cleanLine(lines[hint]!))) return null;
  const top = findLastIndex(lines, (line, index) => index < hint && OMP_MODEL_TOP_RE.test(line.trim()));
  if (top < 0 || !OMP_MODEL_STATUS_RE.test(cleanLine(lines[top + 1] ?? "")) || !OMP_MODEL_SEARCH_RE.test(cleanLine(lines[top + 2] ?? ""))) return null;
  // the search box and a blank over the rows; a blank and the two lines on the cursor's row under them
  const window = lines.slice(top + 4, hint - 3);
  if (window.length === 0 || cleanLine(lines[top + 3]!) || cleanLine(lines[hint - 3]!)) return null;
  const rows: { label: string; cursor: boolean; current: boolean; overContext: string | null }[] = [];
  let more = false;
  let padding = false;
  for (const raw of window) {
    const shown = cleanLine(raw);
    const line = shown.replace(OMP_MODEL_SCROLLBAR_RE, "").trimEnd();
    if (line !== shown) more = true;
    // the window's padding comes after its last row, never between two
    if (!line) { padding = true; continue; }
    if (padding) return null;
    if (isDivider(line)) continue;
    const row = OMP_MODEL_ROW_RE.exec(line);
    if (!row) return null;
    rows.push({ label: row[2]!, cursor: row[1] !== undefined, current: row[3] !== undefined, overContext: OMP_MODEL_OVER_CONTEXT_RE.exec(line)?.[1] ?? null });
  }
  return rows.filter((row) => row.cursor).length === 1 ? { rows, more } : null;
}

function parseOmpModel(screen: string): ParsedPrompt | null {
  const list = ompModelPicker(screen.replace(ANSI_RE, "").split(/\r?\n/));
  if (list === null) return null;
  const labels = list.rows.map((row) => row.label);
  const current = list.rows.find((row) => row.current);
  const asked = current ? own("Select model for this session (currently {model})", { model: current.label }) : own("Select model for this session");
  return finishPrompt("omp", {
    kind: "question",
    title: "",
    question: list.more ? own("{question}. More models are listed in the terminal.", { question: asked }) : asked,
    body: null,
    options: list.rows.map((row) => ({
      label: row.label,
      description: row.overContext === null ? null : own("The conversation is over its {context} context: omp compacts it first", { context: row.overContext }),
    })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "omp-model", menuLabels: labels, selectedIndex: list.rows.findIndex((row) => row.cursor), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

const OMP_HANDOFF_RE = /^\S\s+(Generating handoff…)\s+\((?:⎋|esc|escape)\s+to cancel\)$/i;

/**
 * omp's /handoff (18.8.7, same in 18.12.3) shows no dialog: one status line while it writes the
 * handoff document, which Esc cancels. Read only while that line is the live status, right above
 * omp's status bar and editor; a line left in the transcript above them is history.
 */
function parseOmpHandoff(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/).map((line) => line.trim());
  const index = findLastIndex(lines, (line) => OMP_HANDOFF_RE.test(line));
  if (index < 0) return null;
  const below = lines.slice(index + 1).filter(Boolean);
  if (below.length < 2 || !below[0]!.startsWith("π >") || !below.slice(1).every((line) => line.startsWith("╰─"))) return null;
  return finishPrompt("omp", {
    kind: "menu", title: own("Handoff"), question: OMP_HANDOFF_RE.exec(lines[index]!)![1]!, body: null,
    options: [{ label: own("Cancel"), description: null }], multi_select: false, custom_option_index: null,
  }, {
    responder: "omp-handoff", menuLabels: ["Cancel"], selectedIndex: 0,
    checkedOptionIndices: [], customMenuIndex: null, rejectWithEscapeIndex: 0,
  });
}

export const readers: readonly DialogReader[] = [
  {
    id: "omp-question", agents: ["omp"], priority: 10,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseOmpQuestion(screen);
      return parsed?.responder === "omp-question" ? parsed : null;
    },
  },
  {
    id: "omp-submit", agents: ["omp"], priority: 20,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseOmpSubmit(screen);
      return parsed?.responder === "omp-submit" ? parsed : null;
    },
  },
  {
    id: "omp-approval", agents: ["omp"], priority: 30,
    reread: "none", list: "none",
    parse: (screen) => {
      const parsed = parseOmpApproval(screen);
      return parsed?.responder === "omp-approval" ? parsed : null;
    },
  },
  {
    id: "omp-model", agents: ["omp"], priority: 40,
    // closed under the moves (Esc in the terminal), the picker leaves omp's input box, which takes
    // ↑/↓ as its history: every move after the first waits for the picker on the row before it
    reread: "each-move", list: "none",
    // ↑/↓ step over the rule between recent and other models, as the rows do. omp reorders its
    // rows when its catalogue refreshes under them, which the name under the cursor catches
    interaction: (parsed) => pickerPlan(parsed, parseOmpModel,
      parsed.options.map((_, index) => keySteps([...navigationKeys(index - parsed.selectedIndex), KEY.enter])),
      (shown, cursor) => shown.options[cursor]?.label),
    parse: (screen) => {
      const parsed = parseOmpModel(screen);
      return parsed?.responder === "omp-model" ? parsed : null;
    },
  },
  {
    // Esc only while the handoff is still being written: the loop reads the screen again first
    id: "omp-handoff", agents: ["omp"], priority: 40,
    reread: "before-commit", list: "none",
    parse: parseOmpHandoff,
  },
];
