const LITERAL = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`';

/** Literal code-mode commands only; no script is evaluated and dynamic expressions stay unnamed. */
export function execSummary(input: string): string | null {
  // Skip strings and comments outside calls so quoted examples never become command labels.
  const key = '(?:[A-Za-z_$][\\w$]*|"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')';
  const property = `${key}\\s*:\\s*(?:${LITERAL}|-?\\d+(?:\\.\\d+)?|true|false|null)\\s*,\\s*`;
  const calls = new RegExp(`${LITERAL}|/\\*[\\s\\S]*?\\*/|//[^\\n]*|\\btools\\.exec_command\\(\\s*\\{\\s*(?:${property})*?(?:cmd|"cmd"|'cmd')\\s*:\\s*(${LITERAL})(?=\\s*[,}])`, "gs");
  const commands: string[] = [];
  for (const match of input.matchAll(calls)) {
    const literal = match[1];
    if (literal === undefined || literal.startsWith("`") && literal.includes("${")) continue;
    let command: string;
    if (literal.startsWith('"')) {
      try { command = JSON.parse(literal); }
      catch { continue; }
    } else {
      command = literal.slice(1, -1).replace(/\\(['`])/g, "$1");
    }
    if (command.trim()) commands.push(command.trim().replace(/\s+/g, " "));
  }
  if (!commands.length) {
    // Only resolve an unchanged literal list mapped directly into the command argument.
    const mapped = input.match(/^\s*const\s+([\w$]+)\s*=\s*\[((?:\s*\[\s*"(?:[^"\\]|\\.)*"\s*,\s*"(?:[^"\\]|\\.)*"\s*,\s*\d+\s*\]\s*,?)+)\]\s*;\s*const\s+[\w$]+\s*=\s*await\s+Promise\.all\(\s*\1\.map\(\s*async\s*\(\s*\[\s*([\w$]+)\s*,\s*([\w$]+)\s*,\s*([\w$]+)\s*\]\s*\)\s*=>\s*\{\s*const\s+[\w$]+\s*=\s*await\s+tools\.exec_command\(\s*\{\s*(?:cmd\s*:\s*\4|(?=cmd\s*[,}])\4)\s*[,}]/);
    if (mapped) {
      try {
        const rows: unknown = JSON.parse(`[${mapped[2]!.replace(/,\s*$/, "")}]`);
        if (Array.isArray(rows)) {
          for (const row of rows) {
            if (Array.isArray(row) && typeof row[1] === "string" && row[1].trim()) commands.push(row[1].trim().replace(/\s+/g, " "));
          }
        }
      } catch { return null; }
    }
  }
  return commands.length ? commands.join(" · ").slice(0, 120) : null;
}

export function execToolCalls(input: string): { name: string; argumentsAt: number }[] {
  const calls = new RegExp(`${LITERAL}|/\\*[\\s\\S]*?\\*/|//[^\\n]*|/(?:\\\\.|[^/\\\\\\n])+/[dgimsuvy]*(?=\\s*(?:[;,.()\\]}]|$))|(?<![\\w$.])tools\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
  return [...input.matchAll(calls)].flatMap((match) => match[1] === undefined ? [] : [{ name: match[1], argumentsAt: match.index + match[0].length }]);
}

export function execToolSummary(input: string): string | null {
  const names = new Set(execToolCalls(input).map((call) => call.name).filter((name) => name !== "exec_command" && name !== "apply_patch"));
  return names.size > 0 ? [...names].join(" · ").slice(0, 120) : null;
}
