import { expect, it } from "bun:test";
import { claudeCommandEcho } from "./claude.ts";

it("leaves nonmatching text and builtin echoes to existing handling", () => {
  for (const text of [
    "/probe-skill hello",
    "<command-message>probe-skill</command-message>",
    "<command-message>other</command-message><command-name>/probe-skill</command-name><command-args>hello</command-args>",
    "<command-message>compact</command-message><command-name>/compact</command-name><command-args></command-args>",
    "<command-message>config</command-message><command-name>/config</command-name><command-args>theme=dark</command-args>",
    "<command-message>heapdump</command-message><command-name>/heapdump</command-name><command-args></command-args>",
  ]) expect(claudeCommandEcho(text)).toBeNull();
});

it("records a bundled skill's echo, or that of a skill of the user's own named like one, as a skill", () => {
  expect(claudeCommandEcho("<command-message>code-review</command-message><command-name>/code-review</command-name><command-args>high</command-args>"))
    .toEqual({ text: "/code-review high", skill: { name: "code-review", evidence: "invocation", status: "requested" } });
  expect(claudeCommandEcho("<command-message>simplify</command-message><command-name>/simplify</command-name><command-args></command-args>")?.skill.name).toBe("simplify");
});

it("keeps angle brackets in the recorded arguments", () => {
  expect(claudeCommandEcho("<command-message>probe-skill</command-message>\n<command-name>/probe-skill</command-name>\n<command-args>read <path> if x < y</command-args>")?.text).toBe("/probe-skill read <path> if x < y");
});
