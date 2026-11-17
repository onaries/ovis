import type { ConversationPart, SlashCommand } from "../../shared/protocol.ts";
import { DEFAULT_SKILL_SYNTAX, type SkillSyntax } from "../../shared/skill-syntax.ts";

/** One skill name as an answer spells it: `/name`, or `$name` for a Codex skill. */
export interface SkillMention {
  /** the exact text in the answer, trigger included: what a copy yields */
  raw: string;
  name: string;
}

export type SkillSplit = string | SkillMention;

/** OmO replaces a selected token in its recorded request; only its loaded instruction proves that replacement. */
export function skillRequestText(text: string, parts: readonly ConversationPart[]): string {
  for (const part of parts) {
    if (part.kind === "skill" && part.skill.evidence === "instructions" && part.skill.status === "loaded") {
      text = text.replaceAll(`[skill: ${part.skill.name}]`, `$skill:${part.skill.name}`);
    }
  }
  return text;
}

/** Splits plain answer text around the skill names in it; null when the pane lists no skill. */
export type SkillMatcher = (text: string) => SkillSplit[];

/** A name does not start inside a word, a path or an address. */
const BEFORE = /[\w/.:~$@#\\-]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches only skills the pane's command list names, whole, in the form they are typed (`/name`;
 * `$name` for a Codex skill). A bare word never matches, nor does a longer name that merely starts
 * with a skill's (`/review-all` for `review`), a path (`/review/x`, `a/review`) or a file (`/review.md`).
 */
export function createSkillMatcher(commands: readonly SlashCommand[], syntax: SkillSyntax = DEFAULT_SKILL_SYNTAX): SkillMatcher | null {
  const names = new Map<string, string>();
  /** omo's placeholder `[skill: name]`: bracketed, so it needs neither the leading nor the trailing guard */
  const bracketed = new Map<string, string>();
  for (const command of commands) {
    if (command.source !== "skill" || command.name === "") continue;
    const trigger = command.trigger ?? "/";
    // an OpenCode v2 skill is sent as `@name` (compose.ts atSkillReplacement)
    names.set(trigger + command.name, command.name);
    if (command.name.startsWith("skill:") && command.name.length > "skill:".length) {
      for (const form of syntax.chipForms) {
        const raw = form.replace("{bare}", command.name.slice("skill:".length));
        (raw.startsWith("[") && raw.endsWith("]") ? bracketed : names).set(raw, command.name);
      }
    }
  }
  if (names.size === 0) return null;
  // longest first, so `/review-pr` is not cut at a skill named `review`
  const alternatives = [...names.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const bracketAlternatives = [...bracketed.keys()].map(escapeRegExp).join("|");
  const source = `(?:${alternatives})(?![\\w:/-]|\\.\\w)`;
  const pattern = new RegExp(bracketAlternatives === "" ? source : `${source}|${bracketAlternatives}`, "g");
  return (text) => {
    const out: SkillSplit[] = [];
    let cursor = 0;
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const start = match.index;
      const raw = match[0];
      const bracket = bracketed.get(raw);
      if (bracket === undefined && start > 0 && BEFORE.test(text[start - 1] ?? "")) continue;
      if (start > cursor) out.push(text.slice(cursor, start));
      out.push({ raw, name: bracket ?? names.get(raw) ?? raw.slice(1) });
      cursor = start + raw.length;
    }
    if (cursor === 0) return [text];
    if (cursor < text.length) out.push(text.slice(cursor));
    return out;
  };
}
