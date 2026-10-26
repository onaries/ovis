import { describe, expect, it } from "bun:test";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { appendChatRowSlots, continuesHistory, createChatRowSlots, insertChatRowSlots, prependChatRowSlots } from "./chatRows.ts";

const scope = { machineId: "local", paneId: "pane-a", historyId: "history-a", incarnation: 0 };
const keys = (rows: readonly { readonly key: string }[]) => rows.map((row) => row.key);

describe("chat row slots", () => {
  it("keeps existing keys when an older page prepends", () => {
    const newest = createChatRowSlots(scope, 2);
    const before = keys(newest.rows);

    const loaded = prependChatRowSlots(newest, 3);

    expect(keys(loaded.rows.slice(3))).toEqual(before);
    expect(new Set(keys(loaded.rows)).size).toBe(5);
  });

  it("keeps both sides stable when a held-page gap fills", () => {
    const loaded = createChatRowSlots(scope, 3);
    const before = keys(loaded.rows);

    const filled = insertChatRowSlots(loaded, 1, 2);

    expect(keys(filled.rows.slice(0, 1))).toEqual(before.slice(0, 1));
    expect(keys(filled.rows.slice(3))).toEqual(before.slice(1));
    expect(new Set(keys(filled.rows)).size).toBe(5);
  });

  it("keeps existing slots and allocates a distinct one when a new turn arrives", () => {
    const previous = createChatRowSlots(scope, 2);
    const loaded = appendChatRowSlots(previous, 1);

    expect(keys(loaded.rows.slice(0, 2))).toEqual(keys(previous.rows));
    expect(loaded.rows).toHaveLength(3);
    expect(new Set(keys(loaded.rows)).size).toBe(3);
  });

  it("does not reuse a slot when new turns arrive after a prepend", () => {
    const previous = prependChatRowSlots(createChatRowSlots(scope, 2), 3);
    const loaded = appendChatRowSlots(previous, 2);

    expect(keys(loaded.rows.slice(0, 5))).toEqual(keys(previous.rows));
    expect(new Set(keys(loaded.rows)).size).toBe(7);
  });

  it("separates replacements when the bridge supplies no history ID", () => {
    const first = createChatRowSlots({ ...scope, historyId: null }, 2);
    const replacement = createChatRowSlots({ ...scope, historyId: null, incarnation: 1 }, 2);

    expect(keys(first.rows).some((key) => keys(replacement.rows).includes(key))).toBeFalse();
  });

  it("separates machine, pane, and history identities", () => {
    const local = keys(createChatRowSlots(scope, 1).rows);
    const remote = keys(createChatRowSlots({ ...scope, machineId: "studio-mac" }, 1).rows);
    const otherPane = keys(createChatRowSlots({ ...scope, paneId: "pane-b" }, 1).rows);
    const otherHistory = keys(createChatRowSlots({ ...scope, historyId: "history-b" }, 1).rows);

    expect(local).not.toEqual(remote);
    expect(local).not.toEqual(otherPane);
    expect(local).not.toEqual(otherHistory);
  });
});

describe("continuesHistory", () => {
  const turn = (role: ConversationTurn["role"], ts: string | null, text: string = role): ConversationTurn => ({ role, ts, parts: [{ kind: "text", text }] });
  const page = (turns: ConversationTurn[], source: "gjc-transcript" | "pi-transcript" | "claude-transcript" | "scrollback" = "gjc-transcript") => ({ source, turns });
  const tool = (name: string, output: string): ConversationTurn["parts"][number] => ({ kind: "tool", name, summary: name, input: "{}", output });
  const working = (...tools: ConversationTurn["parts"]): ConversationTurn => ({ role: "assistant", ts: "2026-10-24T00:00:02Z", parts: [{ kind: "text", text: "Reading." }, ...tools] });
  const shown = page([turn("user", "2026-10-24T00:00:01Z"), working(tool("read", "alpha"), tool("read", "beta"))]);

  it("continues a rewrite that holds every shown turn, trimmed or followed by more", () => {
    expect(continuesHistory(shown, page([turn("user", "2026-10-24T00:00:01Z"), working(tool("read", "[trimmed]"), tool("read", "beta"), tool("bash", "")), turn("user", "2026-10-24T00:00:09Z")]))).toBeTrue();
    expect(continuesHistory(shown, shown)).toBeTrue();
  });

  it("starts over when a shown turn's parts are not the ones it had", () => {
    expect(continuesHistory(shown, page([turn("user", "2026-10-24T00:00:01Z"), working(tool("read", "alpha"), tool("bash", "beta"))]))).toBeFalse();
    expect(continuesHistory(shown, page([turn("user", "2026-10-24T00:00:01Z"), working(tool("read", "alpha"))]))).toBeFalse();
  });

  it("starts over when a rewind put another call of the same tool in a shown place", () => {
    const call = (input: string, callId?: string): ConversationTurn["parts"][number] => ({ kind: "tool", name: "read", summary: "read", input, output: "", ...(callId === undefined ? {} : { call_id: callId }) });
    const before = page([turn("user", "2026-10-24T00:00:01Z"), working(call('{"path":"src/alpha.ts"}'), call('{"path":"src/beta.ts"}', "c2"))]);
    expect(continuesHistory(before, page([turn("user", "2026-10-24T00:00:01Z"), working(call('{"path":"src/alpha.ts"}'), call('{"path":"src/gamma.ts"}', "c2"))]))).toBeFalse();
    expect(continuesHistory(before, page([turn("user", "2026-10-24T00:00:01Z"), working(call('{"path":"src/alpha.ts"}'), call('{"path":"src/beta.ts"}', "c3"))]))).toBeFalse();
    expect(continuesHistory(before, page([turn("user", "2026-10-24T00:00:01Z"), working(call('{"path":"src/alpha.ts"}'), call('{"path":"src/beta.ts"}', "c2"))]))).toBeTrue();
  });

  it("starts over when a shown turn is gone, moved or has another start", () => {
    // a compaction that dropped the first turns: the newest page starts later than what is shown
    expect(continuesHistory(shown, page([shown.turns[1]!, turn("user", "2026-10-24T00:00:09Z")]))).toBeFalse();
    expect(continuesHistory(shown, page([turn("user", "2026-10-24T00:00:01Z")]))).toBeFalse();
    expect(continuesHistory(shown, page([turn("user", "2026-10-24T00:00:01Z"), turn("assistant", "2026-10-24T00:00:05Z")]))).toBeFalse();
    expect(continuesHistory(shown, page([turn("assistant", "2026-10-24T00:00:02Z"), turn("user", "2026-10-24T00:00:09Z")]))).toBeFalse();
    expect(continuesHistory(shown, page([turn("user", "2026-10-24T00:00:01Z"), turn("user", "2026-10-24T00:00:02Z")]))).toBeFalse();
  });

  it("starts over for another agent, another source, a scrollback, nothing shown or turns without a start", () => {
    expect(continuesHistory(page(shown.turns, "pi-transcript"), page(shown.turns, "pi-transcript"))).toBeFalse();
    expect(continuesHistory(shown, page(shown.turns, "claude-transcript"))).toBeFalse();
    expect(continuesHistory(page(shown.turns, "scrollback"), page(shown.turns, "scrollback"))).toBeFalse();
    expect(continuesHistory(null, shown)).toBeFalse();
    expect(continuesHistory(page([]), shown)).toBeFalse();
    const untimed = page([turn("user", null), turn("assistant", null)]);
    expect(continuesHistory(untimed, untimed)).toBeFalse();
  });
});
