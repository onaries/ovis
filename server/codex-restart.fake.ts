import { chmodSync, constants, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { herdrRpc, paneGet, paneProcessInfo, paneRead, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { UsageService } from "./usage.ts";

export const RESTART_SESSION = "01a0c7a1-56d9-7e20-9f08-f7a2d973bf01";

/** A fake CLI boundary and real Herdr PTY; no authentication or model requests. */
export async function codexRestartFixture(serverFactory = createServer) {
  const root = process.env["CHECK_DIR"];
  const home = process.env["CODEX_HOME"];
  if (!root || !home?.startsWith(`${root}/`) || !process.env["HERDR_TEST_SESSION"]?.startsWith("check-")) throw new Error("restart fixtures require an isolated check session and CODEX_HOME");
  const bin = join(root, "codex-bin");
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const runtime = join(bin, "bun");
  copyFileSync(process.execPath, runtime, constants.COPYFILE_FICLONE);
  const path = join(home, "sessions", `rollout-2026-11-02T00-00-00-${RESTART_SESSION}.jsonl`);
  const answer = "This fixture conversation keeps the original migration request and the exact final answer while its Codex terminal client is restarted in place.";
  writeFileSync(path, [
    { type: "session_meta", payload: { id: RESTART_SESSION, cwd: root } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Keep this conversation" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: answer }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const db = new Database(join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, rollout_path TEXT, cwd TEXT, archived INTEGER, agent_role TEXT, created_at INTEGER, updated_at INTEGER, source TEXT)");
  db.query("INSERT INTO threads VALUES (?, ?, ?, 0, NULL, 1, 1, 'cli')").run(RESTART_SESSION, path, root);
  db.close();
  const log = join(root, "clients.jsonl");
  const cli = join(bin, "codex");
  writeFileSync(cli, `#!${runtime}\nimport {appendFileSync,openSync,closeSync,existsSync} from 'node:fs';
const args=process.argv.slice(2),root=${JSON.stringify(root)},path=${JSON.stringify(path)},log=${JSON.stringify(log)};
if(args[0]==='app-server'){setInterval(()=>{},1000);process.on('SIGTERM',()=>process.exit(0));}
else {
const resume=args.indexOf('resume');if(resume<0||args[resume+1]!==${JSON.stringify(RESTART_SESSION)}||resume+2!==args.length||process.env.CODEX_HOME!==${JSON.stringify(home)})process.exit(64);
const fd=openSync(path,'a');
const at=args.findIndex(x=>x==='--model'||x==='-m');const model=at<0?'fixture-default':args[at+1];
appendFileSync(path,JSON.stringify({type:'turn_context',payload:{model,effort:'high'}})+'\\n');
appendFileSync(log,JSON.stringify({event:'started',pid:process.pid,args})+'\\n');
process.stdout.write('>_ OpenAI Codex (v0.166.0)\\n\\n• '+${JSON.stringify(answer)}+'\\n\\n› Ask Codex to do anything\\n  '+model+' high · '+root+'\\n  ? for shortcuts\\n');
if(existsSync(root+'/steering'))process.stdout.write('• Working (2s • esc to interrupt)\\n• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\\n  ↳ keep this queued message\\n› Ask Codex to do anything\\n  '+model+' high · '+root+'\\n');
process.on('SIGTERM',()=>{appendFileSync(log,JSON.stringify({event:'stopped',pid:process.pid})+'\\n');closeSync(fd);setTimeout(()=>process.exit(0),150);});
setInterval(()=>{},1000);
}
`);
  chmodSync(cli, 0o755);
  const daemon = Bun.spawn([cli, "app-server"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  const owned: string[] = [];
  const app = serverFactory({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "app-state"), codexHome: home, tailscaleOwner: null, usage: new UsageService(undefined, []) });
  const records = (): { event: string; pid: number; args?: string[] }[] => {
    try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  };
  const clear = async () => { for (const id of owned.splice(0)) await workspaceClose(id); rmSync(join(root, "steering"), { force: true }); };
  return {
    app, root, home, path, runtime, daemon, records, clear,
    async pane(label: string, shellHome?: string, fish = false) {
      const created = await workspaceCreate({ cwd: root, label });
      owned.push(created.workspace.workspace_id);
      const paneId = created.root_pane.pane_id;
      if (fish) {
        await herdrRpc("pane.send_text", { pane_id: paneId, text: "exec /usr/bin/fish --no-config -i\n" });
        for (const deadline = Date.now() + 10_000;;) {
          const pid = (await paneProcessInfo(paneId))?.shell_pid;
          if (pid && readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("/usr/bin/fish\0")) break;
          if (Date.now() >= deadline) throw new Error("fixture fish never started");
          await Bun.sleep(50);
        }
      }
      await herdrRpc("pane.send_text", { pane_id: paneId, text: `export PATH='${bin}':"$PATH"; ${shellHome ? `export CODEX_HOME='${shellHome}'; CODEX_HOME='${home}' ` : ""}'${cli}' -m fixture-sol --no-alt-screen resume ${RESTART_SESSION}\n` });
      for (const deadline = Date.now() + 10_000;;) {
        if ((await paneRead({ paneId, source: "recent", lines: 100, stripAnsi: true })).text.includes(answer.slice(0, 48))) break;
        if (Date.now() >= deadline) throw new Error("fixture Codex never started");
        await Bun.sleep(100);
      }
      await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "codex", state: "idle" });
      return await paneGet(paneId);
    },
    async close() {
      app.stop();
      await clear();
      daemon.kill();
      await daemon.exited;
      for (const dir of [home, bin, join(root, "app-state")]) rmSync(dir, { recursive: true, force: true });
    },
  };
}
