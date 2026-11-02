import { expect, it, spyOn } from "bun:test";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { OUTPUT_HARD_BYTES } from "../output-window.ts";
import { type Client, connectionData } from "./connections.ts";
import { createSocket } from "./socket.ts";

function socket(stopped: boolean) {
  const ended: string[] = [];
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => stopped, admit: () => true, setRole() {}, watchable: () => true, watchPane() {}, unwatchPane() {},
    end: (_client, reason) => { ended.push(reason); }, holdPending() {}, attachments: new Map(),
    clientSnapshot: async () => ({}) as SessionSnapshot, herdrLifetime: () => undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
  });
  const client: Client = { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: () => 1, close: () => {} };
  return { handler, client, ended };
}

it("tells a new connection its features before its snapshot, which waits on herdr, and even when that read fails", async () => {
  for (const outcome of ["read", "failed"] as const) {
    let settle: (snapshot: SessionSnapshot) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const held = new Promise<SessionSnapshot>((resolve, reject) => { settle = resolve; fail = reject; });
    const handler = createSocket({
      clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchable: () => true, watchPane() {}, unwatchPane() {},
      end() {}, holdPending() {}, attachments: new Map(),
      clientSnapshot: () => held, herdrLifetime: () => outcome === "read" ? "herdr-a" : undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
    });
    const frames: { type: string; features?: string[]; code?: string; connection?: string; herdr_lifetime?: string }[] = [];
    const client: Client = { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: (raw: string) => { frames.push(JSON.parse(raw)); return raw.length; }, close: () => {} };
    const opened = handler.open!(client);
    expect(frames.map((frame) => frame.type)).toEqual(["features"]);
    expect(frames[0]!.features).toEqual(expect.arrayContaining(["submit", "pending-input", "terminal-insert", "watch"]));
    expect(frames[0]!.connection).toBe(client.data.connectionId);
    // the herdr it reads now, read without a herdr call; none when it proves none
    expect(frames[0]!.herdr_lifetime).toBe(outcome === "read" ? "herdr-a" : undefined);
    if (outcome === "read") settle({ workspaces: [], panes: [], agents: [], layouts: [] } as unknown as SessionSnapshot);
    else fail(new Error("herdr session.snapshot timed out after 10000ms"));
    await opened;
    expect(frames.map((frame) => frame.type)).toEqual(outcome === "read" ? ["features", "snapshot"] : ["features", "error"]);
    if (outcome === "read") expect(frames[1]!.features).toEqual(frames[0]!.features);
  }
});

it("offers no watch where none can be drawn (herdr-core), and ends a watch sent anyway without starting one", async () => {
  const watched: string[] = [];
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchable: () => false,
    watchPane: (_client, paneId) => { watched.push(paneId); }, unwatchPane() {},
    end() {}, holdPending() {}, attachments: new Map(),
    clientSnapshot: async () => ({ workspaces: [], panes: [], agents: [], layouts: [] }) as unknown as SessionSnapshot, herdrLifetime: () => undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
  });
  const frames: { type: string; features?: string[]; pane_id?: string; code?: string }[] = [];
  const client: Client = { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: (raw: string) => { frames.push(JSON.parse(raw)); return raw.length; }, close: () => {} };
  await handler.open!(client);
  expect(frames.map((frame) => frame.type)).toEqual(["features", "snapshot"]);
  for (const frame of frames) {
    expect(frame.features).not.toContain("watch");
    // everything else stays offered
    expect(frame.features).toEqual(expect.arrayContaining(["submit", "pending-input", "conversation-watch", "terminal-insert"]));
  }
  frames.length = 0;
  await handler.message!(client, JSON.stringify({ type: "watch", pane_id: "t1", cols: 80, rows: 24 }));
  expect(frames).toEqual([{ type: "watch-end", pane_id: "t1" }]);
  expect(watched).toEqual([]);
  // a grid out of range is still refused as such
  frames.length = 0;
  await handler.message!(client, JSON.stringify({ type: "watch", pane_id: "t1", cols: 0, rows: 24 }));
  expect(frames.map((frame) => frame.code)).toEqual(["invalid_geometry"]);
});

it("delivers a session snapshot larger than the transport budget to a socket with nothing queued (#2566)", async () => {
  // a large session: its snapshot alone serializes past the 1 MiB the transport may hold queued
  const snapshot = { workspaces: [], panes: Array.from({ length: 600 }, (_, i) => ({ pane_id: `p${i}`, cwd: `/w/${"x".repeat(2000)}` })), agents: [], layouts: [] } as unknown as SessionSnapshot;
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(OUTPUT_HARD_BYTES);
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchable: () => true, watchPane() {}, unwatchPane() {},
    end() {}, holdPending() {}, attachments: new Map(),
    clientSnapshot: async () => snapshot, herdrLifetime: () => undefined, browserSnapshot: (read) => read, countVisit() {}, drainOutput() {}, frames: {} as never,
  });
  // a real Bun socket with the production limits, so Bun's own backpressure cap is in play as well
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (request, bun) => bun.upgrade(request, { data: connectionData({ deviceId: undefined, readOnly: false }) }) ? undefined : new Response(null, { status: 400 }),
    websocket: handler,
  });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  try {
    const types: string[] = [];
    const outcome = Promise.withResolvers<string>();
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; snapshot?: SessionSnapshot };
      types.push(frame.type);
      if (frame.type === "snapshot") outcome.resolve(`snapshot with ${frame.snapshot!.panes.length} panes`);
    };
    ws.onclose = (event) => outcome.resolve(`closed ${event.code} ${event.reason}`);
    const timer = setTimeout(() => outcome.resolve("timed out"), 5_000);
    try {
      expect(await outcome.promise).toBe("snapshot with 600 panes");
    } finally {
      clearTimeout(timer);
    }
    expect(types).toEqual(["features", "snapshot"]);
  } finally {
    ws.close();
    await server.stop(true);
  }
});

it("records an abnormal close while running and stays quiet once the server is stopping", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const running = socket(false);
    running.handler.close!(running.client, 4001, "");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ event: "websocket.failed", close_code: 4001 });
    const stopping = socket(true);
    stopping.handler.close!(stopping.client, 1006, "");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(stopping.ended).toEqual(["closed"]);
  } finally {
    warn.mockRestore();
  }
});
