import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paneAlertsMuted, type AlertPrefs } from "../shared/notify-policy.ts";
import { paneStorageId } from "../shared/machines.ts";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { handlePreferencesRequest, PreferenceStore } from "./preferences.ts";
import { createPushService, handlePushRequest, parseSubscription, type PushService } from "./push.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";
import { privateStateFs } from "./private-state.ts";

/**
 * The server half of web push, end to end against a fake push service that decrypts
 * and verifies like a real device would. No herdr needed: panes are handed in the way
 * the collector hands them (seed) and status changes the way it reports them.
 */

function pane(paneId: string, status: AgentStatus, title: string): HerdrPane {
  return {
    pane_id: paneId,
    agent_status: status,
    terminal_title: title,
    focused: false,
    revision: 0,
    tab_id: "t1",
    terminal_id: "term_1",
    workspace_id: "w1",
  };
}

let stateDir: string;
let fake: FakePushService;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "ovis-push-"));
  fake = await startFakePushService();
});

afterEach(() => {
  fake.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

/** Alerts go out at once, and each status change is awaited until its alert went out. */
function subscribed(options: Partial<Parameters<typeof createPushService>[0]> = {}): PushService {
  const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, ...options });
  push.subscribe(fake.subscription);
  const onStatus = push.onStatus;
  push.onStatus = async (...args) => {
    await onStatus(...args);
    await push.settled();
  };
  return push;
}

describe("parseSubscription", () => {
  it("accepts what a browser's PushSubscription.toJSON() produces", () => {
    const browserJson = { ...fake.subscription, expirationTime: null };
    // the fake's endpoint is loopback http, which only a service made for it accepts
    expect(parseSubscription(browserJson, { loopbackHttp: true })).toEqual(fake.subscription);
  });

  it("rejects endpoints and keys a push service could never have issued", () => {
    const { endpoint, keys } = fake.subscription;
    expect(parseSubscription({ endpoint: "ftp://push.example/x", keys })).toBeNull();
    expect(parseSubscription({ endpoint: "not a url", keys })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, p256dh: keys.p256dh.slice(0, 40) } })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, auth: "AAAA" } })).toBeNull();
    expect(parseSubscription({ endpoint })).toBeNull();
    expect(parseSubscription("subscription")).toBeNull();
    // a plain-http endpoint is never a browser subscription, and it is the shape that
    // would turn the sender into a POST from inside the user's network
    expect(parseSubscription({ endpoint: "http://169.254.169.254/latest/meta-data/", keys })).toBeNull();
    expect(parseSubscription({ endpoint: "http://192.168.0.10:9000/push/1", keys })).toBeNull();
  });

  it("refuses http on loopback too, unless the push service was made for the tests' fake", () => {
    const { keys } = fake.subscription;
    for (const endpoint of ["http://127.0.0.1:9000/push/1", "http://[::1]:9000/push/1", "http://localhost:9000/push/1"]) {
      expect(parseSubscription({ endpoint, keys })).toBeNull();
      expect(parseSubscription({ endpoint, keys }, { loopbackHttp: true })).not.toBeNull();
    }
    expect(parseSubscription({ endpoint: "https://127.0.0.1:9000/push/1", keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: "https://push.example/x", keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: "http://192.168.0.10:9000/push/1", keys }, { loopbackHttp: true })).toBeNull();
  });
});

describe("push state", () => {
  it("keeps one owner-only VAPID key pair across restarts", () => {
    const key = createPushService({ loopbackHttp: true, stateDir }).publicKey();
    expect(Buffer.from(key, "base64url").length).toBe(65);
    expect(createPushService({ loopbackHttp: true, stateDir }).publicKey()).toBe(key);
    expect(statSync(join(stateDir, "vapid.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses a malformed key file instead of rotating the key under every device", () => {
    writeFileSync(join(stateDir, "vapid.json"), "{}\n");
    expect(() => createPushService({ loopbackHttp: true, stateDir }).publicKey()).toThrow("malformed");
    expect(readFileSync(join(stateDir, "vapid.json"), "utf8")).toBe("{}\n");
  });

  it("keeps subscriptions across restarts", async () => {
    subscribed();
    expect(statSync(join(stateDir, "push-subscriptions.json")).mode & 0o777).toBe(0o600);
    const restarted = createPushService({ loopbackHttp: true, stateDir });
    expect(await restarted.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(fake.received).toHaveLength(1);
  });

  it("does not publish an unpersisted VAPID key", () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try {
      expect(() => push.publicKey()).toThrow("EIO");
      // no second call may hand out the key that never reached disk
      expect(() => push.publicKey()).toThrow("EIO");
    } finally { fsync.mockRestore(); }
    expect(readdirSync(stateDir)).toEqual([]);
    const key = push.publicKey();
    expect(createPushService({ loopbackHttp: true, stateDir }).publicKey()).toBe(key);
  });

  it("keeps the subscriptions in use unchanged when their write fails", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const rename = spyOn(privateStateFs, "renameSync").mockImplementation(() => { throw new Error("EXDEV: rename refused"); });
    try {
      expect(() => push.subscribe(fake.subscription, undefined, "0123456789abcdef")).toThrow("EXDEV");
    } finally { rename.mockRestore(); }
    expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
    expect(existsSync(join(stateDir, "push-subscriptions.json"))).toBe(false);
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    push.subscribe(fake.subscription, undefined, "0123456789abcdef");
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try {
      expect(() => push.revokeDevice("0123456789abcdef")).toThrow("EIO");
      expect(() => push.unsubscribe(fake.subscription.endpoint)).toThrow("EIO");
    } finally { fsync.mockRestore(); }
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(await createPushService({ loopbackHttp: true, stateDir }).sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
  });
});

describe("push delivery", () => {
  it("delivers the real finish after a late unknown snapshot arrives during a new Codex turn", async () => {
    const push = subscribed();
    const completions = new CompletionTracker();
    const id = "w1:p1";
    const atRest = { panes: [{ ...pane(id, "unknown", "Codex regression"), agent: "codex" }], agents: [] } as unknown as SessionSnapshot;
    push.seed(atRest.panes);
    let release!: (value: SessionSnapshot) => void;
    const pending = new Promise<SessionSnapshot>((resolve) => { release = resolve; });
    const reading = completions.readSnapshot(() => pending);
    await push.onStatus(id, completions.observe(id, "working", "codex"));
    release(atRest);
    expect((await reading).panes[0]!.agent_status).toBe("working");
    expect(completions.seen(id)).toBe(false);
    expect(fake.received).toHaveLength(0);

    expect(completions.observe(id, "unknown", "codex")).toBe("done");
    await push.onStatus(id, "done");
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]!.payload.body).toBe("work finished");
    expect(fake.received[0]!.vapidValid).toBe(true);
  });

  it("delivers one done alert per Codex finish while an agent handoff keeps working", async () => {
    const push = subscribed();
    const completions = new CompletionTracker();
    const id = "w1:p1";
    push.seed([pane(id, "unknown", "Codex regression")]);
    const report = async (status: AgentStatus, agent: string) => {
      const presented = completions.observe(id, status, agent);
      await push.onStatus(id, presented);
      return presented;
    };

    for (let turn = 0; turn < 2; turn++) {
      expect(await report("working", "codex")).toBe("working");
      expect(await report("unknown", "codex")).toBe("done");
      // Repeated raw unknown events must not repeat the completion alert.
      expect(await report("unknown", "codex")).toBe("done");
      expect(fake.received).toHaveLength(turn + 1);
    }
    expect(fake.received.every((message) => message.payload.body === "work finished" && message.vapidValid)).toBe(true);

    await report("working", "pi");
    expect(await report("unknown", "claude")).toBe("working");
    expect(fake.received).toHaveLength(2);
    expect(await report("idle", "claude")).toBe("done");
    expect(fake.received).toHaveLength(3);
  });

  it("sends a status alert the device can decrypt, signed with the server's key", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");

    expect(fake.received).toHaveLength(1);
    const [received] = fake.received;
    expect(received!.payload).toEqual({
      pane_id: "w1:p1",
      workspace_id: "w1",
      title: "claude: fix the build",
      body: "waiting for your input",
      tag: "herdr-pane-w1:p1",
    });
    expect(received!.urgency).toBe("high");
    expect(received!.ttl).toBe(12 * 60 * 60);
    expect(received!.vapidValid).toBe(true);
    expect(received!.vapidKey).toBe(push.publicKey());
    expect(received!.vapidClaims.aud).toBe(new URL(fake.subscription.endpoint).origin);
    expect(received!.vapidClaims.sub).toBe("https://github.com/devswha/ovis");
  });

  it("keeps equal pane IDs, titles, status baselines and push links separated by PC", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "alpha")], "pc-a", "Work PC");
    push.seed([pane("w1:p1", "working", "beta")], "pc-b", "Home PC");
    await push.onStatus("w1:p1", "blocked", "pc-a");
    await push.onStatus("w1:p1", "done", "pc-b");
    expect(fake.received.map((r) => r.payload.machine_id)).toEqual(["pc-a", "pc-b"]);
    expect(fake.received.map((r) => r.payload.title)).toEqual(["Work PC · alpha", "Home PC · beta"]);
    expect(fake.received[0]!.payload.tag).not.toBe(fake.received[1]!.payload.tag);
    expect(fake.received.every((r) => r.vapidValid)).toBe(true);
  });

  it("measures the first change after a restart against the seeded baseline", async () => {
    const push = subscribed();
    // never seeded: the first report is a first sighting, not news (same rule as the tab)
    await push.onStatus("w1:p9", "blocked");
    expect(fake.received).toHaveLength(0);
    // seeded from the collector's snapshot: the very first event is already a transition
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.pane_id)).toEqual(["w1:p1"]);
    expect(fake.received[0]!.urgency).toBe("normal");
  });

  it("does not let a later snapshot overwrite a status an event already reported", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // a reconcile that raced the event still says working; blocked -> blocked is not news
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(1);
  });

  it("names the pane by its current title, falling back to the seeded one", async () => {
    let fresh: string | Error = "claude: new task";
    const push = subscribed({
      lookupTitle: async () => {
        if (fresh instanceof Error) throw fresh;
        return fresh;
      },
    });
    push.seed([pane("w1:p1", "working", "claude: old task")]);
    await push.onStatus("w1:p1", "blocked");
    fresh = new Error("herdr busy");
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.title)).toEqual(["claude: new task", "claude: old task"]);
  });

  it("tells the device a pane's terminal ended, under its last known title", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "vim notes.md")]);
    await push.onEnded("w1:p1");
    // the pane is gone from herdr by now: the workspace it was seen in is named, for the tap to open
    expect(fake.received[0]!.payload).toEqual({
      pane_id: "w1:p1",
      workspace_id: "w1",
      title: "vim notes.md",
      body: "terminal ended",
      tag: "herdr-pane-w1:p1",
    });
  });

  it("forgets a device its push service reports gone", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
  });

  it.each([404, 410])("answers subscription_gone on the first test when the push service returns %i", async (status) => {
    const push = subscribed();
    fake.answerWith(status);

    const response = await handlePushRequest(new Request("http://localhost/api/push/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: fake.subscription.endpoint }),
    }), "/api/push/test", push, null);

    expect(response?.status).toBe(410);
    expect((await response?.json()).error.code).toBe("subscription_gone");
  });

  // regression (fails on main): the browser can keep handing over the endpoint its push service retired (#1038)
  it("refuses a re-registration of an endpoint its push service retired, so the device subscribes anew", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    const post = (path: string, body: unknown) => handlePushRequest(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), path, push, null);
    const again = (await post("/api/push/subscribe", { subscription: fake.subscription }))!;
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    const tested = (await post("/api/push/test", { endpoint: fake.subscription.endpoint }))!;
    expect(tested.status).toBe(410);
    expect(((await tested.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    // control: an endpoint this server never knew is still just not found
    const unknown = (await post("/api/push/test", { endpoint: "https://push.example/never-known" }))!;
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("subscription_not_found");
  });

  // regression (fails on the merged #1060): a restart between the retirement and "Turn alerts on again" re-registered the dead endpoint
  it("still refuses a retired endpoint after a server restart", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    const path = join(stateDir, "push-retired.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(fake.subscription.endpoint);
    const restarted = createPushService({ loopbackHttp: true, stateDir });
    const post = (path: string, body: unknown) => handlePushRequest(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), path, restarted, null);
    const again = (await post("/api/push/subscribe", { subscription: fake.subscription }))!;
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    // control: an endpoint this server never retired registers after a restart as before
    const other = { ...fake.subscription, endpoint: `${fake.subscription.endpoint}-other` };
    expect((await post("/api/push/subscribe", { subscription: other }))?.status).toBe(204);
  });

  it("forgets a retired endpoint after its time to live and ignores a malformed file", async () => {
    let clock = 1_000_000;
    const push = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    push.subscribe(fake.subscription);
    fake.answerWith(410);
    await push.sendTest(fake.subscription.endpoint);
    expect(push.retired(fake.subscription.endpoint)).toBe(true);
    clock += 31 * 24 * 60 * 60 * 1000;
    expect(createPushService({ loopbackHttp: true, stateDir, now: () => clock }).retired(fake.subscription.endpoint)).toBe(false);
    // control: inside the time to live it is still remembered
    expect(createPushService({ loopbackHttp: true, stateDir, now: () => 1_000_000 + 1000 }).retired(fake.subscription.endpoint)).toBe(true);
    // a malformed file is ignored, never fatal
    writeFileSync(join(stateDir, "push-retired.json"), "not json");
    expect(createPushService({ loopbackHttp: true, stateDir }).retired(fake.subscription.endpoint)).toBe(false);
  });

  it("keeps a device through a failure that is not a goodbye", async () => {
    const push = subscribed();
    fake.answerWith(500);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 500, gone: false });
    const response = await handlePushRequest(new Request("http://localhost/api/push/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: fake.subscription.endpoint }),
    }), "/api/push/test", push, null);
    expect(response?.status).toBe(502);
    expect((await response?.json()).error.code).toBe("push_failed");
    fake.answerWith(201);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
  });
});

describe("alert timing and each device's choice", () => {
  const SHORT = 40;
  const LONG = 80;
  /** real timers, short enough for a test; the clock that measures turns is ours to move */
  function timed(alerts?: AlertPrefs) {
    let clock = 0;
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: SHORT, long: LONG, longTurn: 1_000 }, now: () => clock });
    push.subscribe(fake.subscription, alerts);
    push.seed([pane("w1:p1", "idle", "claude")]);
    return { push, advance: (ms: number) => { clock += ms; } };
  }

  it("calls off a derived Codex finish when it is seen or a new turn begins", async () => {
    const { push } = timed({ input: true, done: "always" });
    const completions = new CompletionTracker();
    const report = (status: AgentStatus) => push.onStatus("w1:p1", completions.observe("w1:p1", status, "codex"));
    await report("working");
    await report("unknown");
    expect(completions.seen("w1:p1")).toBe(true);
    // This is the same onFocus status the server passes to PushService.
    await push.onStatus("w1:p1", "idle");
    await push.settled();
    expect(fake.received).toHaveLength(0);

    await report("working");
    await report("unknown");
    await report("working");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    await report("unknown");
    await push.settled();
    expect(fake.received.map((message) => message.payload.body)).toEqual(["work finished"]);
  });

  /**
   * Holds the alert timers (the delays `timed()` sets) until the test fires them, so whether a
   * status change lands before or after an alert never depends on how loaded the machine is.
   * Every other timer runs for real.
   */
  function holdAlertTimers() {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const held = new Map<object, () => void>();
    const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== SHORT && ms !== LONG) return realSet(callback, ms, ...args);
      const handle = {};
      held.set(handle, () => callback(...args));
      return handle;
    }) as never);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
      if (!held.delete(handle as object)) realClear(handle as Parameters<typeof clearTimeout>[0]);
    }) as never);
    return {
      pending: () => held.size,
      fire() {
        const due = [...held.values()];
        held.clear();
        for (const run of due) run();
      },
      restore() { set.mockRestore(); clear.mockRestore(); },
    };
  }

  it("calls off a question answered before it goes out, and sends one left waiting", async () => {
    const timers = holdAlertTimers();
    try {
      const { push } = timed();
      await push.onStatus("w1:p1", "working");
      await push.onStatus("w1:p1", "blocked");
      expect(timers.pending()).toBe(1);
      await push.onStatus("w1:p1", "working");
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
      await push.onStatus("w1:p1", "blocked");
      timers.fire();
      await push.settled();
      expect(fake.received.map((r) => r.payload.body)).toEqual(["waiting for your input"]);
    } finally { timers.restore(); }
  });

  it("tells a finish only after a turn that worked a while, and not one followed by the next prompt", async () => {
    const timers = holdAlertTimers();
    try {
      const { push, advance } = timed();
      await push.onStatus("w1:p1", "working");
      advance(500);
      await push.onStatus("w1:p1", "done");
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
      await push.onStatus("w1:p1", "working");
      advance(2_000);
      await push.onStatus("w1:p1", "done");
      expect(timers.pending()).toBe(1);
      // the next prompt went in before the alert: the user is there
      await push.onStatus("w1:p1", "working");
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
      advance(2_000);
      await push.onStatus("w1:p1", "done");
      timers.fire();
      await push.settled();
      expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished"]);
    } finally { timers.restore(); }
  });

  it("follows what the device chose: no questions, every finish, or no finish at all", async () => {
    const quiet = timed({ input: false, done: "always" });
    await quiet.push.onStatus("w1:p1", "blocked");
    await quiet.push.onStatus("w1:p1", "done");
    await quiet.push.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished"]);
    fake.received.length = 0;
    const none = timed({ input: true, done: "off" });
    await none.push.onStatus("w1:p1", "working");
    none.advance(5_000);
    await none.push.onStatus("w1:p1", "done");
    await none.push.onEnded("w1:p1");
    await none.push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("keeps a device's choice through a re-registration without one, and a restart", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    push.subscribe(fake.subscription, { input: false, done: "off" });
    push.subscribe(fake.subscription);
    const stored = JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8")) as Array<{ alerts?: AlertPrefs }>;
    expect(stored[0]!.alerts).toEqual({ input: false, done: "off" });
    const restarted = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 } });
    restarted.seed([pane("w1:p1", "working", "claude")]);
    await restarted.onStatus("w1:p1", "blocked");
    await restarted.settled();
    expect(fake.received).toHaveLength(0);
  });
});

it("cancels the remaining delay group after an earlier device already received its finish", async () => {
  const slower = await startFakePushService();
  try {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 10_000, longTurn: 0 } });
    push.subscribe(fake.subscription, { input: true, done: "always" });
    push.subscribe(slower.subscription, { input: true, done: "long" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await fake.waitFor((message) => message.payload.body === "work finished", "early finish", 2000);
    await push.onStatus("w1:p1", "working");
    await push.settled();
    expect(slower.received).toHaveLength(0);
  } finally { slower.stop(); }
});

it("settles only after a delivery already under way, when a later group is called off", async () => {
  let release!: () => void;
  let asked!: () => void;
  const titleAsked = new Promise<void>((resolve) => { asked = resolve; });
  const push = createPushService({
    loopbackHttp: true,
    stateDir, timing: { short: 0, long: 10_000, longTurn: 0 },
    lookupTitle: () => { asked(); return new Promise((resolve) => { release = () => resolve("claude"); }); },
  });
  const slower = await startFakePushService();
  try {
    push.subscribe(fake.subscription, { input: true, done: "always" });
    push.subscribe(slower.subscription, { input: true, done: "long" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await titleAsked;
    await push.onStatus("w1:p1", "working");
    // what had arrived when settled() resolved: the delivery held at its title lookup must be in it
    const settling = push.settled().then(() => fake.received.length);
    release();
    expect(await settling).toBe(1);
    expect(slower.received).toHaveLength(0);
  } finally { slower.stop(); }
});


it("persists device ownership and refuses revoked and legacy subscriptions after restart", async () => {
  const active = new Set(["device-a"]);
  const canDeliver = (id: string | null | undefined) => id === null || typeof id === "string" && active.has(id);
  const push = createPushService({ loopbackHttp: true, stateDir, canDeliver });
  push.subscribe(fake.subscription, undefined, "device-a");
  expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0].device_id).toBe("device-a");
  active.clear();
  const restarted = createPushService({ loopbackHttp: true, stateDir, canDeliver });
  await restarted.onEnded("w1:p1");
  expect(fake.received).toHaveLength(0);
  restarted.revokeDevice("device-a");
  expect(await restarted.sendTest(fake.subscription.endpoint)).toBeNull();
  // Legacy records cannot identify a revoked device; re-registration supplies an owner.
  push.subscribe(fake.subscription);
  const migrated = createPushService({ loopbackHttp: true, stateDir, canDeliver });
  await migrated.onEnded("w1:p1");
  expect(fake.received).toHaveLength(0);
  migrated.subscribe(fake.subscription, undefined, null);
  await migrated.onEnded("w1:p1");
  expect(fake.received).toHaveLength(1);
});

it("keeps a pending alert across re-registration but drops it after device revocation", async () => {
  const active = new Set(["device-a"]);
  const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 20 }, canDeliver: (id) => typeof id === "string" && active.has(id) });
  push.subscribe(fake.subscription, undefined, "device-a");
  push.seed([pane("w1:p1", "working", "claude")]);
  await push.onStatus("w1:p1", "blocked");
  push.subscribe(fake.subscription, undefined, "device-a");
  await push.settled();
  expect(fake.received).toHaveLength(1);
  await push.onStatus("w1:p1", "working");
  await push.onStatus("w1:p1", "blocked");
  active.clear();
  // The registry still blocks delivery if push-file cleanup cannot run.
  await push.settled();
  expect(fake.received).toHaveLength(1);
});

it("keeps a subscription made through the open LAN only while the LAN stays open", async () => {
  let gated = false;
  // the server's rule (index.ts): owners null always, undefined only while ungated
  const push = createPushService({ loopbackHttp: true, stateDir, canDeliver: (id) => id === null || (id === undefined ? !gated : false) });
  const request = new Request("http://192.168.1.20:8787/api/push/subscribe", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: fake.subscription }),
  });
  expect((await handlePushRequest(request, "/api/push/subscribe", push, undefined))?.status).toBe(204);
  expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0]).not.toHaveProperty("device_id");
  await push.onEnded("w1:p1");
  expect(fake.received).toHaveLength(1);
  // pairing a device closes the open LAN: its earlier subscriber hears nothing more
  gated = true;
  await push.onEnded("w1:p2");
  expect(fake.received).toHaveLength(1);
});

it("never follows a redirect: an https endpoint cannot send the alert on to a local service", async () => {
  // a push service never redirects; one that does is an endpoint pointing the POST elsewhere
  const redirector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { location: fake.subscription.endpoint } }) });
  try {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const endpoint = `http://127.0.0.1:${redirector.port}/push/1`;
    push.subscribe({ ...fake.subscription, endpoint });
    const delivery = await push.sendTest(endpoint);
    expect(delivery?.ok).toBe(false);
    expect(fake.received).toHaveLength(0);
  } finally { redirector.stop(true); }
});

describe("a window of the app in use (#751)", () => {
  it("sends no device an alert while some window is in use, and sends again once none is", async () => {
    let inUse = true;
    const push = subscribed({ inUse: () => inUse });
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onEnded("w1:p1");
    expect(fake.received).toHaveLength(0);
    // the confirmation a device asked for is not an alert: it still goes out
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(fake.received.map((r) => r.payload.tag)).toEqual(["herdr-test"]);
    inUse = false;
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received.map((r) => r.payload.body)).toEqual(["Alerts are on for this device", "waiting for your input"]);
  });

  it("asks when the alert would go out, not when the status changed", async () => {
    let inUse = false;
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, inUse: () => inUse });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // the window came forward while the alert waited for its timer
    inUse = true;
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("holds an alert when a window comes into use while its title is looked up", async () => {
    let inUse = false;
    const push = subscribed({ inUse: () => inUse, lookupTitle: async () => { inUse = true; return "claude"; } });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(0);
  });
});

describe("push resync after lost status events", () => {
  it("calls off the waiting alert of a pane that closed while events were lost", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 50, long: 50, longTurn: 0 } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "gone"), pane("w1:p2", "working", "kept"), pane("w1:p3", "working", "new")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onStatus("w1:p3", "blocked");
    // p1 is gone; p3 is missing from the snapshot too, but was heard of since it was asked for
    push.resync([pane("w1:p2", "working", "kept")], new Set(["w1:p3"]));
    await push.settled();
    expect(fake.received.map((r) => r.payload.title)).toEqual(["new"]);
  });

  it("takes a clean pane's snapshot status as its baseline and announces nothing", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude")]);
    // it finished and started over while events were lost
    push.resync([pane("w1:p1", "blocked", "claude")], new Set());
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // measured against the resynced baseline: blocked -> blocked is no change
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(0);
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((r) => r.payload.body)).toHaveLength(1);
  });

  it("calls off an alert still waiting for a pane that is at rest by the snapshot", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 50, long: 50, longTurn: 0 } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    push.resync([pane("w1:p1", "idle", "claude")], new Set());
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("leaves a pane with a newer event, and done versus idle, as they are", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "a"), pane("w1:p2", "working", "b")]);
    await push.onStatus("w1:p2", "done");
    const sent = fake.received.length;
    push.resync([pane("w1:p1", "idle", "a"), pane("w1:p2", "idle", "b")], new Set(["w1:p1"]));
    // p1 was not clean: still working, so its finish is news
    await push.onStatus("w1:p1", "done");
    expect(fake.received.length).toBe(sent + 1);
    // p2 stayed done (at rest either way): a new turn and its finish are still heard
    await push.onStatus("w1:p2", "working");
    await push.onStatus("w1:p2", "done");
    expect(fake.received.length).toBe(sent + 2);
  });
});

describe("the shared pane mute (shared/preferences.ts muted_panes)", () => {
  /** the persisted list as the server composition hands it over: read each time, as the store's document is */
  function mutable(timing = { short: 0, long: 0, longTurn: 0 }) {
    const list: string[] = [];
    const push = createPushService({ loopbackHttp: true, stateDir, timing, muted: (machineId, paneId) => paneAlertsMuted(list, machineId, paneId) });
    push.subscribe(fake.subscription, { input: true, done: "always" });
    return { push, list };
  }

  it("mute cancels delayed push", async () => {
    const { push, list } = mutable({ short: 10_000, long: 10_000, longTurn: 0 });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // the list changed while the alert waited: the server composition tells push, and the alert is called off
    list.push(paneStorageId("local", "w1:p1"));
    push.mutesChanged();
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // an unmute resurrects nothing: the question is still unanswered, and still untold
    list.length = 0;
    push.mutesChanged();
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // only a transition after the unmute is told
    const prompt = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, muted: (machineId, paneId) => paneAlertsMuted(list, machineId, paneId) });
    prompt.seed([pane("w1:p1", "blocked", "claude")]);
    await prompt.onStatus("w1:p1", "working");
    await prompt.onStatus("w1:p1", "blocked");
    await prompt.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["waiting for your input"]);
  });

  it("a persisted mute and unmute while the title is looked up sends nothing", async () => {
    // wired as the server composition wires it (server/core/status.ts): the store's list, and its changes told to push
    const store = new PreferenceStore(stateDir);
    let release!: () => void;
    let asked!: () => void;
    const titleAsked = new Promise<void>((resolve) => { asked = resolve; });
    const push = createPushService({
      loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 },
      muted: (machineId, paneId) => paneAlertsMuted(store.get().muted_panes, machineId, paneId),
      lookupTitle: () => { asked(); return new Promise((resolve) => { release = () => resolve("claude"); }); },
    });
    const stop = store.subscribe(() => push.mutesChanged());
    const put = (keys: string[]) => handlePreferencesRequest(new Request("http://test/api/preferences", { method: "PUT", body: JSON.stringify({ settings: {}, muted_panes: keys }) }), store);
    try {
      push.subscribe(fake.subscription, { input: true, done: "always" });
      push.seed([pane("w1:p1", "working", "claude")]);
      await push.onStatus("w1:p1", "done");
      // its timer fired: the finish waits for its title, past every check made before the lookup
      await titleAsked;
      expect((await put([paneStorageId("local", "w1:p1")])).status).toBe(200);
      expect((await put([])).status).toBe(200);
      expect(store.get().revision).toBe(2);
      release();
      await push.settled();
      // the mute called it off for good: the unmute after it resurrects nothing
      expect(fake.received).toHaveLength(0);
    } finally {
      stop();
      release?.();
    }
  });

  it("holds back the phone app's native push as the browser's", async () => {
    // the app subscribes through its OvisPush plugin and posts the relay endpoint it got (push-relay
    // POST /v1/push/<id>) to the same route, so it is one more subscription on the same list
    const { push, list } = mutable();
    const app = { ...fake.subscription, endpoint: fake.subscription.endpoint.replace(/\/push\/[^/]+$/, `/v1/push/${crypto.randomUUID()}`) };
    push.subscribe(app, { input: true, done: "always" });
    list.push(paneStorageId("local", "w1:p1"));
    push.seed([pane("w1:p1", "working", "mine"), pane("w1:p2", "working", "other")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onEnded("w1:p1");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // the pane next to it still reaches the browser and the app
    await push.onStatus("w1:p2", "blocked");
    await push.settled();
    expect(fake.received.map((r) => r.payload.title)).toEqual(["other", "other"]);
  });

  it("asks the list again right before a waiting alert goes out", async () => {
    const { push, list } = mutable({ short: 20, long: 20, longTurn: 0 });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    // the list changed while the alert waited, and nobody told push: the alert still reads it before it goes out
    list.push(paneStorageId("local", "w1:p1"));
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("all four paths suppress only the keyed pane", async () => {
    const { push, list } = mutable();
    list.push(paneStorageId("local", "w1:p1"));
    push.seed([pane("w1:p1", "working", "mine"), pane("w1:p2", "working", "other")]);
    push.seed([pane("w1:p1", "working", "theirs")], "pc-2", "Laptop");
    // the muted pane: its status is tracked (an unmute tells only what changes after it), its alerts are not told
    await push.onStatus("w1:p1", "blocked");
    await push.onStatus("w1:p1", "done");
    await push.onEnded("w1:p1");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    // the same pane id on another PC, and another pane here, are told as before
    await push.onStatus("w1:p1", "blocked", "pc-2");
    await push.settled();
    await push.onStatus("w1:p2", "blocked");
    await push.settled();
    await push.onEnded("w1:p1", "pc-2");
    await push.settled();
    expect(fake.received.map((r) => [r.payload.title, r.payload.body])).toEqual([
      ["Laptop · theirs", "waiting for your input"], ["other", "waiting for your input"], ["Laptop · theirs", "terminal ended"],
    ]);
    // tracked while muted (it was last seen done): unmuted, done -> done is no change, and the next change is told
    list.length = 0;
    await push.onStatus("w1:p1", "done");
    await push.settled();
    expect(fake.received).toHaveLength(3);
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(fake.received.at(-1)?.payload.title).toBe("mine");
  });
});
