import type { SkillActivity } from "../../shared/protocol.ts";

/** The skills a session's `cogs_json` keeps active: Devin 3000.11 adds one `skill/<name>` cog per invoked skill. */
export function devinSessionSkills(cogs: unknown): Set<string> {
  const names = new Set<string>();
  if (typeof cogs !== "string" || cogs.length > 8 * 1024 * 1024) return names;
  let value: unknown;
  try { value = JSON.parse(cogs); } catch { return names; }
  for (const cog of Array.isArray(value) ? value : []) {
    const lifetime: unknown = typeof cog === "object" && cog !== null && "lifetime" in cog ? cog.lifetime : null;
    const unique: unknown = typeof lifetime === "object" && lifetime !== null && "Unique" in lifetime ? lifetime.Unique : null;
    const name = typeof unique === "string" ? /^skill\/([^\s/<>]{1,200})$/.exec(unique)?.[1] : undefined;
    if (name) names.add(name);
  }
  return names;
}

/** A typed `/name` Devin expanded into the stored content, for a skill the session records. */
export function devinPromptSkill(content: string, typed: string, skills: ReadonlySet<string>): SkillActivity | null {
  if (typed === content) return null;
  const name = /^\/([^\s/<>]{1,200})(?:\s|$)/.exec(typed)?.[1];
  return name && skills.has(name) ? { name, evidence: "instructions", status: "loaded" } : null;
}

/** Devin's `skill` tool names the skill it invokes in `skill`. */
export function devinToolSkill(name: string, args: Record<string, unknown>, status: unknown): SkillActivity | null {
  if (name !== "skill" || typeof args.skill !== "string" || !/^[^\s/<>]{1,200}$/.test(args.skill)) return null;
  return { name: args.skill, evidence: "invocation", status: status === "completed" ? "loaded" : status === "error" || status === "failed" ? "failed" : "requested" };
}

/** Devin's recorded ACP blocks retain the user's input before skill expansion. */
export function devinUserText(content: string, metadata: unknown): string {
  if (typeof metadata !== "object" || metadata === null || !("extensions" in metadata)) return content;
  const extensions = metadata.extensions;
  if (typeof extensions !== "object" || extensions === null || !("chisel/acp-content-blocks" in extensions)) return content;
  const blocks = extensions["chisel/acp-content-blocks"];
  if (!Array.isArray(blocks) || blocks.length !== 1) return content;
  const block: unknown = blocks[0];
  if (typeof block !== "object" || block === null || !("type" in block) || block.type !== "text" || !("text" in block) || typeof block.text !== "string") return content;
  return /^\/[\p{L}\p{N}_:-]+(?:\s|$)/u.test(block.text) ? block.text : content;
}
