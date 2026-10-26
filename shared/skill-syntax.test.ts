import { describe, expect, it } from "bun:test";

import { DEFAULT_SKILL_SYNTAX, SKILL_SYNTAX, skillSyntax } from "./skill-syntax.ts";
import { SUPPORTED_AGENT_KINDS } from "./supported-agents.ts";

describe("skillSyntax", () => {
  it("has an explicit row for every supported agent and Command Code", () => {
    expect(Object.keys(SKILL_SYNTAX).sort()).toEqual([...SUPPORTED_AGENT_KINDS, "cmd"].sort());
    for (const agent of SUPPORTED_AGENT_KINDS) {
      expect(SKILL_SYNTAX[agent]).toBe(skillSyntax(agent));
    }
  });

  it("never offers dollar skills for omp", () => {
    const syntax = skillSyntax("omp");
    expect(syntax.skillTriggers).toEqual(["/"]);
    expect(syntax.inline).not.toContain("$");
  });

  it("uses the default syntax for missing or unknown agents", () => {
    for (const agent of [null, undefined, "", "unknown", "toString"]) {
      expect(skillSyntax(agent)).toBe(DEFAULT_SKILL_SYNTAX);
    }
  });
});
