import { describe, expect, it } from "bun:test";
import type { PendingMessage } from "../../shared/protocol.ts";
import { PendingMessageStore } from "./pendingMessages.ts";

const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
};
const message = (id: string, state: PendingMessage["state"] = "queued", text = "check the tests"): PendingMessage => ({ id, request_id: 1, text, state, created_at: "2026-10-06T00:00:00Z" });

describe("pending message ownership", () => {
  it("drops a first message delivered while its connection was down once the new connection's receipt says so", () => {
    const store = new PendingMessageStore(() => storage());
    // listed on the first connection, which then drops: kept, as not confirmed (a first message: no connection's request id)
    store.publish("p", [{ ...message("first", "queued", "Plan the config file"), request_id: -1 }], [], "connection-1");
    store.suspendScope("connection-1");
    expect(store.read("p")[0]!.state).toBe("uncertain");
    // the next connection is told it went: no copy is left uncertain
    store.publish("p", [], [{ id: "first", outcome: "sent" }], "connection-2");
    expect(store.read("p")).toEqual([]);
  });
  it("keeps a row a live connection proves when another connection's receipt names it (control)", () => {
    const store = new PendingMessageStore(() => storage());
    store.publish("p", [message("own")], [], "connection-1");
    store.publish("p", [], [{ id: "own", outcome: "sent" }], "connection-2");
    expect(store.read("p").map((row) => row.id)).toEqual(["own"]);
  });
  it("regression: advances a persisted attempt only on a definitive no-input refusal", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("h", "held"), null);
    store.begin("p", "h"); store.unconfirm("p", "h");
    store.fail("p", "h", { code: "agent_blocked", message: "nothing typed" }, false, 0);
    store.end("p", "h");
    expect(new PendingMessageStore(() => port).read("p")[0]!.resendGeneration).toBe(1);
    store.begin("p", "h"); store.unconfirm("p", "h");
    store.fail("p", "h", { code: "submit_changed", message: "uncertain" }, true, 1);
    store.end("p", "h");
    const restored = new PendingMessageStore(() => port).read("p")[0]!;
    expect(restored.resendGeneration).toBe(1);
    expect(restored.state).toBe("uncertain");
  });
  it("regression: duplicate refusal receipts advance once and an older uncertain receipt cannot poison the retry", () => {
    const port = storage(), a = new PendingMessageStore(() => port), b = new PendingMessageStore(() => port);
    a.accept("p", message("h", "held"), "owner-a");
    a.begin("p", "h"); b.begin("p", "h"); b.unconfirm("p", "h");
    a.fail("p", "h", { code: "agent_blocked", message: "nothing typed" }, false, 0);
    b.fail("p", "h", { code: "agent_blocked", message: "nothing typed" }, false, 0);
    a.end("p", "h"); b.end("p", "h");
    a.fail("p", "h", { code: "submit_changed", message: "old receipt" }, true, 0);
    const restored = new PendingMessageStore(() => port).read("p")[0]!;
    expect(restored.resendGeneration).toBe(1);
    expect(restored.state).toBe("held");
  });
  it("regression: an uncertain reply keeps its generation and survives another live owner's suspension", () => {
    const port = storage(), a = new PendingMessageStore(() => port), b = new PendingMessageStore(() => port);
    a.accept("p", message("h", "held"), "owner-a");
    b.begin("p", "h"); b.unconfirm("p", "h");
    b.fail("p", "h", { code: "submit_changed", message: "uncertain" }, true, 0);
    b.end("p", "h"); a.refresh("p"); a.suspend("p", "owner-a");
    const restored = new PendingMessageStore(() => port).read("p")[0]!;
    expect(restored.state).toBe("uncertain");
    expect(restored.resendGeneration).toBe(0);
  });
  it("regression: preserves another tab's resend mark when a live owner suspends", () => {
    const port = storage(), first = new PendingMessageStore(() => port);
    first.accept("p", message("h", "held"), "scope-a");
    const second = new PendingMessageStore(() => port);
    second.begin("p", "h");
    expect(second.unconfirm("p", "h")).toBe(true);
    first.refresh("p");
    first.suspend("p", "scope-a");
    expect(new PendingMessageStore(() => port).read("p")[0]!.state).toBe("uncertain");
  });
  it("regression: keeps another tab's resend mark through an authoritative row update", () => {
    const port = storage(), first = new PendingMessageStore(() => port);
    first.accept("p", message("h", "held"), "scope-a");
    const second = new PendingMessageStore(() => port);
    second.begin("p", "h"); second.unconfirm("p", "h");
    first.accept("p", message("h", "held"), "scope-a");
    first.suspend("p", "scope-a");
    expect(new PendingMessageStore(() => port).read("p")[0]!.state).toBe("uncertain");
  });
  it("regression: an unsaved owner preserves a recovered storage resend mark", () => {
    const port = storage();
    let full = false;
    const first = new PendingMessageStore(() => ({ ...port, setItem: (key, value) => {
      if (full) throw new Error("full");
      port.setItem(key, value);
    } }));
    first.accept("p", message("h", "held"), "scope-a");
    full = true;
    first.accept("p", message("other", "held"), "scope-a");
    const second = new PendingMessageStore(() => port);
    second.begin("p", "h"); second.unconfirm("p", "h");
    full = false;
    first.suspend("p", "scope-a");
    const rows = new PendingMessageStore(() => port).read("p");
    expect(rows.find((row) => row.id === "h")!.state).toBe("uncertain");
    expect(rows.find((row) => row.id === "other")!.text).toBe("check the tests");
  });
  it("regression: refuses resend when both storage reads and writes throw", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("h", "held"), null);
    let blocked = false;
    const tab = new PendingMessageStore(() => blocked ? {
      getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {},
    } : port);
    tab.begin("p", "h");
    blocked = true;
    expect(tab.unconfirm("p", "h")).toBe(false);
  });
  it("restores saved queued and sending text as uncertain, without arming delivery", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("q"), "connection-1");
    live.accept("pc:pane", message("s", "sending"), "connection-1");
    live.accept("pc:pane", message("h", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.read("pc:pane").map(({ id, state, serverOwned }) => [id, state, serverOwned])).toEqual([["q", "uncertain", false], ["s", "uncertain", false], ["h", "held", false]]);
    restored.publish("pc:pane", [], [], "connection-2");
    expect(restored.read("pc:pane")).toHaveLength(3);
  });
  it("keeps owner isolation and requires a matching connection proof for removal receipts", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("local:p1", message("one"), "scope-1");
    store.accept("remote:p1", message("two"), "scope-2");
    store.publish("local:p1", [], [{ id: "one", outcome: "sent" }], "scope-2");
    expect(store.read("local:p1")).toHaveLength(1);
    store.publish("local:p1", [], [{ id: "one", outcome: "sent" }], "scope-1");
    expect(store.read("local:p1")).toEqual([]);
    expect(store.read("remote:p1")[0]!.id).toBe("two");
  });
  it("suspends unconfirmed deliveries, retains confirmed held items, and cannot be rearmed by a late ACK", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("q"), "old");
    store.accept("p", message("h", "held"), "old");
    store.suspendScope("old");
    store.accept("p", message("q"), null);
    expect(store.read("p").map(({ state, serverOwned }) => [state, serverOwned])).toEqual([["uncertain", false], ["held", false]]);
    store.publish("p", [], [{ id: "q", outcome: "sent" }], "new");
    expect(store.read("p")).toHaveLength(2);
  });
  it("retains identical texts with different IDs and serializes actions on one ID", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("a"), "scope");
    store.accept("p", message("b"), "scope");
    expect(store.read("p")).toHaveLength(2);
    expect(store.begin("p", "a")).toBe(true);
    expect(store.begin("p", "a")).toBe(false);
    store.publish("p", [], [{ id: "a", outcome: "discarded" }], "scope");
    store.end("p", "a");
    expect(store.read("p").map((row) => row.id)).toEqual(["b"]);
  });
  it("does not resurrect an already delivered ID when its acceptance ACK arrives late", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("a"), "scope");
    store.publish("p", [], [{ id: "a", outcome: "sent" }], "scope");
    store.accept("p", message("a"), "scope");
    expect(store.read("p")).toEqual([]);
  });
  it("does not let another tab's saved copy discard a live server-owned request", () => {
    const port = storage(), own = new PendingMessageStore(() => port);
    own.accept("p", message("a"), "scope");
    const other = new PendingMessageStore(() => port);
    expect(other.read("p")[0]!.state).toBe("uncertain");
    other.removeCopy("p", "a");
    own.refresh("p");
    expect(own.read("p")[0]!.serverOwned).toBe(true);
  });
  it("keeps another tab's saved message when a removal receipt arrives before that tab's storage event", () => {
    const port = storage(), first = new PendingMessageStore(() => port), second = new PendingMessageStore(() => port);
    first.accept("pc:pane", message("x"), "connection-a");
    second.read("pc:pane");
    second.accept("pc:pane", message("y"), "connection-b");
    first.publish("pc:pane", [], [{ id: "x", outcome: "sent" }], "connection-a");
    expect(first.read("pc:pane").map((item) => item.id)).toEqual(["y"]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map((item) => item.id)).toEqual(["y"]);
  });
  it("saves a held copy as not confirmed while it is sent again, and as held once that is refused", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("h", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.begin("pc:pane", "h")).toBe(true);
    restored.unconfirm("pc:pane", "h");
    expect(restored.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "held"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
    restored.fail("pc:pane", "h", { code: "agent_blocked", message: "menu" }, false);
    restored.end("pc:pane", "h");
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "held"]]);
  });
  it("keeps a copy being sent again not confirmed through another row's write", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("a", "held"), "connection-1");
    live.accept("pc:pane", message("b", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.begin("pc:pane", "a")).toBe(true);
    restored.unconfirm("pc:pane", "a");
    restored.removeCopy("pc:pane", "b");
    expect(restored.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["a", "held"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["a", "uncertain"]]);
  });
  it("keeps another tab's saved message when a held copy is marked before that tab's storage event", () => {
    const port = storage(), seed = new PendingMessageStore(() => port);
    seed.accept("pc:pane", message("h", "held"), "connection-0");
    const first = new PendingMessageStore(() => port), second = new PendingMessageStore(() => port);
    first.read("pc:pane"); second.read("pc:pane");
    second.accept("pc:pane", message("y"), "connection-b");
    expect(first.begin("pc:pane", "h")).toBe(true);
    first.unconfirm("pc:pane", "h");
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"], ["y", "uncertain"]]);
  });
  it("keeps another tab's mark when this tab writes the list for a row of its own", () => {
    const port = storage(), seed = new PendingMessageStore(() => port);
    seed.accept("pc:pane", message("h", "held"), "connection-0");
    seed.accept("pc:pane", message("b", "held"), "connection-0");
    const first = new PendingMessageStore(() => port), second = new PendingMessageStore(() => port);
    first.read("pc:pane"); second.read("pc:pane");
    expect(first.begin("pc:pane", "h")).toBe(true);
    expect(first.unconfirm("pc:pane", "h")).toBe(true);
    second.removeCopy("pc:pane", "b");
    expect(second.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
  });
  it("does not send a held copy again when its mark cannot be saved over the saved copy", () => {
    const port = storage(), seed = new PendingMessageStore(() => port);
    seed.accept("pc:pane", message("h", "held"), "connection-0");
    const full = new PendingMessageStore(() => ({ ...port, setItem: () => { throw new Error("quota"); } }));
    expect(full.begin("pc:pane", "h")).toBe(true);
    expect(full.unconfirm("pc:pane", "h")).toBe(false);
    // with nothing saved there is no copy a reload could offer again
    const none = new PendingMessageStore(() => ({ getItem: () => null, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} }));
    none.accept("pc:pane", message("m", "held"), null);
    expect(none.begin("pc:pane", "m")).toBe(true);
    expect(none.unconfirm("pc:pane", "m")).toBe(true);
  });
  it("keeps a typed Pi receipt through reload as a dismissible, non-resendable local copy", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    const waiting = { ...message("pi:1", "uncertain", "same"), error: { code: "pi_transcript_pending", message: "waiting" } };
    live.accept("pc:pane", waiting, "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.read("pc:pane")[0]).toMatchObject({ id: "pi:1", state: "uncertain", serverOwned: false, error: { code: "transcript_unconfirmed" } });
    // Only an explicitly owner-scoped server snapshot may restore live confirmation authority.
    restored.publish("pc:pane", [waiting], [], "connection-2");
    expect(restored.read("pc:pane")[0]).toMatchObject({ state: "uncertain", serverOwned: true, error: { code: "pi_transcript_pending" } });
    restored.publish("pc:pane", [], [{ id: "pi:1", outcome: "consumed" }], "connection-2");
    expect(restored.read("pc:pane")).toEqual([]);
  });
  it("keeps unsaved text in memory when storage fails", () => {
    const store = new PendingMessageStore(() => ({ getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("full"); } }));
    store.accept("p", message("a"), "scope");
    expect(store.isUnsaved("p")).toBe(true);
    store.refresh("p");
    expect(store.read("p")[0]!.text).toBe("check the tests");
  });
});
