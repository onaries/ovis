/** Two mounted native dsh transcripts, one attached socket, real bridge and chat. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "dsh-switch-"));
const evidence = process.env.UI_EVIDENCE_DIR || join(root, "evidence");
mkdirSync(evidence, { recursive: true });
const ids = ["f2c92739-0fc4-44fb-a6b7-27b0815e789b", "1b0c6063-8d61-4b71-b33a-6afcfedabf46"] as const;
const answers = ["First attached conversation", "Second attached conversation"] as const;
const store = join(root, "dsh");
const inject = join(root, ".dsh-tui", "inject");
mkdirSync(inject, { recursive: true });
const paths = ids.map((id, index) => {
  const directory = join(store, "sessions", `project-${index}`, id);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "session.v4.jsonl.zstd");
  const records = [
    { type: "session", version: 4, id, cwd: root },
    { type: "user/message", seq: 1, time: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: `Question ${index + 1}` }] } },
    { type: "assistant/message", seq: 2, time: 2, data: { message: { content: [{ type: "text", text: answers[index] }] } } },
  ];
  writeFileSync(path, Bun.zstdCompressSync(Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n")));
  return path;
});
const launcher = join(root, "dsh-tui.mjs");
const readyFile = join(root, "ready");
const control = join(root, "control.sock");
writeFileSync(launcher, `import { openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
for (const path of ${JSON.stringify(paths)}) openSync(path, 'r');
let listener;
async function attach(id) {
  if (listener) await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(${JSON.stringify(inject)} + '/' + id + '.sock', resolve); });
}
await attach(${JSON.stringify(ids[0])});
createServer(socket => { socket.once('data', async data => {
  await attach(data.toString().trim()); socket.end('attached\\n');
}); }).listen(${JSON.stringify(control)}, () => writeFileSync(${JSON.stringify(readyFile)}, 'ready'));
`);
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const oldHome = process.env.HOME;
const oldDsh = process.env.DSH_HOME;
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const attach = async (id: string) => {
  const socket = connect(control);
  try {
    const acknowledged = once(socket, "data", { signal: AbortSignal.timeout(10_000) });
    await once(socket, "connect", { signal: AbortSignal.timeout(10_000) });
    socket.write(id);
    await acknowledged;
  } finally { socket.destroy(); }
};
try {
  const created = await workspaceCreate({ cwd: root, label: "dsh session switch fixture" });
  workspace = created.workspace.workspace_id;
  const paneId = created.root_pane.pane_id;
  const watcher = watch(root);
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("dsh fixture did not start")), 15_000);
      watcher.on("change", (_event, name) => { if (name === "ready") { clearTimeout(deadline); resolve(); } });
    });
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `exec ${quote(Bun.which("node") ?? "node")} ${quote(launcher)}\n` });
    await ready;
  } finally { watcher.close(); }
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "dsh-tui", state: "idle" });
  process.env.HOME = root;
  process.env.DSH_HOME = store;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null, usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--no-proxy-server"] });
  for (const width of [1280, 390]) for (const theme of ["dark", "light"]) {
    await attach(ids[0]);
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme === "dark" ? "dark" : "light" });
    try {
      await context.addInitScript(({ paneId, theme }) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
        localStorage.setItem(`ovis:view:${paneId}`, "chat");
      }, { paneId, theme });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
      const log = page.locator(`.pane-frame[data-layout-pane="${paneId}"]`).getByRole("log");
      await log.getByText(answers[0], { exact: true }).waitFor();
      await attach(ids[1]);
      await log.getByText(answers[1], { exact: true }).waitFor();
      assert.equal(await log.getByText(answers[0], { exact: true }).count(), 0);
      await page.screenshot({ path: join(evidence, `${width}-${theme}-second.png`) });
      await attach(ids[0]);
      await log.getByText(answers[0], { exact: true }).waitFor();
      assert.equal(await log.getByText(answers[1], { exact: true }).count(), 0);
      await page.screenshot({ path: join(evidence, `${width}-${theme}-first.png`) });
      console.log(`PASS ${width}px ${theme}: first -> second -> first without reload, both transcripts stay open`);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldDsh === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldDsh;
  rmSync(root, { recursive: true, force: true });
  console.log("Cleanup: owned browser, bridge, fixture pane and files removed");
}
