import { expect, it, spyOn } from "bun:test";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { type Client, connectionData } from "./connections.ts";
import { createSocket } from "./socket.ts";

function socket(stopped: boolean) {
  const ended: string[] = [];
  const handler = createSocket({
    clients: new Set(), present: new Set(), stopped: () => stopped, admit: () => true, setRole() {}, watchPane() {}, unwatchPane() {},
    end: (_client, reason) => { ended.push(reason); }, holdPending() {}, attachments: new Map(),
    clientSnapshot: async () => ({}) as SessionSnapshot, browserSnapshot: (snapshot) => snapshot, countVisit() {}, drainOutput() {}, frames: {} as never,
  });
  const client = { data: connectionData({ deviceId: undefined, readOnly: false }) } as Client;
  return { handler, client, ended };
}

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
