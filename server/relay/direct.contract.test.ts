import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRelayChannel } from "../../shared/relay-channel.ts";
import type { RelayDevice, RelayDeviceStore } from "../../shared/relay-device.ts";
import { DIRECT_CARRIER, FrameType, MuxProtocolError } from "../../shared/relay-mux.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { SignedInSessions } from "./admissions.ts";
import { DirectCarrier, rankLanAddresses } from "./direct.ts";
import type { NetworkInterfaceInfo } from "node:os";
import { loadRelayIdentity } from "./identity.ts";
import { RelayService } from "./service.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture } from "./test-helpers.ts";
import { startBunRelay } from "../../relay/bun.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** A PC with its relay identity and a direct carrier on loopback (a test stands in for a private address). */
async function directFixture() {
  const fixture = relayFixture();
  const identity = loadRelayIdentity(fixture.stateDir);
  const direct = new DirectCarrier({ identity, services: fixture.app.context.services, port: fixture.app.port,
    addresses: () => ["127.0.0.1"], preferredPort: 0, peerAllowed: () => true });
  await direct.start();
  cleanup.push(() => fixture.close(), () => direct.stop());
  const offer: RelayOffer = { v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.ovis.example" };
  const url = (): string => `ws://127.0.0.1:${direct.port}/v1/ws?v=1`;
  return { fixture, identity, direct, offer, url };
}

/** The phone's saved key for the PC, as the hosted app keeps it after pairing through the relay. */
function savedStore(device: Awaited<ReturnType<typeof relayDevice>>, offer: RelayOffer): RelayDeviceStore {
  let saved: RelayDevice | undefined = { server_id: offer.server_id, device_id: device.id, private_key: device.keys.privateKey,
    public_spki: device.publicKey, label: "Phone", server_public_key: offer.server_public_key, relay: offer.relay };
  return {
    get: async () => saved,
    update: async (_id, change) => (saved = change(saved)),
    list: async () => saved ? [saved] : [],
    remove: async () => { saved = undefined; },
  };
}

/** Resolves when the socket opens, rejects when it is refused or closes first. */
function opened(socket: WebSocket): Promise<void> {
  const result = deferred<void>();
  socket.onopen = () => result.resolve();
  socket.onerror = () => result.reject(new Error("refused"));
  socket.onclose = () => result.reject(new Error("closed"));
  return bounded(result.promise);
}

describe("direct carrier", () => {
  it("lets a paired device sign in over the same Noise channel, without the relay", async () => {
    // Given a PC listening directly and a phone paired with it through the relay
    const { fixture, direct, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    // When the phone opens its channel to the PC's address
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) }));
    cleanup.push(() => channel.close());
    // Then it is admitted as itself, and counted as a session
    expect(channel.device.device_id).toBe(device.id);
    expect(channel.role).toBe("drive");
    expect(direct.sessions).toBe(1);
  });

  it("is not the PC when the key it proves is another one", async () => {
    // Given a phone that pinned another PC's key under this PC's id
    const { fixture, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    const elsewhere = relayFixture();
    cleanup.push(() => elsewhere.close());
    const other = loadRelayIdentity(elsewhere.stateDir);
    const pinned: RelayOffer = { ...offer, server_public_key: other.public_key };
    // When it reaches this address, the handshake against the pinned key fails before anything is sent
    await expect(bounded(openRelayChannel(pinned, { store: savedStore(device, pinned), socket: () => new WebSocket(url()) }))).rejects.toThrow();
  });

  it("ends a direct session when its device is removed", async () => {
    // Given a phone signed in directly
    const { fixture, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    const closed = deferred<Error>();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()), onClose: (error) => closed.resolve(error) }));
    cleanup.push(() => channel.close());
    // When the PC removes the device
    fixture.app.context.services.devices.revoke(device.id);
    // Then the direct session ends, and the device is not let in again
    await bounded(closed.promise);
    const again = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()) })).catch((caught: unknown) => caught);
    expect(again).toBeInstanceOf(MuxProtocolError);
    expect((again as MuxProtocolError).code).toBe("auth_failed");
  });

  it("pairs nothing: a code sent there is refused and stays unspent", async () => {
    // Given a pairing code the PC shows
    const { fixture, offer, url } = await directFixture();
    const store = fixture.app.context.services.devices;
    const code = store.startPairing().code;
    const phone = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const empty: RelayDeviceStore = { get: async () => undefined, update: async (_id, change) => change(undefined), list: async () => [], remove: async () => {} };
    // When a phone sends it over the direct carrier
    const error = await bounded(openRelayChannel({ ...offer, code }, { store: empty, socket: () => new WebSocket(url()) })).catch((caught: unknown) => caught);
    // Then it is refused, and the code still pairs through the relay's path
    expect(error).toBeInstanceOf(MuxProtocolError);
    expect((error as MuxProtocolError).code).toBe("auth_failed");
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", phone.publicKey)).toString("base64url");
    expect(store.pairRelay(code, "Phone", publicKey)).toBeTruthy();
  });

  it("holds at most two clients that have not signed in per address", async () => {
    // Given two sockets from one address that never start a handshake
    const { url } = await directFixture();
    const first = new WebSocket(url());
    const second = new WebSocket(url());
    cleanup.push(() => first.close(), () => second.close());
    await opened(first);
    await opened(second);
    // When a third comes from the same address, it is refused before upgrade
    const third = new WebSocket(url());
    cleanup.push(() => third.close());
    await expect(opened(third)).rejects.toThrow();
  });

  it("answers only private network peers", async () => {
    // Given the default peer rule, on loopback
    const fixture = relayFixture();
    const strict = new DirectCarrier({ identity: loadRelayIdentity(fixture.stateDir), services: fixture.app.context.services,
      port: fixture.app.port, addresses: () => ["127.0.0.1"], preferredPort: 0 });
    await strict.start();
    cleanup.push(() => fixture.close(), () => strict.stop());
    // Then a loopback client is refused
    await expect(opened(new WebSocket(`ws://127.0.0.1:${strict.port}/v1/ws?v=1`))).rejects.toThrow();
  });

  it("ends every direct session when it stops", async () => {
    // Given a phone signed in directly
    const { fixture, direct, offer, url } = await directFixture();
    const device = await relayDevice(fixture);
    const closed = deferred<Error>();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(url()), onClose: (error) => closed.resolve(error) }));
    cleanup.push(() => channel.close());
    // When direct connections stop, the session ends and nothing listens
    await direct.stop();
    await bounded(closed.promise);
    expect(direct.port).toBeNull();
  });
});

describe("a sign-in-only session", () => {
  it("refuses a comparison of digits as a sign-in failure, whatever the phone offered", async () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const connection = await relayConnection(fixture, { signInOnly: true });
    await connection.hello(["pair-sas", "pair-intent-pc"]);
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
    connection.mux.sendSession({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Phone", public_key: publicKey, commitment: Buffer.alloc(32).toString("base64url") } });
    expect(await bounded(connection.serverError)).toBe("auth_failed");
  });
});

describe("direct carriers in AUTH_OK", () => {
  it("are named only to a phone that offered them", async () => {
    // Given a PC with a direct carrier
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const device = await relayDevice(fixture);
    const carriers = ["ws://192.168.0.10:7319"];
    // When one phone offers DIRECT_CARRIER and another does not
    const offering = await relayConnection(fixture, { directCarriers: () => carriers });
    const plain = await relayConnection(fixture, { directCarriers: () => carriers });
    // Then only the one that offered is told
    expect((await offering.auth(device, [DIRECT_CARRIER])).direct).toEqual(carriers);
    expect(await plain.auth(device)).not.toHaveProperty("direct");
  });

  it("are left out when there are none", async () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const device = await relayDevice(fixture);
    const connection = await relayConnection(fixture, { directCarriers: () => [] });
    expect(await connection.auth(device, [DIRECT_CARRIER])).not.toHaveProperty("direct");
  });
});

describe("direct connections setting", () => {
  it("is on by default and kept off once turned off", async () => {
    // Given a relay service that offers direct connections, with the relay off
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const service = new RelayService({ stateDir: fixture.stateDir, direct: { addresses: () => [] } });
    expect(service.status().direct).toEqual({ on: true, carriers: [] });
    // When it is turned off
    await service.setDirect(false);
    // Then it says so, and a new start reads it back
    expect(JSON.parse(readFileSync(join(fixture.stateDir, "relay", "direct.json"), "utf8"))).toEqual({ on: false });
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(false);
  });

  it("is absent where the server offers no direct connections", () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    expect(new RelayService({ stateDir: fixture.stateDir }).status()).not.toHaveProperty("direct");
    expect(existsSync(join(fixture.stateDir, "relay", "direct.json"))).toBe(false);
  });
});

describe("addresses listened on", () => {
  const nic = (address: string): NetworkInterfaceInfo => ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` });
  it("puts the default route's first, leaves out virtual adapters and keeps four", () => {
    const interfaces = { docker0: [nic("172.17.0.1")], "br-1a2b": [nic("172.18.0.1")], virbr0: [nic("192.168.122.1")], "vEthernet (WSL)": [nic("172.24.0.1")],
      eth1: [nic("10.0.0.2")], eth2: [nic("10.0.1.2")], eth3: [nic("10.0.2.2")], eth4: [nic("10.0.3.2")], wlan0: [nic("192.168.0.10")],
      tailscale0: [nic("100.100.1.1")], lo: [{ ...nic("127.0.0.1"), internal: true }] };
    expect(rankLanAddresses(interfaces, "192.168.0.10")).toEqual(["192.168.0.10", "10.0.0.2", "10.0.1.2", "10.0.2.2"]);
  });

  it("keeps a virtual adapter the default route leaves from", () => {
    expect(rankLanAddresses({ "vEthernet (Default Switch)": [nic("172.20.0.5")], docker0: [nic("172.17.0.1")] }, "172.20.0.5")).toEqual(["172.20.0.5"]);
  });

  it("takes another port when the one asked for is busy", async () => {
    // Given the preferred port held by something else
    const fixture = relayFixture();
    const held = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const direct = new DirectCarrier({ identity: loadRelayIdentity(fixture.stateDir), services: fixture.app.context.services, port: fixture.app.port,
      addresses: () => ["127.0.0.1"], preferredPort: held.port, peerAllowed: () => true });
    cleanup.push(() => fixture.close(), () => held.stop(true), () => direct.stop());
    // When direct connections start, they listen on another one
    await direct.start();
    expect(direct.port).not.toBeNull();
    expect(direct.port).not.toBe(held.port);
  });
});

describe("signed-in sessions over every way in", () => {
  it("count against one limit, a device's oldest giving way", () => {
    const sessions = new SignedInSessions(8, 4);
    const closed: string[] = [];
    for (const name of ["r1", "r2", "d1", "d2", "d3"]) sessions.admit("phone", () => closed.push(name));
    expect(closed).toEqual(["r1"]);
    expect(sessions.size).toBe(4);
  });

  it("let a device at its share replace its own oldest even when every place is taken", () => {
    const sessions = new SignedInSessions(8, 4);
    const closed: string[] = [];
    for (const device of ["a", "b"]) for (let index = 1; index <= 4; index++) sessions.admit(device, () => closed.push(`${device}${index}`));
    sessions.admit("a", () => closed.push("a5"));
    expect(closed).toEqual(["a1"]);
    expect(sessions.size).toBe(8);
  });

  it("close a session past every place, and give places back", () => {
    const sessions = new SignedInSessions(2, 4);
    const closed: string[] = [];
    const release = sessions.admit("a", () => closed.push("a"));
    sessions.admit("b", () => closed.push("b"));
    sessions.admit("c", () => closed.push("c"));
    expect(closed).toEqual(["c"]);
    release();
    sessions.admit("d", () => closed.push("d"));
    expect(closed).toEqual(["c"]);
  });
});

describe("direct connections setting, read back", () => {
  it("stays off when the saved choice cannot be read", () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    mkdirSync(join(fixture.stateDir, "relay"), { recursive: true });
    writeFileSync(join(fixture.stateDir, "relay", "direct.json"), '{ "on": fal');
    expect(new RelayService({ stateDir: fixture.stateDir, direct: {} }).status().direct?.on).toBe(false);
  });

  it("refuses a switch without on: true or false", async () => {
    const stateDir = relayFixture();
    stateDir.close();
    const fixture = relayFixture(false, { relay: new RelayService({ stateDir: stateDir.stateDir, direct: { addresses: () => [] } }) });
    cleanup.push(() => fixture.close());
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const response = await fetch(`${base}/api/relay/direct`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ on: "yes" }) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_relay_direct");
  });
});

describe("direct connections with the relay", () => {
  /** A PC on a local relay, direct connections on loopback named as a private address. */
  async function liveFixture() {
    const relay = startBunRelay({ port: 0 });
    const holder = relayFixture();
    holder.close();
    const synced = deferred<void>();
    const service = new RelayService({
      stateDir: holder.stateDir, relay: "wss://relay.test",
      connect: (url) => {
        const target = new URL(url);
        const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
        socket.addEventListener("message", (event) => { if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve(); });
        return socket;
      },
      direct: { addresses: () => ["127.0.0.1"], peerAllowed: () => true, preferredPort: 0, advertise: (port) => [`ws://10.0.0.7:${port}`] },
    });
    const fixture = relayFixture(false, { stateDir: holder.stateDir, relay: service });
    cleanup.push(() => relay.stop(), () => fixture.close(), () => service.shutdown());
    service.start();
    await bounded(synced.promise);
    await service.setDirect(true);
    const identity = loadRelayIdentity(holder.stateDir);
    const offer: RelayOffer = { v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: "wss://relay.test" };
    const port = (): string => service.status().direct!.carriers[0]!.split(":").at(-1)!;
    return { fixture, service, offer, port };
  }

  it("listen while the relay is on, end their sessions when turned off, and come back when turned on", async () => {
    // Given a PC with the relay on and a phone signed in directly
    const { fixture, service, offer, port } = await liveFixture();
    expect(service.status().direct?.carriers).toHaveLength(1);
    const device = await relayDevice(fixture);
    const closed = deferred<Error>();
    const channel = await bounded(openRelayChannel(offer, { store: savedStore(device, offer), socket: () => new WebSocket(`ws://127.0.0.1:${port()}/v1/ws?v=1`), onClose: (error) => closed.resolve(error) }));
    cleanup.push(() => channel.close());
    expect(service.status().sessions).toBe(1);
    // When direct connections are turned off, the session ends and nothing is named
    await service.setDirect(false);
    await bounded(closed.promise);
    expect(service.status().direct).toEqual({ on: false, carriers: [] });
    // When they are turned on again, the listener is back
    await service.setDirect(true);
    expect(service.status().direct?.carriers).toHaveLength(1);
  });

  it("stop with the relay", async () => {
    const { service } = await liveFixture();
    await service.stop();
    expect(service.status().direct).toEqual({ on: true, carriers: [] });
  });

  it("refuse the switch on a server without them", async () => {
    const fixture = relayFixture();
    cleanup.push(() => fixture.close());
    const base = `http://127.0.0.1:${fixture.app.port}`;
    const response = await fetch(`${base}/api/relay/direct`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ on: false }) });
    expect(response.status).toBe(409);
  });
});
