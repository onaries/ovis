import type { SkillActivity } from "../../shared/protocol.ts";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * Grok 1.0.67's TUI marks a prompt that ran a skill with `displayAsSkill` on the chunk's content;
 * the expanded body stays out of the update log. Print mode (`grok -p`) records no mark.
 */
export function grokPromptSkill(content: unknown): SkillActivity | null {
  const meta = record(record(content)._meta);
  if (meta.displayAsSkill !== true || typeof meta.displayText !== "string") return null;
  const name = /^\/([\p{L}\p{N}_.:-]{1,200})(?:\s|$)/u.exec(meta.displayText)?.[1];
  return name ? { name, evidence: "invocation", status: "requested" } : null;
}
