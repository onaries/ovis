import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { startBunRelay } from "../relay/bun.ts";
import type { HerdrIdentity, Machine, MachineEvent, PcUpdateAll } from "../shared/machines.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { RelayService } from "./relay/service.ts";
import { newRouteProbes, openRelayPcTunnel, RelayPcKey } from "./relay-pc.ts";
import { decodeOffer } from "../shared/relay-offer.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";
import type { UpdateService } from "./update-api.ts";
import { noInstalledNotes, noUpdateNotes, unmanagedUpdateStatus, type UpdateStatus, INSTALL_ID } from "../shared/update.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-relay-pc-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The private address B names for its direct carrier in these tests, on the direct listener's own port (the only one
 * a PC server dials); A's dials to it reach B's loopback listener on whatever port that got.
 */
const LAN = "10.99.0.1";
/** B's Tailscale address in the tests that name one */
const TAILNET = "100.64.0.7";
const listener = { port: 0 };

/**
 * PC B with the relay on, PC A that adds it through the relay, and the local relay between them. `direct`: B also
 * listens on its network, and A reaches that address on the dials `reachable` lets through (else nothing answers).
 */
async function twoPcs(options: { direct?: { reachable: (dial: number, host: string) => boolean; held?: (dial: number) => Promise<void> | undefined; named?: (port: number) => readonly string[] }; updates?: UpdateService } = {}) {
  const relay = startBunRelay({ port: 0, limiters: {
    perAddress: { async limit() { return { success: true }; } },
    global: { async limit() { return { success: true }; } },
  } });
  cleanup.push(() => relay.stop());
  const synced = deferred<void>();
  /** while set, what B sends its phones (A, here) reaches the relay this much later */
  const delay = { ms: 0 };
  const local = (url: string): WebSocket => {
    const target = new URL(url);
    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`);
    if (target.searchParams.has("connection_id")) {
      const send = socket.send.bind(socket);
      socket.send = (data) => { if (delay.ms > 0) setTimeout(() => send(data), delay.ms); else send(data); };
    }
    if (target.searchParams.get("role") === "server" && !target.searchParams.has("connection_id")) {
      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string" && JSON.parse(event.data).type === "sync") synced.resolve();
      });
    }
    return socket;
  };
  const bState = stateDir();
  const service = new RelayService({ stateDir: bState, relay: `wss://127.0.0.1:${relay.port}`, connect: local, pairCodeRelay: `wss://127.0.0.1:${relay.port}`,
    ...(options.direct ? { direct: { addresses: () => ["127.0.0.1"], advertise: (port: number) => { listener.port = port; return options.direct!.named?.(port) ?? [`ws://${LAN}:7319`]; }, peerAllowed: () => true, preferredPort: 0 } } : {}) });
  const b = createServer({ port: 0, hostname: "127.0.0.1", stateDir: bState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relay: service, ...(options.updates ? { updates: options.updates } : {}) });
  cleanup.push(async () => { await service.shutdown(); b.stop(); });
  const bBase = `http://127.0.0.1:${b.port}`;
  const started = await fetch(`${bBase}/api/relay/start`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
  expect(started.status).toBe(200);
  await bounded(synced.promise);
  const offered = await fetch(`${bBase}/api/relay/offer`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
  expect(offered.status).toBe(200);
  // the add-me screen's window: what it takes is this PC's own to decide
  const approvals = b.context.services.relay.approvals;
  expect((await fetch(`${bBase}/api/relay/link`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } })).status).toBe(200);
  expect(approvals.localOnlyOpen()).toBe(false);
  expect((await fetch(`${bBase}/api/relay/link`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1", "x-ovis-local-only": "1" } })).status).toBe(200);
  expect(approvals.localOnlyOpen()).toBe(true);
  const { url: link } = await offered.json() as { url: string };
  const aState = stateDir();
  const lan = { dials: 0, dialed: [] as string[], ended: [] as string[] };
  const onLan = (url: string): WebSocket => {
    const target = new URL(url);
    lan.dialed.push(target.host);
    // anything but B's own addresses goes nowhere (and is recorded)
    if (target.hostname !== LAN && target.hostname !== TAILNET) return new WebSocket("ws://127.0.0.1:1/");
    // port 1 on loopback refuses at once, as an address of another network does
    const dial = ++lan.dials;
    const port = options.direct?.reachable(dial, target.hostname) ? (target.port === "7319" ? String(listener.port) : target.port) : "1";
    const socket = new WebSocket(`ws://127.0.0.1:${port}${target.pathname}${target.search}`);
    socket.addEventListener("close", () => lan.ended.push(target.hostname));
    const held = options.direct?.held?.(dial);
    if (!held) return socket;
    // what the PC answers on this dial reaches A only once `held` settles: a sign-in that takes its time
    const answer = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage")!;
    let handler: ((event: MessageEvent) => void) | null = null;
    answer.set!.call(socket, (event: MessageEvent) => { void held.then(() => handler?.(event)); });
    Object.defineProperty(socket, "onmessage", { get: () => handler, set: (next) => { handler = next; } });
    return socket;
  };
  const startA = () => {
    const a = createServer({ port: 0, hostname: "127.0.0.1", stateDir: aState, token: "", tailscaleOwner: null, sidecar: false, registerBridge: false, relayPcSocket: local, relayPcDirectSocket: onLan,
      pcUpdateTimings: { pollMs: 20, startMs: 5_000, checkMs: 1_000 } });
    let stopped = false;
    const stop = () => { if (!stopped) { stopped = true; a.stop(); } };
    cleanup.push(stop);
    return { app: a, base: `http://127.0.0.1:${a.port}`, stop };
  };
  return { b, bBase, link, aState, startA, delay, lan, local, onLan };
}

const findRelayPc = (base: string, code: string) => postRelay(base, { code }, "/code");

const errorCode = async (response: Response) => (await response.json() as { error: { code: string } }).error.code;

function addRelayPc(base: string, link: string, name?: string): Promise<Response> {
  return postRelay(base, { link, ...(name === undefined ? {} : { name }) });
}

function postRelay(base: string, body: Record<string, string>, path = ""): Promise<Response> {
  return fetch(`${base}/api/machines/relay${path}`, {
    method: "POST", headers: { origin: base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The first roster on A's machine events stream (the browser's own feed) in which `wanted` holds for a PC. */
async function machineWhen(base: string, wanted: (machine: Machine) => boolean, stop?: AbortSignal): Promise<Machine> {
  const abort = new AbortController();
  stop?.addEventListener("abort", () => abort.abort(), { once: true });
  const response = await fetch(`${base}/api/machines/events`, { headers: { origin: base }, signal: abort.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    return await bounded((async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("machine events ended");
        buffer += value;
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6)) as MachineEvent;
          const found = event.type === "machines" ? event.machines.find(wanted) : undefined;
          if (found) return found;
        }
      }
    })(), 30_000);
  } finally { abort.abort(); }
}

it("adds a PC through the relay, shows its panes, signs in again after a restart and stops at a revocation", async () => {
  const { b, link, aState, startA } = await twoPcs();
  let a = startA();

  const added = await addRelayPc(a.base, link, "Lab");
  expect(added.status).toBe(201);
  const { machine } = await added.json() as { machine: Machine };
  expect(machine).toMatchObject({ kind: "relay", name: "Lab", relay: { server_id: new URL(link).pathname.split("/")[2] } });

  // a release from before relay PCs reads machines.json: a relay PC is kept apart, so a rollback still starts
  expect(readFileSync(join(aState, "machines.json"), "utf8")).not.toContain(machine.id);
  expect(readFileSync(join(aState, "relay-pcs.json"), "utf8")).toContain(machine.id);

  // B admitted A as one more paired device, by the same consent a phone needs
  const devices = b.context.services.devices;
  const paired = devices.list(null).find((device) => device.via_relay);
  expect(paired?.label).toBe(`Ovis on ${hostname()}`.slice(0, 64));

  // B's roster reaches A's sidebar feed over the relay, and A's API routes reach B through it
  const connected = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected" && pc.snapshot !== null);
  const direct = await (await fetch(`http://127.0.0.1:${b.port}/api/session`, { headers: { origin: `http://127.0.0.1:${b.port}` } })).json() as { snapshot: SessionSnapshot };
  expect(connected.snapshot!.workspaces.map((workspace) => workspace.workspace_id)).toEqual(direct.snapshot.workspaces.map((workspace) => workspace.workspace_id));
  const proxied = await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } });
  expect(proxied.status).toBe(200);
  expect((await proxied.json() as { snapshot: SessionSnapshot }).snapshot.panes.length).toBe(direct.snapshot.panes.length);

  // A knows what runs B's terminals, as an SSH PC's bridge tells it, so its header shows no "herdr offline"
  const health = await (await fetch(`http://127.0.0.1:${b.port}/api/health`, { headers: { origin: `http://127.0.0.1:${b.port}` } })).json() as { herdr: HerdrIdentity };
  expect(health.herdr.protocol).toBeNumber();
  const known = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.herdr !== undefined);
  expect(known.herdr).toEqual(health.herdr);

  // a terminal socket for that PC goes through the same tunnel
  const opened = deferred<string>();
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const terminal = new RuntimeSocket(`${a.base.replace("http:", "ws:")}/ws?machine_id=${machine.id}`, { headers: { origin: a.base } });
  terminal.onmessage = (event) => opened.resolve(String(event.data));
  terminal.onclose = (event) => opened.reject(new Error(`terminal socket closed ${event.code}`));
  expect(JSON.parse(await bounded(opened.promise)).type).toBeString();
  terminal.onclose = null;
  terminal.close();

  // a restart signs in with the saved key: the pairing code is spent, and none is sent again
  a.stop();
  a = startA();
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");

  // B revokes A: A stops, says why, and does not try again
  devices.revoke(paired!.id);
  const revoked = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "error");
  expect(revoked.error).toContain("removed this PC's access");

  // Remove PC forgets the key with the registration
  const removed = await fetch(`${a.base}/api/machines/${machine.id}`, { method: "DELETE", headers: { origin: a.base, "x-herdr-machine": "1", "x-herdr-update": "1" } });
  expect(removed.status).toBe(200);
  const keys = join(aState, "relay-pcs");
  expect(existsSync(keys) ? readdirSync(keys) : []).toEqual([]);
}, 60_000);

it("finds a PC by the code it shows, keeps its offer while its ID is compared, and adds it once that ID is confirmed", async () => {
  const { bBase, startA } = await twoPcs();
  const a = startA();
  const notACode = await findRelayPc(a.base, "hello");
  expect(notACode.status).toBe(400);
  expect(await errorCode(notACode)).toBe("typed_code_not-a-code");
  const noPc = await findRelayPc(a.base, "ZZZZZ-ZZZZZ");
  expect(noPc.status).toBe(404);
  expect(await errorCode(noPc)).toBe("typed_code_no-pc");

  const minted = await fetch(`${bBase}/api/relay/code`, { method: "POST", headers: { origin: bBase, "x-herdr-update": "1" } });
  expect(minted.status).toBe(200);
  const { code, server_id } = await minted.json() as { code: string; server_id: string };
  const found = await findRelayPc(a.base, code.toLowerCase());
  expect(found.status).toBe(200);
  // the ID to compare with B's screen, and no pairing code: the offer that holds one stays on A
  const answer = await found.json() as { ticket: string; server_id: string; name: string };
  expect(answer).toEqual({ ticket: expect.any(String), server_id, name: expect.any(String) });
  // one exchange spends the code: nothing finds B with it again
  expect(await errorCode(await findRelayPc(a.base, code))).toBe("typed_code_no-pc");

  // only the window holding the ticket adds it: another client naming B's public ID takes nothing
  const other = await postRelay(a.base, { found: server_id });
  expect(other.status).toBe(400);
  expect((await other.json() as { error: { message: string } }).error.message).toContain("no longer waiting");
  const added = await postRelay(a.base, { found: answer.ticket });
  expect(added.status).toBe(201);
  const { machine } = await added.json() as { machine: Machine };
  expect(machine.relay?.server_id).toBe(server_id);
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  // and only once
  expect((await postRelay(a.base, { found: answer.ticket })).status).toBe(400);
}, 60_000);

it("refuses a link without a pairing code and a PC already added", async () => {
  const { link, startA } = await twoPcs();
  const a = startA();
  const bare = new URL(link);
  bare.hash = "";
  const refused = await addRelayPc(a.base, bare.href);
  expect(refused.status).toBe(400);
  expect((await refused.json() as { error: { message: string } }).error.message).toContain("not a pairing link");
  expect((await addRelayPc(a.base, link)).status).toBe(201);
  const again = await addRelayPc(a.base, link);
  expect(again.status).toBe(400);
  expect((await again.json() as { error: { message: string } }).error.message).toContain("already added");
}, 60_000);

it("leaves no relay PC behind when its registration cannot be saved", async () => {
  const { link, aState, startA } = await twoPcs();
  let a = startA();
  // the add's save fails at machines.json, which other saves write after relay-pcs.json
  const registrations = join(aState, "machines.json");
  mkdirSync(registrations);
  const failed = await addRelayPc(a.base, link, "Lab");
  expect(failed.status).toBe(400);
  expect((await failed.json() as { error: { message: string } }).error.message).toContain("could not be saved");
  const keys = join(aState, "relay-pcs");
  expect(existsSync(keys) ? readdirSync(keys) : []).toEqual([]);
  // the PC's registration was never written, not written and then taken back: no relay-pcs.json where none was
  expect(existsSync(join(aState, "relay-pcs.json"))).toBe(false);

  // a restart brings back no PC without its key
  a.stop();
  rmSync(registrations, { recursive: true });
  a = startA();
  const { machines } = await (await fetch(`${a.base}/api/machines`, { headers: { origin: a.base } })).json() as { machines: Machine[] };
  expect(machines.filter((machine) => machine.kind === "relay")).toEqual([]);
}, 60_000);

it("waits for a PC that answers slower than an idle connection's default limit", async () => {
  const { link, startA, delay } = await twoPcs();
  const a = startA();
  const { machine } = await (await addRelayPc(a.base, link)).json() as { machine: Machine };
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  // Bun ends a request its server has not answered for 10 s unless told otherwise
  delay.ms = 12_000;
  const slow = await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } });
  expect(slow.status).toBe(200);
}, 60_000);

/** Opens a terminal socket for the PC through A and resolves with its first frame. */
async function terminalAnswers(base: string, machineId: string): Promise<string> {
  const opened = deferred<string>();
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const terminal = new RuntimeSocket(`${base.replace("http:", "ws:")}/ws?machine_id=${machineId}`, { headers: { origin: base } });
  terminal.onmessage = (event) => opened.resolve(String(event.data));
  terminal.onclose = (event) => opened.reject(new Error(`terminal socket closed ${event.code}`));
  try { return await bounded(opened.promise); } finally { terminal.onclose = null; terminal.close(); }
}

it("moves a relay PC's connection to its same-network address without dropping it, and starts there after a restart", async () => {
  // Given B listening on its network as well, and A on that network
  const { link, startA } = await twoPcs({ direct: { reachable: () => true } });
  let a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  // When A has paired through the relay (pairing never goes direct) and B named its address inside the channel
  const seen: string[] = [];
  const routedEarly: string[] = [];
  const moved = await machineWhen(a.base, (pc) => {
    if (pc.id !== machine.id) return false;
    if (pc.state !== "connected" || seen.length > 0) seen.push(pc.state);
    if (pc.route !== undefined && pc.state !== "connected") routedEarly.push(`${pc.state}/${pc.route}`);
    return pc.route === "direct";
  });
  // Then the connection moved to that address with no disconnect in between, and still carries routes and terminals
  expect(moved.state).toBe("connected");
  expect(seen.filter((state) => state !== "connected")).toEqual([]);
  // a route is told only for a connected PC
  expect(routedEarly).toEqual([]);
  expect((await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } })).status).toBe(200);
  expect(JSON.parse(await terminalAnswers(a.base, machine.id)).type).toBeString();

  // and a restart signs in there first, from the address A kept with the key
  a.stop();
  a = startA();
  const back = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  expect(back.route).toBe("direct");
  // and that channel outlives the deadline its sign-in had (each carrier's share of 1.5 s)
  const watch = new AbortController();
  const dropped: string[] = [];
  const watching = machineWhen(a.base, (pc) => { if (pc.id === machine.id && pc.state !== "connected") dropped.push(pc.state); return false; }, watch.signal).catch(() => undefined);
  // fixed wait: proving nothing happens past the sign-in deadline
  await Bun.sleep(2_500);
  watch.abort();
  await watching;
  expect(dropped).toEqual([]);
  expect((await fetch(`${a.base}/api/machines/${machine.id}/session`, { headers: { origin: a.base } })).status).toBe(200);
}, 60_000);

it("keeps a relay PC on the relay while its same-network address does not answer", async () => {
  // Given B listening on a network A is not on
  const { link, startA, lan } = await twoPcs({ direct: { reachable: () => false } });
  let a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  // When A restarts, it tries that address first
  a.stop();
  const dialsBefore = lan.dials;
  a = startA();
  const back = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected");
  // Then it falls back to the relay by itself, and the PC works there
  expect(lan.dials).toBeGreaterThan(dialsBefore);
  expect(back.route).toBe("relay");
  expect(JSON.parse(await terminalAnswers(a.base, machine.id)).type).toBeString();
}, 60_000);

it("lets a request that starts while a move signs in finish, and still moves", async () => {
  // Given a tunnel to B paired through the relay, whose move to B's network has its sign-in held there
  // (dial 1 is the probe after admission, dial 2 the move's session)
  const release = deferred<void>();
  const holding = deferred<void>();
  const { link, local, onLan } = await twoPcs({ direct: { reachable: () => true, held: (dial) => {
    if (dial !== 2) return undefined;
    holding.resolve();
    return release.promise;
  } } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const lost: Error[] = [];
  const moved = deferred<void>();
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: (error) => lost.push(error), onMoved: () => moved.resolve() });
  cleanup.push(() => tunnel.close());
  await bounded(holding.promise);
  // When a request starts in that window and the sign-in then completes
  const request = fetch(`${tunnel.endpoint.url}/api/session`, { headers: { authorization: `Bearer ${tunnel.endpoint.token}` } });
  release.resolve();
  // Then the request is answered, the move happens, and the connection was never lost
  expect((await bounded(request)).status).toBe(200);
  await bounded(moved.promise, 30_000);
  expect(tunnel.route).toBe("direct");
  expect(lost).toEqual([]);
}, 60_000);

it("keeps the old session when input is sent while a move signs in, and moves on a later try", async () => {
  // Given a tunnel whose first move has its sign-in held (dial 2), and a socket that sends while it is held
  const release = deferred<void>();
  const holding = deferred<void>();
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: () => true, held: (dial) => {
    if (dial !== 2) return undefined;
    holding.resolve();
    return release.promise;
  } } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const lost: Error[] = [];
  const moved = deferred<void>();
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: (error) => lost.push(error), onMoved: () => moved.resolve() });
  cleanup.push(() => tunnel.close());
  await bounded(holding.promise);
  const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
  const socket = new RuntimeSocket(`${tunnel.endpoint.url.replace("http:", "ws:")}/ws`, { headers: { authorization: `Bearer ${tunnel.endpoint.token}` } });
  cleanup.push(() => socket.close());
  const open = deferred<void>();
  socket.onopen = () => open.resolve();
  await bounded(open.promise);
  // When input goes out on it before the held sign-in completes
  socket.send(JSON.stringify({ type: "role", mode: "observe" }));
  release.resolve();
  // Then that attempt's session is dropped, a later one moves, and the connection was never lost
  await bounded(moved.promise, 45_000);
  expect(lan.dials).toBeGreaterThanOrEqual(3);
  expect(tunnel.route).toBe("direct");
  expect(lost).toEqual([]);
}, 60_000);

it("checks the direct route again when this PC's addresses change, and moves there", async () => {
  // Given a tunnel on the relay because B's address did not answer after the sign-in
  const lanUp = { now: false };
  const { link, local, onLan } = await twoPcs({ direct: { reachable: () => lanUp.now } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const network = { now: "192.168.1.5" };
  const lost: Error[] = [];
  const moved = deferred<void>();
  const probed = deferred<void>();
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, onLost: (error) => lost.push(error), onMoved: () => moved.resolve(),
    directSocket: ((url: string) => { if (!lanUp.now) probed.resolve(); return onLan(url); }) as never,
    network: () => network.now, networkCheckMs: 50 });
  cleanup.push(() => tunnel.close());
  await bounded(probed.promise);
  expect(tunnel.route).toBe("relay");
  // When this PC joins B's network (its addresses change) well before the next timed check
  lanUp.now = true;
  network.now = "10.99.0.20";
  // Then it checks again at once and moves to B's address, never losing the connection
  await bounded(moved.promise);
  expect(tunnel.route).toBe("direct");
  expect(lost).toEqual([]);
}, 60_000);

it("dials none of the carriers a PC names off its listener's port family or on link-local, and uses the one it may", async () => {
  // Given B naming, inside its AUTH_OK, a link-local address and a service port beside its real carrier
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: () => true,
    named: (port) => ["ws://169.254.169.254:7319", `ws://${LAN}:80`, `ws://${LAN}:${port === 7319 ? 7320 : port}`, `ws://${LAN}:7319`] } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const moved = deferred<void>();
  // When A pairs and checks B's direct routes
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, onMoved: () => moved.resolve() });
  cleanup.push(() => tunnel.close());
  await bounded(moved.promise);
  // Then it only ever dialed B's listener on the direct port, and keeps only that one
  expect([...new Set(lan.dialed)]).toEqual([`${LAN}:7319`]);
  expect(key.direct).toEqual([`ws://${LAN}:7319`]);
}, 60_000);

/** Waits, bounded, until `done` holds. */
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) { if (Date.now() > deadline) throw new Error("condition not reached"); await Bun.sleep(10); }
}

it("keeps a PC's probe deadline across its tunnels, so reconnects dial its routes no more often", async () => {
  // Given B's address that does not answer, and A's per-PC probe state
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: () => false } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = newRouteProbes();
  const first = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes });
  // a check starts as its tunnel is handed over: its probe has dialed by now, and finds nothing
  expect(lan.dials).toBe(1);
  await until(() => probes.failed);
  first.close();
  // When the connection comes back right away, again and again (a relay that keeps dropping it, say)
  const { code: _code, ...signIn } = offer;
  for (let again = 0; again < 3; again++) {
    const tunnel = await openRelayPcTunnel(signIn, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes });
    tunnel.close();
  }
  // Then neither their sign-ins nor their checks dialed B's address again before the deadline
  expect(lan.dials).toBe(1);
}, 60_000);

it("tries a PC's routes again on reconnect when this PC changed networks while away", async () => {
  // Given a probe that found B's address silent on this PC's network
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: () => false } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = newRouteProbes();
  const network = { now: "192.168.1.5" };
  const first = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes, network: () => network.now });
  await until(() => probes.failed);
  first.close();
  const before = lan.dials;
  // When this PC is on another network by the time it connects again
  network.now = "10.99.0.20";
  const { code: _code, ...signIn } = offer;
  const second = await openRelayPcTunnel(signIn, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes, network: () => network.now });
  cleanup.push(() => second.close());
  // Then it tried B's address again at once
  expect(lan.dials).toBeGreaterThan(before);
}, 60_000);

it("still signs in on a working Tailscale route after a check of its same-network route found that silent", async () => {
  // Given B named on its network (not reachable from A) and on Tailscale (reachable), and A moved to Tailscale
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: (_dial, host) => host === TAILNET,
    named: () => [`ws://${LAN}:7319`, `ws://${TAILNET}:7319`] } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = newRouteProbes();
  const network = { now: "192.168.1.5" };
  const open = (from: RelayOffer, moved?: () => void) => openRelayPcTunnel(from, key, { socket: local as never, directSocket: onLan as never,
    onLost: () => {}, ...(moved ? { onMoved: moved } : {}), probes, network: () => network.now, networkCheckMs: 50 });
  const moved = deferred<void>();
  const first = await open(offer, () => moved.resolve());
  await bounded(moved.promise);
  first.close();
  const { code: _code, ...signIn } = offer;
  const second = await open(signIn);
  expect(second.route).toBe("direct");
  // When this PC's addresses change and the check of the earlier, same-network route finds it silent
  const endedBefore = lan.ended.filter((host) => host === LAN).length;
  network.now = "10.20.0.3";
  await until(() => lan.ended.filter((host) => host === LAN).length > endedBefore);
  // the check settles in the turn its probe's socket closed
  await new Promise((resolve) => setTimeout(resolve, 0));
  second.close();
  // Then a reconnect still signs in on Tailscale, the route that works
  const third = await open(signIn);
  cleanup.push(() => third.close());
  expect(third.route).toBe("direct");
}, 60_000);

it("lets a sign-in try the direct routes again once a check found one answering, even if it could not move", async () => {
  // Given a PC whose direct routes were found silent a while ago (the next check is due in a moment)
  const { link, local, onLan, lan } = await twoPcs({ direct: { reachable: (dial) => dial === 1 } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = { ...newRouteProbes(), failed: true, at: performance.now() - 5 * 60_000 + 300 };
  // When that check's probe finds B answering (dial 1) but the move's sign-in there fails (dial 2)
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes });
  cleanup.push(() => tunnel.close());
  await until(() => lan.ended.length >= 2);
  // the check settles in the turn the move's socket closed
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Then the next sign-in is not held back from the route that answered
  expect(tunnel.route).toBe("relay");
  expect(probes.failed).toBe(false);
}, 60_000);

it("records nothing for a PC when its tunnel closes in the middle of a check", async () => {
  // Given a check whose probe of B's address is under way (held there, dial 1)
  const holding = deferred<void>();
  const { link, local, onLan } = await twoPcs({ direct: { reachable: () => true, held: (dial) => {
    if (dial !== 1) return undefined;
    holding.resolve();
    return new Promise<void>(() => {});
  } } });
  const offer = decodeOffer(link)!;
  const key = await RelayPcKey.create(join(stateDir(), "key.json"), offer, () => true);
  const probes = newRouteProbes();
  const tunnel = await openRelayPcTunnel(offer, key, { socket: local as never, directSocket: onLan as never, onLost: () => {}, probes });
  await bounded(holding.promise);
  // When the tunnel closes (a relay that ends the connection, say) before the probe can answer
  tunnel.close();
  // the cut-off probe settles in this turn's microtasks; the check would record its result right after
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Then the next sign-in is not held back from the PC's direct routes
  expect(probes.failed).toBe(false);
}, 60_000);

/** B's own updater as a stand-in: `status` is what it tells; an install asked for runs through `after`, one status per read */
function updater(status: UpdateStatus, after: Partial<UpdateStatus>[]) {
  const requests: unknown[] = [];
  let reads = -1;
  const service: UpdateService = {
    status: () => reads < 0 ? status : { ...status, ...after[Math.min(reads++, after.length - 1)] },
    notes: noUpdateNotes,
    installed: noInstalledNotes,
    request: (request) => { requests.push(request); if (request.command === "install") reads = 0; },
  };
  return { service, requests };
}
const OFFERED_RELEASE = "a".repeat(40);
const ownOffer = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true,
  current_version: "0.5.0", latest_version: "0.5.1", current_revision: "c".repeat(40), latest_revision: OFFERED_RELEASE, revision_bound_install: true, ...patch });
const machinePost = (base: string, path: string, method = "POST") => fetch(`${base}/api/machines/${path}`, { method, headers: { origin: base, "x-herdr-machine": "1", "x-herdr-update": "1" } });

it("shows a relay PC's own update on its card and installs it from here, with its steps, until that PC answers on the new release", async () => {
  const b = updater(ownOffer(), [{ phase: "building", step: "download" }, { phase: "building", step: "build" }, { phase: "idle", available: false, current_revision: OFFERED_RELEASE, current_version: "0.5.1" }]);
  const { link, startA } = await twoPcs({ updates: b.service });
  const a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  const offered = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected" && pc.ovis_update != null);
  expect(offered.ovis_update).toEqual({ how: "own", current_version: "0.5.0", latest_version: "0.5.1", updatable: true, reason: null, revision: OFFERED_RELEASE });
  // a release other than the one shown is refused, and nothing is asked of that PC
  const other = await fetch(`${a.base}/api/machines/${machine.id}/update`, { method: "POST", headers: { origin: a.base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ revision: "b".repeat(40) }) });
  expect(other.status).toBe(409);
  expect(b.requests).toEqual([]);

  const seen = new AbortController();
  const step = machineWhen(a.base, (pc) => pc.id === machine.id && pc.updating?.step.includes("building") === true, seen.signal);
  const started = await fetch(`${a.base}/api/machines/${machine.id}/update`, { method: "POST", headers: { origin: a.base, "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" }, body: JSON.stringify({ revision: OFFERED_RELEASE }) });
  expect(started.status).toBe(202);
  const { job_id } = await started.json() as { job_id: string };
  expect((await step).updating).toMatchObject({ job_id, ovis: true });
  // the install names the release shown, and carries the id its 202 gave (POST /api/updates/install), which only a cancel by
  // the one that asked for it names
  expect(b.requests).toEqual([{ command: "install", expected_revision: OFFERED_RELEASE, install_id: expect.stringMatching(INSTALL_ID) }]);
  const done = await machineWhen(a.base, (pc) => pc.id === machine.id && !pc.updating && pc.ovis_update === null);
  expect(done.update_error ?? null).toBeNull();
  // nothing more on offer: asked again, it is refused in plain words
  const again = await machinePost(a.base, `${machine.id}/update`);
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: { code: "update_unavailable", message: "This PC's Ovis is up to date." } });
});

it("tells why a relay PC cannot update, and Update all skips it with that reason", async () => {
  const b = updater(ownOffer({ revision_bound_install: undefined }), []);
  const { link, startA } = await twoPcs({ updates: b.service });
  const a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  const offered = await machineWhen(a.base, (pc) => pc.id === machine.id && pc.state === "connected" && pc.ovis_update != null);
  expect(offered.ovis_update).toMatchObject({ how: "own", updatable: false, reason: expect.stringContaining("too old") });
  const refused = await machinePost(a.base, `${machine.id}/update`);
  expect(refused.status).toBe(409);
  expect((await refused.json() as { error: { code: string } }).error.code).toBe("update_unavailable");
  const all = await machinePost(a.base, "update-all");
  expect(all.status).toBe(202);
  expect(await all.json() as PcUpdateAll).toEqual({ started: [], queued: [], skipped: [{ machine_id: machine.id, reason: offered.ovis_update!.reason! }] });
  expect(b.requests).toEqual([]);
});

it("starts every relay PC's update with Update all, and reports a failure there on its card", async () => {
  const b = updater(ownOffer(), [{ phase: "building", step: "build" }, { phase: "error", error: "The build failed." }]);
  const { link, startA } = await twoPcs({ updates: b.service });
  const a = startA();
  const { machine } = await (await addRelayPc(a.base, link, "Lab")).json() as { machine: Machine };
  await machineWhen(a.base, (pc) => pc.id === machine.id && pc.ovis_update?.updatable === true);
  const all = await machinePost(a.base, "update-all");
  expect(all.status).toBe(202);
  const { started } = await all.json() as PcUpdateAll;
  expect(started.map((entry) => entry.machine_id)).toEqual([machine.id]);
  const failed = await machineWhen(a.base, (pc) => pc.id === machine.id && !pc.updating && typeof pc.update_error === "string");
  expect(failed.update_error).toBe("That PC's Ovis could not update itself: The build failed.");
});
