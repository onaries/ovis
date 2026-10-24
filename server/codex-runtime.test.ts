import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePromptRequest } from "./prompt.ts";

const failure = "■ Selected model is at capacity. Please try a different model.";
let screen: string;
let status: "working" | "blocked" | "done";
let root: string;
let previous: string | undefined;
let listener: ReturnType<typeof Bun.listen>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-capacity-"));
  previous = process.env["HERDR_SOCKET"];
  status = "working";
  process.env["HERDR_SOCKET"] = join(root, "herdr.sock");
  screen = `${failure}\n\n› Ask Codex to do anything\n  gpt-6.1-sol high · 38% context left`;
  listener = Bun.listen<{ text: string }>({ unix: process.env["HERDR_SOCKET"], socket: {
    open(socket) { socket.data = { text: "" }; },
    data(socket, chunk) {
      socket.data.text += chunk.toString();
      if (!socket.data.text.includes("\n")) return;
      const request = JSON.parse(socket.data.text);
      const result = request.method === "session.snapshot" ? { snapshot: { panes: [{ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "t1", agent: "codex", agent_status: status, cwd: root, revision: 1 }] } }
        : request.method === "pane.read" ? { read: { text: screen } }
        : request.method === "agent.get" ? { agent: null, agent_session: null }
        : request.method === "pane.process_info" ? { process_info: { foreground_processes: [] } } : null;
      if (result === null) throw new Error(`Unexpected RPC: ${request.method}`);
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    },
  } });
});
afterEach(() => {
  listener.stop(true);
  if (previous === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = previous;
  rmSync(root, { recursive: true, force: true });
});
async function read() {
  const url = new URL("http://localhost/api/pane/prompt?pane_id=w1:p1");
  const response = await handlePromptRequest(new Request(url), url);
  expect(response?.status).toBe(200);
  return response?.json();
}
it("reports a native capacity failure without a transcript record, even when status still says working", async () => {
  for (const next of ["working", "blocked", "done"] as const) {
    status = next;
    expect(await read()).toMatchObject({ prompt: null, runtime_error: "model_capacity" });
  }
});
it("does not retain an older failure once Codex resumes or the user starts another prompt", async () => {
  for (const later of ["› continue", "• Browsing the web", "• Working (2s • esc to interrupt)", "• Done"]) {
    screen = `${failure}\n\n${later}\n\n› Ask Codex to do anything\n  gpt-6.1-sol high · 38% context left`;
    expect((await read()).runtime_error).toBeUndefined();
  }
});
it("handles a narrow terminal's wrapped failure", async () => {
  screen = "■ Selected model is at\n  capacity. Please try a\n  different model.\n\n›\n  gpt-6.1-sol high · 38% context left";
  expect((await read()).runtime_error).toBe("model_capacity");
});
it("does not treat a quoted error or an unverified screen as a native failure", async () => {
  for (const next of [`› ${failure}\n›\n gpt-6.1-sol high · 38% context left`, `${failure}\n›`, `Tool output:\n└ ${failure}\n›\n gpt-6.1-sol high · 38% context left`]) {
    screen = next;
    expect((await read()).runtime_error).toBeUndefined();
  }
});
