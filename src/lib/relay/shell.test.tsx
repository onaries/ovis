import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import type { ReactElement } from "react";

import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { memoryAccountStore } from "../account/store.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { RelayTransport, type RelayTransportOptions } from "./transport.ts";
import { MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";

const AP = "wss://relay-ap.ovis.sh";
const SERVICE = "https://account.ovis.sh";
const SHEET_JOIN = "ovis-add-pc-sheet";

const keyFor = () => { const pair = generateKeyPair(); return { server_id: deriveServerId(pair.publicKey), server_public_key: exportPublicKey(pair.publicKey) }; };

/** Spins the microtask queue until `holds`, or fails naming `what`: the shell's reads are promises alone, so no clock takes part. */
async function until(holds: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) { if (holds()) return; await Promise.resolve(); }
  throw new Error(`gave up waiting for ${what}`);
}
/** Enough turns for any read the shell wrongly started to reach the fetch (a read takes a few dozen). */
const drain = async (): Promise<void> => { for (let turn = 0; turn < 500; turn++) await Promise.resolve(); };

/** An isolated browser boundary shared by the controller suites; no production seam. */
export function createShellTestPage() {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let visibility: "visible" | "hidden" = "visible";
  const page = new EventTarget();
  const sessionStore = new Map<string, string>();
    for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "matchMedia"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const storage = (store: Map<string, string>) => ({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() });
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage(new Map()) });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage(sessionStore) });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://app.ovis.sh/", search: "", hash: "", origin: "https://app.ovis.sh", pathname: "/" },
      history: { state: null, replaceState() {} },
      matchMedia, innerWidth: 1440,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return visibility; },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page), dispatchEvent: page.dispatchEvent.bind(page),
    } });
  return { page, sessionStore, setVisibility: (next: typeof visibility) => { visibility = next; }, dispose: () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  } };
}

describe("the hosted shell's front page", () => {
  let browser: ReturnType<typeof createShellTestPage>;
  let rendered: ReactElement[];
  beforeEach(() => { browser = createShellTestPage(); rendered = []; });
  afterEach(() => { jest.useRealTimers(); setTransport(nativeTransport); browser.dispose(); });

  const deviceStore = (devices: RelayDevice[]): RelayDeviceStore => ({
    async get(serverId) { return devices.find((device) => device.server_id === serverId); },
    async list() { return [...devices]; },
    async remove(serverId) { const at = devices.findIndex((device) => device.server_id === serverId); if (at >= 0) devices.splice(at, 1); },
    async update(serverId, change) { const next = change(devices.find((device) => device.server_id === serverId)); const at = devices.findIndex((device) => device.server_id === serverId); if (at >= 0) devices[at] = next; else devices.push(next); return next; },
  });
  const mountFor = (over: Partial<RelayShellMount>): RelayShellMount => ({
    container: {} as HTMLElement, entryUrl: "https://app.ovis.sh/", shellVersion: "0.0.0-test", label: "Test phone",
    renderApp: () => { throw new Error("the app is not expected here"); },
    createRoot: () => ({ render(element: ReactElement) { rendered.push(element); }, unmount() {} }),
    open: () => Promise.reject(new Error("no connection is expected here")),
    checkPc: async () => ({ kind: "offline", reason: "relay" }),
    reload: async () => {},
    accountService: null,
    ...over,
  });
  const shellProps = (element: ReactElement): RelayShellProps => {
    let node = element;
    while (node.type !== RelayShell) node = (node.props as { children: ReactElement }).children;
    return node.props as RelayShellProps;
  };
  const last = (): RelayShellProps => shellProps(rendered.at(-1)!);
  const account = () => { const { state } = last(); if ((state.kind !== "list" && state.kind !== "empty") || state.account?.kind !== "signed-in") throw new Error(`not the signed-in front page: ${state.kind}`); return state.account; };

  it("starts a fresh typed challenge after wrong digits and ignores repeated pending submissions", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const challenges: RelayTransportOptions[] = [];
    browser.sessionStore.set("ovis-typed-join", offer.server_id);
    await mountRelayShell(mountFor({
      entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]),
      open: async (_offer, options = {}) => {
        challenges.push(options);
        await options.compare?.(challenges.length === 1 ? "123456" : "654321");
        throw new MuxProtocolError("auth_failed", "fixture declined");
      },
    }));
    last().onPair();
    await until(() => last().state.kind === "compare", "first challenge");
    last().onPair();
    await drain();
    expect(challenges).toHaveLength(1);
    last().onMatch("000000");
    expect(challenges[0]?.signal?.aborted).toBe(true);
    last().onRetry();
    await until(() => challenges.length === 2 && last().state.kind === "compare", "fresh challenge");
    expect(last().state).toMatchObject({ kind: "compare", typed: true, confirmed: false });
    expect(JSON.stringify(last().state)).not.toContain("654321");
    expect([...browser.sessionStore.values()].join()).not.toMatch(/123456|654321|000000/);
    last().onMatch("123456");
    expect(challenges[1]?.signal?.aborted).toBe(true);
  });

  it("suppresses a cancelled failure even when its saved-key lookup finishes late", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const held = Promise.withResolvers<RelayDevice | undefined>();
    const store = deviceStore([]);
    let reading = false;
    store.get = () => { reading = true; return held.promise; };
    await mountRelayShell(mountFor({
      entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store, navigate() {},
      open: async () => { throw new MuxProtocolError("auth_revoked", "fixture revoked"); },
    }));
    last().onPair();
    await until(() => reading, "revocation lookup");
    last().onCancel();
    const count = rendered.length;
    held.resolve(undefined);
    await drain();
    expect(rendered).toHaveLength(count);
  });

  it("keeps an admitted pairing Ready until Open PC", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    class Admitted extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
    }
    const opened = new Admitted(offer);
    let apps = 0;
    await mountRelayShell(mountFor({
      entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]), shellVersion: "1.0.0",
      open: async () => opened,
      renderApp: () => { apps++; return { render() {}, unmount() {} }; },
      pendingPush: { get: async () => undefined, clear: async () => {} },
    }));
    last().onPair();
    await drain();
    expect(apps).toBe(0);
    expect(last().state.kind).toBe("ready");
    last().onOpenPc?.();
    last().onOpenPc?.();
    expect(apps).toBe(1);
    opened.close();
  });

  it("returns admitted version observations to the dashboard and clears outdated on newer admission", async () => {
    browser.setVisibility("hidden");
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const store = deviceStore([{ ...offer, device_id: "paired", private_key: key.privateKey, public_spki: "fixture", label: "Phone" }]);
    const accountStore = memoryAccountStore();
    await accountStore.set("session", { service: SERVICE, account: "acct-test", provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
    class Admitted extends RelayTransport {
      version = "0.0.1";
      override get server() { return { version: this.version, relayProtocol: RELAY_PROTOCOL }; }
      override async fetch() { return Response.json({ managed: false }); }
    }
    const transport = new Admitted(offer);
    const front = mountFor({ store, accountStore, accountService: SERVICE, accountProviders: ["github"], accountFetch: async () => Response.json({ pcs: [] }) });
    await mountRelayShell(front);
    expect(account().pcs?.[0]?.state).toBe("paired");
    await mountRelayShell(mountFor({ store, entryUrl: `https://app.ovis.sh/s/${offer.server_id}/`, shellVersion: "1.0.0", open: async () => transport }));
    await mountRelayShell(front);
    expect(account().pcs?.[0]?.state).toBe("needs-update");
    expect(last().observedVersions?.get(offer.server_id)?.version).toBe("0.0.1");
    transport.version = "1.0.0";
    await mountRelayShell(mountFor({ store, entryUrl: `https://app.ovis.sh/s/${offer.server_id}/`, shellVersion: "1.0.0", open: async () => transport,
      renderApp: () => ({ render() {}, unmount() {} }), pendingPush: { get: async () => undefined, clear: async () => {} } }));
    await mountRelayShell(front);
    expect(account().pcs?.[0]?.state).toBe("paired");
    transport.close();
  });

  it("closes an admitted result that arrives after Cancel without rendering it", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP };
    const result = Promise.withResolvers<RelayTransport>();
    const began = Promise.withResolvers<void>();
    let closed = false;
    class Late extends RelayTransport { override close() { closed = true; super.close(); } }
    const opened = new Late(offer);
    await mountRelayShell(mountFor({ entryUrl: encodeOffer(offer, "https://app.ovis.sh"), store: deviceStore([]),
      navigate() {}, open: async () => { began.resolve(); return result.promise; } }));
    last().onPair();
    await began.promise;
    last().onCancel();
    const count = rendered.length;
    result.resolve(opened);
    await drain();
    expect(closed).toBe(true);
    expect(rendered).toHaveLength(count);
  });

  it("continues a confirmed typed-code offer in scope once without retaining its code", async () => {
    const offer = { v: 1 as const, ...keyFor(), relay: AP, code: "123456" };
    const paths: string[] = [];
    const settings = mountFor({ store: deviceStore([]), navigate: (path) => paths.push(path), findByCode: async () => offer });
    await mountRelayShell(settings);
    last().onCodeStart(); last().onCodeSubmit("typed-secret");
    await until(() => last().state.kind === "code-compare", "code comparison");
    last().onCodeMatch(); last().onCodeMatch();
    expect(paths).toHaveLength(1);
    expect([...browser.sessionStore.values()].join()).not.toMatch(/typed-secret|123456/);
    let attempts = 0;
    await mountRelayShell({ ...settings, entryUrl: paths[0] ?? "", open: async () => { attempts++; throw new MuxProtocolError("auth_failed", "spent"); } });
    await drain();
    expect(attempts).toBe(1);
    await mountRelayShell({ ...settings, entryUrl: paths[0] ?? "" });
    expect(last().state.kind).toBe("confirm");
  });

  it("returns from code entry in place without discarding the caller's view", async () => {
    const paths: string[] = [];
    await mountRelayShell(mountFor({ store: deviceStore([]), navigate: (path) => paths.push(path) }));
    last().onCodeStart();
    last().onCancel();
    await drain();
    expect(last().state.kind).toBe("empty");
    expect(paths).toEqual([]);
  });

  it("takes up the dashboard's sheet on the PC's page only for the PC the join was for, once", async () => {
    const pc = keyFor();
    const other = keyFor();
    const entryUrl = encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.server_public_key, relay: AP, name: "Desk PC" }, "https://app.ovis.sh");
    const arriveWith = async (marker: unknown): Promise<RelayShellProps> => {
      if (marker !== undefined) browser.sessionStore.set(SHEET_JOIN, typeof marker === "string" ? marker : JSON.stringify(marker));
      rendered = [];
      await mountRelayShell(mountFor({ entryUrl }));
      expect(last().state.kind).toBe("confirm");
      return last();
    };

    // a marker for another PC is not this page's join
    expect((await arriveWith({ mode: "new", server_id: other.server_id })).sheetJoin).toBeNull();
    // whatever the marker, the page took it: a later plain visit shows the screens alone
    expect(browser.sessionStore.has(SHEET_JOIN)).toBe(false);
    // this PC's join goes on in the sheet, in its mode
    expect((await arriveWith({ mode: "join", server_id: pc.server_id })).sheetJoin).toEqual({ mode: "join", server_id: pc.server_id });
    expect(browser.sessionStore.has(SHEET_JOIN)).toBe(false);
    expect((await arriveWith({ mode: "new", server_id: pc.server_id })).sheetJoin).toEqual({ mode: "new", server_id: pc.server_id });
    expect((await arriveWith({ mode: "new", server_id: pc.server_id, returnHash: "#pcs?filter=needs", code: "secret", access_token: "token" })).sheetJoin)
      .toEqual({ mode: "new", server_id: pc.server_id, returnHash: "#pcs?filter=needs" });
    expect((await arriveWith({ mode: "join", server_id: pc.server_id, returnHash: "#code=secret&state=private" })).sheetJoin)
      .toEqual({ mode: "join", server_id: pc.server_id });
    // no marker, a mode that is no join, or a marker that does not parse: the screens alone
    expect((await arriveWith(undefined)).sheetJoin).toBeNull();
    expect((await arriveWith({ mode: "add", server_id: pc.server_id })).sheetJoin).toBeNull();
    expect((await arriveWith("{not json")).sheetJoin).toBeNull();
  });
});
