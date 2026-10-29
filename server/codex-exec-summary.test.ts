import { expect, it } from "bun:test";
import { parseCodexTranscript } from "./codex.ts";
import { toolVerb } from "../src/lib/toolVerbs.ts";
import { workRowLabel } from "../src/lib/workRowLabel.ts";

const parse = (input: string) => parseCodexTranscript(JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", call_id: "one", name: "exec", input } }))[0]?.parts[0];
it("names a printed tool catalog search without executing its predicate", () => {
  const input = 'const matches = ALL_TOOLS.filter(x => /confluence|atlassian/i.test(x.name + " " + x.description));\ntext(matches);';
  const part = parse(input);
  expect(part).toMatchObject({ summary: "Search tools: confluence|atlassian", input });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(workRowLabel(part, part.summary)).toEqual({ narration: true, verb: null });
  for (const other of [
    `const example = ${JSON.stringify(input)};`,
    `/* ${input} */`,
    `// ${input.replaceAll("\n", "\n// ")}`,
    input.replace("ALL_TOOLS", "other.ALL_TOOLS"),
    input.replace("text(matches)", "text(other)"),
    input.replace('x.name + " " + x.description', 'change() + x.description'),
    input.replace("const matches", "let matches"),
  ]) expect(parse(other)).toMatchObject({ summary: "exec" });
  expect(parse(input + '\nawait tools.view_image({path:file});')).toMatchObject({ summary: "view_image" });
});

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
it("names literal strings mapped to the command property, including shorthand", () => {
  const commands = [
    'ssh -x -o ClearAllForwardings=yes -o BatchMode=yes -o ConnectTimeout=8 macbook \'mount | grep -i -E "nucbox|macfuse|sshfs"\' </dev/null',
    'ssh -x -o ClearAllForwardings=yes -o BatchMode=yes -o ConnectTimeout=8 macbook \'stat -f "%N %HT %Su" /Users/safemotion/nucbox-projects\' </dev/null',
  ];
  const input = `const cmds=${JSON.stringify(commands)};const r=await Promise.all(cmds.map(cmd=>tools.exec_command({cmd,yield_time_ms:10000,max_output_tokens:1000}))); for(let i=0;i<r.length;i++) text(JSON.stringify({idx:i,...r[i]}));`;
  const summary = commands.join(" · ").slice(0, 120);
  expect(parse(input)).toMatchObject({ summary });
  expect(toolVerb({ name: "exec", input }, summary)).toBe("Ran");
  expect(parse('const cmds=["git status", "bun test",];await Promise.all(cmds.map(cmd=>tools.exec_command({cmd})));')).toMatchObject({ summary: "git status · bun test" });
  expect(parse(input.replace("all(", "allSettled(").replace("map(cmd=>", "map(async (c)=>").replace("({cmd,", "({cmd:c,"))).toMatchObject({ summary });
  for (const invalid of [
    input.replace("const r=", "cmds.reverse();const r="),
    input.replace("{cmd,", "{cmd:other,"),
    input.replace("cmds.map", "other.map"),
    input.replace("{cmd,", '{cmd,cmd:"different",'),
    input.replace("{cmd,", "{cmd,...options,"),
    input.replace("yield_time_ms:10000", "yield_time_ms:change(cmds)"),
    input.replace("yield_time_ms:10000", "workdir:`${change(cmds)}`"),
    input.replace(JSON.stringify(commands), '["literal",dynamic]'),
    `const example=${JSON.stringify(input)};`,
  ]) expect(parse(invalid)).toMatchObject({ summary: invalid.startsWith("const example=") ? "exec" : "exec_command" });
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

it("shows a proven command prefix for a concatenated constant passed directly to exec_command", () => {
  const input = String.raw`const summary=JSON.parse(load("folderPatinaSummaryOutput").trim());store("folderPatinaSummary",summary);
if(load("folderPatinaExit")!==0||summary.ok!==true||summary.status!=="verified"||summary.exitCode!==0)throw Error("Patina verification failed");
const command="node -e 'const fs=require(\"node:fs\"),crypto=require(\"node:crypto\");const r=JSON.parse(fs.readFileSync(\""+summary.receiptPath+"\",\"utf8\"));console.log(JSON.stringify({keys:Object.keys(r),status:r.status,exitCode:r.exitCode,sourceHash:r.sourceHash,outputHash:r.outputHash,completedAt:r.completedAt}));const hash=p=>crypto.createHash(\"sha256\").update(fs.readFileSync(p)).digest(\"hex\");if(hash(\""+load("folderDocDraft")+"\")!==\""+summary.sourceHash+"\"||hash(\""+summary.outputPath+"\")!==\""+summary.outputHash+"\")throw Error(\"Patina file hash mismatch\");'\ndiff -u "+load("folderDocDraft")+" "+summary.outputPath;
text(await tools.exec_command({cmd:command,max_output_tokens:3500}));`;
  const part = parse(input);
  expect(part).toMatchObject({ summary: "node -e …", input });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(toolVerb(part, part.summary)).toBe("Ran");
  expect(parse('const command="git status --short";text(await tools.exec_command({cmd:command}));')).toMatchObject({ summary: "git status --short" });
  for (const invalid of [
    input.replace("cmd:command", "cmd:other"),
    input.replace("text(await", 'other();text(await'),
    input.replace("{cmd:command,", '{cmd:command,cmd:"different",'),
    input.replace("{cmd:command,", "{cmd:command,...options,"),
    input.replace('"node -e ', '"node'),
    `const example=${JSON.stringify(input)};`,
    `/* ${input} */`,
    'const command="node " + resolveCommand();text(await tools.exec_command({cmd:command}));',
    'const command="node"+suffix;text(await tools.exec_command({cmd:command}));',
    'const example=/const command="node "+suffix;text(await tools.exec_command({cmd:command}));/;',
  ]) expect(parse(invalid)).toMatchObject({ summary: invalid.startsWith("const example=") || invalid.startsWith("/*") ? "exec" : "exec_command" });
});

it("shows the edited file when a code-mode patch is passed by constant", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch";
  const part = parse(`const patch = ${JSON.stringify(patch)}; text(await tools.apply_patch(patch));`);
  expect(part).toMatchObject({ name: "exec", summary: "src/a.ts" });
  if (part?.kind !== "tool") throw new Error("Missing tool row");
  expect(toolVerb(part, part.summary)).toBe("Edited");
});
