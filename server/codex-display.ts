import { parseMarkdown, type InlineNode, type MarkdownBlock } from "../shared/markdown.ts";
import { FOOTER } from "./codex-steering.ts";

/** A native completed-turn frame, including a reply clipped by the terminal's top edge. */
export function completedCodexAnswer(screen: string, footer: RegExp): { text: string; prompt: string | null; cropped: boolean } | null {
  const lines = screen.split("\n").map((line) => line.replace(/\r$/, ""));
  const rows = lines.map((line, at) => ({ line, at })).filter(({ line }) => line.trim() !== "");
  let composer = rows.length - 1;
  while (composer >= 0 && !rows[composer]!.line.startsWith("›")) composer--;
  if (composer < 0 || !/^›(?:\s+Ask Codex to do anything)?$/.test(rows[composer]!.line.trim())) return null;
  const status = rows.slice(composer + 1);
  if (status.length === 0 || status.length > 4 || !status.every(({ line }) => {
    const text = line.trim();
    const hint = /^(?:←[^·]*·\s*)?\?\s*for\s+([a-z]+)/.exec(text)?.[1];
    return FOOTER.test(text) || /^\S+(?:\s+\S+){0,2}\s+(?:default|minimal|none|low|medium|high|xhigh|max|ultra)(?:\s+fast)?\s*·/.test(text)
      || (hint !== undefined && hint.length >= 2 && "shortcuts".startsWith(hint));
  })) return null;
  let finished = composer - 1;
  while (finished >= 0 && /^\s*\d+ background terminals? running\b/.test(rows[finished]!.line)) finished--;
  const end = rows[finished];
  if (end === undefined || !footer.test(end.line) || lines[end.at - 1]?.trim() !== "") return null;
  let last = end.at - 1;
  while (last > 0 && lines[last - 1]!.trim() === "") last--;
  // Native hook diagnostics may follow the answer without being part of the saved message.
  while (last > 0) {
    let hook = last - 1;
    while (hook > 0 && /^(?:\s|$)/.test(lines[hook]!)) hook--;
    if (lines[hook]!.trimEnd() !== "• Hook failed" || !/^\s+└\s+\S/.test(lines[hook + 1] ?? "")) break;
    last = hook;
    while (last > 0 && lines[last - 1]!.trim() === "") last--;
  }
  if (last === 0) return null;
  let first = last - 1;
  while (first > 0 && /^(?:\s|$)/.test(lines[first]!)) first--;
  const complete = lines[first]!.startsWith("• ");
  if (!complete) {
    let prompt = last - 1;
    while (prompt >= 0 && !lines[prompt]!.startsWith("›")) prompt--;
    first = prompt < 0 ? 0 : prompt + 1;
    if (prompt >= 0) {
      while (first < last && lines[first]!.trim() !== "") first++;
      while (first < last && lines[first]!.trim() === "") first++;
    }
    if (first >= last || lines.slice(first, last).some((line) => line.trim() !== "" && !/^\s/.test(line))) return null;
  }
  const body = lines.slice(first, last).join("\n");
  if (/^\s*(?:›|↳|└|• (?:Ran|You ran|Called|Explored|Searched|Waited|Running|Calling|Exploring|Searching|Waiting|Working)\b)/m.test(body)) return null;
  let prompt = first - 1;
  while (prompt >= 0 && !lines[prompt]!.startsWith("›")) prompt--;
  return { text: complete ? body.slice(2) : body, prompt: prompt < 0 ? null : lines[prompt]!.slice(1).trim(), cropped: !complete };
}

function inline(nodes: readonly InlineNode[]): string | null {
  let text = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": case "code": text += node.value; break;
      case "strong": case "em": case "del": {
        const value = inline(node.children);
        if (value === null) return null;
        text += value;
        break;
      }
      case "link": case "file": {
        const value = inline(node.children);
        if (value === null) return null;
        const target = node.type === "link" ? node.href : node.path;
        text += value === target ? value : `[${value}](${target})`;
        break;
      }
      case "math": case "image": return null;
    }
  }
  return text;
}

function blocks(nodes: readonly MarkdownBlock[], bullet: string): string | null {
  const lines: string[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "heading": {
        const value = inline(node.content);
        if (value === null) return null;
        lines.push(value);
        break;
      }
      case "paragraph": {
        for (const line of node.lines) {
          const value = inline(line);
          if (value === null) return null;
          lines.push(value);
        }
        break;
      }
      case "list": {
        for (const [index, item] of node.items.entries()) {
          if (item.checked !== undefined) return null;
          const value = inline(item.content);
          if (value === null) return null;
          lines.push(`${node.ordered ? `${(node.start ?? 1) + index}.` : bullet} ${value}`);
          const nested = blocks(item.blocks ?? [], bullet);
          if (nested === null) return null;
          lines.push(nested);
        }
        break;
      }
      case "code": lines.push(node.value); break;
      case "table": case "blockquote": case "hr": case "math": return null;
    }
  }
  return lines.join("\n");
}

/** Known text-only TUI Markdown renderings; operators stay literal and unknown drawings tell nothing. */
export function codexMarkdownDisplays(text: string, tail = false): string[] {
  let parsed = parseMarkdown(text);
  if (tail) {
    let start = parsed.length;
    while (start > 0 && blocks(parsed.slice(start - 1), "•") !== null) start--;
    parsed = parsed.slice(start);
  }
  return [...new Set(["•", "-"].flatMap((bullet) => {
    const shown = blocks(parsed, bullet);
    return shown === null ? [] : [shown];
  }))];
}
