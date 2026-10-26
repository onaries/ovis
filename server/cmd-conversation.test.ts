import { afterAll, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as cmd from "./cmd.ts";
import * as herdr from "./herdr/client.ts";
import { forgetTranscriptState, paneConversation, transcriptPage } from "./conversation.ts";

const root = mkdtempSync(join(tmpdir(), "cmd-conversation-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

it.each([null, "recorded-model"])("refreshes cmd model and ETag without an append or cached-page mutation (recorded %j)", async (recorded) => {
  const path = join(root, `session-${recorded}.jsonl`);
  writeFileSync(path, [
    { type: "session", id: "cmd-session", version: 3 },
    ...(recorded ? [{ type: "model_change", id: "m0", parentId: null, modelId: recorded }] : []),
    { type: "message", id: "u1", parentId: recorded ? "m0" : null, message: { role: "user", content: "hello" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const resolution = spyOn(cmd, "cmdTranscriptPath").mockResolvedValue({ path });
  const pane = {
    pane_id: "cmd-pane", agent: "cmd", agent_status: "idle", focused: false,
    revision: 1, tab_id: "tab", terminal_id: "terminal", workspace_id: "workspace", cwd: root,
  };
  const agent = { ...pane, tokens: { model: "first-model" } };
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: [pane], agents: [agent], workspaces: [], tabs: [], layouts: [], version: "fixture", protocol: 22,
  });
  const processes = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
    if (method !== "pane.process_info") throw new Error(`unexpected cmd fixture RPC: ${method}`);
    return { process_info: { foreground_processes: [] } };
  });
  try {
    const cached = transcriptPage("cmd-transcript", path);
    const first = await paneConversation(pane.pane_id);
    expect(first.metadata.model).toBe("first-model");
    expect((await paneConversation(pane.pane_id)).version).toBe(first.version);

    agent.tokens.model = "second-model";
    const second = await paneConversation(pane.pane_id);
    expect(second.metadata.model).toBe("second-model");
    expect(second.version).not.toBe(first.version);
    expect(first.metadata.model).toBe("first-model");
    expect(cached.metadata.model).toBe(recorded);
    expect(transcriptPage("cmd-transcript", path)).toEqual(cached);

    agent.tokens.model = "";
    const unknown = await paneConversation(pane.pane_id);
    expect(unknown.metadata.model).toBe(recorded);
  } finally {
    processes.mockRestore();
    snapshot.mockRestore();
    resolution.mockRestore();
    forgetTranscriptState();
  }
});
