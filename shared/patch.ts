/**
 * Codex's file edits: an `apply_patch` call carries the patch as its whole input, and the
 * `exec` tool's scripts carry it as the string argument of `tools.apply_patch(…)`. Both
 * read as a raw blob unless the patch is found and its files named.
 */

import { execToolCalls } from "./execSummary.ts";

const BEGIN = "*** Begin Patch";

/** The patch an edit call carries, or null when the input is not one. */
export function patchText(input: string): string | null {
  const trimmed = input.trimStart();
  if (trimmed.startsWith(BEGIN)) return trimmed;
  const call = /tools\.apply_patch\(\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/s.exec(input);
  let literal = call?.[1];
  if (literal === undefined) {
    for (const tool of execToolCalls(input)) {
      if (tool.name !== "apply_patch") continue;
      const argument = /^\s*([A-Za-z_$][\w$]*)\s*\)/.exec(input.slice(tool.argumentsAt));
      if (!argument) continue;
      const tokens = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*|\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)\s*;/g;
      const declarations = [...input.slice(0, tool.argumentsAt).matchAll(tokens)].filter((match) => match[1] === argument[1]);
      if (declarations.length === 1) literal = declarations[0]?.[2];
      if (literal !== undefined) break;
    }
  }
  if (literal === undefined) return null;
  let text: string;
  if (literal.startsWith("`")) {
    if (literal.includes("${")) return null;
    text = literal.slice(1, -1).replace(/\\`/g, "`");
  }
  else {
    try { text = JSON.parse(literal) as string; } catch { return null; }
  }
  return text.trimStart().startsWith(BEGIN) ? text.trimStart() : null;
}

/** The files a patch adds, updates or deletes, in the order it names them. */
export function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
    const file = match[1]!.trim();
    if (!files.includes(file)) files.push(file);
  }
  return files;
}
