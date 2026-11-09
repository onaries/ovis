import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { useLinkPageSignIn } from "../lib/account/useLinkPageSignIn.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { RelayState } from "../lib/useRelay.ts";
import { RelayTab } from "./ConnectPhoneDialog.tsx";

// The relay tab's Sign in starts the sign-in on the Ovis link page in a new tab, never Settings, and
// this tab comes back signed in once the person confirms there.
const SERVICE = "https://account.ovis.example";
const ONLINE: RelayStatus = { phase: "online", relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null };
const relay: RelayState = { status: ONLINE, unsupported: false, pending: false, request: async () => ONLINE };

interface FakeTab { opener: unknown; closed: boolean; location: { href: string }; close(): void }

describe("the relay tab's Sign in", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let fake: FakeAccountService;
  /** what window.open answers: a tab, or null for a blocked popup */
  let popupBlocked: boolean;
  let opened: string[];
  let tab: FakeTab | null;
  /** settles with the address the new tab is sent to */
  let navigated: Promise<string>;
  /** the link page's code, approved there as the first poll comes in */
  let approveOnPoll: boolean;
  let userCode: string | null;
  let polls: AbortSignal[];
  let firstPoll: Promise<void>;
  let settings: string[];
  let focusTargets: string[];
  let startGate: Promise<void>;
  let failStart: boolean;
  let linkPageAvailable: boolean;

  beforeEach(() => {
    fake = new FakeAccountService();
    fake.offerLinkPage(["github", "google"]);
    popupBlocked = false;
    opened = [];
    tab = null;
    approveOnPoll = false;
    userCode = null;
    polls = [];
    settings = [];
    focusTargets = [];
    startGate = Promise.resolve();
    failStart = false;
    linkPageAvailable = true;
    const sent = Promise.withResolvers<string>();
    navigated = sent.promise;
    const polled = Promise.withResolvers<void>();
    firstPoll = polled.promise;
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: { href: "https://workstation.example.ts.net/" },
      open: (url: string) => {
        opened.push(url);
        if (popupBlocked) return null;
        let href = url;
        tab = {
          opener: "ovis", closed: false, close() { this.closed = true; },
          location: { get href() { return href; }, set href(next: string) { href = next; sent.resolve(next); } },
        };
        return tab;
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.origin !== SERVICE) return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
      if (url.pathname === "/v1/signin/ovis/device" && !linkPageAvailable) return Response.json({ error: { code: "not_found", message: "no link page" } }, { status: 404 });
      if (url.pathname.startsWith("/v1/signin/")) {
        await startGate;
        if (failStart) return Response.json({ error: { code: "invalid_request", message: "refused" } }, { status: 400 });
      }
      if (url.pathname === "/v1/token") {
        if (init?.signal) polls.push(init.signal);
        if (approveOnPoll && userCode !== null) fake.approveOnLinkPage(userCode, "acct_one", "github");
        polled.resolve();
      }
      const answer = await fake.fetch(input, init);
      if (!url.pathname.startsWith("/v1/signin/") || !answer.ok) return answer;
      const started = await answer.json() as Record<string, unknown>;
      userCode = String(started["user_code"]);
      // the first poll comes at once rather than after the service's five seconds
      return Response.json({ ...started, interval: 0.001 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const mount = async (onSignedIn: () => void = () => undefined) => {
    const account = { service: SERVICE, onOpen: () => { settings.push("account"); }, onSignedIn };
    await act(async () => {
      renderer = create(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={account} phone={false} /></SettingsProvider>, {
        createNodeMock: ({ props }) => ({ closest: () => null, querySelector: () => null, focus() {
          if (typeof props === "object" && props !== null && "children" in props && typeof props.children === "string") focusTargets.push(props.children);
        } }),
      });
    });
  };
  const signIn = async () => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === "Sign in to Ovis");
    expect(found).toHaveLength(1);
    await act(async () => { found[0]!.props.onClick(); });
  };

  it.each(["starting", "waiting", "cancel", "failure"])("keeps keyboard focus usable after %s", async (phase) => {
    const gate = Promise.withResolvers<void>();
    startGate = gate.promise;
    failStart = phase === "failure";
    await mount();
    await signIn();
    if (phase === "starting") {
      const starting = renderer?.root.findByProps({ className: "btn btn-primary connect-signin-button" });
      expect(starting?.props.disabled).not.toBe(true);
      expect(starting?.props["aria-disabled"]).toBe(true);
      await act(async () => { starting?.props.onClick(); });
      expect(opened).toEqual(["about:blank"]);
    }
    await act(async () => { gate.resolve(); });
    if (phase === "starting") return;
    if (phase === "failure") {
      expect(renderer?.root.findByProps({ role: "alert" })).toBeDefined();
      expect(focusTargets.at(-1)).toBe("Sign in to Ovis");
      expect(tab?.closed).toBe(true);
      return;
    }
    await act(async () => { await firstPoll; });
    if (phase === "cancel") {
      await act(async () => { renderer?.root.findAllByType("button").find((node) => text(node) === "Cancel")?.props.onClick(); });
    }
    expect(focusTargets.at(-1)).toBe(phase === "waiting" ? "Open the sign-in page" : "Sign in to Ovis");
  });

  it.each([
    ["starting", "cancel"], ["starting", "restart"], ["starting", "unmount"],
    ["waiting", "cancel"], ["waiting", "restart"], ["waiting", "unmount"],
  ] as const)("cleans up a %s attempt on %s, closing only an unsent tab", async (phase, action) => {
    let actions: ReturnType<typeof useLinkPageSignIn> | undefined;
    const gate = Promise.withResolvers<void>();
    if (phase === "starting") startGate = gate.promise;
    function SignInHarness() { actions = useLinkPageSignIn(SERVICE, () => undefined, () => undefined); return null; }
    await act(async () => { renderer = create(<SignInHarness />); });
    await act(async () => { actions?.start(); });
    if (phase === "waiting") await act(async () => { await firstPoll; });
    const abandoned = tab;
    await act(async () => {
      switch (action) {
        case "cancel": actions?.cancel(); break;
        case "restart": actions?.start(); break;
        case "unmount": renderer?.unmount(); renderer = undefined; break;
        default: action satisfies never;
      }
    });
    expect(abandoned?.closed).toBe(phase === "starting");
    if (phase === "waiting") expect(polls[0]?.aborted).toBe(true);
    await act(async () => { actions?.cancel(); gate.resolve(); });
    if (phase === "starting") expect(abandoned?.location.href).toBe("about:blank");
  });

  it("announces completion in the same polite region after the account replaces the sign-in", async () => {
    approveOnPoll = true;
    const finished = Promise.withResolvers<void>();
    await mount(() => finished.resolve());
    const before = renderer?.root.findAllByProps({ "aria-live": "polite" });
    await signIn();
    await act(async () => { await finished.promise; });
    const account = { service: SERVICE, onOpen() {}, onSignedIn() {} };
    await act(async () => { renderer?.update(<SettingsProvider><RelayTab relay={relay} closesGate={false} signedIn joinBySignIn={false} account={account} phone={false} /></SettingsProvider>); });
    const after = renderer?.root.findAllByProps({ "aria-live": "polite" }) ?? [];
    expect(after.map(text)).toContain("Signed in with GitHub");
    expect(after[0]).toBe(before?.[0]);
  });

  it("uses the offered Google device page when the link page is unavailable", async () => {
    fake.offer(["google"], ["google"]);
    linkPageAvailable = false;
    await mount();
    await signIn();
    await act(async () => { await firstPoll; });
    expect(tab?.location.href).toBe("https://www.google.com/device");
    expect(renderer?.root.findAllByType("a").map(text)).toEqual(["Open Google"]);
  });

  it("opens the link page with its code filled in, in a new tab, and comes back signed in here", async () => {
    approveOnPoll = true;
    const signedIn = Promise.withResolvers<void>();
    await mount(() => signedIn.resolve());
    await signIn();
    // the tab opens in the click itself, so no popup blocker takes it
    expect(opened).toEqual(["about:blank"]);
    const page = await navigated;
    expect(page).toBe(`${SERVICE}/link?code=${userCode}`);
    expect(tab!.opener).toBeNull();
    expect(settings).toEqual([]);
    await act(async () => { await signedIn.promise; });
    expect((await indexedAccountStore.get("session"))?.account).toBe("acct_one");
    expect(text(renderer!.root)).toContain("Signed in with GitHub");
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    expect(tab?.closed).toBe(false);
  });

  it("shows the link page and its code here when the browser blocks the new tab", async () => {
    popupBlocked = true;
    await mount();
    await signIn();
    await act(async () => { await firstPoll; });
    const links = renderer!.root.findAll((node) => node.type === "a" && node.props.href === `${SERVICE}/link?code=${userCode}`);
    expect(links.map((link) => text(link))).toEqual(["Open the sign-in page"]);
    expect(text(renderer!.root)).toContain(userCode!);
    expect(settings).toEqual([]);
  });

  it("ends the waiting sign-in when the sheet closes, keeping no session", async () => {
    await mount();
    await signIn();
    await act(async () => { await firstPoll; });
    expect(polls.map((signal) => signal.aborted)).toEqual([false]);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    expect(polls[0]!.aborted).toBe(true);
    fake.approveOnLinkPage(userCode!, "acct_one", "github");
    expect(await indexedAccountStore.get("session")).toBeUndefined();
  });
});
