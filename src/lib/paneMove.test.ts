import { expect, it } from "bun:test";
import { ComposerDraftStore } from "./composerDraft.ts";
import { carryPaneState } from "./paneMove.ts";
import { readTerminalDraft, setTerminalDraftSending, writeTerminalDraft } from "./terminalDraft.ts";
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, drafts: new ComposerDraftStore(() => storage), storage: () => storage };
}
it("carries the chat draft, the held terminal input and the picked lens to the pane's new ID, sending nothing", () => {
  const { data, drafts, storage } = fixture();
  drafts.set("ovis:composer-draft:w1:p1", "unsent question");
  data.set("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo held", at: 1 }));
  data.set("ovis:view:w1:p1", "terminal");
  // another pane's state, and the same pane ID on another PC, stay where they are
  data.set("ovis:view:w1:p2", "chat");
  drafts.set("ovis:composer-draft:remote:pc:w1%3Ap1", "other PC");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage);
  expect(drafts.read("ovis:composer-draft:w2:p4")).toEqual({ text: "unsent question", sending: false });
  expect(drafts.read("ovis:composer-draft:w1:p1").text).toBe("");
  expect(data.get("ovis:terminal-draft:w2:p4")).toBe(JSON.stringify({ text: "echo held", at: 1 }));
  expect(data.get("ovis:view:w2:p4")).toBe("terminal");
  expect([...data.keys()].filter((key) => key.endsWith(":w1:p1"))).toEqual([]);
  expect(data.get("ovis:view:w1:p2")).toBe("chat");
  expect(drafts.read("ovis:composer-draft:remote:pc:w1%3Ap1").text).toBe("other PC");
});
it("leaves a draft whose send is on its way, and keeps what the new ID holds already", () => {
  const { data, drafts, storage } = fixture();
  drafts.set("ovis:composer-draft:w1:p1", "on its way");
  expect(drafts.begin("ovis:composer-draft:w1:p1", "on its way")).toBe(true);
  data.set("ovis:view:w1:p1", "chat");
  data.set("ovis:view:w2:p4", "terminal");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage);
  expect(drafts.read("ovis:composer-draft:w1:p1")).toEqual({ text: "on its way", sending: true });
  expect(drafts.read("ovis:composer-draft:w2:p4").text).toBe("");
  expect(data.get("ovis:view:w2:p4")).toBe("terminal");
  expect(data.get("ovis:view:w1:p1")).toBe("chat");
});
it("carries a touch screen's unsent terminal line to the new ID, and leaves one on its way", () => {
  const { drafts, storage } = fixture();
  writeTerminalDraft("w7:p1", "git status");
  carryPaneState("local", "w7:p1", "w8:p2", drafts, storage);
  expect(readTerminalDraft("w8:p2")).toBe("git status");
  expect(readTerminalDraft("w7:p1")).toBe("");
  writeTerminalDraft("w7:p3", "make");
  setTerminalDraftSending("w7:p3", true);
  carryPaneState("local", "w7:p3", "w8:p4", drafts, storage);
  setTerminalDraftSending("w7:p3", false);
  expect(readTerminalDraft("w7:p3")).toBe("make");
  expect(readTerminalDraft("w8:p4")).toBe("");
});
