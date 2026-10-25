import { expect, it, setSystemTime } from "bun:test";
import { ComposerDraftStore, SEND_LEASE_MS, storageEventDraft } from "./composerDraft.ts";
function fixture() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  return { data, store: new ComposerDraftStore(() => storage) };
}
it("keeps the draft busy and intact until an acknowledged send settles, and releases a refused send for retry", () => {
  const { store } = fixture();
  store.set("a", "check delivery");
  expect(store.begin("a", "check delivery")).toBe(true);
  expect(store.read("a")).toEqual({ text: "check delivery", sending: true });
  expect(store.begin("a", "check delivery")).toBe(false);
  store.settle("a", "check delivery");
  store.end("a");
  expect(store.read("a")).toEqual({ text: "", sending: false });
  store.set("a", "retry this");
  store.begin("a", "retry this");
  store.end("a");
  expect(store.read("a")).toEqual({ text: "retry this", sending: false });
  expect(store.begin("a", "retry this")).toBe(true);
});
it("settles an unmounted pane's draft and pending send without changing another owner", () => {
  const { store, data } = fixture();
  store.set("local:a", "sent"); store.begin("local:a");
  store.set("remote:a", "other PC");
  expect(store.begin("local:a")).toBe(false);
  store.settle("local:a", "sent"); store.end("local:a");
  expect(store.read("local:a")).toEqual({ text: "", sending: false });
  expect(data.has("local:a")).toBe(false);
  expect(store.read("remote:a").text).toBe("other PC");
});
it("preserves appended text, internal edits and newer edits from another tab", () => {
  const { store, data } = fixture();
  store.set("a", "sent plus next");
  expect(store.settle("a", "sent")).toEqual({ text: " plus next", edited: false });
  store.set("a", "edited sent");
  expect(store.settle("a", "sent")).toEqual({ text: "edited sent", edited: true });
  data.set("a", "another tab's draft");
  expect(store.settle("a", "sent").text).toBe("another tab's draft");
});
it("notifies a remounted composer and keeps a failed send's draft", () => {
  const { store } = fixture();
  store.set("a", "sent"); store.begin("a");
  let updates = 0;
  const off = store.subscribe(() => { updates++; });
  store.end("a");
  expect(store.read("a").text).toBe("sent");
  store.settle("a", "sent");
  expect(updates).toBe(2);
  off();
});
it("retains unsaved edits when browser storage is unavailable", () => {
  const store = new ComposerDraftStore(() => { throw new Error("blocked"); });
  store.set("a", "sent then next");
  expect(store.settle("a", "sent").text).toBe(" then next");
});
it("keeps a draft cleared and retyped while its send was on its way", () => {
  const { store } = fixture();
  store.set("a", "a"); store.begin("a", "a");
  store.set("a", ""); store.set("a", "ab");
  expect(store.settle("a", "a")).toEqual({ text: "ab", edited: true });
  store.end("a");
  // a plain append during the next send still loses only the sent prefix
  store.set("a", "x"); store.begin("a", "x");
  store.set("a", "xy");
  expect(store.settle("a", "x")).toEqual({ text: "y", edited: false });
  store.end("a");
});
it("keeps a draft another tab cleared and retyped while this tab's send was on its way", () => {
  const { store, data } = fixture();
  store.set("a", "sent"); store.begin("a", "sent");
  data.delete("a"); store.refresh("a");
  data.set("a", "sent again"); store.refresh("a");
  expect(store.settle("a", "sent")).toEqual({ text: "sent again", edited: true });
  store.end("a");
});
it("refuses a second tab's send while the first is still on its way", () => {
  const { data, store: first } = fixture();
  const second = new ComposerDraftStore(() => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  }));
  first.set("a", "do the thing");
  first.begin("a", "do the thing");
  // the other tab reads the same draft and sees the send, so it cannot send it again
  second.read("a");
  second.refresh("a");
  expect(second.read("a")).toEqual({ text: "do the thing", sending: true });
  expect(second.begin("a")).toBe(false);
  // the first tab's end is what releases it, and the draft text is still there to send
  first.end("a");
  second.refresh("a");
  expect(second.read("a")).toEqual({ text: "do the thing", sending: false });
  expect(second.begin("a")).toBe(true);
});
it("honours another tab's send as a lease, not forever", () => {
  const { data, store } = fixture();
  data.set("ovis:composer-sending:a", JSON.stringify({ sent: "x", at: Date.now() - SEND_LEASE_MS - 1 }));
  store.read("a");
  store.refresh("a");
  expect(store.read("a").sending).toBe(false);
  expect(store.begin("a")).toBe(true);
});
it("ignores a hand-edited sending record instead of blocking the pane", () => {
  const { data, store } = fixture();
  data.set("ovis:composer-sending:a", "not json");
  store.read("a");
  store.refresh("a");
  expect(store.begin("a")).toBe(true);
});
it("still reconciles another tab's text when no send is in flight", () => {
  const { data, store } = fixture();
  store.set("a", "mine");
  store.refresh("a");
  data.set("a", "theirs");
  store.refresh("a");
  expect(store.read("a").text).toBe("theirs");
});

it("names the draft another tab's edit or send concerns, and nothing else", () => {
  const key = "ovis:composer-draft:local:w1:p1";
  expect(storageEventDraft(key)).toBe(key);
  expect(storageEventDraft(`ovis:composer-sending:${key}`)).toBe(key);
  expect(storageEventDraft("ovis:settings")).toBeNull();
  expect(storageEventDraft(null)).toBeNull();
});

it("lets a tab send again once another tab's abandoned lease runs out, and tells its composer", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const wakeUps: Array<{ run: () => void; ms: number }> = [];
  const closed = new ComposerDraftStore(() => storage);
  const other = new ComposerDraftStore(() => storage, (run, ms) => { wakeUps.push({ run, ms }); return 0; });
  const key = "ovis:composer-draft:local:w1:p1";
  const start = Date.now();
  try {
    setSystemTime(start);
    expect(closed.begin(key, "hello")).toBe(true);
    // the other tab hears of the lease; the sending tab then closes without ending it
    other.refresh(key);
    expect(other.read(key).sending).toBe(true);
    expect(other.begin(key, "hello")).toBe(false);
    expect(wakeUps.length).toBe(1);
    expect(wakeUps[0]!.ms).toBeGreaterThan(SEND_LEASE_MS - 1000);
    let told = 0;
    other.subscribe(() => { told += 1; });
    setSystemTime(start + SEND_LEASE_MS + 1);
    wakeUps[0]!.run();
    expect(other.read(key).sending).toBe(false);
    expect(told).toBe(1);
    expect(other.begin(key, "hello")).toBe(true);
  } finally {
    setSystemTime();
  }
});
