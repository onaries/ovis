import { expect, it } from "bun:test";
import { parseCodexTranscript } from "./codex.ts";
import { toolVerb } from "../src/lib/toolVerbs.ts";
import { workRowLabel } from "../src/lib/workRowLabel.ts";

const parse = (input: string) => parseCodexTranscript(JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "one", name: "exec", input } }))[0]?.parts[0];
it("shows nested image and terminal calls instead of an exec-only heading", () => {
  const input = 'for (const name of ["phone.png", "desktop.png"]) { const r = await tools.view_image({path:"/repo/evidence/" + name}); image(r.image_url); } text(await tools.write_stdin({session_id:51623,chars:""}));';
  const part = parse(input);
  expect(part).toMatchObject({ name: "exec", summary: "view_image · write_stdin", input, call_id: "one" });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(toolVerb(part, part.summary)).toBeNull();
  expect(workRowLabel(part, part.summary)).toEqual({ narration: true, verb: null });
  expect(parse('await tools.view_image({path: file}); await tools.view_image({path: other});')).toMatchObject({ summary: "view_image" });
  expect(parse('await tools.write_stdin({session_id: id,chars:"continue"});')).toMatchObject({ summary: "write_stdin" });
  expect(parse('await tools.web__run({search_query: queries});')).toMatchObject({ summary: "web__run" });
});
it("does not name nested tools mentioned only as data or a property", () => {
  for (const input of ['// tools.view_image({path:"fake"})', '/* tools.write_stdin({}) */', 'const example = "tools.view_image({})";', 'const example = `tools.view_image({})`;', 'const pattern = /tools.view_image({})/g;', 'other.tools.view_image({});', 'tools.view_image;', 'tools[name]({});']) {
    expect(parse(input)).toMatchObject({ summary: "exec" });
  }
});
it("names code-mode shell commands rather than only exec, including parallel calls", () => {
  const input = 'await Promise.all([tools.exec_command({cmd:"git status --short",workdir:"/repo"}), tools.exec_command({"workdir":"/repo","cmd":"bun test"})]);';
  const part = parse(input);
  expect(part).toMatchObject({ name: "exec", summary: "git status --short · bun test", input });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(toolVerb(part, part.summary)).toBe("Ran");
});
it("names commands from a literal list directly mapped to exec_command", () => {
  const input = 'const cmds = [["one", "nl -ba src/a.py", 20000], ["two", "rg -n todo src", 30000]];\nconst rs = await Promise.all(cmds.map(async ([n, c, m]) => { const x = await tools.exec_command({cmd: c, workdir: "/repo", max_output_tokens: m}); return {n, o:x.output}; }));\nfor (const r of rs) text(r.o);';
  const part = parse(input);
  expect(part).toMatchObject({ summary: "nl -ba src/a.py · rg -n todo src" });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(toolVerb(part, part.summary)).toBe("Ran");
  expect(parse(input.replace('[n, c, m]', '[n, cmd, m]').replace('cmd: c', 'cmd'))).toMatchObject({ summary: "nl -ba src/a.py · rg -n todo src" });
  expect(parse(input.replace('cmd: c', 'cmd: other'))).toMatchObject({ summary: "exec_command" });
  expect(parse(input.replace('const rs =', 'cmds.reverse(); const rs ='))).toMatchObject({ summary: "exec_command" });
  expect(parse('const cmds = [["one", "do not execute", 1]];')).toMatchObject({ summary: "exec" });
});
it("does not invent a shell command from comments, quoted examples or dynamic arguments", () => {
  for (const input of ['// tools.exec_command({cmd:"fake"})', 'const example = "tools.exec_command({cmd:\"fake\"})";', 'await tools.exec_command({cmd: command})', 'await tools.exec_command({description:"cmd: \'fake\'",cmd: command})', 'await tools.exec_command({cmd:`echo ${secret}`})']) {
    expect(parse(input)).toMatchObject({ summary: input.startsWith("await ") ? "exec_command" : "exec" });
  }
});
it("names literal command objects passed unchanged through a parallel map", () => {
  const commands = [
    { cmd: "ssh host 'cat /tmp/final.json' ", workdir: "/repo", yield_time_ms: 10000, max_output_tokens: 12000 },
    { cmd: 'ssh host \'echo "cmd: example"; echo $(date)\'', workdir: "/repo", max_output_tokens: 6000 },
  ];
  const rows = JSON.stringify(commands).replace(/"(cmd|workdir|yield_time_ms|max_output_tokens)":/g, "$1:");
  const input = `const cmds=${rows};\nconst rs=await Promise.allSettled(cmds.map(c=>tools.exec_command(c)));\nfor(const r of rs) text(r);`;
  const part = parse(input);
  expect(part).toMatchObject({ summary: commands.map(({ cmd }) => cmd.trim()).join(" · ").slice(0, 120) });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(toolVerb(part, part.summary)).toBe("Ran");
  expect(parse(input.replace("allSettled", "all"))).toMatchObject({ summary: part.summary });
  for (const invalid of [
    `const cmds=${rows};`,
    input.replace("tools.exec_command(c)", "tools.exec_command(other)"),
    input.replace("cmds.map", "other.map"),
    input.replace("const rs=", "cmds.reverse(); const rs="),
    input.replace('cmd:"', 'cmd:dynamic+"'),
    `const example=${JSON.stringify(input)};`,
  ]) expect(parse(invalid)).toMatchObject({ summary: invalid.includes("tools.exec_command") && !invalid.startsWith("const example=") ? "exec_command" : "exec" });
});
it("names dynamic shell and patch tools without claiming their generated commands or files", () => {
  const input = 'const files=[["a.ts","old","new"]]; let p="*** Begin Patch\\n"; for (const [f,a,b] of files) { const r=await tools.exec_command({cmd:`rg -F ${a} ${f}`}); p+=r.output; } p+="*** End Patch"; text(await tools.apply_patch(p));';
  const part = parse(input);
  expect(part).toMatchObject({ summary: "exec_command · apply_patch" });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(workRowLabel(part, part.summary)).toEqual({ narration: true, verb: null });
});
it("decodes literal commands without executing the script and preserves patch summaries", () => {
  expect(parse('await tools.exec_command({cmd:"echo ${HOME}"})')).toMatchObject({ summary: "echo ${HOME}" });
  for (const input of ["await tools.exec_command({cmd:'git status --short'})", 'await tools.exec_command({cmd:`git status --short`})']) {
    expect(parse(input)).toMatchObject({ summary: "git status --short" });
  }
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch";
  expect(parse(`await tools.apply_patch(${JSON.stringify(patch)}); await tools.exec_command({cmd:"bun test"});`)).toMatchObject({ summary: "src/a.ts" });
  expect(parse('await tools.exec_command({cmd:"bun test"}); await tools.view_image({path:file});')).toMatchObject({ summary: "bun test" });
});

it("shows the edited file when a code-mode patch is passed by constant", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch";
  const part = parse(`const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`);
  expect(part).toMatchObject({ name: "exec", summary: "src/a.ts" });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(toolVerb(part, part.summary)).toBe("Edited");
});
