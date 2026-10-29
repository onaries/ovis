import { expect, it, spyOn } from "bun:test";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { type Client, connectionData } from "./connections.ts";
import { createSocket } from "./socket.ts";

function socket(stopped: boolean) {
  const ended: string[] = [];
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => stopped, admit: () => true, setRole() {}, watchPane() {}, unwatchPane() {},
    end: (_client, reason) => { ended.push(reason); }, holdPending() {}, attachments: new Map(),
    clientSnapshot: async () => ({}) as SessionSnapshot, herdrLifetime: () => undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
  });
  const client = { data: connectionData({ deviceId: undefined, readOnly: false }) } as Client;
  return { handler, client, ended };
}

it("tells a new connection its features before its snapshot, which waits on herdr, and even when that read fails", async () => {
  for (const outcome of ["read", "failed"] as const) {
    let settle: (snapshot: SessionSnapshot) => void = () => {};
    let fail: (error: Error) => void = () => {};
    const held = new Promise<SessionSnapshot>((resolve, reject) => { settle = resolve; fail = reject; });
    const handler = createSocket({
      clients: new Set(), present: new Set(), stopped: () => false, admit: () => true, setRole() {}, watchPane() {}, unwatchPane() {},
      end() {}, holdPending() {}, attachments: new Map(),
      clientSnapshot: () => held, herdrLifetime: () => outcome === "read" ? "herdr-a" : undefined, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
    });
    const frames: { type: string; features?: string[]; code?: string; connection?: string; herdr_lifetime?: string }[] = [];
    const client = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (raw: string) => { frames.push(JSON.parse(raw)); return raw.length; } } as unknown as Client;
    const opened = handler.open!(client);
    expect(frames.map((frame) => frame.type)).toEqual(["features"]);
    expect(frames[0]!.features).toEqual(expect.arrayContaining(["submit", "pending-input", "terminal-insert"]));
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
