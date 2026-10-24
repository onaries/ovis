import { expect, it } from "bun:test";
import { parseCodexTranscript } from "./codex.ts";
import { toolVerb } from "../src/lib/toolVerbs.ts";

const parse = (input: string) => parseCodexTranscript(JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "one", name: "exec", input } }))[0]?.parts[0];
it("names code-mode shell commands rather than only exec, including parallel calls", () => {
  const input = 'await Promise.all([tools.exec_command({cmd:"git status --short",workdir:"/repo"}), tools.exec_command({"workdir":"/repo","cmd":"bun test"})]);';
  const part = parse(input);
  expect(part).toMatchObject({ name: "exec", summary: "git status --short · bun test", input });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(toolVerb(part, part.summary)).toBe("Ran");
});
it("does not invent a shell command from comments, quoted examples or dynamic arguments", () => {
  for (const input of ['// tools.exec_command({cmd:"fake"})', 'const example = "tools.exec_command({cmd:\"fake\"})";', 'await tools.exec_command({cmd: command})', 'await tools.exec_command({description:"cmd: \'fake\'",cmd: command})', 'await tools.exec_command({cmd:`echo ${secret}`})']) {
    expect(parse(input)).toMatchObject({ summary: "exec" });
  }
});
it("decodes literal commands without executing the script and preserves patch summaries", () => {
  expect(parse('await tools.exec_command({cmd:"echo ${HOME}"})')).toMatchObject({ summary: "echo ${HOME}" });
  for (const input of ["await tools.exec_command({cmd:'git status --short'})", 'await tools.exec_command({cmd:`git status --short`})']) {
    expect(parse(input)).toMatchObject({ summary: "git status --short" });
  }
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch";
  expect(parse(`await tools.apply_patch(${JSON.stringify(patch)}); await tools.exec_command({cmd:"bun test"});`)).toMatchObject({ summary: "src/a.ts" });
});
