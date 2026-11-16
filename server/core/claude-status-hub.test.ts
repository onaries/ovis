import { describe, expect, it, jest, type Mock, setSystemTime, spyOn } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as conversation from "../conversation.ts";
import { claude, handlers, hub, line, root, workingClaude } from "./status.fake.ts";

// Claude Code 2.1.321 at an API rate limit, as recorded: the turn's answer entry is the error (isApiErrorMessage)
const failed = readFileSync(join(import.meta.dir, "..", "fixtures", "claude-api-error-2.1.321.jsonl"), "utf8");
/** the recorded error entry alone, for a turn whose prompt a fixture wrote already */
const failedEntry = `${failed.trim().split("\n").at(-1)!}\n`;
const prompt = (text: string) => line({ type: "user", origin: { kind: "human" }, timestamp: new Date().toISOString(), message: { role: "user", content: text } });
const answer = (text: string) => line({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });
/** the stood-in lookup of a pane's transcript (status.fake.ts) */
const lookup = () => conversation.claudePaneSession as Mock<typeof conversation.claudePaneSession>;

let sessions = 0;
/**
 * a hub whose Claude pane reads `path` as its transcript, found by a snapshot while the pane is at rest; `text` null: a
 * new session, whose transcript Claude Code writes only with its first message. `found`: the lookup finds the transcript
 * only once it exists, as the real one does (conversation.ts claudeTranscriptPath)
 */
async function claudeHub(text: string | null, found = false) {
  const id = `44444444-4444-4444-8444-${String(++sessions).padStart(12, "0")}`;
  const path = join(root, `${id}.jsonl`);
  if (text !== null) writeFileSync(path, text);
  const pane = { ...claude, agent_session: { ...claude.agent_session, value: id } };
  const h = hub(path);
  if (found) lookup().mockImplementation(async () => existsSync(path) ? { path, startedAt: null, pid: null } : null);
  const failures: string[] = [];
  spyOn(h.status.push, "onFailed").mockImplementation(async (paneId: string) => { failures.push(paneId); });
  h.herdrSays(pane);
  handlers.onBaseline([pane]);
  await h.snapshot();
  return { ...h, path, pane, failures };
}

describe("a Claude pane whose turn ended on an API error", () => {
  it("reads at rest and tells the failure once, never DONE, for a turn this server saw run", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, failed);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("idle");
    expect(h.alerts).toEqual(["working", "idle"]);
    expect(h.failures).toEqual([h.pane.pane_id]);
    expect(h.pending.current(h.pane.pane_id)).toBe("idle");
    // herdr's own DONE for the pane, in a snapshot or an event, changes nothing and tells nothing again
    h.herdrSays({ ...h.pane, agent_status: "done" });
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("idle");
    handlers.onStatus(h.pane.pane_id, "done", "claude");
    expect(h.last().status).toBe("idle");
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("finishes the turn after a failure that answered", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, failed);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("idle");
    // the user sends again, and the retry gets through
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    appendFileSync(h.path, `${prompt("again")}${answer("Done")}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    expect(h.alerts.at(-1)).toBe("done");
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("finishes a turn whose API error a retry answered before the rest", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, `${failed}${answer("Done")}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    expect(h.failures).toEqual([]);
  });

  it("finishes a turn that answered, as before", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, `${prompt("go")}${answer("Done")}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    expect(h.alerts).toEqual(["working", "done"]);
    expect(h.failures).toEqual([]);
  });

  it("reads an API error written after the rest was told at the next snapshot, and a retry's answer after it as the finish", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, prompt("go"));
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    appendFileSync(h.path, failed);
    h.herdrSays({ ...h.pane, agent_status: "done" });
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("idle");
    expect(h.last().status).toBe("idle");
    expect(h.failures).toEqual([h.pane.pane_id]);
    // the same file read again finds nothing new and tells nothing again
    await h.snapshot();
    expect(h.failures).toEqual([h.pane.pane_id]);
    appendFileSync(h.path, answer("Done"));
    await h.snapshot();
    expect(h.last().status).toBe("done");
    expect(h.alerts.at(-1)).toBe("done");
  });

  it("tells the failure of a turn held on its background work once that wait ends with no turn after it", async () => {
    jest.useFakeTimers();
    try {
      const h = await workingClaude();
      const failures: string[] = [];
      spyOn(h.status.push, "onFailed").mockImplementation(async (paneId: string) => { failures.push(paneId); });
      appendFileSync(h.path, failedEntry);
      handlers.onStatus(h.pane.pane_id, "idle", "claude");
      // at rest, held on the subagent the turn started: the alerts take it for working, and no failure is told yet
      expect(h.last()).toEqual({ status: "idle", tasks: 1, bg: true });
      expect(failures).toEqual([]);
      // the subagent ends, no turn follows it, and the wait runs out: the failure is told then, once
      appendFileSync(h.child, line({ type: "assistant", isSidechain: true, timestamp: new Date().toISOString(), message: { role: "assistant", stop_reason: "end_turn", content: [] } }));
      h.poll();
      jest.advanceTimersByTime(61_000);
      expect(h.last()).toEqual({ status: "idle", tasks: 0, bg: false });
      expect(h.alerts.at(-1)).toBe("idle");
      expect(failures).toEqual([h.pane.pane_id]);
      jest.advanceTimersByTime(5_000);
      expect(failures).toEqual([h.pane.pane_id]);
    } finally { jest.useRealTimers(); }
  });

  it("tells nothing of a later turn's failure it did not see run, after one it saw answer", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, `${prompt("go")}${answer("Done")}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    // status events are lost meanwhile: a turn begins and ends on an API error unseen, and a snapshot reads the pane at rest
    appendFileSync(h.path, `${prompt("next")}${failedEntry}`);
    h.herdrSays({ ...h.pane, agent_status: "done" });
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("done");
    expect(h.failures).toEqual([]);
  });

  it("tells no failure of a turn that answered in a new session while the pane still names the old transcript (/clear)", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, failed);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.failures).toEqual([h.pane.pane_id]);
    // /clear: the next turn writes a transcript of its own, and rests before a snapshot binds the pane to it
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(join(root, `44444444-4444-4444-8444-${String(++sessions).padStart(12, "0")}.jsonl`), `${prompt("again")}${answer("Done")}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    expect(h.alerts.at(-1)).toBe("done");
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("tells a failure once, however often the pane works and rests after it without writing to its transcript", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, failed);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.failures).toEqual([h.pane.pane_id]);
    for (let cycle = 0; cycle < 2; cycle++) {
      handlers.onStatus(h.pane.pane_id, "working", "claude");
      handlers.onStatus(h.pane.pane_id, "idle", "claude");
      expect(h.last().status).toBe("done");
    }
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("reads a retry whose prompt is only half written at its rest by herdr's word, not by the failure before it", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, failed);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.failures).toEqual([h.pane.pane_id]);
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    const retry = prompt("again");
    appendFileSync(h.path, retry.slice(0, 20));
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    expect(h.failures).toEqual([h.pane.pane_id]);
    // the retry, written whole and answered, is the finish told already
    appendFileSync(h.path, `${retry.slice(20)}${answer("Done")}`);
    h.herdrSays({ ...h.pane, agent_status: "done" });
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("done");
    expect(h.last().status).toBe("done");
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("reads the first turn of a new session, whose transcript did not exist as it began, at rest with one failure alert once its transcript is found", async () => {
    const h = await claudeHub(null, true);
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, `${prompt("go")}${failedEntry}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    // no transcript found for the pane yet: herdr's word, as on main
    expect(h.last().status).toBe("done");
    expect(h.failures).toEqual([]);
    h.herdrSays({ ...h.pane, agent_status: "done" });
    // the lookup is tried again only a while after the last one: the snapshot then finds the transcript, the next reads it
    setSystemTime(new Date(Date.now() + 6000));
    try {
      await h.snapshot();
      expect((await h.snapshot()).panes[0]!.agent_status).toBe("idle");
    } finally { setSystemTime(); }
    expect(h.last().status).toBe("idle");
    expect(h.alerts).toEqual(["working", "done", "idle"]);
    expect(h.failures).toEqual([h.pane.pane_id]);
    await h.snapshot();
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("finishes the first turn of a new session that answered", async () => {
    const h = await claudeHub(null);
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, `${prompt("go")}${answer("Done")}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    expect(h.alerts).toEqual(["working", "done"]);
    expect(h.failures).toEqual([]);
  });

  it("tells no failure of a turn that answered after /clear while the lookup still names the old transcript, ending on an error", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, failed);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.failures).toEqual([h.pane.pane_id]);
    // /clear: herdr names the new session, and a snapshot reads it while the lookup still finds the old transcript
    const cleared = { ...h.pane, agent_session: { ...h.pane.agent_session, value: `44444444-4444-4444-8444-${String(++sessions).padStart(12, "0")}` } };
    h.herdrSays(cleared);
    await h.snapshot();
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(join(root, `${cleared.agent_session.value}.jsonl`), `${prompt("again")}${answer("Done")}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    h.herdrSays({ ...cleared, agent_status: "done" });
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("done");
    expect(h.last().status).toBe("done");
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("reads nothing of a transcript older than the turn that the pane's lookup names only once the turn began", async () => {
    const h = await claudeHub(null);
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    // an older session's transcript, ending on an API error, appears where the lookup points
    const before = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(h.path, `${line({ type: "user", origin: { kind: "human" }, timestamp: before, message: { role: "user", content: "go" } })}${failedEntry}`);
    await h.snapshot();
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    h.herdrSays({ ...h.pane, agent_status: "done" });
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("done");
    expect(h.failures).toEqual([]);
  });

  it("tells no failure of a turn that answered in a new session while the lookup still names the previous one, begun moments before and ending on an error", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, `${prompt("go")}${failedEntry}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.failures).toEqual([h.pane.pane_id]);
    // /clear at once: herdr names the new session, and the turn begins while the lookup for it, which names the
    // previous session's transcript, is under way
    const cleared = { ...h.pane, agent_session: { ...h.pane.agent_session, value: `44444444-4444-4444-8444-${String(++sessions).padStart(12, "0")}` } };
    h.herdrSays(cleared);
    const looking = Promise.withResolvers<{ path: string; startedAt: null; pid: null }>();
    lookup().mockImplementation(() => looking.promise);
    const bound = h.status.claudeAgents.refresh([cleared as never]);
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    looking.resolve({ path: h.path, startedAt: null, pid: null });
    await bound;
    writeFileSync(join(root, `${cleared.agent_session.value}.jsonl`), `${prompt("again")}${answer("Done")}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("tells no failure of a turn that wrote no prompt into a new session's transcript of entries copied with fresh stamps", async () => {
    const h = await claudeHub(null);
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    // a session continued into a new file: its summary, then entries of the old one stamped anew, ending on its API error
    const now = new Date().toISOString();
    const summary = line({ type: "user", isCompactSummary: true, timestamp: now, message: { role: "user", content: "This session is being continued from a previous conversation." } });
    writeFileSync(h.path, `${summary}${answer("Earlier")}${line({ ...JSON.parse(failedEntry) as object, timestamp: now })}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    expect(h.failures).toEqual([]);
  });

  it("tells no failure of a turn that answered after /clear, while herdr still names the session before, which failed at once", async () => {
    const h = await claudeHub(null, true);
    // a new session's first turn fails at once, its transcript not found for the pane yet: herdr's word, as on main
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, `${prompt("go")}${failedEntry}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    // /clear moments later: the next turn answers in a session of its own, while herdr still names the first
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(join(root, `44444444-4444-4444-8444-${String(++sessions).padStart(12, "0")}.jsonl`), `${prompt("again")}${answer("Done")}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    // the lookup, tried again a while later, finds the first session's transcript: it began before the pane's last rest
    h.herdrSays({ ...h.pane, agent_status: "done" });
    setSystemTime(new Date(Date.now() + 6000));
    try {
      await h.snapshot();
      expect((await h.snapshot()).panes[0]!.agent_status).toBe("done");
    } finally { setSystemTime(); }
    expect(h.last().status).toBe("done");
    expect(h.alerts).toEqual(["working", "done", "working", "done"]);
    expect(h.failures).toEqual([]);
  });

  it("tells no second failure for a turn after a failure whose prompt opens on bash mode's tags", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    writeFileSync(h.path, failed);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.failures).toEqual([h.pane.pane_id]);
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    appendFileSync(h.path, prompt("<bash-stdout>ok</bash-stdout> please explain this output"));
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    h.herdrSays({ ...h.pane, agent_status: "done" });
    await h.snapshot();
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("reads an API error written after a rest whose turn took a queued prompt in after an answer", async () => {
    const h = await claudeHub("");
    handlers.onStatus(h.pane.pane_id, "working", "claude");
    const queued = line({ type: "attachment", timestamp: new Date().toISOString(), attachment: { type: "queued_command", commandMode: "prompt", prompt: "and this", origin: { kind: "human" } } });
    writeFileSync(h.path, `${prompt("go")}${answer("Done")}${queued}`);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("done");
    expect(h.failures).toEqual([]);
    appendFileSync(h.path, failedEntry);
    h.herdrSays({ ...h.pane, agent_status: "done" });
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("idle");
    expect(h.last().status).toBe("idle");
    expect(h.failures).toEqual([h.pane.pane_id]);
    await h.snapshot();
    expect(h.failures).toEqual([h.pane.pane_id]);
  });

  it("tells no failure held on its background work when a new prompt, not its work's end, ends the wait", async () => {
    const h = await workingClaude();
    const failures: string[] = [];
    spyOn(h.status.push, "onFailed").mockImplementation(async (paneId: string) => { failures.push(paneId); });
    appendFileSync(h.path, failedEntry);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last()).toEqual({ status: "idle", tasks: 1, bg: true });
    // the user sends a new prompt: the tracker reads it before herdr says the pane works
    appendFileSync(h.path, line({ type: "user", origin: { kind: "human" }, timestamp: new Date(Date.now() + 1000).toISOString(), message: { role: "user", content: "next" } }));
    await h.poll();
    expect(h.last().bg).toBe(false);
    expect(failures).toEqual([]);
  });

  it("tells nothing of a failure it never saw run: a pane found already at rest, after a restart", async () => {
    const h = await claudeHub(failed);
    handlers.onStatus(h.pane.pane_id, "idle", "claude");
    expect(h.last().status).toBe("idle");
    expect(h.failures).toEqual([]);
    h.herdrSays({ ...h.pane, agent_status: "done" });
    expect((await h.snapshot()).panes[0]!.agent_status).toBe("done");
    expect(h.failures).toEqual([]);
  });
});
