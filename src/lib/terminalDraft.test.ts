import { expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { acknowledgeTerminalDraft, readTerminalDraft, setTerminalDraftSending, terminalDraftSending, terminalDraftVersion, writeTerminalDraft } from "./terminalDraft.ts";

it("preserves edits across remounts and confines acknowledgements to the submitting PC/pane", () => {
  const owner = "remote-a:w1:p1";
  const other = "remote-b:w1:p1";
  writeTerminalDraft(owner, "sent");
  writeTerminalDraft(other, "other");
  setTerminalDraftSending(owner, true);
  expect(terminalDraftSending(owner)).toBe(true);
  writeTerminalDraft(owner, "sent plus 한글");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe(" plus 한글");
  expect(readTerminalDraft(other)).toBe("other");
});

it("does not erase a replacement even when the user retypes the same text before acknowledgement", () => {
  const owner = "edited:w1:p1";
  writeTerminalDraft(owner, "same text");
  setTerminalDraftSending(owner, true);
  writeTerminalDraft(owner, "");
  writeTerminalDraft(owner, "same text");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe("same text");
});

it("late ack keeps replacement draft", () => {
  // an Insert on its way: the draft is replaced meanwhile, then the acknowledgement comes
  const owner = "insert:w1:p1";
  writeTerminalDraft(owner, "git status");
  setTerminalDraftSending(owner, true);
  expect(terminalDraftVersion(owner)).toBeGreaterThan(0);
  writeTerminalDraft(owner, "git log");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe("git log");
  // text typed after the sent prefix while it was on its way stays; the prefix goes
  writeTerminalDraft(owner, "git log");
  setTerminalDraftSending(owner, true);
  writeTerminalDraft(owner, "git log --oneline");
  acknowledgeTerminalDraft(owner);
  setTerminalDraftSending(owner, false);
  expect(readTerminalDraft(owner)).toBe(" --oneline");
});

it("counts every write of a draft, so a paste can tell an edit made while it waited", () => {
  const owner = "version:w1:p1";
  const before = terminalDraftVersion(owner);
  writeTerminalDraft(owner, "a");
  expect(terminalDraftVersion(owner)).toBe(before + 1);
  writeTerminalDraft(owner, "a");
  expect(terminalDraftVersion(owner)).toBe(before + 2);
  expect(terminalDraftVersion("version:w1:p2")).toBe(0);
});

it("counts a line a herdr replacement took away, typed or not, so a paste that waited is not put into the new pane's line", () => {
  const roster = (lifetime: string) => [{ id: "local", snapshot: { panes: [], herdr_lifetime: lifetime } } as unknown as Machine];
  paneLifetimes.observe(roster("retire-herdr-a"), (item) => item.pane_id);
  writeTerminalDraft("retire:w1:p1", "make release");
  const typed = terminalDraftVersion("retire:w1:p1");
  // a paste into an empty line asks for its count before the clipboard answers
  const empty = terminalDraftVersion("retire:w1:p2");
  paneLifetimes.observe(roster("retire-herdr-b"), (item) => item.pane_id);
  expect(readTerminalDraft("retire:w1:p1")).toBe("");
  expect(terminalDraftVersion("retire:w1:p1")).not.toBe(typed);
  expect(terminalDraftVersion("retire:w1:p2")).not.toBe(empty);
});
