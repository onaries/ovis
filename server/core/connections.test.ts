import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import { DeviceStore } from "../devices.ts";
import type { MachineRelay } from "../machine-relay.ts";
import type { PendingInputs } from "../pending-input.ts";
import { type Client, connectionData, connectionOf, createConnections, send } from "./connections.ts";

function harness({ deviceId, readOnly = false, relay, revokedAlready = false, store }: { deviceId?: string; readOnly?: boolean; relay?: MachineRelay; revokedAlready?: boolean; store?: DeviceStore } = {}) {
  const log: string[] = [];
  const revocations: (() => void)[] = [];
  const devices = store ?? {
    onRevoke: (_id: string, close: () => void) => {
      if (revokedAlready) close(); else revocations.push(close);
      return () => log.push("unwatch device");
    },
  } as unknown as DeviceStore;
  const pending = { close: () => log.push("pending closed") } as unknown as PendingInputs<Client, never>;
  const client = {
    data: connectionData({ deviceId, readOnly, ...(relay ? { relay } : {}) }),
    close: (code: number, reason: string) => log.push(`closed ${code} ${reason}`),
    getBufferedAmount: () => 0,
    send: () => 1,
  } as unknown as Client;
  const clients = new Set<Client>([client]);
  const present = new Set<Client>([client]);
  const connections = createConnections({
    clients, present, pending, devices,
    detachClaimed: () => log.push("detach claimed"),
    dropClaims: () => log.push("drop claims"),
  });
  return { client, clients, present, log, revoke: () => revocations.forEach((close) => close()), ...connections };
}

it("a stall ends the connection once and leaves its presence to the socket's close", () => {
  const { client, clients, present, log, end } = harness();
  end(client, "stalled");
  end(client, "stalled");
  expect(log).toEqual(["pending closed", "detach claimed", "drop claims", `closed ${OUTPUT_STALLED_CLOSE_CODE} terminal output consumer stalled`]);
  expect(clients.has(client)).toBe(false);
  expect(present.has(client)).toBe(true);
  expect(send(client, { type: "session-changed" })).toBe(0);
  end(client, "closed");
  expect(present.has(client)).toBe(false);
});

it("a revoke ends the connection with 1008 and leaves its pending input to the socket's close", () => {
  const { client, clients, present, log, admit, revoke, end, mayType, authorizeSocket } = harness({ deviceId: "phone" });
  expect(admit(client)).toBe(true);
  expect(mayType(client)).toBe(true);
  revoke();
  expect(log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
  expect(clients.has(client) || present.has(client)).toBe(false);
  expect(mayType(client)).toBe(false);
  expect(() => authorizeSocket(client)).toThrow("this device's access was revoked");
  end(client, "closed");
  expect(log.slice(3)).toEqual(["unwatch device", "pending closed", "detach claimed", "drop claims"]);
});

it("does not admit a device that was revoked before its socket opened", () => {
  const { client, log, admit } = harness({ deviceId: "phone", revokedAlready: true });
  expect(admit(client)).toBe(false);
  expect(log.at(-1)).toBe("closed 1008 Device access revoked");
});

it("revoking every device ends local and relayed device connections alike, and admits none after", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-connections-revoke-all-"));
  try {
    const store = new DeviceStore(root);
    const phone = store.pair(store.startPairing().code, "Phone", "drive")!;
    store.match(phone.token);
    const tablet = store.pair(store.startPairing().code, "Tablet", "drive")!;
    store.match(tablet.token);
    const relayed: string[] = [];
    const relay = { close: () => relayed.push("relay closed") } as unknown as MachineRelay;
    const local = harness({ deviceId: phone.device.id, store });
    const remote = harness({ deviceId: tablet.device.id, relay, store });
    expect(local.admit(local.client)).toBe(true);
    expect(remote.admit(remote.client)).toBe(true);
    expect(store.revokeAll().sort()).toEqual([phone.device.id, tablet.device.id].sort());
    expect(local.log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
    expect(remote.log).toEqual(["detach claimed", "drop claims", "closed 1008 Device access revoked"]);
    // the relayed connection's relay is closed with the revocation itself, before its socket's own close
    expect(relayed).toEqual(["relay closed"]);
    expect(local.mayType(local.client)).toBe(false);
    expect(() => remote.authorizeSocket(remote.client)).toThrow("this device's access was revoked");
    remote.end(remote.client, "closed");
    expect(relayed).toEqual(["relay closed", "relay closed"]);
    // a socket that opens with a revoked device's cookie after the fact is closed at once
    const late = harness({ deviceId: phone.device.id, store });
    expect(late.admit(late.client)).toBe(false);
    expect(late.log.at(-1)).toBe("closed 1008 Device access revoked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("closes only the relay of a relayed connection", () => {
  const relayed: string[] = [];
  const relay = { close: () => relayed.push("relay closed") } as unknown as MachineRelay;
  const { client, present, log, end } = harness({ relay });
  end(client, "closed");
  expect(relayed).toEqual(["relay closed"]);
  expect(log).toEqual([]);
  expect(present.has(client)).toBe(false);
});

it("counts each change of role, and a read-only connection only watches", () => {
  const { client, setRole, mayType } = harness();
  setRole(client, "interact");
  expect(connectionOf(client).roles).toBe(0);
  setRole(client, "observe");
  setRole(client, "interact");
  expect(connectionOf(client)).toMatchObject({ mode: "interact", roles: 2 });
  expect(mayType(client)).toBe(true);
  const watcher = harness({ readOnly: true });
  expect(connectionOf(watcher.client).mode).toBe("observe");
  expect(() => watcher.authorizeSocket(watcher.client)).toThrow("this connection can only watch");
});
