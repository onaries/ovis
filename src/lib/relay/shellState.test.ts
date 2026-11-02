import { describe, expect, it } from "bun:test";
import type { Root } from "react-dom/client";
import { exportPublicKey, generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { MuxProtocolError } from "../../../shared/relay-mux.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { loadRelayShell } from "../relay.ts";
import type { RelayShellMount } from "./shell.tsx";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { serverIdOfPath, serverScopePath, shellModeOf, shellServiceWorker } from "../shellMode.ts";
import { bootRelayShell, takeEntryUrl } from "./boot.ts";
import { RelayAdmissionTimeoutError, RelayUnreachableError, UnsafeRelayDestinationError } from "./channel.ts";
import { ServerIdentityChangedError } from "./device.ts";
import { testOffer } from "./device.test.ts";
import { failureOf, forgedOffer, forgetsDevice, iosBrowserTab, offerOf, shellEntry } from "./shellState.ts";

const APP = "https://app.example";

describe("the shell's entry", () => {
  it("reads the PC from the path and the offer from the fragment", () => {
    const offer = { ...testOffer(), code: "123456", name: "Desk" };
    const entry = shellEntry(encodeOffer(offer, APP));
    expect(entry).toEqual({ serverId: offer.server_id, offer, damaged: false });
  });

  it("is a saved PC's page without a fragment, and the front page at the root", () => {
    expect(shellEntry(`${APP}/s/${"12".repeat(16)}/`)).toEqual({ serverId: "12".repeat(16), offer: null, damaged: false });
    expect(shellEntry(`${APP}/`)).toEqual({ serverId: null, offer: null, damaged: false });
    expect(shellEntry(`${APP}/?pane=abc`)).toEqual({ serverId: null, offer: null, damaged: false });
  });

  it("calls a fragment that does not decode, or names another PC, damaged without throwing", () => {
    expect(shellEntry(`${APP}/s/${"12".repeat(16)}/#offer=abc`)).toEqual({ serverId: "12".repeat(16), offer: null, damaged: true });
    const other = encodeOffer(testOffer(), APP).replace(`/s/${"12".repeat(16)}/`, `/s/${"34".repeat(16)}/`);
    expect(shellEntry(other)).toMatchObject({ serverId: "34".repeat(16), offer: null, damaged: true });
    expect(shellEntry(`${APP}/s/not-an-id/#offer=abc`)).toEqual({ serverId: null, offer: null, damaged: true });
  });

  it("calls an offer forged when its key is not the one its PC's id is derived from", () => {
    // Given a PC's real identity (server/relay/identity.ts) and a key of someone else's.
    const own = generateKeyPair().publicKey;
    const genuine = { ...testOffer(), server_id: deriveServerId(own), server_public_key: exportPublicKey(own) };
    // Then only the PC's own key passes; another key under its id, or no key at all, is forged.
    expect(forgedOffer(genuine)).toBe(false);
    expect(forgedOffer({ ...genuine, server_public_key: exportPublicKey(generateKeyPair().publicKey) })).toBe(true);
    expect(forgedOffer({ ...genuine, server_public_key: "not-a-key" })).toBe(true);
  });

  it("rebuilds a saved PC's offer without a code", () => {
    const offer = { ...testOffer(), name: "Desk" };
    const device = { ...offer, device_id: "d1", private_key: {} as CryptoKey, public_spki: "spki", label: "Phone" };
    expect(offerOf(device)).toEqual({ v: 1, server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay, name: "Desk" });
    const { name: _name, ...unnamed } = device;
    expect("name" in offerOf(unnamed)).toBe(false);
  });
});

describe("the screen a failure lands on", () => {
  const paired = { code: false, paired: true };
  const pairing = { code: true, paired: false };
  const mux = (code: ConstructorParameters<typeof MuxProtocolError>[0]) => new MuxProtocolError(code, code);

  it("tells the relay from the PC by who stalled: the relay before assigning, the PC before answering, the PC's admission after", () => {
    expect(failureOf(new RelayUnreachableError(null), paired)).toBe("relay-unreachable");
    expect(failureOf(new RelayUnreachableError(null, true), paired)).toBe("relay-unreachable");
    expect(failureOf(new RelayUnreachableError(1013), pairing)).toBe("relay-unreachable");
    expect(failureOf(new TypeError("Failed to fetch"), paired)).toBe("relay-unreachable");
    expect(failureOf(mux("timeout"), paired)).toBe("pc-offline");
    expect(failureOf(mux("internal_error"), paired)).toBe("pc-offline");
    expect(failureOf(new RelayAdmissionTimeoutError("welcome"), paired)).toBe("pc-unresponsive");
    expect(failureOf(new RelayAdmissionTimeoutError("auth"), pairing)).toBe("pc-unresponsive");
  });

  it("names a used code, a revoked phone and a changed identity", () => {
    expect(failureOf(mux("auth_failed"), pairing)).toBe("code-expired");
    expect(failureOf(mux("auth_failed"), { code: false, paired: false })).toBe("code-expired");
    expect(failureOf(mux("auth_failed"), paired)).toBe("revoked");
    expect(failureOf(mux("auth_revoked"), paired)).toBe("revoked");
    expect(failureOf(new ServerIdentityChangedError("12".repeat(16)), paired)).toBe("identity-changed");
    expect(failureOf(mux("auth_changed"), paired)).toBe("pc-offline");
    expect(forgetsDevice(failureOf(mux("auth_changed"), paired))).toBe(false);
  });

  it("asks for an update on a protocol the two sides do not share, and calls an unsafe offer damaged", () => {
    expect(failureOf(mux("unsupported_version"), paired)).toBe("needs-update");
    expect(failureOf(mux("unsupported_extension"), pairing)).toBe("needs-update");
    expect(failureOf(new UnsafeRelayDestinationError("relay"), pairing)).toBe("bad-offer");
    expect(failureOf(mux("protocol_error"), paired)).toBe("relay-unreachable");
  });

  it("forgets the saved key only when the PC removed the phone", () => {
    expect(forgetsDevice("revoked")).toBe(true);
    for (const failure of ["pc-offline", "pc-unresponsive", "relay-unreachable", "needs-update", "identity-changed", "code-expired", "bad-offer"] as const) expect(forgetsDevice(failure)).toBe(false);
  });
});

describe("the iPhone browser tab", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  it("is an iPhone or iPad that is not installed", () => {
    expect(iosBrowserTab({ userAgent: iphone, maxTouchPoints: 5, standalone: false })).toBe(true);
    expect(iosBrowserTab({ userAgent: iphone, maxTouchPoints: 5, standalone: undefined })).toBe(true);
    expect(iosBrowserTab({ userAgent: iphone, maxTouchPoints: 5, standalone: true })).toBe(false);
    expect(iosBrowserTab({ userAgent: ipad, maxTouchPoints: 5, standalone: false })).toBe(true);
    expect(iosBrowserTab({ userAgent: ipad, maxTouchPoints: 0, standalone: undefined })).toBe(false);
    expect(iosBrowserTab({ userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120", maxTouchPoints: 5, standalone: undefined })).toBe(false);
  });

  for (const platform of ["ios", "android"]) {
    it(`does not show the home-screen hint inside the ${platform} app`, () => {
      const original = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
      Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
        isNativePlatform: () => true, getPlatform: () => platform,
      } });
      try {
        expect(iosBrowserTab({ userAgent: iphone, maxTouchPoints: 5, standalone: undefined })).toBe(false);
        expect(iosBrowserTab({ userAgent: ipad, maxTouchPoints: 5, standalone: false })).toBe(false);
      } finally {
        if (original) Object.defineProperty(globalThis, "Capacitor", original);
        else Reflect.deleteProperty(globalThis, "Capacitor");
      }
    });
  }
});

describe("shell mode", () => {
  const document = (content: string | null) => ({ querySelector: (selector: string) => selector === 'meta[name="ovis-shell"]' && content !== null ? { getAttribute: () => content } : null });

  it("is the meta the shell build writes and nothing else", () => {
    expect(shellModeOf(document("relay"))).toBe("relay");
    expect(shellModeOf(document(null))).toBeNull();
    expect(shellModeOf(document("other"))).toBeNull();
  });

  it("knows a PC's scope, its worker and the front page", () => {
    const id = "ab".repeat(16);
    expect(serverScopePath(id)).toBe(`/s/${id}/`);
    expect(serverIdOfPath(`/s/${id}/`)).toBe(id);
    expect(serverIdOfPath(`/s/${id}`)).toBe(id);
    expect(serverIdOfPath(`/s/${id}/index.html`)).toBe(id);
    expect(serverIdOfPath("/")).toBeNull();
    expect(serverIdOfPath("/s/")).toBeNull();
    expect(serverIdOfPath(`/s/${id}x/`)).toBeNull();
    expect(serverIdOfPath(`/s/${id.toUpperCase()}/`)).toBeNull();
    expect(shellServiceWorker(`/s/${id}/`)).toEqual({ script: `/s/${id}/sw.js`, scope: `/s/${id}/` });
    expect(shellServiceWorker("/")).toBeNull();
  });
});

describe("the offer fragment", () => {
  const page = (href: string) => {
    const url = new URL(href);
    const replaced: string[] = [];
    return {
      replaced,
      location: { href, pathname: url.pathname, search: url.search, hash: url.hash },
      history: { replaceState: (_data: unknown, _unused: string, to: string) => replaced.push(to) },
    };
  };

  it("leaves the address bar before anything else, and the entry keeps it", () => {
    const offer = encodeOffer(testOffer(), APP);
    const with_ = page(offer);
    expect(takeEntryUrl(with_)).toBe(offer);
    expect(with_.replaced).toEqual([`/s/${"12".repeat(16)}/`]);
    const without = page(`${APP}/s/${"12".repeat(16)}/?pane=p1`);
    expect(takeEntryUrl(without)).toBe(`${APP}/s/${"12".repeat(16)}/?pane=p1`);
    expect(without.replaced).toEqual([]);
  });

  it("is taken off before boot loads, requests or opens anything, and the shell gets it whole", async () => {
    // Given a page loaded with an offer, and every way boot could reach out recorded in order.
    const offer = encodeOffer(testOffer(), APP);
    const loaded = page(offer);
    const order: string[] = [];
    const replace = loaded.history.replaceState;
    loaded.history.replaceState = (data, unused, to) => { order.push("address"); return replace(data, unused, to); };
    const saved = { window: globalThis.window, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
    const mounted = Promise.withResolvers<string>();
    Object.assign(globalThis, {
      window: loaded,
      fetch: () => { order.push("fetch"); return new Promise(() => {}); },
      WebSocket: function () { order.push("socket"); },
    });
    try {
      // When boot runs, with the shell's chunk loading as lib/relay.ts loads it.
      bootRelayShell({} as HTMLElement, () => ({}) as Root, () => {
        order.push("load");
        const shell = { mountRelayShell: async ({ entryUrl }: RelayShellMount) => { mounted.resolve(entryUrl); } };
        return Promise.resolve(shell as Awaited<ReturnType<typeof loadRelayShell>>);
      });
      // Then the address changed first and synchronously, and the shell still got the offer.
      expect(order).toEqual(["address", "load"]);
      expect(loaded.replaced).toEqual([`/s/${"12".repeat(16)}/`]);
      expect(await mounted.promise).toBe(offer);
      expect(order).toEqual(["address", "load"]);
    } finally {
      Object.assign(globalThis, saved);
      // Bun has no window of its own: leave none behind
      if (saved.window === undefined) delete (globalThis as { window?: unknown }).window;
    }
  });
});
