import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, open, symlink, rename, type FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { authorizeDshTranscript, completeDshFrames, isDshProcess, dshConversation as boundConversation, dshToolOutput as boundToolOutput, dshSessionsDirectory, forgetDshProcesses, projectDsh, resolveDshTranscript } from "./dsh.ts";
import { ConversationNotStarted, ConversationUnavailable, HistoryChanged } from "./conversation-shared.ts";
import * as processProbe from "./omp-process.ts";
import { processStartTicks } from "./omp-process.ts";
import type { ConversationPage } from "./conversation-shared.ts";
let home: string;
let memory: ReturnType<typeof spyOn<typeof processProbe, "ompProcessMemory">>;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ovis-dsh-home-"));
  await mkdir(join(home, "sessions"));
  memory = spyOn(processProbe, "ompProcessMemory").mockResolvedValue({ argv: [], environ: [`HOME=${home}`, `DSH_HOME=${home}`] });
  forgetDshProcesses();
});
afterEach(async () => {
  memory.mockRestore();
  forgetDshProcesses();
  await rm(home, { recursive: true, force: true });
});
async function binding(path: string) {
  const value = await authorizeDshTranscript(path, join(home, "sessions"));
  if (value === null) throw new ConversationUnavailable("fixture not authorized");
  return value;
}
async function dshConversation(path: string, page?: ConversationPage) { return boundConversation(await binding(path), page); }
async function dshToolOutput(path: string, ref: string) { return boundToolOutput(await binding(path), ref); }
const id = "12345678-1234-1234-1234-123456789abc";
const header = {type:"session",version:4,id,delegationDepth:0};
const event = (type: string, data: unknown, seq: number) => ({type,data,seq,time:1700000000000+seq});
const message = (text: string) => ({role:"user",source:{kind:"user"},content:[{type:"text",text}]});
const log = (...rows: unknown[]) => [header,...rows].map(r=>JSON.stringify(r)).join("\n")+"\n";
async function fixture(run: (path:string)=>Promise<void>) {
 const root=await mkdtemp(join(home,"sessions","project-")); const dir=join(root,id); await mkdir(dir);
 try {await run(join(dir,"session.v4.jsonl.zstd"));} finally {await rm(root,{recursive:true,force:true});}
}
const linuxTest = process.platform === "linux" ? test : test.skip;
/** What herdr reports for a TUI launched through the npm-installed launcher. */
const DSH_ARGV = ["node", "/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js", "--profile", "tui"];
const DSH_TUI_ARGV = ["node", "/home/user/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/host-entry.js"];
const otherId = "87654321-4321-4321-4321-cba987654321";
const hostInfo = () => ({ foreground_processes: [{ pid: process.pid, argv: DSH_TUI_ARGV }] });
async function listen(server: Server, session: string, directory = join(home, ".dsh-tui", "inject")) {
  await mkdir(directory, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(join(directory, `${session}.sock`), () => { server.off("error", reject); resolve(); });
  });
}
async function closeListener(server: Server) {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function attachedFixture(run: (first: string, second: string) => Promise<void>) {
  const first = join(home, "sessions", "project", id, "session.v4.jsonl.zstd");
  const second = join(home, "sessions", "project", otherId, "session.v4.jsonl.zstd");
  const handles: FileHandle[] = [];
  try {
    for (const [session, path, label] of [[id, first, "attached-A"], [otherId, second, "attached-B"]] as const) {
      await mkdir(join(path, ".."), { recursive: true });
      const rows = [{ ...header, id: session }, event("user/message", message(label), 0)];
      await writeFile(path, Bun.zstdCompressSync(rows.map(row => JSON.stringify(row)).join("\n") + "\n"));
      handles.push(await open(join(path, "..", "session.lock"), "w"), await open(path, "r"));
    }
    await run(first, second);
  } finally { await Promise.all(handles.map(handle => handle.close())); }
}

describe("dsh-tui attachment selection", () => {
  linuxTest("rejects invalid process ids before inspecting attachment evidence", async () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) {
      await expect(resolveDshTranscript({ foreground_processes: [{ pid, argv: DSH_TUI_ARGV }] })).rejects.toBeInstanceOf(ConversationUnavailable);
    }
    expect(memory).not.toHaveBeenCalled();
  });

  linuxTest("follows A->B->A through process-owned listeners while both logs and locks stay open", async () => attachedFixture(async (first, second) => {
    const socket = createServer();
    try {
      const histories: string[] = [];
      for (const [session, path, label] of [[id, first, "attached-A"], [otherId, second, "attached-B"], [id, first, "attached-A"]] as const) {
        await listen(socket, session);
        const selected = await resolveDshTranscript(hostInfo());
        expect(selected.path).toBe(path);
        const page = await boundConversation(selected);
        expect(page.turns[0]?.parts).toEqual([{ kind: "text", text: label }]);
        histories.push(page.history_id);
        await closeListener(socket);
      }
      expect(histories[0]).not.toBe(histories[1]);
      expect(histories[0]).toBe(histories[2]);
    } finally { await closeListener(socket); }
  }));

  linuxTest("refuses parked sessions without a listener", async () => attachedFixture(async () => {
    await expect(resolveDshTranscript(hostInfo())).rejects.toBeInstanceOf(ConversationUnavailable);
  }));

  linuxTest("does not borrow a listener owned by another process in the same socket table", async () => attachedFixture(async (first, second) => {
    const socket = createServer();
    const child = Bun.spawn([process.execPath, "-e", 'const fs = require("node:fs"); for (const path of process.argv.slice(1)) fs.openSync(path, "r"); process.stdout.write("ready\\n"); setInterval(() => {}, 60000);', join(first, "..", "session.lock"), join(second, "..", "session.lock")], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const reader = child.stdout.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
      await listen(socket, id);
      await expect(resolveDshTranscript({ foreground_processes: [{ pid: child.pid, argv: DSH_TUI_ARGV }] })).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally {
      await closeListener(socket);
      await reader.cancel(); reader.releaseLock();
      child.kill(); await child.exited;
    }
  }));

  linuxTest("refuses two owned listeners instead of choosing the first", async () => attachedFixture(async () => {
    const first = createServer(), second = createServer();
    try {
      await listen(first, id);
      await listen(second, otherId);
      await expect(resolveDshTranscript(hostInfo())).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally { await Promise.all([closeListener(first), closeListener(second)]); }
  }));

  linuxTest("does not find a transcript by socket id without its own held lock", async () => attachedFixture(async () => {
    const socket = createServer();
    try {
      await listen(socket, "11111111-1111-1111-1111-111111111111");
      await expect(resolveDshTranscript(hostInfo())).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally { await closeListener(socket); }
  }));

  for (const failure of ["missing-log", "linked-log", "unknown-home", "changed-birth", "wrong-uid"] as const) linuxTest(`keeps authorization with an attached listener and ${failure}`, async () => attachedFixture(async (first, second) => {
    const socket = createServer();
    const nativeBirth = processProbe.processStartTicks;
    const nativeStat = fs.stat;
    let birthSpy: ReturnType<typeof spyOn<typeof processProbe, "processStartTicks">> | undefined;
    let statSpy: ReturnType<typeof spyOn<typeof fs, "stat">> | undefined;
    try {
      await listen(socket, id);
      if (failure === "missing-log" || failure === "linked-log") await rm(first);
      if (failure === "linked-log") await symlink(second, first);
      if (failure === "unknown-home") memory.mockResolvedValue({ argv: [], environ: [`DSH_HOME=${home}`, "HOME=relative"] });
      if (failure === "changed-birth") {
        let reads = 0;
        birthSpy = spyOn(processProbe, "processStartTicks").mockImplementation(pid => {
          const start = nativeBirth(pid);
          return pid === process.pid && start !== null && ++reads > 1 ? String(BigInt(start) + 1n) : start;
        });
      }
      if (failure === "wrong-uid") statSpy = spyOn(fs, "stat").mockImplementation(new Proxy(nativeStat, {
        async apply(target, receiver, args) {
          const result = await Reflect.apply(target, receiver, args);
          return args[0] === `/proc/${process.pid}` ? new Proxy(result, { get(target, name) { return name === "uid" ? -1 : Reflect.get(target, name); } }) : result;
        },
      }));
      await expect(resolveDshTranscript(hostInfo())).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally { birthSpy?.mockRestore(); statSpy?.mockRestore(); await closeListener(socket); }
  }));

  for (const kind of ["wrong-home", "invalid-id", "non-host"] as const) linuxTest(`does not use ${kind} socket evidence`, async () => attachedFixture(async () => {
    const socket = createServer();
    try {
      await listen(socket, kind === "invalid-id" ? "not-a-session" : id, kind === "wrong-home" ? join(home, "inject") : undefined);
      await expect(resolveDshTranscript(kind === "non-host" ? { foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] } : hostInfo())).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally { await closeListener(socket); }
  }));

  linuxTest("rejects a listener id shared by two locked directories", async () => fixture(async first => fixture(async second => {
    await writeFile(first, Bun.zstdCompressSync(log()));
    await writeFile(second, Bun.zstdCompressSync(log()));
    const locks = await Promise.all([open(join(first, "..", "session.lock"), "w"), open(join(second, "..", "session.lock"), "w")]);
    const socket = createServer();
    try {
      await listen(socket, id);
      await expect(resolveDshTranscript(hostInfo())).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally { await closeListener(socket); await Promise.all(locks.map(lock => lock.close())); }
  })));

  linuxTest("keeps the single-lock fallback but refuses log descriptors alone", async () => fixture(async path => {
    await writeFile(path, Bun.zstdCompressSync(log()));
    const file = await open(path, "r");
    const lock = await open(join(path, "..", "session.lock"), "w");
    try {
      expect((await resolveDshTranscript(hostInfo())).path).toBe(path);
      await lock.close();
      await expect(resolveDshTranscript(hostInfo(), 0n)).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally { await lock.close(); await file.close(); }
  }));

  linuxTest("rejects an attached lock outside the process's configured store", async () => attachedFixture(async () => {
    const socket = createServer();
    try {
      await listen(socket, id);
      await mkdir(join(home, "another-store", "sessions"), { recursive: true });
      memory.mockResolvedValue({ argv: [], environ: [`HOME=${home}`, `DSH_HOME=${join(home, "another-store")}`] });
      await expect(resolveDshTranscript(hostInfo())).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally { await closeListener(socket); }
  }));

  linuxTest("fails closed when the host's socket table cannot be read", async () => attachedFixture(async () => {
    const socket = createServer();
    const nativeReadFile = fs.readFile;
    const probe = spyOn(fs, "readFile").mockImplementation(new Proxy(nativeReadFile, {
      apply(target, receiver, args) {
        if (args[0] === `/proc/${process.pid}/net/unix`) return Promise.reject(new Error("fixture unreadable socket table"));
        return Reflect.apply(target, receiver, args);
      },
    }));
    try {
      await listen(socket, id);
      await expect(resolveDshTranscript(hostInfo())).rejects.toBeInstanceOf(ConversationUnavailable);
    } finally { probe.mockRestore(); await closeListener(socket); }
  }));
});

describe("native dsh conversation",()=>{
 linuxTest("shows an unwritten new process as empty but does not guess a resumed session",async()=>{
 await expect(resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:DSH_ARGV}]},0n)).rejects.toBeInstanceOf(ConversationNotStarted);
 try {await resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:[...DSH_ARGV,"--resume","missing"]}]},0n);throw Error("unexpected binding");}catch(error){expect(error).toBeInstanceOf(ConversationUnavailable);expect(error).not.toBeInstanceOf(ConversationNotStarted);}
 });
 test("shows human messages, reasoning and tools without runtime instructions",()=>{
 const p=projectDsh(log(event("user/message",message("hello"),0),event("user/message",{...message("hidden"),source:{kind:"agent-instructions"}},1),event("assistant/message",{message:{role:"assistant",content:[{type:"reasoning",text:"reason"},{type:"text",text:"answer"},{type:"tool-call",id:"t"}]}},2),event("tool/call",{callId:"t",name:"shell",arguments:"{}"},3),event("tool/result",{message:{toolCallId:"t",content:[{type:"text",text:"done"}]}},4),event("turn/end",{reason:{kind:"completed"}},5)),"inode",id);
 expect(p.turns).toHaveLength(2);expect(JSON.stringify(p.turns)).not.toContain("hidden");expect(p.turns[1]!.parts.map(p=>p.kind)).toEqual(["thinking","text","tool"]);
 expect(p.turns[1]!.parts[2]).toMatchObject({state:"ok",output:"done"});
 });
 test("rejects unsupported versions, wrong sessions, and missing event sequences",()=>{
 expect(()=>projectDsh(JSON.stringify({...header,version:5})+"\n","x")).toThrow(ConversationUnavailable);
 expect(()=>projectDsh(log(),"x","other")).toThrow(ConversationUnavailable);
 expect(()=>projectDsh(log(event("user/message",message("x"),1)),"x")).toThrow(ConversationUnavailable);
 });
 test("rejects malformed event and content values with the terminal fallback",()=>{
 expect(()=>projectDsh(log(null),"x")).toThrow(ConversationUnavailable);
 expect(()=>projectDsh(log(event("user/message",{...message("x"),content:[null]},0)),"x")).toThrow(ConversationUnavailable);
 });
 test("reads concatenated compressed frames and ignores an incomplete final append",async()=>fixture(async path=>{
 const first=Bun.zstdCompressSync(log(event("user/message",message("hello"),0)));
 const second=Bun.zstdCompressSync(JSON.stringify(event("assistant/message",{message:{role:"assistant",content:[{type:"text",text:"answer"}]}},1))+"\n");
 await writeFile(path,Buffer.concat([first,second,second.subarray(0,7)]));
 expect(completeDshFrames(Buffer.concat([first,second,second.subarray(0,7)]))).toBe(first.length+second.length);
 expect((await dshConversation(path)).turns).toHaveLength(2);
 }));
 test("rejects corrupt frames and oversized decompressed logs",async()=>fixture(async path=>{
 expect(()=>completeDshFrames(Buffer.from("not a frame"))).toThrow(ConversationUnavailable);
 await writeFile(path,Bun.zstdCompressSync("x".repeat(16*1024*1024+1)));
 await expect(dshConversation(path)).rejects.toBeInstanceOf(ConversationUnavailable);
 }));
 test("pages history and rejects a cursor after an earlier message changes",async()=>fixture(async path=>{
 const rows=Array.from({length:60},(_,i)=>event("user/message",message(String(i)),i));
 await writeFile(path,Bun.zstdCompressSync(log(...rows)));const page=await dshConversation(path);
 expect(page.turns).toHaveLength(50);expect(page.cursor).not.toBeNull();expect((await dshConversation(path,{before:page.cursor!})).turns).toHaveLength(10);
 rows[0]=event("user/message",message("changed"),0);await writeFile(path,Bun.zstdCompressSync(log(...rows)));
 await expect(dshConversation(path,{before:page.cursor!})).rejects.toBeInstanceOf(HistoryChanged);
 }));
 test("uses the terminal fallback when the bound log disappears",async()=>fixture(async path=>{
 await expect(dshConversation(path)).rejects.toBeInstanceOf(ConversationUnavailable);
 }));
 test("reads plain logs and waits for an unfinished JSONL line",async()=>fixture(async compressed=>{
 const path=compressed.replace(".zstd","");
 await writeFile(path,log(event("user/message",message("hello"),0))+"{unfinished");
 expect((await dshConversation(path)).turns).toHaveLength(1);
 }));
 test("keeps prior human turns across compaction and marks failed turns",()=>{
 const p=projectDsh(log(event("user/message",message("original"),0),event("user/message",{...message("summary"),source:{kind:"compact-checkpoint"}},1),event("assistant/message",{message:{role:"assistant",content:[{type:"text",text:"partial"}]}},2),event("turn/end",{reason:{kind:"cancelled"}},3)),"inode");
 expect(p.turns[0]!.role).toBe("user");expect(p.turns[1]!.parts[0]!.kind).toBe("compact");expect(p.turns[1]!.parts.at(-1)).toMatchObject({kind:"notice",text:expect.stringMatching(/\bcancelled\b/)});
 });
 linuxTest("rejects two held session locks instead of choosing one",async()=>fixture(async first=>fixture(async second=>{
 await writeFile(first,Bun.zstdCompressSync(log()));await writeFile(second,Bun.zstdCompressSync(log()));
 const locks=await Promise.all([open(join(first,"..","session.lock"),"w"),open(join(second,"..","session.lock"),"w")]);
 try {await expect(resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:DSH_ARGV}]})).rejects.toBeInstanceOf(ConversationUnavailable);} finally {await Promise.all(locks.map(lock=>lock.close()));}
 })));
 test("fetches long tool output by opaque reference",async()=>fixture(async path=>{
 await writeFile(path,Bun.zstdCompressSync(log(event("tool/call",{callId:"a",name:"shell",arguments:"{}"},0),event("tool/result",{message:{toolCallId:"a",content:[{type:"text",text:"x".repeat(5000)}]}},1))));
 const part=(await dshConversation(path)).turns[0]!.parts[0]!;expect(part.kind).toBe("tool");if(part.kind!=="tool")throw Error();expect(await dshToolOutput(path,part.output_ref!)).toHaveLength(5000);
 }));
 linuxTest("binds only an exact held lock",async()=>fixture(async path=>{
 await writeFile(path,Bun.zstdCompressSync(log()));const lock=await open(join(path,"..","session.lock"),"w");
 const info={foreground_processes:[{pid:process.pid,argv:DSH_ARGV}]};
 try {expect((await resolveDshTranscript(info)).path).toBe(path);expect((await boundConversation(await resolveDshTranscript(info))).turns).toHaveLength(0);await expect(resolveDshTranscript({foreground_processes:[{pid:process.pid,argv:["unrelated"]}]})).rejects.toBeInstanceOf(ConversationUnavailable);}finally{await lock.close();}
 // a process seen holding a lock is no new chat once it lets go, even when it started after this server
 await expect(resolveDshTranscript(info,0n)).rejects.toBeInstanceOf(ConversationUnavailable);
 }));
});

test("keeps legacy multistep, runtime-filtering and digest-output coverage through the pinned async reader", async () => fixture(async path => {
  const callId = "call_5df25fae9066492d84296134cec11c12|fc_02a31c4b7cf803ae";
  const rows = [
    event("request/header", { header: { config: { model: "gpt-6.1-sol" } } }, 0),
    event("user/message", message("first question"), 1),
    event("assistant/message", { message: { role: "assistant", content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: "checking" }, { type: "tool-call", id: callId }] } }, 2),
    event("tool/call", { callId, name: "bash", arguments: '{"command":"ls -a"}' }, 3),
    event("tool/result", { message: { toolCallId: callId, content: [{ type: "text", text: "a\nb\n" }] } }, 4),
    event("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: "finished" }] } }, 5),
    event("tool/call", { callId: "not-in-assistant-content", name: "bash", arguments: "{}" }, 6),
    event("tool/result", { message: { toolCallId: "not-in-assistant-content", isError: true, content: [{ type: "text", text: "Error: boom" }] } }, 7),
    event("user/message", { ...message("runtime context"), source: { kind: "runtime-context" } }, 8),
    event("user/message", message("second question"), 9),
    event("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } }, 10),
    event("turn/end", { reason: { kind: "completed" } }, 11),
  ];
  await writeFile(path, Bun.zstdCompressSync(log(...rows)));
  const pinned = await binding(path);
  const page = await boundConversation(pinned);
  expect(page.source).toBe("dsh-transcript");
  expect(page.metadata).toEqual({ model: "gpt-6.1-sol", reasoning_effort: null });
  expect(page.turns.map(turn => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(page.turns[1]?.parts).toMatchObject([
    { kind: "thinking", text: "thinking" }, { kind: "text", text: "checking" },
    { kind: "tool", name: "bash", input: '{"command":"ls -a"}', output: "a\nb\n", state: "ok" },
    { kind: "text", text: "finished" }, { kind: "tool", error: true, output: "Error: boom", state: "error" },
  ]);
  expect(JSON.stringify(page.turns)).not.toContain("runtime context");
  expect(await boundToolOutput(pinned, "missing-reference")).toBeNull();
  rows[4] = event("tool/result", { message: { toolCallId: callId, content: [{ type: "text", text: "x".repeat(30_000) }] } }, 4);
  await writeFile(path, Bun.zstdCompressSync(log(...rows)));
  const tool = (await boundConversation(pinned)).turns[1]?.parts.find(part => part.kind === "tool");
  if (tool?.kind !== "tool" || !tool.output_ref) throw new Error("fixture tool reference missing");
  expect(tool.output_ref).toMatch(/^[0-9a-f]{64}$/);
  expect(tool.output_size).toBe(30_000);
  expect(tool.output.length).toBeLessThan(30_000);
  expect(await boundToolOutput(pinned, tool.output_ref)).toBe("x".repeat(30_000));
}));

linuxTest("resolves DSH_HOME like dsh-home-paths and refuses an unprovable relative home", () => {
  expect(dshSessionsDirectory(["HOME=/user"])).toBe("/user/.dsh/sessions");
  expect(dshSessionsDirectory(["HOME=/user", "DSH_HOME=   "])).toBe("/user/.dsh/sessions");
  expect(dshSessionsDirectory(["HOME=/user", "DSH_HOME=/work/dsh"])).toBe("/work/dsh/sessions");
  expect(dshSessionsDirectory(["HOME=/user", "DSH_HOME=~/work"])).toBe("/user/work/sessions");
  expect(dshSessionsDirectory(["HOME=/user", "DSH_HOME=~"])).toBe("/user/sessions");
  expect(dshSessionsDirectory(["HOME=/user", "DSH_HOME=relative"])).toBeNull();
  expect(dshSessionsDirectory([])).toBeNull();
});

linuxTest("rejects a held lock outside the configured store, including sibling-prefix paths", async () => {
  const outside = join(home, "sessions-outside", id);
  await mkdir(outside, { recursive: true });
  const path = join(outside, "session.v4.jsonl");
  await writeFile(path, log());
  const lock = await open(join(outside, "session.lock"), "w");
  try {
    expect(await authorizeDshTranscript(path, join(home, "sessions"))).toBeNull();
    await expect(resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] })).rejects.toBeInstanceOf(ConversationUnavailable);
  } finally { await lock.close(); }
});

linuxTest("rejects file and session-directory links out of the store, but accepts a linked store root", async () => fixture(async path => {
  const outside = join(home, "outside", id);
  await mkdir(outside, { recursive: true });
  const logPath = join(outside, "session.v4.jsonl.zstd");
  await writeFile(logPath, Bun.zstdCompressSync(log()));
  await symlink(logPath, path);
  expect(await authorizeDshTranscript(path, join(home, "sessions"))).toBeNull();
  const link = join(home, "sessions", "linked-session");
  await symlink(outside, link);
  expect(await authorizeDshTranscript(join(link, "session.v4.jsonl.zstd"), join(home, "sessions"))).toBeNull();
  await rm(path);
  await writeFile(path, Bun.zstdCompressSync(log()));
  const store = join(home, "store-link");
  await symlink(join(home, "sessions"), store);
  expect((await authorizeDshTranscript(path, store))?.path).toBe(path);
}));

test("rejects file replacement between binding and conversation or tool-output reads", async () => fixture(async path => {
  await writeFile(path, Bun.zstdCompressSync(log()));
  const original = await binding(path);
  await rename(path, path + ".old");
  await writeFile(path, Bun.zstdCompressSync(log()));
  await expect(boundConversation(original)).rejects.toBeInstanceOf(ConversationUnavailable);
  await expect(boundToolOutput(original, "ref")).rejects.toBeInstanceOf(ConversationUnavailable);
}));

linuxTest("uses the foreground process DSH_HOME instead of the bridge environment", async () => fixture(async path => {
  await writeFile(path, Bun.zstdCompressSync(log()));
  const lockPath = join(path, "..", "session.lock");
  await writeFile(lockPath, "");
  memory.mockRestore();
  const child = Bun.spawn([process.execPath, "-e", 'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("ready\\n"); setInterval(() => {}, 60000);', lockPath], {
    env: { ...process.env, HOME: join(home, "another-home"), DSH_HOME: home },
    stdin: "ignore", stdout: "pipe", stderr: "ignore",
  });
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    expect((await resolveDshTranscript({ foreground_processes: [{ pid: child.pid, argv: DSH_ARGV }] })).path).toBe(path);
  } finally {
    await reader.cancel();
    reader.releaseLock();
    child.kill();
    await child.exited;
  }
}));

for (const compressed of [false, true]) linuxTest(`rejects a held ${compressed ? "compressed" : "plain"} log outside the sessions root`, async () => {
  const outside = join(home, "outside", id);
  await mkdir(outside, { recursive: true });
  const path = join(outside, compressed ? "session.v4.jsonl.zstd" : "session.v4.jsonl");
  await writeFile(path, compressed ? Bun.zstdCompressSync(log()) : log());
  const lock = await open(join(outside, "session.lock"), "w");
  try {
    await expect(resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] })).rejects.toBeInstanceOf(ConversationUnavailable);
  } finally { await lock.close(); }
});

linuxTest("rejects a held log symlink escaping the sessions root", async () => fixture(async path => {
  const outside = join(home, "outside.jsonl.zstd");
  await writeFile(outside, Bun.zstdCompressSync(log()));
  await symlink(outside, path);
  const lock = await open(join(path, "..", "session.lock"), "w");
  try {
    await expect(resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] })).rejects.toBeInstanceOf(ConversationUnavailable);
  } finally { await lock.close(); }
}));

test("matches only a dsh launcher that boots a chat profile", () => {
  for (const argv of [
    ["node", "/home/user/.nvm/versions/node/v24/bin/dsh", "--profile", "dsh-tui"],
    ["node", "/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js", "--profile", "tui"],
    ["node", "/usr/local/bin/dsh", "tui", "--resume", "1dacc7bc-68e8-4934-baec-ba181b8251f9"],
    ["node", "/usr/local/bin/dsh", "--profile", "headless", "--session-id", "session-1", "continue"],
    ["node", "/usr/local/bin/dsh", "--profile=tui"],
    // what `dsh-tui` and `dsh-tui --resume` leave in front: dsh-tui's own host process, which holds the lock
    ["/usr/bin/node", "/home/user/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/host-entry.js"],
  ]) expect(isDshProcess(argv)).toBe(true);
  for (const argv of [
    ["vim", "dsh"],
    // a program merely named dsh is no dsh launcher
    ["node", "/srv/app/dsh", "--profile", "tui"],
    ["/srv/app/dsh", "--profile", "tui"],
    // Debian's distributed shell, and any launcher not run by node
    ["/usr/bin/dsh", "--profile", "tui"],
    ["/usr/bin/dsh", "-a", "uptime"],
    ["node", "server.js", "dsh"],
    ["node", "/srv/app/dsh-helper.js", "--profile", "tui"],
    ["node", "/usr/local/bin/dsh"],
    ["node", "/usr/local/bin/dsh", "plugin", "--profile", "tui", "add", "x"],
    ["node", "/usr/local/bin/dsh", "--profile", "tui", "--dump-config"],
    ["node", "/usr/local/bin/dsh", "--profile", "web"],
    ["node", "/usr/local/bin/dsh", "acp"],
    ["dsh", "-a", "-c", "uptime"],
    // dsh-tui's launcher shims, which hold no session
    ["node", "/usr/local/bin/dsh-tui"],
    ["/usr/bin/node", "/home/user/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/bin/dsh-tui.js"],
    ["node", "/srv/app/lib/host-entry.js"],
    [42, "/usr/local/bin/dsh", "--profile", "tui"],
  ]) expect(isDshProcess(argv)).toBe(false);
});

linuxTest("binds a headless session directory named session-<uuid>", async () => {
  const sessionId = `session-${id}`;
  const dir = join(home, "sessions", "--workspace--", sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "session.v4.jsonl.zstd");
  await writeFile(path, Bun.zstdCompressSync(JSON.stringify({ ...header, id: sessionId }) + "\n"));
  const lock = await open(join(dir, "session.lock"), "w");
  try {
    expect((await resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: [...DSH_ARGV.slice(0, 3), "headless", "--session-id", sessionId, "next"] }] })).path).toBe(path);
  } finally { await lock.close(); }
});

linuxTest("treats headless --session-id and dsh-tui's resume variable as explicit resumes, not a new empty chat", async () => {
  const refusal = (argv: string[]) => resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv }] }, 0n).then(() => null, (error: unknown) => error);
  const explicit = async (argv: string[]) => {
    const error = await refusal(argv);
    expect(error).toBeInstanceOf(ConversationUnavailable);
    expect(error).not.toBeInstanceOf(ConversationNotStarted);
  };
  await explicit([...DSH_ARGV.slice(0, 3), "headless", "--session-id", "session-x", "next"]);
  memory.mockResolvedValue({ argv: [], environ: [`HOME=${home}`, `DSH_HOME=${home}`, "DSH_TUI_RESUME_SESSION=1dacc7bc-68e8-4934-baec-ba181b8251f9"] });
  await explicit([...DSH_ARGV.slice(0, 3), "dsh-tui"]);
  memory.mockResolvedValue({ argv: [], environ: [`HOME=${home}`, `DSH_HOME=${home}`, "DSH_TUI_RESUME_SESSION="] });
  expect(await refusal([...DSH_ARGV.slice(0, 3), "dsh-tui"])).toBeInstanceOf(ConversationNotStarted);
});

/** Logs recorded from dsh 0.2.1-rc.5 (headless, then dsh-tui 0.17.0) through an OpenAI-compatible proxy; paths and the system prompt are replaced. */
for (const [name, file, exchanges] of [["headless", "dsh-headless-0.2.1-rc.5.jsonl", 3], ["dsh-tui", "dsh-tui-0.17.0-dsh-0.2.1-rc.5.jsonl", 2]] as const) {
  linuxTest(`reads a real ${name} session written as one zstd frame per append`, async () => {
    const text = await Bun.file(join(import.meta.dir, "fixtures", file)).text();
    const rows = text.trimEnd().split("\n");
    const sessionId = JSON.parse(rows[0]!).id as string;
    const dir = join(home, "sessions", "--workspace--", sessionId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, "session.v4.jsonl.zstd");
    await writeFile(path, Buffer.concat(rows.map((row) => Bun.zstdCompressSync(row + "\n"))));
    const lock = await open(join(dir, "session.lock"), "w");
    try {
      const page = await boundConversation(await resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] }));
      expect(page.source).toBe("dsh-transcript");
      expect(page.metadata).toEqual({ model: "claude-haiku-4-5-20251001", reasoning_effort: null });
      expect(page.turns.map((turn) => turn.role)).toEqual(Array.from({ length: exchanges }, () => ["user", "assistant"] as const).flat());
      expect(JSON.stringify(page.turns)).not.toContain("elided");
      const tool = page.turns[1]!.parts.find((part) => part.kind === "tool");
      expect(tool).toMatchObject({ state: "ok" });
      expect(tool?.kind === "tool" && tool.output).toContain("alpha");
      expect(page.turns[1]!.parts.at(-1)).toMatchObject({ kind: "text", phase: "final_answer" });
      expect(page.turns[3]!.parts.at(-1)).toMatchObject({ kind: "text", text: expect.stringContaining("alpha"), phase: "final_answer" });
    } finally { await lock.close(); }
  });
}

linuxTest("rejects a held session whose log links to another session in the same store", async () => fixture(async path => {
  const other = join(home, "sessions", "--workspace--", "87654321-4321-4321-4321-cba987654321");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "session.v4.jsonl.zstd"), Bun.zstdCompressSync(log()));
  await symlink(join(other, "session.v4.jsonl.zstd"), path);
  const lock = await open(join(path, "..", "session.lock"), "w");
  try {
    await expect(resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] })).rejects.toBeInstanceOf(ConversationUnavailable);
  } finally { await lock.close(); }
}));

linuxTest("falls back when two sessions are locked even if only one of them has a readable log", async () => fixture(async path => {
  await writeFile(path, Bun.zstdCompressSync(log()));
  const empty = join(home, "sessions", "--workspace--", "87654321-4321-4321-4321-cba987654321");
  await mkdir(empty, { recursive: true });
  const locks = await Promise.all([open(join(path, "..", "session.lock"), "w"), open(join(empty, "session.lock"), "w")]);
  try {
    await expect(resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] })).rejects.toBeInstanceOf(ConversationUnavailable);
  } finally { await Promise.all(locks.map((lock) => lock.close())); }
}));

linuxTest("does not show a new empty chat for a lock-free dsh that started before this server", async () => {
  // a TUI that went idle released its lock; after an Ovis restart nothing proves it never held one
  const error = await resolveDshTranscript({ foreground_processes: [{ pid: process.ppid, argv: DSH_ARGV }] }).then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ConversationUnavailable);
  expect(error).not.toBeInstanceOf(ConversationNotStarted);
});

test("shows a turn that failed before any reply with the error dsh recorded, as a failed request", () => {
  const p = projectDsh(log(event("user/message", message("hello"), 0), event("turn/end", { turn: 1, reason: { kind: "error", error: { message: "429: rate limited" } } }, 1)), "inode");
  expect(p.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
  expect(p.turns[1]!.parts).toEqual([{ kind: "text", text: "Error: 429: rate limited", failed: true }]);
});

test("shows the error a recorded dsh-tui turn ended on (a provider with no balance), not a background result", async () => {
  // dsh-tui 0.19.0 with dsh-core 0.2.2-rc.1, its DeepSeek route at no balance, as recorded (system prompts and tool lists left out)
  const text = await Bun.file(join(import.meta.dir, "fixtures", "dsh-tui-0.19.0-dsh-0.2.2-rc.1-error.jsonl")).text();
  const turns = projectDsh(text, "inode").turns;
  const sent = turns.findIndex((turn) => turn.role === "user" && turn.parts.some((part) => part.kind === "text" && part.text === "Reply with exactly: SHOULD-FAIL"));
  expect(turns[sent + 1]?.parts).toEqual([{ kind: "text", failed: true, text: "Error: Insufficient Balance (request_id: ef4dff0b-9860-485e-bf1e-2adc49608099)" }]);
  // the turns after it read as before
  expect(turns[sent + 2]?.role).toBe("user");
});

test("names a turn stopped by the user as such, not as a background result", () => {
  const p = projectDsh(log(event("user/message", message("hello"), 0), event("assistant/message", { message: { role: "assistant", content: [{ type: "text", text: "Working" }] } }, 1), event("turn/end", { turn: 1, reason: { kind: "aborted" } }, 2)), "inode");
  expect(p.turns[1]!.parts.at(-1)).toEqual({ kind: "notice", source: "dsh-turn-end", text: "Turn ended: aborted" });
});

linuxTest("treats a dsh that started in the same clock tick as this server as unproven, not new", async () => {
  const sameTick = BigInt(processStartTicks(process.pid)!);
  const error = await resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] }, sameTick).then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ConversationUnavailable);
  expect(error).not.toBeInstanceOf(ConversationNotStarted);
});

for (const failure of ["environ", "sessions", "descriptors", "birth", "final-birth", "gone", "changed-birth"] as const) {
  linuxTest(`does not choose a peer transcript when a recognized dsh has ${failure}`, async () => fixture(async first => fixture(async second => {
    await writeFile(first, Bun.zstdCompressSync(log()));
    await writeFile(second, Bun.zstdCompressSync(log()));
    const firstLock = await open(join(first, "..", "session.lock"), "w");
    const secondLock = join(second, "..", "session.lock");
    await writeFile(secondLock, "");
    const child = Bun.spawn([process.execPath, "-e", 'require("node:fs").openSync(process.argv[1], "r"); process.stdout.write("ready\\n"); setInterval(() => {}, 60000);', secondLock], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore",
    });
    const reader = child.stdout.getReader();
    const nativeBirth = processProbe.processStartTicks;
    const nativeReaddir = fs.readdir;
    let birthSpy: ReturnType<typeof spyOn<typeof processProbe, "processStartTicks">> | undefined;
    let fdSpy: ReturnType<typeof spyOn<typeof fs, "readdir">> | undefined;
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
      const info = { foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }, { pid: child.pid, argv: DSH_ARGV }] };
      // Both locks are real; only the selected inspection step is made unreadable.
      await expect(resolveDshTranscript(info)).rejects.toBeInstanceOf(ConversationUnavailable);
      memory.mockImplementation(async pid => pid === child.pid && failure === "environ" ? null : {
        argv: [], environ: pid === child.pid && failure === "sessions" ? ["DSH_HOME=relative"] : [`DSH_HOME=${home}`],
      });
      if (failure === "descriptors") {
        fdSpy = spyOn(fs, "readdir").mockImplementation(new Proxy(nativeReaddir, {
          apply(target, receiver, args) {
            if (args[0] === `/proc/${child.pid}/fd`) return Promise.reject(new Error("fixture unreadable fd list"));
            return Reflect.apply(target, receiver, args);
          },
        }));
      }
      if (failure === "birth" || failure === "final-birth" || failure === "changed-birth") {
        let reads = 0;
        birthSpy = spyOn(processProbe, "processStartTicks").mockImplementation(pid => {
          if (pid !== child.pid) return nativeBirth(pid);
          const start = nativeBirth(pid);
          if (start === null) throw new Error("fixture child birth unavailable");
          if (failure === "birth") return null;
          if (++reads === 1) return start;
          return failure === "final-birth" ? null : String(BigInt(start) + 1n);
        });
      }
      if (failure === "gone") {
        child.kill();
        await child.exited;
      }
      if (failure === "gone" || failure === "changed-birth") {
        expect((await resolveDshTranscript(info)).path).toBe(first);
      } else {
        const error = await resolveDshTranscript(info).then(() => null, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(ConversationUnavailable);
        expect(error).not.toBeInstanceOf(ConversationNotStarted);
      }
    } finally {
      birthSpy?.mockRestore();
      fdSpy?.mockRestore();
      await reader.cancel();
      reader.releaseLock();
      child.kill();
      await child.exited;
      await firstLock.close();
    }
  })));
}

linuxTest("rejects a preferred linked log instead of downgrading to an older plain log", async () => fixture(async path => {
  const other = join(home, "sessions", "87654321-4321-4321-4321-cba987654321");
  await mkdir(other);
  await writeFile(join(other, "session.v4.jsonl.zstd"), Bun.zstdCompressSync(log()));
  await symlink(join(other, "session.v4.jsonl.zstd"), path);
  await writeFile(path.replace(".zstd", ""), log(event("user/message", message("older-plain-A"), 0)));
  const lock = await open(join(path, "..", "session.lock"), "w");
  try {
    await expect(resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] })).rejects.toBeInstanceOf(ConversationUnavailable);
  } finally { await lock.close(); }
}));

linuxTest("does not infer an empty chat when the server birth is unknown", async () => {
  const error = await resolveDshTranscript({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] }, null).then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ConversationUnavailable);
  expect(error).not.toBeInstanceOf(ConversationNotStarted);
});
