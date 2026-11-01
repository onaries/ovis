import { expect, it } from "bun:test";
import { paneStorageId, type Machine } from "../../shared/machines.ts";
import { ComposerDraftStore } from "./composerDraft.ts";
import { ReplyCommentStore } from "./replyComments.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { carryPaneState } from "./paneMove.ts";
import { readTerminalDraft, setTerminalDraftSending, writeTerminalDraft } from "./terminalDraft.ts";
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, drafts: new ComposerDraftStore(() => storage), storage: () => storage, comments: new ReplyCommentStore(() => storage) };
}
it("carries the chat draft, the held terminal input and the picked lens to the pane's new ID, sending nothing", () => {
  const { data, drafts, storage, comments } = fixture();
  drafts.set("ovis:composer-draft:w1:p1", "unsent question");
  data.set("ovis:terminal-draft:w1:p1", JSON.stringify({ text: "echo held", at: 1 }));
  data.set("ovis:view:w1:p1", "terminal");
  data.set("ovis:reply-comments:w1:p1", JSON.stringify([{ id: "c1", quote: "q", comment: "c" }]));
  // another pane's state, and the same pane ID on another PC, stay where they are
  data.set("ovis:view:w1:p2", "chat");
  drafts.set("ovis:composer-draft:remote:pc:w1%3Ap1", "other PC");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  expect(drafts.read("ovis:composer-draft:w2:p4")).toEqual({ text: "unsent question", sending: false });
  expect(drafts.read("ovis:composer-draft:w1:p1").text).toBe("");
  expect(data.get("ovis:terminal-draft:w2:p4")).toBe(JSON.stringify({ text: "echo held", at: 1 }));
  expect(data.get("ovis:view:w2:p4")).toBe("terminal");
  // the comments waiting on its replies go with it (#511)
  expect(data.get("ovis:reply-comments:w2:p4")).toBe(JSON.stringify([{ id: "c1", quote: "q", comment: "c" }]));
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
it("moves every waiting comment with the pane, and a send begun before the move removes only the ones it carried (#511)", () => {
  const { drafts, storage, comments } = fixture();
  const before = "ovis:reply-comments:w1:p1", after = "ovis:reply-comments:w2:p4";
  comments.add(before, "selected first", "send this");
  expect(drafts.begin("ovis:composer-draft:w1:p1", "go")).toBe(true);
  const carried = comments.read(before);
  // saved while that message is on its way: it waits for the next one
  comments.add(before, "selected second", "save for next message");
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  expect(comments.read(after).map((item) => item.comment)).toEqual(["send this", "save for next message"]);
  // the send is acknowledged under the ID it went with
  comments.removeSent(before, carried);
  expect(comments.read(after).map((item) => item.comment)).toEqual(["save for next message"]);
  expect(comments.read(before)).toEqual([]);
});
it("keeps the comments a refused send carried on the moved pane, after any it held already (#511)", () => {
  const { storage, drafts, comments } = fixture();
  comments.add("ovis:reply-comments:w2:p4", "its own", "already here");
  comments.add("ovis:reply-comments:w1:p1", "selected", "refused with its message");
  expect(drafts.begin("ovis:composer-draft:w1:p1", "go")).toBe(true);
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  expect(comments.read("ovis:reply-comments:w2:p4").map((item) => item.comment)).toEqual(["already here", "refused with its message"]);
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
it("carries what this page alone keeps for a PC that names no herdr, and writes none of it to storage", () => {
  const { data, storage } = fixture();
  const window = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage() } });
  try {
    // an older bridge names no herdr: its panes' state lives in the page (lib/paneLifetime.ts)
    paneLifetimes.observe([{ id: "older", snapshot: { panes: [] } } as unknown as Machine], (item) => item.pane_id);
    const before = paneStorageId("older", "w1:p1");
    const after = paneStorageId("older", "w2:p4");
    paneLifetimes.paneStorage.setItem(`ovis:terminal-draft:${before}`, JSON.stringify({ text: "echo held", at: 1 }));
    paneLifetimes.paneStorage.setItem(`ovis:view:${before}`, "terminal");
    carryPaneState("older", "w1:p1", "w2:p4", new ComposerDraftStore(() => paneLifetimes.paneStorage));
    expect(paneLifetimes.paneStorage.getItem(`ovis:terminal-draft:${after}`)).toBe(JSON.stringify({ text: "echo held", at: 1 }));
    expect(paneLifetimes.paneStorage.getItem(`ovis:view:${after}`)).toBe("terminal");
    expect(paneLifetimes.paneStorage.getItem(`ovis:view:${before}`)).toBeNull();
    expect([...data.keys()]).toEqual([]);
  } finally {
    if (window) Object.defineProperty(globalThis, "window", window);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
it("keeps the comments a send on its way carries out of a second send from the moved pane until the first settles (#511)", () => {
  const { drafts, storage, comments } = fixture();
  const before = "ovis:reply-comments:w1:p1", after = "ovis:reply-comments:w2:p4";
  comments.add(before, "quote", "carried");
  expect(drafts.begin("ovis:composer-draft:w1:p1", "first")).toBe(true);
  const carried = comments.read(before);
  comments.reserve(carried);
  carryPaneState("local", "w1:p1", "w2:p4", drafts, storage, comments);
  // the moved pane's own next message, before the first is acknowledged, carries none of them
  expect(drafts.read("ovis:composer-draft:w2:p4").sending).toBe(false);
  expect(comments.unreserved(comments.read(after))).toEqual([]);
  comments.add(after, "later", "for the next message");
  expect(comments.unreserved(comments.read(after)).map((item) => item.comment)).toEqual(["for the next message"]);
  // refused: they are free again, on the moved pane, none lost
  comments.release(carried);
  expect(comments.unreserved(comments.read(after)).map((item) => item.comment)).toEqual(["carried", "for the next message"]);
});
