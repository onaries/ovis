import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportPublicKey, generateKeyPair } from "../shared/relay-e2ee.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { RelayUnreachableError } from "../shared/relay-channel.ts";
import { GLOBAL_RELAY, REGIONAL_RELAYS } from "../shared/relay-regions.ts";
import { openRelayPcTunnel, RelayPcKey } from "./relay-pc.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function offer(): RelayOffer {
  const publicKey = exportPublicKey(generateKeyPair().publicKey);
  return { v: 1, server_id: "ab".repeat(16), server_public_key: publicKey, relay: "wss://relay.example", code: "123456" };
}

function keyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-pc-key-"));
  dirs.push(dir);
  return join(dir, "relay-pcs", "pc.json");
}

it("saves an admitted key privately and signs in with it again", async () => {
  const path = keyPath();
  const pc = offer();
  const key = await RelayPcKey.create(path, pc, () => true);
  const [device] = await key.list();
  expect(existsSync(path)).toBe(false);
  await key.update(pc.server_id, () => ({ ...device!, device_id: "device-1" }));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const loaded = await RelayPcKey.load(path, () => true);
  expect(loaded.paired).toBe(true);
  expect(loaded.offer).toEqual({ v: 1, server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay });
});

it("writes no key for a PC removed while its pairing finished", async () => {
  const path = keyPath();
  const pc = offer();
  let wanted = true;
  const key = await RelayPcKey.create(path, pc, () => wanted);
  const [device] = await key.list();
  wanted = false;
  await expect(key.update(pc.server_id, () => ({ ...device!, device_id: "device-1" }))).rejects.toThrow("removed");
  expect(existsSync(path)).toBe(false);
});

/** A relay socket that closes before the relay assigns it, as an unreachable relay's does; records where it was dialed. */
function unreachable(dialed: string[]) {
  return (url: string) => {
    dialed.push(new URL(url).origin);
    const socket = { binaryType: "arraybuffer" as BinaryType, readyState: 3, send() {}, close() {},
      onmessage: null, onerror: null, onclose: null as ((event: CloseEvent) => void) | null };
    queueMicrotask(() => socket.onclose?.(new CloseEvent("close", { code: 1006 })));
    return socket;
  };
}

it("adds a PC through the global relay when its regional relay cannot be reached", async () => {
  // Given a PC whose offer names Ovis's regional relay, which does not answer
  const pc = { ...offer(), relay: REGIONAL_RELAYS[0]! };
  const key = await RelayPcKey.create(keyPath(), pc, () => true);
  const dialed: string[] = [];
  // Then the regional relay and then the global one, which that PC also keeps a link to, are tried
  await expect(openRelayPcTunnel(pc, key, { socket: unreachable(dialed), onLost: () => {} })).rejects.toBeInstanceOf(RelayUnreachableError);
  expect(dialed).toEqual([pc.relay, GLOBAL_RELAY]);
});

it("never tries Ovis's relay for a PC on a relay of its own", async () => {
  const pc = offer();
  const key = await RelayPcKey.create(keyPath(), pc, () => true);
  const dialed: string[] = [];
  await expect(openRelayPcTunnel(pc, key, { socket: unreachable(dialed), onLost: () => {} })).rejects.toBeInstanceOf(RelayUnreachableError);
  expect(dialed).toEqual(["wss://relay.example"]);
});

it("keeps across a restart the relay the PC named on admission", async () => {
  const path = keyPath();
  const key = await RelayPcKey.create(path, { ...offer(), relay: GLOBAL_RELAY }, () => true);
  await key.update(key.offer.server_id, (current) => ({ ...(current ?? { ...key.offer, device_id: null, label: "x", public_spki: "", private_key: undefined as never }), device_id: "cd".repeat(8), relay: REGIONAL_RELAYS[0]! }));
  expect((await RelayPcKey.load(path, () => true)).offer.relay).toBe(REGIONAL_RELAYS[0]!);
});
