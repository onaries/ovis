/**
 * Find in one file's diff: the loaded patch read as logical lines, and the literal occurrences of a
 * query in them. The model is built from the whole patch git printed, never from the rows mounted
 * or from the context the viewer folds away, so a match is found wherever it sits in the patch.
 * Nothing outside the patch (the rest of the file) is searched.
 */

export type DiffSide = "old" | "new";
export type DiffLineKind = "context" | "addition" | "deletion";

/** One line of the patch: an unchanged line is one line, anchored to the new side, with both numbers kept. */
export interface DiffFindLine {
  side: DiffSide;
  /** the line number on `side` */
  line: number;
  kind: DiffLineKind;
  /** the old side's number (null for an addition) */
  oldLine: number | null;
  /** the new side's number (null for a deletion) */
  newLine: number | null;
  /** the line's text, without the patch's leading mark and a CRLF file's trailing carriage return */
  text: string;
}

/** One occurrence: its line, and zero-based columns `start` (inclusive) to `end` (exclusive) in that line's text. */
export interface DiffFindMatch extends DiffFindLine {
  start: number;
  end: number;
}

/** The find bar's query cap, the same as the terminal's find control. */
export const DIFF_FIND_MAX_QUERY = 1024;

/** A match's identity across renders, layouts and folds. */
export function matchKey(match: Pick<DiffFindMatch, "side" | "line" | "start">): string {
  return `${match.side}:${match.line}:${match.start}`;
}

/**
 * The patch's lines in patch order: every hunk's context, deleted and added lines, numbered as the
 * hunk header says. File headers, hunk headers, the lines between hunks and git's
 * `\ No newline at end of file` marker are left out; a hunk ends when its counts are used up.
 */
export function diffFindLines(patch: string | null): DiffFindLine[] {
  if (patch === null) return [];
  const lines: DiffFindLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split("\n")) {
    if (oldLeft <= 0 && newLeft <= 0) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (header === null) continue;
      oldLine = Number(header[1]);
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLine = Number(header[3]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      // an empty side starts before its first line (`-0,0`): its next line is 1
      if (oldLeft === 0) oldLine += 1;
      if (newLeft === 0) newLine += 1;
      continue;
    }
    if (raw.startsWith("\\")) continue;
    const mark = raw[0];
    const text = raw.slice(1).replace(/\r$/, "");
    if (mark === "+") {
      lines.push({ side: "new", line: newLine, kind: "addition", oldLine: null, newLine, text });
      newLine += 1; newLeft -= 1;
    } else if (mark === "-") {
      lines.push({ side: "old", line: oldLine, kind: "deletion", oldLine, newLine: null, text });
      oldLine += 1; oldLeft -= 1;
    } else if (mark === " " || raw === "") {
      // a blank unchanged line some tools print without its space
      lines.push({ side: "new", line: newLine, kind: "context", oldLine, newLine, text });
      oldLine += 1; newLine += 1; oldLeft -= 1; newLeft -= 1;
    }
  }
  return lines;
}

/**
 * Every non-overlapping occurrence of `query` in `lines`, case-sensitive and literal (no pattern
 * syntax), in patch order and from the left within a line. An empty query finds nothing; a query
 * past the find bar's cap is cut to it.
 */
export function findInDiff(lines: readonly DiffFindLine[], query: string): DiffFindMatch[] {
  const needle = query.slice(0, DIFF_FIND_MAX_QUERY);
  if (needle === "") return [];
  const matches: DiffFindMatch[] = [];
  for (const line of lines) {
    let from = 0;
    for (;;) {
      const start = line.text.indexOf(needle, from);
      if (start < 0) break;
      matches.push({ ...line, start, end: start + needle.length });
      from = start + needle.length;
    }
  }
  return matches;
}

/** The match after (or before) `index`, wrapping at either end; the first match when none is active. */
export function stepMatch(index: number | null, total: number, direction: 1 | -1): number | null {
  if (total === 0) return null;
  if (index === null) return direction === 1 ? 0 : total - 1;
  return (index + direction + total) % total;
}
