const LITERAL = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`';

function stringConstants(bindings: string): Map<string, string> | null {
  if (!/^(?:\s*const\s+[A-Za-z_$][\w$]*\s*=\s*"(?:[^"\\]|\\.)*"\s*;\s*)*\s*$/.test(bindings)) return null;
  const values = new Map<string, string>();
  for (const declaration of bindings.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*("(?:[^"\\]|\\.)*")\s*;/g)) {
    const name = declaration[1], value = declaration[2];
    if (name === undefined || value === undefined || values.has(name)) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "string") return null;
      values.set(name, parsed);
    }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; return null; }
  }
  return values;
}

/** Resolves adjacent string constants only; template expressions are never executed. */
export function constantTemplate(literal: string, bindings: string): string | null {
  if (!literal.startsWith("`") || !literal.endsWith("`") || literal.includes("\\")) return null;
  const values = stringConstants(bindings);
  if (values === null) return null;
  let unknown = false;
  const text = literal.slice(1, -1).replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (_token, name: string) => {
    const value = values.get(name);
    if (value === undefined) unknown = true;
    return value ?? "";
  });
  return unknown || text.includes("${") ? null : text;
}

/** Never evaluates code; only literal commands or proven prefixes name a shell call. */
export function execSummary(input: string): string | null {
  // Skip strings and comments outside calls so quoted examples never become command labels.
  const key = '(?:[A-Za-z_$][\\w$]*|"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\')';
  const property = `${key}\\s*:\\s*(?:${LITERAL}|-?\\d+(?:\\.\\d+)?|true|false|null)\\s*,\\s*`;
  const calls = new RegExp(`${LITERAL}|/\\*[\\s\\S]*?\\*/|//[^\\n]*|\\btools\\.exec_command\\(\\s*\\{\\s*(?:${property})*?(?:cmd|"cmd"|'cmd')\\s*:\\s*(${LITERAL})(?=\\s*[,}])`, "gs");
  const commands: string[] = [];
  for (const match of input.matchAll(calls)) {
    const literal = match[1];
    if (literal === undefined) continue;
    let command: string;
    if (literal.startsWith("`") && literal.includes("${")) {
      const prefix = input.slice(0, match.index);
      const marker = /(?:const\s+[A-Za-z_$][\w$]*\s*=\s*)?(?:text\s*\(\s*)?await\s*$/.exec(prefix);
      const option = `(?!cmd\\s*:)[A-Za-z_$][\\w$]*\\s*:\\s*(?:${LITERAL}|-?\\d+(?:\\.\\d+)?|true|false|null)`;
      const ending = new RegExp(`^\\s*(?:,\\s*${option})*\\s*,?\\s*\\}\\s*\\)`);
      if (!marker || !ending.test(input.slice(match.index + match[0].length))) continue;
      const resolved = constantTemplate(literal, prefix.slice(0, marker.index));
      if (resolved === null) continue;
      command = resolved;
    } else if (literal.startsWith('"')) {
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
  if (!commands.length) {
    const field = `${key}\\s*:\\s*(?:${LITERAL}|-?\\d+(?:\\.\\d+)?|true|false|null)`;
    const object = `\\{\\s*${field}(?:\\s*,\\s*${field})*\\s*,?\\s*\\}`;
    const mappedObjects = new RegExp(`^\\s*const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\[\\s*(${object}(?:\\s*,\\s*${object})*\\s*,?)\\s*\\]\\s*;\\s*(?:const\\s+[A-Za-z_$][\\w$]*\\s*=\\s*)?await\\s+Promise\\.(?:all|allSettled)\\(\\s*\\1\\.map\\(\\s*(?:async\\s+)?\\(?\\s*([A-Za-z_$][\\w$]*)\\s*\\)?\\s*=>\\s*(?:await\\s+)?tools\\.exec_command\\(\\s*\\3\\s*\\)\\s*\\)\\s*\\)\\s*;`).exec(input);
    if (mappedObjects?.[2] !== undefined) {
      const json = `[${mappedObjects[2]}]`.replace(/"(?:[^"\\]|\\.)*"|([A-Za-z_$][\w$]*)\s*:|,\s*(?=[}\]])/g,
        (token, name: string | undefined) => name !== undefined ? `${JSON.stringify(name)}:` : token.startsWith(",") ? "" : token);
      try {
        const rows: unknown = JSON.parse(json);
        if (Array.isArray(rows)) {
          for (const row of rows) {
            if (row !== null && typeof row === "object" && "cmd" in row && typeof row.cmd === "string" && row.cmd.trim()) commands.push(row.cmd.trim().replace(/\s+/g, " "));
          }
        }
      } catch { return null; }
    }
  }
  if (!commands.length) {
    const string = '"(?:[^"\\\\]|\\\\.)*"';
    const prefix = new RegExp(`^\\s*(?:const\\s+[A-Za-z_$][\\w$]*\\s*=\\s*${string}\\s*;\\s*)*`).exec(input)?.[0] ?? "";
    const bindings = stringConstants(prefix);
    const names = [...bindings?.keys() ?? []].map((name) => name.replaceAll("$", "\\$"));
    const boundOption = names.length ? `|(?:${names.join("|")})(?![\\w$])` : "";
    const option = `(?!cmd\\s*:)[A-Za-z_$][\\w$]*\\s*:\\s*(?:${string}|-?\\d+(?:\\.\\d+)?|true|false|null${boundOption})`;
    const mappedStrings = new RegExp(`^\\s*const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*\\[\\s*(${string}(?:\\s*,\\s*${string})*\\s*,?)\\s*\\]\\s*;\\s*(?:const\\s+[A-Za-z_$][\\w$]*\\s*=\\s*)?await\\s+Promise\\.(?:all|allSettled)\\(\\s*\\1\\.map\\(\\s*(?:async\\s+)?\\(?\\s*([A-Za-z_$][\\w$]*)\\s*\\)?\\s*=>\\s*(?:await\\s+)?tools\\.exec_command\\(\\s*\\{\\s*(?:cmd\\s*:\\s*\\3|(?=cmd\\s*[,}])\\3)(?:\\s*,\\s*${option})*\\s*,?\\s*\\}\\s*\\)\\s*\\)\\s*\\)\\s*;`).exec(input.slice(prefix.length));
    if (mappedStrings?.[2] !== undefined && bindings !== null && !bindings.has("tools") && !bindings.has("Promise")
      && !bindings.has(mappedStrings[1] ?? "") && !bindings.has(mappedStrings[3] ?? "")) {
      try {
        const rows: unknown = JSON.parse(`[${mappedStrings[2].replace(/,\s*$/, "")}]`);
        if (Array.isArray(rows)) {
          for (const row of rows) if (typeof row === "string" && row.trim()) commands.push(row.trim().replace(/\s+/g, " "));
        }
      } catch { return null; }
    }
  }
  if (!commands.length) {
    const id = "[A-Za-z_$][\\w$]*";
    const string = '"(?:[^"\\\\]|\\\\.)*"';
    const value = `(?:${LITERAL}|${id}(?:\\.${id})*|load\\(\\s*(?:${LITERAL})\\s*\\))`;
    const option = `(?!cmd\\s*:)${id}\\s*:\\s*(?:${string}|-?\\d+(?:\\.\\d+)?|true|false|null)`;
    const bound = new RegExp(`${LITERAL}|/\\*[\\s\\S]*?\\*/|//[^\\n]*|\\bconst\\s+(${id})\\s*=\\s*(${string})((?:\\s*\\+\\s*${value})*)\\s*;\\s*(?:text\\(\\s*)?await\\s+tools\\.exec_command\\(\\s*\\{\\s*cmd\\s*:\\s*\\1(?:\\s*,\\s*${option})*\\s*,?\\s*\\}\\s*\\)\\s*\\)?\\s*;`, "gs");
    const sites = execToolCalls(input);
    for (const match of input.matchAll(bound)) {
      const argumentsAt = match.index + match[0].lastIndexOf("tools.exec_command(") + "tools.exec_command(".length;
      if (!sites.some((site) => site.name === "exec_command" && site.argumentsAt === argumentsAt)) continue;
      const literal = match[2];
      if (literal === undefined) continue;
      let command: string;
      try { command = JSON.parse(literal); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; continue; }
      const prefix = command.trimStart().match(/^[\w./-]+(?:[ \t]+-[A-Za-z]+)?(?=\s)/)?.[0];
      if (match[3]) {
        if (prefix !== undefined) commands.push(`${prefix} …`);
      } else if (command.trim()) commands.push(command.trim().replace(/\s+/g, " "));
    }
  }
  return commands.length ? commands.join(" · ").slice(0, 120) : null;
}

export function execToolCalls(input: string): { name: string; argumentsAt: number }[] {
  const calls = new RegExp(`${LITERAL}|/\\*[\\s\\S]*?\\*/|//[^\\n]*|/(?:\\\\.|[^/\\\\\\n])+/[dgimsuvy]*(?=\\s*(?:[;,.()\\]}]|$))|(?<![\\w$.])tools\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
  return [...input.matchAll(calls)].flatMap((match) => match[1] === undefined ? [] : [{ name: match[1], argumentsAt: match.index + match[0].length }]);
}

export function execToolSummary(input: string): string | null {
  const names = new Set(execToolCalls(input).map((call) => call.name));
  if (names.size === 0) {
    const printed = /^\s*(?:const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+?)\s*;\s*text\s*\(\s*\1\s*\)|text\s*\(\s*([\s\S]+?)\s*\))\s*;?\s*$/.exec(input);
    const expression = printed?.[2] ?? printed?.[3];
    const catalog = expression === undefined ? null : /^ALL_TOOLS\s*\.\s*filter\s*\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\/((?:\\.|[^/\\\n])+)\/[dgimsuvy]*\s*\.\s*test\s*\(\s*\1\.name\s*\+\s*(?:" "|' ')\s*\+\s*\1\.description\s*\)\s*\)(?:\s*\.\s*slice\s*\(\s*\d+\s*,\s*\d+\s*\))?\s*$/.exec(expression);
    return catalog ? `Search tools: ${catalog[2]}`.slice(0, 120) : null;
  }
  return names.size > 0 ? [...names].join(" · ").slice(0, 120) : null;
}
