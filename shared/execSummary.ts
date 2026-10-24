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
  return commands.length ? commands.join(" · ").slice(0, 120) : null;
}
