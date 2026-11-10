import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { createPcSweep } from "./pcSweep.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import type { PcStatus } from "./pcStatus.ts";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";

type Found = Exclude<PcStatus, { kind: "checking" }>;

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  } });
});
afterEach(() => {
  jest.useRealTimers();
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

async function savedPcs(count: number): Promise<{ devices: RelayDevice[]; store: RelayDeviceStore }> {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const devices: RelayDevice[] = Array.from({ length: count }, (_, index) => {
    const pair = generateKeyPair();
    return { server_id: deriveServerId(pair.publicKey), device_id: String(index), private_key: key.privateKey, public_spki: "fixture",
      label: "Phone", server_public_key: exportPublicKey(pair.publicKey), relay: "wss://relay.ovis.sh" };
  });
  const store: RelayDeviceStore = {
    list: async () => devices, get: async (id) => devices.find((device) => device.server_id === id),
    remove: async () => {}, update: async () => { throw new Error("sweep cannot change pairings"); },
  };
  return { devices, store };
}

/** A probe that answers only when the test lets it: each call's resolver in `pending`, and `arrived(n)` resolves once n calls were made. */
function heldProbe() {
  const pending: ReturnType<typeof Promise.withResolvers<Found>>[] = [];
  const checked: string[] = [];
  const waiting = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const arrived = (count: number): Promise<void> => {
    if (checked.length >= count) return Promise.resolve();
    const gate = waiting.get(count) ?? Promise.withResolvers<void>();
    waiting.set(count, gate);
    return gate.promise;
  };
  const probe = async (device: RelayDevice): Promise<Found> => {
    checked.push(device.server_id);
    const result = Promise.withResolvers<Found>();
    pending.push(result);
    waiting.get(checked.length)?.resolve();
    return result.promise;
  };
  return { pending, checked, arrived, probe };
}

it("limits each rotating sweep to eight PCs and two simultaneous checks, including repeated requests", async () => {
  jest.useFakeTimers();
  const { devices, store } = await savedPcs(12);
  const { pending, checked, arrived, probe } = heldProbe();
  const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
  const first = sweep.check();
  await arrived(2);
  await sweep.check();
  expect(pending).toHaveLength(2);
  for (let wave = 0; wave < 4; wave++) {
    pending[wave * 2]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
    pending[wave * 2 + 1]?.resolve({ kind: "offline", reason: "relay" });
    if (wave < 3) await arrived((wave + 2) * 2);
  }
  await first;
  expect(checked).toEqual(devices.slice(0, 8).map((device) => device.server_id));
  await sweep.check();
  expect(checked).toHaveLength(8);
  expect(sweep.status.get(devices[0]?.server_id ?? "")).toEqual({ kind: "answered", route: "relay", rttMs: 20 });
  jest.advanceTimersByTime(60_000);
  await arrived(10);
  expect(checked.slice(8)).toEqual(devices.slice(8, 10).map((device) => device.server_id));
  for (let wave = 4; wave < 8; wave++) {
    pending[wave * 2]?.resolve({ kind: "offline", reason: "relay" });
    pending[wave * 2 + 1]?.resolve({ kind: "offline", reason: "relay" });
    if (wave < 7) await arrived((wave + 2) * 2);
  }
  await arrived(16);
  expect(checked.slice(8)).toEqual([...devices.slice(8), ...devices.slice(0, 4)].map((device) => device.server_id));
});

it("checks exactly the PC asked for, ahead of a sweep's remaining PCs and within its two checks at once, and never twice while its check runs", async () => {
  const { devices, store } = await savedPcs(12);
  const ids = devices.map((device) => device.server_id);
  const [queued, outside] = [ids[7] ?? "", ids[10] ?? ""];
  const { pending, checked, arrived, probe } = heldProbe();
  const sweep = createPcSweep(store, { active: () => true, redraw() {} }, { probe });
  // a PC outside the sweep's eight, asked for first: checked at once and marked as checking meanwhile
  const asked = sweep.checkOne(outside);
  await arrived(1);
  expect(checked).toEqual([outside]);
  expect(sweep.status.get(outside)).toEqual({ kind: "checking" });
  // the sweep that follows gets the one worker left: two checks at once across both
  const first = sweep.check();
  await arrived(2);
  expect(checked).toEqual([outside, ids[0] ?? ""]);
  // a PC still waiting in the sweep's queue moves to its front, a second one from outside goes before it; the one under way is not asked again
  const movedUp = sweep.checkOne(queued);
  const another = sweep.checkOne(ids[11] ?? "");
  await sweep.checkOne(outside);
  expect(checked).toHaveLength(2);
  pending[0]?.resolve({ kind: "answered", route: "lan", rttMs: 4 });
  await arrived(3);
  expect(checked[2]).toBe(ids[11]);
  await asked;
  expect(sweep.status.get(outside)).toEqual({ kind: "answered", route: "lan", rttMs: 4 });
  pending[1]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
  await arrived(4);
  expect(checked[3]).toBe(queued);
  pending[2]?.resolve({ kind: "offline", reason: "pc" });
  await another;
  expect(sweep.status.get(ids[11] ?? "")).toEqual({ kind: "offline", reason: "pc" });
  pending[3]?.resolve({ kind: "offline", reason: "relay" });
  await movedUp;
  expect(sweep.status.get(queued)).toEqual({ kind: "offline", reason: "relay" });
  for (let turn = 4; turn < 10; turn++) {
    await arrived(turn + 1);
    pending[turn]?.resolve({ kind: "offline", reason: "relay" });
  }
  await first;
  // the sweep's eight plus the two asked for, the PC moved up checked once
  expect(checked).toEqual([outside, ids[0], ids[11], queued, ...ids.slice(1, 7)].map((id) => id ?? ""));
});

it("lets an answer go once it is older than the directory's 15 minutes, while a newer answer for the PC stays", async () => {
  jest.useFakeTimers();
  const { devices, store } = await savedPcs(1);
  const id = devices[0]?.server_id ?? "";
  const { pending, arrived, probe } = heldProbe();
  let redraws = 0;
  const sweep = createPcSweep(store, { active: () => true, redraw() { redraws += 1; } }, { probe });
  const first = sweep.checkOne(id);
  await arrived(1);
  pending[0]?.resolve({ kind: "answered", route: "relay", rttMs: 20 });
  await first;
  // ten minutes on, a second check answers again: the first answer's expiry leaves this one alone
  jest.advanceTimersByTime(10 * 60_000);
  const second = sweep.checkOne(id);
  await arrived(2);
  pending[1]?.resolve({ kind: "answered", route: "lan", rttMs: 4 });
  await second;
  jest.advanceTimersByTime(5 * 60_000);
  expect(sweep.status.get(id)).toEqual({ kind: "answered", route: "lan", rttMs: 4 });
  // fifteen minutes after it, nothing answers for the PC any more, and the rows are drawn again
  const drawn = redraws;
  jest.advanceTimersByTime(10 * 60_000);
  expect(sweep.status.has(id)).toBe(false);
  expect(redraws).toBe(drawn + 1);
});
