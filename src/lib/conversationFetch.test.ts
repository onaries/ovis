import { afterEach, describe, expect, it, spyOn } from "bun:test";

import { ApiError, fetchPaneConversation, conversationAnswerBytes, peekPaneConversation } from "./api.ts";
import { ConversationRefresh } from "./conversationRefresh.ts";
import type { ConversationResponse } from "../../shared/protocol.ts";

const realFetch = globalThis.fetch;
const globals = globalThis as unknown as { window?: unknown };
const realWindow = globals.window;
let restoreClock: (() => void) | undefined;
afterEach(() => {
  globalThis.fetch = realFetch;
  globals.window = realWindow;
  restoreClock?.();
  restoreClock = undefined;
});

describe("conversation polling", () => {
  it("echoes displayed history, retains it on a retryable read, and forgets it on a rejected history", async () => {
    const requests: { history: string | null; etag: string | null }[] = [];
    let status = 200;
    let history = "history-a";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ history: new URL(url, "http://fixture").searchParams.get("history_id"), etag: new Headers(init?.headers).get("if-none-match") });
      if (status === 304) return new Response(null, { status });
      if (status !== 200) return Response.json({ error: { code: status === 409 ? "history_changed" : "conversation_read_pending", message: "retry" } }, { status });
      return Response.json({ source: "copilot-transcript", history_id: history, cursor: null, turns: [] }, { headers: { etag: `"${history}"` } });
    }) as typeof fetch;
    const first = await fetchPaneConversation("retained-history");
    const displayed = { history_id: first.history_id };
    status = 503;
    await expect(fetchPaneConversation("retained-history", "local", displayed)).rejects.toBeInstanceOf(ApiError);
    expect(peekPaneConversation("retained-history")).toBe(first);
    status = 304;
    expect(await fetchPaneConversation("retained-history", "local", displayed)).toBe(first);
    status = 409;
    await expect(fetchPaneConversation("retained-history", "local", { ...displayed, from: "held-a" })).rejects.toBeInstanceOf(ApiError);
    expect(peekPaneConversation("retained-history")).toBeUndefined();
    status = 200; history = "history-b";
    expect((await fetchPaneConversation("retained-history")).history_id).toBe(history);
    expect(requests).toEqual([
      { history: null, etag: null },
      ...Array.from({ length: 2 }, () => ({ history: "history-a", etag: '"history-a"' })),
      { history: "history-a", etag: null },
      { history: null, etag: null },
    ]);
  });

  it("revalidates a new finish without borrowing the previous finish's ETag", async () => {
    const sent: (string | null)[] = [];
    const body: ConversationResponse = { source: "claude-transcript", turns: [] };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("if-none-match"));
      return Response.json(body, { headers: { etag: '"same-answer"' } });
    }) as typeof fetch;
    const first = await fetchPaneConversation("finish-proof-revalidate");
    const next = await fetchPaneConversation("finish-proof-revalidate", "local", { fresh: true });
    expect(sent).toEqual([null, null]);
    expect(next).not.toBe(first);
    expect(next).toEqual(first);
  });

  it("asks with the last ETag and reuses the very same answer on a 304", async () => {
    const sent: (string | null)[] = [];
    let version = "\"v1\"";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const asked = new Headers(init?.headers).get("if-none-match");
      sent.push(asked);
      if (asked === version) return new Response(null, { status: 304, headers: { etag: version } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null, v: version }), { status: 200, headers: { etag: version } });
    }) as typeof fetch;
    const first = await fetchPaneConversation("w1:p1");
    const again = await fetchPaneConversation("w1:p1");
    expect(again).toBe(first);
    version = "\"v2\"";
    const changed = await fetchPaneConversation("w1:p1");
    expect(changed).not.toBe(first);
    expect((changed as unknown as { v: string }).v).toBe("\"v2\"");
    // an older page is asked for once: it never sends or keeps an ETag
    await fetchPaneConversation("w1:p1", "local", { before: "c:10" });
    await fetchPaneConversation("w1:p1", "local", { before: "c:10" });
    expect(sent).toEqual([null, "\"v1\"", "\"v1\"", null, null]);
  });

  it("keeps the polled answer however many older pages are read", async () => {
    const sent: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const asked = new Headers(init?.headers).get("if-none-match");
      sent.push(asked);
      if (asked === "\"v\"") return new Response(null, { status: 304, headers: { etag: "\"v\"" } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { status: 200, headers: { etag: "\"v\"" } });
    }) as typeof fetch;
    const polled = await fetchPaneConversation("w9:p1");
    for (let page = 0; page < 40; page++) await fetchPaneConversation("w9:p1", "local", { before: `c:${page}` });
    // other panes polled in between: the one polled again stays the most recent
    for (let pane = 0; pane < 20; pane++) {
      await fetchPaneConversation(`w8:p${pane}`);
      expect(await fetchPaneConversation("w9:p1")).toBe(polled);
    }
    expect(sent.at(-1)).toBe("\"v\"");
  });

  it("gives up the oldest answers when they outgrow the byte budget, not only when there are too many", async () => {
    const asked = new Map<string, string | null>();
    // ~3 MiB of turns per pane: a third of the cache budget, so four of them do not fit
    const filler = "x".repeat(3 * 1024 * 1024);
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const etag = new Headers(init?.headers).get("if-none-match");
      asked.set(String(url), etag);
      if (etag !== null) return new Response(null, { status: 304, headers: { etag } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [{ text: filler }], cursor: null, filler }), { status: 200, headers: { etag: `"${asked.size}"` } });
    }) as typeof fetch;
    for (let pane = 0; pane < 5; pane++) await fetchPaneConversation(`big:p${pane}`);
    asked.clear();
    // the newest panes are still cached, the ones the budget pushed out are not
    await fetchPaneConversation("big:p4");
    expect([...asked.values()]).toEqual([`"5"`]);
    asked.clear();
    await fetchPaneConversation("big:p0");
    expect([...asked.values()]).toEqual([null]);
  });
});

describe("conversation peek", () => {
  it("reuses a bounded newest page only for the matching page limit", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return new Response(JSON.stringify({ source: "omo-transcript", turns: [], cursor: null }), { status: 200, headers: { etag: "\"bounded\"" } });
    }) as typeof fetch;
    const answer = await fetchPaneConversation("peek:bounded", "local", { limit: 12 });
    expect(peekPaneConversation("peek:bounded", "local", { limit: 12 })).toBe(answer);
    expect(peekPaneConversation("peek:bounded")).toBeUndefined();
    expect(peekPaneConversation("peek:bounded", "local", { limit: 20 })).toBeUndefined();
    expect(asked).toEqual(["/api/pane/conversation?pane_id=peek%3Abounded&limit=12"]);
  });

  it("hands back the newest page last answered, without asking the server", async () => {
    let asked = 0;
    globalThis.fetch = (async (_url: string) => {
      asked += 1;
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { status: 200, headers: { etag: "\"p\"" } });
    }) as typeof fetch;
    const answer = await fetchPaneConversation("peek:p1");
    expect(peekPaneConversation("peek:p1")).toBe(answer);
    expect(peekPaneConversation("peek:p1", "local")).toBe(answer);
    expect(asked).toBe(1);
  });

  it("has nothing for a pane never read, or read on another PC", async () => {
    globalThis.fetch = (async (_url: string) => new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { status: 200, headers: { etag: "\"q\"" } })) as typeof fetch;
    expect(peekPaneConversation("peek:never")).toBeUndefined();
    await fetchPaneConversation("peek:p2", "pc-a");
    expect(peekPaneConversation("peek:p2", "pc-a")).toBeDefined();
    expect(peekPaneConversation("peek:p2")).toBeUndefined();
  });

  it("never hands back an older page", async () => {
    globalThis.fetch = (async (_url: string) => new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: "c:1" }), { status: 200, headers: { etag: "\"r\"" } })) as typeof fetch;
    await fetchPaneConversation("peek:p3", "local", { before: "c:5" });
    expect(peekPaneConversation("peek:p3")).toBeUndefined();
  });
});

it("reports a newest read in flight, so a fresh attach's connected edge can leave it to that read", async () => {
  refreshClock();
  const refresh = new ConversationRefresh();
  const { promise, resolve } = Promise.withResolvers<void>();
  let reads = 0;
  refresh.setRead(async () => { reads += 1; await promise; });
  expect(refresh.reading).toBe(false);
  refresh.refresh();
  expect(refresh.reading).toBe(true);
  resolve();
  await settleRefresh();
  expect(refresh.reading).toBe(false);
  expect(reads).toBe(1);
  refresh.stop();
});

it("counts a compressed answer by its parsed body, not the bytes on the wire", () => {
  const body = { turns: [{ text: "x".repeat(5000) }] } as unknown as Parameters<typeof conversationAnswerBytes>[0];
  expect(conversationAnswerBytes(body, "300")).toBe(300);
  expect(conversationAnswerBytes(body, "300", "identity")).toBe(300);
  expect(conversationAnswerBytes(body, "300", "gzip")).toBe(JSON.stringify(body).length);
});

/** The browser timer the refresher uses, advanced without sleeping or a DOM. */
function refreshClock(): { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  restoreClock = () => { clock.mockRestore(); };
  globals.window = {
    setTimeout(callback: () => void, delay: number): number {
      const id = next++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number | undefined): void { if (id !== undefined) timers.delete(id); },
  };
  return {
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    },
    pending(): number { return timers.size; },
  };
}

async function settleRefresh(): Promise<void> {
  for (let step = 0; step < 20; step++) await Promise.resolve();
}

/** A chat on a bridge that pushes its pane's transcript changes. */
function pushedRefresh(): ConversationRefresh {
  const refresh = new ConversationRefresh();
  refresh.setPushes(true);
  return refresh;
}

describe("conversation invalidation refresh", () => {
  it("coalesces pushes at exactly 1000ms and keeps the 10s backstop, ETag and 304 identity", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const requests: { resolve: (response: Response) => void }[] = [];
    const etags: (string | null)[] = [];
    const answers: unknown[] = [];
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      etags.push(new Headers(init?.headers).get("if-none-match"));
      const { promise, resolve } = Promise.withResolvers<Response>();
      requests.push({ resolve });
      return promise;
    }) as typeof fetch;
    refresh.setRead(async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      try { answers.push(await fetchPaneConversation("refresh-burst:p1")); }
      finally { active -= 1; }
    });
    refresh.refresh();
    clock.advance(100);
    for (let push = 0; push < 8; push++) refresh.invalidate();
    requests[0]!.resolve(new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { headers: { etag: "\"push-v1\"" } }));
    await settleRefresh();
    expect(requests).toHaveLength(1);
    clock.advance(899);
    refresh.invalidate();
    expect(requests).toHaveLength(1);
    clock.advance(1);
    expect(requests).toHaveLength(2);
    expect(etags).toEqual([null, "\"push-v1\""]);
    requests[1]!.resolve(new Response(null, { status: 304, headers: { etag: "\"push-v1\"" } }));
    await settleRefresh();
    expect(answers[1]).toBe(answers[0]);
    expect(maxActive).toBe(1);
    clock.advance(9999);
    expect(requests).toHaveLength(2);
    clock.advance(1);
    expect(requests).toHaveLength(3);
    refresh.stop();
    requests[2]!.resolve(new Response(null, { status: 304, headers: { etag: "\"push-v1\"" } }));
    await settleRefresh();
    expect(clock.pending()).toBe(0);
  });

  it("bounds sustained pushes without extending the deadline and eventually shows the latest REST output", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const starts: number[] = [];
    const answers: ConversationResponse[] = [];
    let output = "initial";
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = (async (_url: string) => new Response(JSON.stringify({
      source: "claude-transcript",
      turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: output }] }],
      cursor: null,
    }), { headers: { etag: `"${output}"` } })) as typeof fetch;
    refresh.setRead(async () => {
      starts.push(performance.now());
      active += 1; maxActive = Math.max(maxActive, active);
      try { answers.push(await fetchPaneConversation("refresh-sustained:p1")); }
      finally { active -= 1; }
    });
    refresh.refresh();
    await settleRefresh();
    for (let push = 1; push <= 53; push++) {
      clock.advance(100);
      output = `output-${push}`;
      refresh.invalidate();
      await settleRefresh();
    }
    expect(starts).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    clock.advance(699);
    expect(starts).toHaveLength(6);
    clock.advance(1);
    await settleRefresh();
    expect(starts).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000]);
    expect(answers.at(-1)?.turns[0]?.parts[0]).toEqual({ kind: "text", text: "output-53" });
    expect(maxActive).toBe(1);
    // A push after idle is not delayed until the periodic backstop.
    clock.advance(2500);
    output = "after-idle";
    refresh.invalidate();
    await settleRefresh();
    expect(starts).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 8500]);
    expect(answers.at(-1)?.turns[0]?.parts[0]).toEqual({ kind: "text", text: "after-idle" });
    refresh.stop();
  });

  it("lets an explicit refresh bypass and replace a delayed push", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const starts: number[] = [];
    refresh.setRead(async () => { starts.push(performance.now()); });
    refresh.refresh();
    await settleRefresh();
    clock.advance(100);
    refresh.invalidate();
    clock.advance(400);
    refresh.refresh();
    await settleRefresh();
    expect(starts).toEqual([0, 500]);
    clock.advance(500);
    expect(starts).toEqual([0, 500]);
    // The explicit read also establishes the next push deadline.
    refresh.invalidate();
    clock.advance(499);
    expect(starts).toEqual([0, 500]);
    clock.advance(1);
    await settleRefresh();
    expect(starts).toEqual([0, 500, 1500]);
    refresh.stop();
  });

  it("runs an immediate refresh after the in-flight read, without waiting for a push deadline", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const first = Promise.withResolvers<void>();
    const starts: number[] = [];
    refresh.setRead(async () => {
      starts.push(performance.now());
      if (starts.length === 1) await first.promise;
    });
    refresh.refresh();
    clock.advance(100);
    refresh.invalidate();
    clock.advance(100);
    refresh.refresh();
    expect(starts).toEqual([0]);
    first.resolve();
    await settleRefresh();
    expect(starts).toEqual([0, 200]);
    clock.advance(1800);
    expect(starts).toEqual([0, 200]);
    refresh.stop();
  });

  it("keeps long in-flight reads serial and trails at the later of completion and the fixed deadline", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const starts: number[] = [];
    const releases: (() => void)[] = [];
    let output = "initial";
    let shown = "";
    let active = 0;
    let maxActive = 0;
    refresh.setRead(async () => {
      const captured = output;
      const { promise, resolve } = Promise.withResolvers<void>();
      releases.push(resolve);
      starts.push(performance.now());
      active += 1; maxActive = Math.max(maxActive, active);
      try { await promise; shown = captured; }
      finally { active -= 1; }
    });
    refresh.invalidate();
    clock.advance(100);
    output = "during-first";
    refresh.invalidate();
    clock.advance(2400);
    output = "latest-first";
    refresh.invalidate();
    expect(starts).toEqual([0]);
    releases[0]!();
    await settleRefresh();
    expect(starts).toEqual([0, 2500]);
    expect(shown).toBe("initial");
    clock.advance(100);
    output = "during-second";
    refresh.invalidate();
    clock.advance(700);
    output = "latest-second";
    refresh.invalidate();
    releases[1]!();
    await settleRefresh();
    expect(shown).toBe("latest-first");
    expect(starts).toEqual([0, 2500]);
    clock.advance(199);
    expect(starts).toEqual([0, 2500]);
    clock.advance(1);
    expect(starts).toEqual([0, 2500, 3500]);
    releases[2]!();
    await settleRefresh();
    expect(shown).toBe("latest-second");
    expect(maxActive).toBe(1);
    refresh.stop();
  });

  it("starts an older page after the newest read and its gap fill, and never holds the next newest read behind it", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const first = Promise.withResolvers<void>();
    const gap = Promise.withResolvers<void>();
    const page = Promise.withResolvers<void>();
    const reads: string[] = [];
    let active = 0;
    let maxActive = 0;
    let newest = 0;
    refresh.setRead(async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      reads.push("latest");
      newest += 1;
      try {
        if (newest === 1) {
          await first.promise;
          reads.push("gap");
          await gap.promise;
        }
      } finally { active -= 1; }
    });
    refresh.refresh();
    const older = refresh.page(async () => {
      reads.push("older");
      await page.promise;
      return "page";
    });
    clock.advance(100);
    for (let push = 0; push < 4; push++) refresh.invalidate();
    first.resolve();
    await settleRefresh();
    expect(reads).toEqual(["latest", "gap"]);
    gap.resolve();
    await settleRefresh();
    expect(reads).toEqual(["latest", "gap", "older"]);
    // the older page is still loading: the pushed newest read keeps its own 1 s deadline
    clock.advance(900);
    await settleRefresh();
    expect(reads).toEqual(["latest", "gap", "older", "latest"]);
    // and an explicit refresh (a clear, a send) does not wait for it either
    refresh.refresh();
    await settleRefresh();
    expect(reads).toEqual(["latest", "gap", "older", "latest", "latest"]);
    page.resolve();
    expect(await older).toBe("page");
    expect(maxActive).toBe(1);
    refresh.stop();
  });

  it("resumes visibility with the current reader only after the cancelled request finishes", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const old = Promise.withResolvers<void>();
    const current = Promise.withResolvers<void>();
    const reads: string[] = [];
    refresh.setRead(async () => { reads.push("old"); await old.promise; });
    refresh.refresh();
    refresh.invalidate();
    refresh.stop();
    refresh.setRead(async () => { reads.push("current"); await current.promise; });
    refresh.refresh();
    refresh.refresh();
    expect(reads).toEqual(["old"]);
    old.resolve();
    await settleRefresh();
    expect(reads).toEqual(["old", "current"]);
    current.resolve();
    await settleRefresh();
    clock.advance(2000);
    expect(reads).toEqual(["old", "current"]);
    refresh.stop();
    clock.advance(30_000);
    expect(reads).toEqual(["old", "current"]);
    expect(clock.pending()).toBe(0);
  });

  it("drops an old reader's in-flight trailing work on replacement without starting the new reader", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const old = Promise.withResolvers<void>();
    const reads: string[] = [];
    refresh.setRead(async () => { reads.push("old"); await old.promise; });
    refresh.refresh();
    refresh.invalidate();
    refresh.setRead(async () => { reads.push("current"); });
    old.resolve();
    await settleRefresh();
    clock.advance(1999);
    expect(reads).toEqual(["old"]);
    refresh.refresh();
    await settleRefresh();
    expect(reads).toEqual(["old", "current"]);
    refresh.stop();
  });

  it("drops delayed push work on reader replacement even without stop", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const reads: string[] = [];
    refresh.setRead(async () => { reads.push("old"); });
    refresh.refresh();
    await settleRefresh();
    clock.advance(100);
    refresh.invalidate();
    refresh.setRead(async () => { reads.push("current"); });
    clock.advance(30_000);
    await settleRefresh();
    expect(reads).toEqual(["old"]);
    expect(clock.pending()).toBe(0);
    refresh.invalidate();
    await settleRefresh();
    expect(reads).toEqual(["old", "current"]);
    refresh.stop();
  });

  it("cancels the delayed trailing read and its timer when the chat becomes hidden", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    let reads = 0;
    refresh.setRead(async () => { reads += 1; });
    refresh.refresh();
    await settleRefresh();
    clock.advance(100);
    refresh.invalidate();
    refresh.stop();
    expect(clock.pending()).toBe(0);
    clock.advance(30_000);
    await settleRefresh();
    expect(reads).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("drops pending pushes and timers while hidden, even when a read is still in flight", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const result = Promise.withResolvers<void>();
    let reads = 0;
    refresh.setRead(async () => { reads += 1; await result.promise; });
    refresh.refresh();
    refresh.invalidate();
    refresh.stop();
    refresh.invalidate();
    refresh.refresh();
    expect(clock.pending()).toBe(0);
    result.resolve();
    await settleRefresh();
    clock.advance(30_000);
    expect(reads).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("reads every 2s without pushes and moves a waiting backstop when pushes come and go", async () => {
    const clock = refreshClock();
    const refresh = new ConversationRefresh();
    let reads = 0;
    refresh.setRead(async () => { reads += 1; });
    refresh.refresh();
    await settleRefresh();
    clock.advance(1999);
    expect(reads).toBe(1);
    clock.advance(1);
    await settleRefresh();
    expect(reads).toBe(2);
    // the bridge starts pushing: the waiting poll becomes the 10s backstop from now
    clock.advance(1000);
    refresh.setPushes(true);
    clock.advance(9999);
    expect(reads).toBe(2);
    clock.advance(1);
    await settleRefresh();
    expect(reads).toBe(3);
    // the tab lets go of its pane: no pushes, so the 2s poll is back without waiting out 10s
    refresh.setPushes(false);
    clock.advance(2000);
    await settleRefresh();
    expect(reads).toBe(4);
    refresh.stop();
    expect(clock.pending()).toBe(0);
  });
});

it.each([200, 409])("a timed-out read cannot replace or clear the last conversation ETag after a late %s response", async (status) => {
  const originalTimer = globalThis.setTimeout;
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => originalTimer(callback, delay === 15_000 ? 10 : delay)) as typeof setTimeout);
  try {
    const pane = "deadline-cache:p1";
    globalThis.fetch = (async (_url: string) => Response.json({ source: "codex-transcript", turns: [], cursor: null }, { headers: { etag: '"current"' } })) as typeof fetch;
    const current = await fetchPaneConversation(pane);
    let resolve!: (body: ConversationResponse) => void;
    const late = new Promise<ConversationResponse>((done) => { resolve = done; });
    const lateResponse = Response.json({}, { status, headers: { etag: '"obsolete"' } });
    lateResponse.json = () => late;
    globalThis.fetch = (async (_url: string) => lateResponse) as typeof fetch;
    await expect(fetchPaneConversation(pane)).rejects.toThrow("timed out");
    resolve({ source: "codex-transcript", turns: [], cursor: null });
    await Promise.resolve();
    const asked: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      asked.push(new Headers(init?.headers).get("if-none-match"));
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    expect(await fetchPaneConversation(pane)).toBe(current);
    expect(asked).toEqual(['"current"']);
  } finally { clock.mockRestore(); }
});
