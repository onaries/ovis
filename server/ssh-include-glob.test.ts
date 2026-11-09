import { expect, it } from "bun:test";

import { matchComponent, parseComponent, type Token } from "./ssh-include-glob.ts";

const tokensOf = (pattern: string): Token[] => {
  const parsed = parseComponent(pattern, true);
  if (parsed === null || !("tokens" in parsed)) throw new Error(`not a pattern: ${pattern}`);
  return parsed.tokens;
};

it("charges every range a bracket expression tries to the matching budget", () => {
  expect(matchComponent(tokensOf(`*[${"a".repeat(5000)}]`), "x".repeat(50), { steps: 100_000 })).toBeNull();
});

it("leaves a match of `?` or a bracket expression against a name beyond ASCII unknown, as ssh's locale decides it", () => {
  expect(matchComponent(tokensOf("?.conf"), "é.conf", { steps: 1000 })).toBeNull();
  expect(matchComponent(tokensOf("[!a].conf"), "é.conf", { steps: 1000 })).toBeNull();
  expect(matchComponent(tokensOf("*.conf"), "é.conf", { steps: 1000 })).toBe(true);
});

it("reads a `[` no `]` closes as itself, as glibc's glob does", () => {
  expect(parseComponent("alice[work", true)).toEqual({ name: "alice[work" });
  expect(parseComponent("x[*", true)).toEqual({ tokens: [{ kind: "char", char: "x" }, { kind: "char", char: "[" }, { kind: "star" }] });
});
