import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import type { ReactNode } from "react";
import * as ReactDom from "react-dom";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { exportPublicKey, generateKeyPair } from "../../shared/relay-e2ee.ts";
import { decodeOffer, encodeOffer } from "../../shared/relay-offer.ts";
import type { PairedDevice, RelayStatus } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import type { RelayState } from "../lib/useRelay.ts";
import type { Machine } from "../../shared/machines.ts";
import type { AddPcPreset } from "../lib/actions.ts";
import { PhonePanel } from "./PhonePanel.tsx";
import { RelayPairing } from "./RelayPanel.tsx";
import { QrCode } from "./QrCode.tsx";

// the confirmation before Revoke all is a portal on document.body, which this renderer has none of
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { ACCOUNT_QR_HIDDEN_MS, ACCOUNT_QR_MAX_MS, CodeRoute, connectTabs, openingTab, RelayRoute, RelayTab, sameNameRelayDevice, SshTab } = await import("./ConnectPhoneDialog.tsx");
const { ConfirmDialog } = await import("./ConfirmDialog.tsx");
const { announcePairingCode, QR_CODE_ENDED_CHANNEL, useRelay } = await import("../lib/useRelay.ts");
const { ACCOUNT_QR_ALONE_MS, ACCOUNT_QR_LATE_MS, ACCOUNT_QR_POLL_MS, accountQrFindings, accountQrNoticeWaiting, addedBy, accountQrPending, resetAccountQrWatch, unvouched } = await import("../lib/accountQrWatch.ts");

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const APP = "https://app.ovis.example";
const OFFER_URL = encodeOffer({ v: 1, server_id: SERVER_ID, server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.ovis.example", code: "482913", name: "Workstation" }, APP);
const ONLINE: RelayStatus = { phase: "online", relay: "wss://relay.ovis.example", app: APP, sessions: 0, blocked: null, error: null };
const relayState = (status: RelayStatus = ONLINE): RelayState => ({ status, unsupported: false, pending: false, request: async () => status, reread: () => {} });

describe("Connect a phone on a phone", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: string[];
  let assigned: string[];
  let shellMeta: boolean;
  let tailnetAnswer: Promise<void>;
  let tailnetOutdated: boolean;
  let extraCandidates: object[];
  let candidatesRefused: string | null;
  let pending: string;
  let pairStarts: { code: string; gate: Promise<void> }[];
  /** what each POST /api/relay/offer said it is for (x-ovis-no-account-only), in the order the PC got them */
  let offersAsked: (string | null)[];
  /** whether the pending code is the relay tab's QR code's own: the PC keeps one pending code, of one kind */
  let pendingOwn: boolean;
  /** the next answers of POST /api/relay/offer, each held until its gate opens: the PC has answered, the answer is on its way */
  let offerGates: Promise<void>[];
  /** offers the PC got whose answers have not arrived */
  let offersOut: number;
  /** the next POSTs of /api/relay/offer, each held on its way to the PC until its gate opens (none: the PC gets it at once) */
  let offerRoads: Promise<void>[];

  beforeEach(() => {
    pending = "482913";
    pairStarts = [];
    offersAsked = [];
    pendingOwn = false;
    offerGates = [];
    offersOut = 0;
    offerRoads = [];
    requests = [];
    assigned = [];
    shellMeta = false;
    tailnetAnswer = Promise.resolve();
    tailnetOutdated = true;
    extraCandidates = [];
    candidatesRefused = null;
    for (const key of ["window", "document", "navigator", "getComputedStyle", "Capacitor", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1", maxTouchPoints: 5 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://workstation.example.ts.net/", assign: (url: string) => { assigned.push(url); } },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: (selector: string) => shellMeta && selector.includes("ovis-shell") ? { getAttribute: () => "relay" } : null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "https://workstation.example.ts.net").pathname;
      requests.push(path);
      const expires_at = new Date(Date.now() + 600_000).toISOString();
      if (path === "/api/relay/offer") {
        const own = new Headers(input instanceof Request ? input.headers : init?.headers).get("x-ovis-no-account-only");
        const road = offerRoads.shift();
        if (road !== undefined) await road;
        offersAsked.push(own);
        // one pending code, as the PC keeps it (server/devices.ts): the relay tab's QR code gets a code of its own, which
        // no other offer carries, so an offer of either kind starts a code when the pending one is of the other kind
        if ((own === "1") !== pendingOwn) {
          pendingOwn = own === "1";
          pending = String(600_000 + offersAsked.length);
        }
        const code = pending;
        offersOut += 1;
        await offerGates.shift();
        offersOut -= 1;
        return Response.json({ url: code === "482913" ? OFFER_URL : encodeOffer({ ...decodeOffer(OFFER_URL)!, code }, APP), expires_at });
      }
      if (path === "/api/devices/pair/start") {
        const held = pairStarts.shift();
        if (held === undefined) return Response.json({ code: pending, expires_at });
        await held.gate;
        return Response.json({ code: held.code, expires_at });
      }
      if (path === "/api/machines/tailnet") { await tailnetAnswer; return Response.json({ pcs: [{ name: "winvm", url: "https://winvm.tail.ts.net:8443", relay: "online", outdated: tailnetOutdated }] }); }
      if (path === "/api/machines/ssh-candidates" && candidatesRefused !== null) return Response.json({ error: { code: candidatesRefused, message: "refused" } }, { status: 403 });
      if (path === "/api/machines/ssh-candidates") return Response.json({ pcs: [
        { name: "nuc12", destination: "nuc12", detail: "rise@100.127.218.1", source: "ssh_config" },
        { name: "winvm", destination: "winvm.tail.ts.net", detail: "winvm.tail.ts.net", source: "tailscale", tailnet: "winvm.tail.ts.net" },
        ...extraCandidates,
      ] });
      if (path === "/api/relay/code") { pending = "777111"; pendingOwn = false; return Response.json({ code: "7K3QD-M2XHA", expires_at, server_id: SERVER_ID }); }
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
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

  const mount = async (node: React.ReactNode) => { await act(async () => { renderer = create(<SettingsProvider>{node}</SettingsProvider>); }); };
  const qrCodes = () => renderer!.root.findAllByType(QrCode);
  /** the six-digit codes of the relay QR codes on screen */
  const shown = () => qrCodes().map((qr) => decodeOffer(String(qr.props.value))?.code);
  /** Lets the page run on, a turn at a time, until `reached` holds; a state that never comes fails here, naming `what`. */
  const until = async (reached: () => boolean, what: string) => {
    for (let turn = 0; turn < 2000; turn += 1) {
      if (reached()) return;
      await act(async () => { await new Promise<void>((resolve) => { setImmediate(resolve); }); });
    }
    throw new Error(`Never came: ${what}`);
  };
  /** the relay tab's QR code is the only one up, with the code the PC has, which is its own; `out`: answers still on their way */
  const onlyTheRelayTabs = (out = 0) => pendingOwn && shown().length === 1 && shown()[0] === pending && offersOut === out;
  /** Holds the answer of an offer the PC is yet to get, the one after the next `after` offers, until the returned call. */
  const gate = (after: number) => {
    for (let passed = 0; passed < after; passed += 1) offerGates.push(Promise.resolve());
    let open = () => {};
    offerGates.push(new Promise<void>((resolve) => { open = resolve; }));
    return () => open();
  };
  /** Holds the next offer asked for on its way to the PC, until the returned call: the PC gets the offers asked for after it first. */
  const holdOnTheWay = () => {
    let open = () => {};
    offerRoads.push(new Promise<void>((resolve) => { open = resolve; }));
    return () => open();
  };
  /** how many offers the page has asked for, those still on their way to the PC too */
  const offersSent = () => requests.filter((path) => path === "/api/relay/offer").length;
  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const button = (label: string) => {
    const found = renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === label);
    expect(found.map(text)).toEqual([label]);
    return found[0]!;
  };
  const buttons = () => renderer!.root.findAll((node) => node.type === "button").map((node) => text(node).trim());

  it("shows the Tailscale address with Copy address and no QR code until Show QR code", async () => {
    await mount(<PhonePanel url="https://workstation.example.ts.net" phone />);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toContain("Copy address");
    await act(async () => { button("Show QR code").props.onClick(); });
    expect(qrCodes()).toHaveLength(1);
  });

  it("keeps the desktop's Tailscale QR code up front", async () => {
    await mount(<PhonePanel url="https://workstation.example.ts.net" />);
    expect(qrCodes()).toHaveLength(1);
    expect(buttons()).not.toContain("Show QR code");
  });

  it("shows a pairing code large, with its QR code behind Show QR code", async () => {
    await mount(<CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce phone />);
    expect(requests).toContain("/api/devices/pair/start");
    expect(qrCodes()).toHaveLength(0);
    const code = renderer!.root.findAll((node) => node.type === "p" && typeof node.props.className === "string" && node.props.className.includes("devices-code"));
    expect(code.map((node) => [node.props.className, text(node)])).toEqual([["devices-code devices-code-large", "482 913"]]);
    await act(async () => { button("Show QR code").props.onClick(); });
    expect(qrCodes()).toHaveLength(1);
  });

  it("a code asked for by a dialog closed meanwhile never replaces the newer code the reopened one shows", async () => {
    let answerOld: () => void = () => {};
    pairStarts = [{ code: "111111", gate: new Promise<void>((resolve) => { answerOld = resolve; }) }, { code: "222222", gate: Promise.resolve() }];
    const shown = () => renderer!.root.findAll((node) => node.type === "p" && typeof node.props.className === "string" && node.props.className.includes("devices-code")).map(text);
    await mount(<CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce />);
    await act(async () => { renderer!.unmount(); });
    await mount(<CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce />);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(shown()).toEqual(["222 222"]);
    await act(async () => { answerOld(); });
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(shown()).toEqual(["222 222"]);
  });

  it("keeps the desktop's pairing code QR code up front", async () => {
    await mount(<CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce />);
    expect(qrCodes()).toHaveLength(1);
  });

  it("keeps two relay QR codes on screen from replacing each other's code without end", async () => {
    await mount(<><RelayPairing /><RelayPairing /></>);
    for (let flush = 0; flush < 5; flush += 1) await act(async () => {});
    expect(requests.filter((path) => path === "/api/relay/offer").length).toBeLessThanOrEqual(3);
    expect(qrCodes()).toHaveLength(2);
    expect(renderer!.root.findAll((node) => node.type === "p" && text(node).includes("This code expired."))).toHaveLength(0);
  });

  it("takes the guide's relay QR code down once the relay tab's QR code has its code, and starts no code for it again", async () => {
    // the setup guide's relay QR code is up; then the relay tab's is shown beside it
    await mount(<RelayPairing />);
    await until(() => shown().join() === "482913" && offersOut === 0, "the guide's QR code with the pending code");
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing /><RelayPairing qrOnly /></SettingsProvider>); });
    await until(() => onlyTheRelayTabs() && offersAsked.length === 3, "the relay tab's QR code alone, with the PC's code");
    // the guide's asked once, before it; the relay tab's asked again as the guide's came down, and the PC kept its code
    expect([offersAsked, pending]).toEqual([[null, "1", "1"], "600002"]);
    expect(renderer!.root.findAll((node) => node.type === "p" && text(node).includes("This code expired."))).toHaveLength(1);
    expect(buttons().filter((label) => label === "New code")).toHaveLength(2);
  });

  it("leaves the relay tab's QR code up with the PC's code when the guide's relay QR code is shown after it", async () => {
    await mount(<RelayPairing qrOnly />);
    await until(onlyTheRelayTabs, "the relay tab's QR code with its code");
    const first = pending;
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing qrOnly /><RelayPairing /></SettingsProvider>); });
    // the guide's offer started a code, which ended the relay tab's; the relay tab's QR code asked for its own again
    await until(() => onlyTheRelayTabs() && offersAsked.length === 4, "the relay tab's QR code alone, with the code the PC has now");
    expect([offersAsked, pending === first]).toEqual([["1", null, "1", "1"], false]);
  });

  it("shows nothing for an offer answered after the relay tab's code took the QR code down; the relay tab's QR code asks for its code again", async () => {
    await mount(<RelayPairing />);
    await until(() => shown().join() === "482913" && offersOut === 0, "the guide's QR code with the pending code");
    // a code was started elsewhere on the PC. A second relay QR code comes up with it and says so, and the guide's asks
    // for its offer again, quietly: the PC answers, and that answer is slow to arrive
    pending = "246801";
    const arrive = gate(1);
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing /><RelayPairing /></SettingsProvider>); });
    await until(() => offersAsked.length === 3, "the guide's second offer reaching the PC");
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing /><RelayPairing /><RelayPairing qrOnly /></SettingsProvider>); });
    await until(() => onlyTheRelayTabs(1), "the relay tab's QR code alone, with its code");
    const before = offersAsked.length;
    await act(async () => { arrive(); });
    await until(() => offersAsked.length > before && offersOut === 0, "the relay tab's QR code asking for its code again");
    // the code that arrived late is one the relay tab's replaced: no QR code shows it, and the PC still has the relay tab's
    expect([offersAsked.slice(before), onlyTheRelayTabs(), shown().includes("246801")]).toEqual([["1"], true, false]);
  });

  it("has the relay tab's QR code ask again when the PC got another relay QR code's offer after its own and answered it late: the QR code left up shows the PC's code", async () => {
    await mount(<RelayPairing qrOnly />);
    await until(onlyTheRelayTabs, "the relay tab's QR code with its code");
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing qrOnly /><RelayPairing /></SettingsProvider>); });
    await until(() => onlyTheRelayTabs() && offersAsked.includes(null), "the relay tab's QR code alone again");
    // a third relay QR code comes up and says its code, then goes: the relay tab's asks for its own again, and the
    // guide's for its offer, quietly. The PC gets the relay tab's first and the guide's after it; both answers are slow
    const settled = offersAsked.length;
    const tabArrives = gate(1);
    const guideArrives = gate(0);
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing qrOnly /><RelayPairing /><RelayPairing /></SettingsProvider>); });
    await until(() => offersOut === 2, "the relay tab's and the guide's offers reaching the PC");
    expect([offersAsked.slice(settled), pendingOwn]).toEqual([[null, "1", null], false]);
    const guides = pending;
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing qrOnly /><RelayPairing /></SettingsProvider>); });
    await act(async () => { tabArrives(); });
    // the relay tab's QR code shows the code the PC started for it, which the guide's has ended since
    await until(() => offersOut === 1 && shown().length === 1 && shown()[0] !== guides, "the relay tab's QR code up alone, the guide's answer still on its way");
    const before = offersAsked.length;
    await act(async () => { guideArrives(); });
    await until(() => offersAsked.length > before, "the relay tab's QR code asking for its code again");
    await until(onlyTheRelayTabs, "the relay tab's QR code alone, with the code the PC has now");
    expect(shown().includes(guides)).toBe(false);
  });

  it("has the relay tab's QR code ask again when a relay QR code that shows a newer code comes down for it", async () => {
    await mount(<RelayPairing qrOnly />);
    await until(onlyTheRelayTabs, "the relay tab's QR code with its code");
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing qrOnly /><RelayPairing /></SettingsProvider>); });
    await until(() => onlyTheRelayTabs() && offersAsked.includes(null), "the relay tab's QR code alone again");
    // as above, but the guide's answer arrives at once and the relay tab's is slow: the guide's QR code shows the PC's
    // code when the relay tab's answer, with a code the PC has ended, takes it down
    const settled = offersAsked.length;
    const tabArrives = gate(1);
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing qrOnly /><RelayPairing /><RelayPairing /></SettingsProvider>); });
    await until(() => offersOut === 1 && shown().includes(pending), "the guide's QR code with the PC's code, the relay tab's answer still on its way");
    expect([offersAsked.slice(settled), pendingOwn]).toEqual([[null, "1", null], false]);
    const before = offersAsked.length;
    await act(async () => { tabArrives(); });
    await until(() => offersAsked.length > before, "the relay tab's QR code asking for its code again");
    await until(onlyTheRelayTabs, "the relay tab's QR code alone, with the code the PC has now");
  });

  it("has the relay tab's QR code ask again when another relay QR code's offer is answered after that QR code is gone", async () => {
    await mount(<RelayPairing qrOnly />);
    await until(onlyTheRelayTabs, "the relay tab's QR code with its code");
    const tabs = pending;
    // the guide's relay QR code comes up and asks for its offer: the PC starts a code for it, which ends the relay
    // tab's. The guide's is gone before the answer arrives, so no QR code is left to show that code or to say it
    const arrive = gate(0);
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing qrOnly /><RelayPairing /></SettingsProvider>); });
    await until(() => offersOut === 1, "the guide's offer reaching the PC");
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing qrOnly /></SettingsProvider>); });
    expect([shown(), pendingOwn]).toEqual([[tabs], false]);
    const before = offersAsked.length;
    await act(async () => { arrive(); });
    await until(() => offersAsked.length > before, "the relay tab's QR code asking for its code again");
    await until(onlyTheRelayTabs, "the relay tab's QR code alone, with the code the PC has now");
    expect([offersAsked.slice(before), pending === tabs]).toEqual([["1"], false]);
  });

  it("has the relay tab's QR code ask again when another relay QR code's first offer reaches the PC after the one it asked for in its place", async () => {
    // the guide's relay QR code asks for its offer, which is slow to reach the PC
    const reach = holdOnTheWay();
    await mount(<RelayPairing />);
    await until(() => offersSent() === 1, "the guide's offer asked for");
    // a second relay QR code comes up with the pending code and says so: the guide's asks for its offer again, quietly,
    // and shows that code without a word. Then the relay tab's QR code comes up, and both come down for its code
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing /><RelayPairing /></SettingsProvider>); });
    await until(() => shown().join() === "482913,482913", "both relay QR codes with the pending code");
    await act(async () => { renderer!.update(<SettingsProvider><RelayPairing /><RelayPairing /><RelayPairing qrOnly /></SettingsProvider>); });
    await until(() => onlyTheRelayTabs() && offersAsked.length === 4, "the relay tab's QR code alone, with its code");
    const tabs = pending;
    // the PC gets the guide's first offer only now: its code ends the relay tab's, and no QR code waits for the answer
    await act(async () => { reach(); });
    await until(() => offersAsked.length > 4, "the guide's first offer reaching the PC");
    await until(onlyTheRelayTabs, "the relay tab's QR code alone, with the code the PC has now");
    expect([offersAsked, pending === tabs]).toEqual([[null, null, "1", "1", null, "1"], false]);
  });

  it("asks for nothing on an answer of the relay tab's own offer that its QR code has asked for again since", async () => {
    // the relay tab's QR code asks for its offer, and again when Phones and devices starts a code: both answers are slow
    const first = gate(0);
    const second = gate(0);
    await mount(<RelayPairing qrOnly />);
    await until(() => offersOut === 1, "the relay tab's offer reaching the PC");
    pending = "246801";
    pendingOwn = false;
    await act(async () => { announcePairingCode({ code: pending, expires_at: new Date(Date.now() + 600_000).toISOString() }); });
    await until(() => offersOut === 2, "the relay tab's second offer reaching the PC");
    await act(async () => { first(); });
    await act(async () => { second(); });
    await until(onlyTheRelayTabs, "the relay tab's QR code with the code the PC has");
    expect(offersAsked).toEqual(["1", "1"]);
  });

  it("a code to type starts a new six-digit code, and the pairing code shown beside it follows", async () => {
    await mount(<><RelayPairing /><CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce={false} /></>);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    const shown = () => renderer!.root.findAll((node) => node.type === "p" && typeof node.props.className === "string" && node.props.className.includes("devices-code")).map(text);
    expect(shown()).toEqual(["482 913"]);
    await act(async () => { await button("Show a code to type").props.onClick(); });
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(shown()).toEqual(["777 111"]);
  });

  it("never shows as digits the code of a QR code shown alone, and drops the code it showed, which that one replaced", async () => {
    await mount(<CodeRoute pairUrl="https://workstation.example.ts.net" startAtOnce />);
    const shown = () => renderer!.root.findAll((node) => node.type === "p" && typeof node.props.className === "string" && node.props.className.includes("devices-code")).map(text);
    expect(shown()).toEqual(["482 913"]);
    const expires_at = new Date(Date.now() + 600_000).toISOString();
    await act(async () => { announcePairingCode({ code: "135790", expires_at, qrOnly: true }); });
    expect(shown()).toEqual([]);
    expect(qrCodes()).toHaveLength(0);
    await act(async () => { announcePairingCode({ code: "246801", expires_at }); });
    expect(shown()).toEqual(["246 801"]);
  });

  it("pairs this phone through the relay in one tap: its own offer opens in this browser", async () => {
    await mount(<RelayRoute relay={relayState()} readOnly={false} phone pairHere />);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toContain("Copy link");
    const offers = () => requests.filter((path) => path === "/api/relay/offer").length;
    const before = offers();
    await act(async () => { await button("Use the relay on this phone").props.onClick(); });
    expect(offers()).toBe(before + 1);
    expect(assigned).toEqual([OFFER_URL]);
    await act(async () => { button("Show QR code").props.onClick(); });
    expect(qrCodes()).toHaveLength(1);
  });

  it("opens its own offer as a PC of the app inside the native app", async () => {
    const calls: unknown[][] = [];
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: {
      isNativePlatform: () => true,
      PluginHeaders: [{ name: "HerdrShell" }],
      nativePromise: async (...args: unknown[]) => { calls.push(args); },
    } });
    await mount(<RelayRoute relay={relayState()} readOnly={false} phone pairHere />);
    await act(async () => { await button("Use the relay on this phone").props.onClick(); });
    expect(calls).toEqual([["HerdrShell", "open", { url: OFFER_URL, scope: `${APP}/s/${SERVER_ID}/`, name: "Workstation" }]]);
    expect(assigned).toEqual([]);
  });

  it("only hints at a relay device with this phone's name, and still offers the relay", async () => {
    await mount(<RelayRoute relay={relayState()} readOnly={false} phone pairHere sameName="iPhone · Safari" />);
    const hints = renderer!.root.findAll((node) => node.type === "p" && node.props.className === "settings-hint").map(text);
    expect(hints.filter((hint) => hint.includes("iPhone · Safari"))).toHaveLength(1);
    expect(buttons()).toContain("Use the relay on this phone");
  });

  it("does not pair a PC whose window is only as narrow as a phone", async () => {
    await mount(<RelayRoute relay={relayState()} readOnly={false} phone />);
    expect(buttons()).not.toContain("Use the relay on this phone");
    expect(qrCodes()).toHaveLength(0);
  });

  it("offers only the ways this window can use: SSH where PCs are added from, the relay to its owner on a direct page", () => {
    const off = relayState({ ...ONLINE, phase: "off" });
    expect(connectTabs({ sshOffered: true, relay: off, readOnly: false })).toEqual(["ssh", "devices", "relay"]);
    expect(connectTabs({ sshOffered: false, relay: relayState(), readOnly: false })).toEqual(["devices", "relay"]);
    expect(connectTabs({ sshOffered: true, relay: { ...off, unsupported: true }, readOnly: false })).toEqual(["ssh", "devices"]);
    // a watching device or a Portal visitor cannot use the relay, and the hosted shell already is on it
    expect(connectTabs({ sshOffered: false, relay: relayState(), readOnly: true })).toEqual(["devices"]);
    shellMeta = true;
    expect(connectTabs({ sshOffered: false, relay: relayState(), readOnly: false })).toEqual(["devices"]);
  });

  it("opens on the relay tab for a waiting notice only where that tab can show it: a page with the Ovis account", () => {
    const all = ["ssh", "devices", "relay"] as const;
    expect(openingTab({ tabs: all, phone: false, noticeWaiting: true, hasAccount: true })).toBe("relay");
    expect(openingTab({ tabs: all, phone: false, noticeWaiting: true, hasAccount: false })).toBe("ssh");
    expect(openingTab({ tabs: all, phone: true, noticeWaiting: true, hasAccount: false })).toBe("devices");
    expect(openingTab({ tabs: ["ssh", "devices"], phone: false, noticeWaiting: true, hasAccount: true })).toBe("ssh");
    expect(openingTab({ tabs: all, phone: true, noticeWaiting: false, hasAccount: true })).toBe("devices");
  });

  it("lists the PCs found over SSH: Add opens Add PC with that address, an added one says so, a herdr PC connects", async () => {
    const added: (AddPcPreset | undefined)[] = [];
    const connected: string[] = [];
    const ssh = (destination: string, extra: Partial<Machine> = {}): Machine => ({ id: destination, name: destination, kind: "ssh", target: { destination }, enabled: true, state: "disconnected", error: null, snapshot: null, ...extra });
    const machines = [ssh("winvm.tail.ts.net", { state: "connected" }), ssh("build-box", { herdr_profile_id: "p1", action_required: "connect" })];
    await mount(<SshTab machines={machines} onAddPc={(preset) => { added.push(preset); }} onConnectMachine={(machine) => { connected.push(machine.id); }} />);
    expect(requests).toContain("/api/machines/ssh-candidates");
    expect(buttons()).toEqual(["Connect", "Add", "Add"]);
    expect(text(renderer!.root).includes("Added")).toBe(true);
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Add nuc12" }).props.onClick(); });
    expect(added).toEqual([{ destination: "nuc12", name: "nuc12" }]);
    await act(async () => { button("Connect").props.onClick(); });
    expect(connected).toEqual(["build-box"]);
  });

  it("says where the list can be seen when the server keeps it from this window", async () => {
    // the server's own words for the refusal (server/dispatch.ts): no instruction to type an address, which an open LAN
    // window could not add either
    const hint = "See the PCs this PC knows on this PC itself, or from a device paired with it directly.";
    const added: (AddPcPreset | undefined)[] = [];
    // an open LAN window: the one window that shows the SSH tab and is refused the list (the relay shell and a Portal
    // visitor, read only, show no SSH tab)
    candidatesRefused = "owner_only";
    await mount(<SshTab machines={[]} onAddPc={(preset) => { added.push(preset); }} onConnectMachine={() => {}} />);
    expect(requests).toContain("/api/machines/ssh-candidates");
    expect(text(renderer!.root)).toContain(hint);
    expect(buttons()).toEqual(["Add"]);
    await act(async () => { renderer!.root.findByProps({ id: "connect-ssh-address" }).props.onChange({ target: { value: "mymac" } }); });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(added).toEqual([{ destination: "mymac" }]);
    await act(async () => { renderer!.unmount(); });
    // a watching device adds no PC: it is not told to type one
    candidatesRefused = "read_only";
    await mount(<SshTab machines={[]} onAddPc={() => {}} onConnectMachine={() => {}} />);
    expect(text(renderer!.root)).not.toContain(hint);
    expect(buttons()).toEqual(["Add"]);
    await act(async () => { renderer!.unmount(); });
    candidatesRefused = null;
    await mount(<SshTab machines={[]} onAddPc={() => {}} onConnectMachine={() => {}} />);
    expect(text(renderer!.root)).not.toContain(hint);
  });

  it("without the Ovis account here, the relay tab keeps the relay's own pairing: its switch, QR code and code to type", async () => {
    const tab = (relay: RelayState) => <RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} account={null} phone={false} />;
    await mount(tab(relayState()));
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findAllByProps({ label: "Ovis relay", checked: true })).toHaveLength(1);
    expect(qrCodes()).toHaveLength(1);
    expect(text(renderer!.root)).toContain("7K3QD-M2XHA");
    expect(buttons()).not.toContain("Sign in to Ovis");
    await act(async () => { renderer!.update(<SettingsProvider>{tab(relayState({ ...ONLINE, phase: "off" }))}</SettingsProvider>); });
    expect(renderer!.root.findAllByProps({ label: "Ovis relay", checked: false })).toHaveLength(1);
  });

  it("holds a Tailscale PC's Add until its Ovis is known, so an older one is not added meanwhile", async () => {
    let answer = () => undefined as void;
    tailnetAnswer = new Promise((resolve) => { answer = resolve; });
    tailnetOutdated = false;
    await mount(<SshTab machines={[]} onAddPc={() => undefined} onConnectMachine={() => undefined} />);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findByProps({ "aria-label": "Add winvm" }).props.disabled).toBe(true);
    expect(renderer!.root.findByProps({ "aria-label": "Add nuc12" }).props.disabled).toBe(false);
    await act(async () => { answer(); });
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findByProps({ "aria-label": "Add winvm" }).props.disabled).toBe(false);
  });

  it("tells an ssh config host that is an older-Ovis Tailscale PC to update it there too", async () => {
    extraCandidates = [{ name: "lab", destination: "lab", detail: "rise@winvm.tail.ts.net", source: "ssh_config", tailnet: "winvm.tail.ts.net" }];
    await mount(<SshTab machines={[]} onAddPc={() => undefined} onConnectMachine={() => undefined} />);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findAllByProps({ "aria-label": "Add lab" })).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.type === "span" && text(node) === "Update Ovis on that PC to 0.5 first.")).toHaveLength(2);
  });

  it("tells a Tailscale PC with an older Ovis to update it there, in one line, instead of offering Add", async () => {
    await mount(<SshTab machines={[]} onAddPc={() => undefined} onConnectMachine={() => undefined} />);
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
    expect(renderer!.root.findAllByProps({ "aria-label": "Add winvm" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "aria-label": "Add nuc12" })).toHaveLength(1);
    expect(text(renderer!.root)).toContain("Update Ovis on that PC to 0.5 first.");
  });

  it("keeps the desktop's relay QR code up front, with no self-pairing", async () => {
    await mount(<RelayRoute relay={relayState()} readOnly={false} />);
    expect(qrCodes()).toHaveLength(1);
    expect(buttons()).not.toContain("Use the relay on this phone");
  });
});

describe("sameNameRelayDevice", () => {
  const device = (extra: Partial<PairedDevice>): PairedDevice => ({ id: "a", label: "iPhone · Safari", role: "drive", created_at: "2026-10-01T00:00:00Z", last_seen_at: null, current: false, ...extra });
  it("names a relay device under this phone's label, never this session's own or a direct one", () => {
    expect(sameNameRelayDevice([device({ via_relay: true })], "iPhone · Safari")).toBe("iPhone · Safari");
    expect(sameNameRelayDevice([device({})], "iPhone · Safari")).toBeNull();
    expect(sameNameRelayDevice([device({ via_relay: true, current: true })], "iPhone · Safari")).toBeNull();
    expect(sameNameRelayDevice([device({ via_relay: true, label: "Pixel 9" })], "iPhone · Safari")).toBeNull();
  });
});

// The relay tab where the page has an Ovis account: the relay's QR code behind a press. A signed-in device that scans
// it puts a PC in no account into its own, so nothing is minted before the press, the code is ended when the QR code
// comes down, and the tab then says which account the PC joined and by which device (docs/account.md, "Adding a PC").
describe("the relay tab's QR code behind a press", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const ACCOUNT_ID = "acct_0123456789abcdefgh";
  const SERVICE = { service: "https://account.ovis.example", onOpen: () => undefined, onSignedIn: () => undefined };
  let renderer: ReactTestRenderer | undefined;
  let requests: string[];
  let ended: unknown[];
  let pcAccount: string | null;
  let devices: PairedDevice[];
  let codePending: boolean;
  let hidden: boolean;
  let visibility: EventTarget;
  let held: boolean[];
  let revokedAll: number;
  let keptAlive: string[];
  let endsPairings: boolean;
  let statusGate: Promise<void>;
  let removed: string[];
  let removable: boolean;
  let offerMarks: (string | null)[];
  let offerAnswer: (() => Response | Promise<Response>) | null;
  // the account the PC says it made the relay tab's code for, in the offer's own answer (absent: an older server)
  let offerAccount: string | null | undefined;
  /** "refused": the account service refuses to list this PC (PUT /v1/pcs/:id); "silent": it never answers its list */
  let listing: "ok" | "refused" | "silent";

  const device = (extra: Partial<PairedDevice>): PairedDevice => ({ id: "a", label: "Laptop · Chrome", role: "drive", created_at: "2026-10-01T00:00:00Z", last_seen_at: null, current: false, ...extra });
  const phoneDevice = (extra: Partial<PairedDevice> = {}) => device({ id: "b", label: "iPhone · Safari", created_at: "2026-11-10T00:00:00Z", via_relay: true, ...extra });

  beforeEach(() => {
    jest.useFakeTimers();
    requests = [];
    ended = [];
    pcAccount = null;
    devices = [device({})];
    codePending = true;
    hidden = false;
    visibility = new EventTarget();
    held = [];
    revokedAll = 0;
    keptAlive = [];
    endsPairings = true;
    statusGate = Promise.resolve();
    removed = [];
    removable = true;
    offerMarks = [];
    offerAnswer = null;
    offerAccount = undefined;
    listing = "ok";
    for (const key of ["window", "document", "navigator", "indexedDB", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    // the page's own sign-in, which a signed-in tab lists this PC under before its QR code
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fakeIndexedDB().factory });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      isSecureContext: true,
      location: { href: "https://workstation.example.ts.net/" },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      activeElement: null,
      get hidden() { return hidden; },
      addEventListener: visibility.addEventListener.bind(visibility),
      removeEventListener: visibility.removeEventListener.bind(visibility),
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "https://workstation.example.ts.net").pathname;
      requests.push(path);
      if (init?.keepalive === true) keptAlive.push(path);
      const expires_at = new Date(Date.now() + 600_000).toISOString();
      if (path === "/api/account/status") await statusGate;
      if (path === "/api/account/status") return Response.json({ account: pcAccount, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay") return Response.json(ONLINE);
      if (path === "/api/devices") return Response.json({ devices });
      if (path.startsWith("/api/devices/") && init?.method === "DELETE") {
        if (!removable) return Response.json({ error: { code: "busy", message: "not now" } }, { status: 500 });
        const id = decodeURIComponent(path.slice("/api/devices/".length));
        if (!devices.some((entry) => entry.id === id)) return Response.json({ error: { code: "not_found", message: "no such device" } }, { status: 404 });
        removed.push(id);
        devices = devices.filter((entry) => entry.id !== id);
        return new Response(null, { status: 204 });
      }
      if (path === "/api/relay/code") return Response.json({ code: "7K3QD-M2XHA", expires_at, server_id: SERVER_ID });
      if (path === "/api/relay/offer") {
        offerMarks.push(new Headers(input instanceof Request ? input.headers : init?.headers).get("x-ovis-no-account-only"));
        return offerAnswer?.() ?? Response.json({ url: OFFER_URL, expires_at, ...(offerAccount === undefined ? {} : { account: offerAccount }) });
      }
      if (path === "/api/relay/code/cancel") return Response.json({ ok: true });
      if (path === "/api/devices/pair/cancel" && endsPairings) {
        ended.push(JSON.parse(String(init?.body)));
        const cancelled = codePending;
        codePending = false;
        return Response.json({ ok: true, cancelled });
      }
      if (path === "/api/devices/revoke-all") { devices = []; pcAccount = null; return Response.json({ revoked: 2 }); }
      if (path === "/v1/pcs") return listing === "silent" ? new Promise<Response>(() => {}) : Response.json({ pcs: [] });
      if (path === `/v1/pcs/${SERVER_ID}` && init?.method === "PUT") return listing === "ok" ? Response.json({}) : Response.json({ error: { code: "unavailable" } }, { status: 503 });
      return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
    return indexedAccountStore.set("session", { service: SERVICE.service, account: ACCOUNT_ID, provider: "github", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 365 * 86_400_000 });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    resetAccountQrWatch();
    mock.restore();
    jest.useRealTimers();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  interface TabOptions { signedIn?: boolean; accountId?: string | null; joinBySignIn?: boolean; relay?: RelayState; active?: boolean }
  const tab = ({ signedIn = true, accountId = signedIn ? ACCOUNT_ID : null, joinBySignIn = false, relay = relayState(), active = true }: TabOptions = {}) => (
    <SettingsProvider>
      <RelayTab relay={relay} closesGate={false} signedIn={signedIn} accountId={accountId} joinBySignIn={joinBySignIn} account={SERVICE} phone={false} active={active}
        onPairingHeld={(next) => { held.push(next); }} onRevokedAll={() => { revokedAll += 1; }} />
    </SettingsProvider>
  );
  const flush = async () => { for (let round = 0; round < 6; round += 1) await act(async () => {}); };
  const mount = async (options?: TabOptions) => {
    await act(async () => { renderer = create(tab(options), { createNodeMock: () => ({ closest: () => null, querySelector: () => null, querySelectorAll: () => [], focus() {}, contains: () => false, addEventListener() {}, removeEventListener() {} }) }); });
    await flush();
  };
  const update = async (options?: TabOptions) => { await act(async () => { renderer!.update(tab(options)); }); await flush(); };
  const advance = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); await flush(); };
  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const section = () => renderer!.root.findByProps({ "data-testid": "connect-account-qr" });
  const buttons = () => section().findAll((node) => node.type === "button").map((node) => text(node).trim());
  const press = async (label: string) => {
    const found = section().findAll((node) => node.type === "button" && text(node).trim() === label);
    expect(found.map(text)).toEqual([label]);
    await act(async () => { found[0]!.props.onClick(); });
    await flush();
  };
  const qrCodes = () => renderer!.root.findAllByType(QrCode);
  const minted = () => requests.filter((path) => path === "/api/relay/code" || path === "/api/relay/offer" || path === "/api/devices/pair/start");
  const count = (path: string) => requests.filter((request) => request === path).length;

  for (const [name, options] of [
    ["signed out", { signedIn: false }],
    ["signed in, with the PC in no account", { signedIn: true }],
  ] as const) {
    it(`${name}: asks for no code or offer before the press, and draws the QR code after it`, async () => {
      await mount(options);
      expect(text(section())).toContain("Add with a QR code");
      expect(text(section())).toContain("this PC joins that account, with no number to type");
      expect(buttons()).toEqual(["Show the QR code"]);
      expect(qrCodes()).toHaveLength(0);
      expect(minted()).toEqual([]);
      await press("Show the QR code");
      // the QR code alone: no code to type is made, so nothing here can be read off the screen and typed elsewhere
      expect(minted()).toEqual(["/api/relay/offer"]);
      // and the PC is told what the code is for, so it makes none once it is in an account
      expect(offerMarks).toEqual(["1"]);
      expect(qrCodes()).toHaveLength(1);
      expect(text(section())).not.toContain("7K3QD-M2XHA");
      expect(section().findAll((node) => node.props["aria-label"] === "Code to type")).toHaveLength(0);
      expect(buttons()).toEqual(["New code"]);
    });
  }

  // a signed-in tab lists this PC in the account it shows, as `ovis add` does. Its QR code is
  // a plain code (no mark), so the listing runs beside the code and never holds it up; the PC's relay key comes
  // from the QR code's own offer, so no pairing window of the PC (another flow may hold it) is opened or closed for it
  it("signed in, lists this PC in the account the tab shows from the QR code's offer, and touches no pairing window", async () => {
    offerAccount = ACCOUNT_ID;
    await mount({ signedIn: true });
    await press("Show the QR code");
    expect(qrCodes()).toHaveLength(1);
    expect(requests.indexOf(`/v1/pcs/${SERVER_ID}`)).toBeGreaterThan(requests.indexOf("/api/relay/offer"));
    expect(requests.filter((path) => path.startsWith("/api/relay/link"))).toEqual([]);
  });

  // the PC made its code for another account (it was named for another one by the time the offer was asked for), or
  // its server does not say which: no tab lists it in the account it shows
  for (const [what, account] of [
    ["that made its code for another account", "acct_other_000000000000"],
    ["that names no account in its offer", null],
    ["on a server that does not say which account its code is for", undefined],
  ] as const) {
    it(`signed in, lists nothing beside the QR code of a PC ${what}`, async () => {
      offerAccount = account;
      await mount({ signedIn: true });
      await press("Show the QR code");
      expect(qrCodes()).toHaveLength(1);
      expect(requests).not.toContain(`/v1/pcs/${SERVER_ID}`);
    });
  }

  // the tab's last read of the relay said the PC was named for this account; the PC was named for another one before it
  // made the code, and its offer says so: nothing is listed
  it("signed in, lists nothing when the PC was named for another account between the tab's last read and the offer", async () => {
    offerAccount = "acct_other_000000000000";
    // the relay state the tab read last named this tab's account (a server that still says which, as one briefly did)
    const stale = { ...ONLINE, account_named: true, named_account: ACCOUNT_ID } as RelayStatus;
    await mount({ signedIn: true, relay: relayState(stale) });
    await press("Show the QR code");
    expect(qrCodes()).toHaveLength(1);
    expect(requests).not.toContain(`/v1/pcs/${SERVER_ID}`);
  });

  // the account is fixed at the press: another tab that switches accounts before the offer
  // comes makes the tab list nothing, not the PC in the account it shows by then
  it("signed in, lists nothing when the account changed between the press and the QR code's offer", async () => {
    const other = "acct_other_000000000000";
    const offerGate = Promise.withResolvers<void>();
    offerAnswer = async () => { await offerGate.promise; return Response.json({ url: OFFER_URL, expires_at: new Date(Date.now() + 600_000).toISOString(), account: ACCOUNT_ID }); };
    await mount({ signedIn: true });
    await press("Show the QR code");
    await indexedAccountStore.set("session", { service: SERVICE.service, account: other, provider: "github", access_token: "other", refresh_token: "other", expires_at: Date.now() + 86_400_000 });
    await update({ signedIn: true, accountId: other });
    offerGate.resolve();
    await flush();
    expect(qrCodes()).toHaveLength(1);
    expect(requests).not.toContain(`/v1/pcs/${SERVER_ID}`);
  });

  for (const [what, setup] of [
    ["the account service refuses the listing", () => { listing = "refused"; }],
    ["the account service never answers", () => { listing = "silent"; }],
    ["another tab stored another account's sign-in since the tab was drawn", () => indexedAccountStore.set("session", { service: SERVICE.service, account: "acct_other_000000000000", provider: "github", access_token: "other", refresh_token: "other", expires_at: Date.now() + 86_400_000 })],
  ] as const) {
    it(`signed in, shows the QR code all the same when ${what}`, async () => {
      await setup();
      offerAccount = ACCOUNT_ID;
      await mount({ signedIn: true });
      await press("Show the QR code");
      expect(qrCodes()).toHaveLength(1);
      expect(ended).toEqual([]);
      expect(section().findAllByProps({ role: "alert" })).toHaveLength(0);
      // nothing is written to an account the tab did not show
      if (what.startsWith("another")) expect(requests).not.toContain(`/v1/pcs/${SERVER_ID}`);
    });
  }

  // the owner's decision (2026-11-11): a PC that is in an account shows no QR code and has no code made for one
  for (const [name, options, whose, heading] of [
    ["this browser signed in to the PC's account", { signedIn: true, joinBySignIn: true }, "mine", "This PC is in your Ovis account (acct_0123456)."],
    ["this browser signed in to another account", { signedIn: true, accountId: "acct_mine_0000000000000" }, "other", "This PC is in another Ovis account (acct_0123456), not the one this browser is signed in to (acct_mine_00)."],
    ["this browser signed out", { signedIn: false }, "unknown", "This PC is in an Ovis account (acct_0123456)."],
  ] as const) {
    it(`on a PC already in an account, ${name}: no QR code, no button and no code asked of the PC, and how a device is added instead`, async () => {
      pcAccount = ACCOUNT_ID;
      await mount(options);
      expect(section().props["data-account"]).toBe(whose);
      expect(text(section())).toContain(heading);
      expect(text(section())).toContain("To add a device, sign in to this PC's account on it and open this PC there.");
      expect(text(section())).toContain("This PC shows a QR code only while it is in no account.");
      expect(text(section()).includes("This browser is not signed in, so it cannot tell whether that account is yours")).toBe(whose === "unknown");
      expect(text(section()).includes("If that account is not yours, revoke every device (More settings → Devices and access)")).toBe(whose === "other");
      expect(text(section())).not.toContain("Add with a QR code");
      expect(text(renderer!.root)).not.toContain("On the new device, sign in to the same Ovis account.");
      expect(buttons()).toEqual([]);
      expect(qrCodes()).toHaveLength(0);
      expect(held.at(-1)).toBe(false);
      await advance(ACCOUNT_QR_POLL_MS * 4);
      expect(minted()).toEqual([]);
    });
  }

  it("on a PC already in an account whose relay is off, signed out, still shows the relay's switch under how a device is added", async () => {
    pcAccount = ACCOUNT_ID;
    await mount({ signedIn: false, relay: relayState({ ...ONLINE, phase: "off" }) });
    expect(text(section())).toContain("This PC is in an Ovis account (acct_0123456).");
    expect(section().findAllByProps({ label: "Ovis relay", checked: false })).toHaveLength(1);
    expect(buttons()).toEqual([""]);
    expect(text(section())).not.toContain("this PC can show its QR code");
  });

  it("signed in on a PC already in an account, shows the relay's switch while it is not online, and never says to add this PC", async () => {
    pcAccount = ACCOUNT_ID;
    await mount({ signedIn: true, relay: relayState({ ...ONLINE, phase: "off" }) });
    expect(renderer!.root.findAllByProps({ label: "Ovis relay", checked: false })).toHaveLength(1);
    expect(text(renderer!.root)).not.toContain("add this PC to your account");
    expect(renderer!.root.findAll((node) => node.type === "button" && text(node) === "Open the account")).toHaveLength(0);
    expect(section().props["data-first"]).toBeUndefined();
    await update({ signedIn: true, joinBySignIn: true });
    expect(renderer!.root.findAllByProps({ label: "Ovis relay" })).toHaveLength(0);
    expect(section().props["data-first"]).toBe(true);
  });

  it("a press on a PC that joined an account since the tab was drawn asks for no code, and says how a device is added", async () => {
    await mount();
    expect(buttons()).toEqual(["Show the QR code"]);
    devices = [device({ account: ACCOUNT_ID, via_relay: true })];
    pcAccount = ACCOUNT_ID;
    await press("Show the QR code");
    expect(minted()).toEqual([]);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual([]);
    expect(text(section())).toContain("This PC is in your Ovis account (acct_0123456).");
    expect(section().findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(held.at(-1)).toBe(false);
  });

  it("takes the QR code away at once when the PC refuses its code for having joined an account, and says which account", async () => {
    await mount();
    offerAnswer = () => {
      devices = [device({ account: ACCOUNT_ID, via_relay: true })];
      pcAccount = ACCOUNT_ID;
      return Response.json({ error: { code: "in_account", message: "This PC is already in an Ovis account. Sign in to that account on the device to add it." } }, { status: 409 });
    };
    await press("Show the QR code");
    await flush();
    expect(qrCodes()).toHaveLength(0);
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(text(notice)).toContain("This PC is in your account (acct_0123456).");
    expect(text(notice)).toContain("Added by Laptop · Chrome.");
    expect(count("/api/relay/offer")).toBe(1);
    expect(section().findAllByProps({ role: "alert" })).toHaveLength(0);
    // it had no code: a typed code another place shows on the PC is left alone
    expect(count("/api/relay/code/cancel")).toBe(0);
    await press("Done");
    expect(buttons()).toEqual([]);
    expect(text(section())).toContain("This PC is in your Ovis account (acct_0123456).");
  });

  it("when the PC joins an account another way while the QR code is up, the QR code leaves, its code is ended, and none is offered again", async () => {
    await mount();
    await press("Show the QR code");
    devices = [device({ account: ACCOUNT_ID, via_relay: true })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    expect(qrCodes()).toHaveLength(0);
    expect(ended).toEqual([{ code: "482913" }]);
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }))).toContain("Added by Laptop · Chrome.");
    await press("Done");
    expect(buttons()).toEqual([]);
    expect(text(section())).toContain("This PC is in your Ovis account (acct_0123456).");
    const before = minted().length;
    await advance(ACCOUNT_QR_MAX_MS);
    expect(minted()).toHaveLength(before);
  });

  it("New code ends the code the QR code showed and asks for another the same way, never for a code to type", async () => {
    await mount();
    await press("Show the QR code");
    await press("New code");
    expect(ended).toEqual([{ code: "482913" }]);
    expect(minted()).toEqual(["/api/relay/offer", "/api/relay/offer"]);
    expect(offerMarks).toEqual(["1", "1"]);
    expect(qrCodes()).toHaveLength(1);
  });

  it("when New code cannot end the old code, says that it may still work and that New code tries again", async () => {
    await mount();
    await press("Show the QR code");
    endsPairings = false;
    await press("New code");
    expect(qrCodes()).toHaveLength(0);
    expect(text(section().findByProps({ role: "alert" }))).toMatch(/^The old code could not be ended, so it may still work until it runs out: .+ New code tries again\.$/);
    endsPairings = true;
    await press("New code");
    expect(ended).toEqual([{ code: "482913" }]);
    expect(qrCodes()).toHaveLength(1);
  });

  it("asks for a new code when another window of this browser ended the one it shows, and only then", async () => {
    await mount();
    await press("Show the QR code");
    const offers = count("/api/relay/offer");
    const tell = async (code: string) => {
      const heard = new BroadcastChannel(QR_CODE_ENDED_CHANNEL);
      const delivered = new Promise<void>((resolve) => { heard.onmessage = () => resolve(); });
      const other = new BroadcastChannel(QR_CODE_ENDED_CHANNEL);
      other.postMessage(code);
      await act(async () => { await delivered; });
      heard.close();
      other.close();
      await flush();
    };
    await tell("111111");
    expect(count("/api/relay/offer")).toBe(offers);
    await tell("482913");
    expect(count("/api/relay/offer")).toBe(offers + 1);
    expect(offerMarks.at(-1)).toBe("1");
    expect(qrCodes()).toHaveLength(1);
  });

  it("with the relay off, shows the relay's switch and no button; signed in, the switch above is the only one", async () => {
    const off = relayState({ ...ONLINE, phase: "off" });
    await mount({ signedIn: false, relay: off });
    expect(section().findAllByProps({ label: "Ovis relay", checked: false })).toHaveLength(1);
    expect(buttons()).not.toContain("Show the QR code");
    expect(text(section())).toContain("Off. Nothing goes through the relay.");
    await update({ signedIn: true, relay: off });
    expect(renderer!.root.findAllByProps({ label: "Ovis relay", checked: false })).toHaveLength(1);
    expect(section().findAllByProps({ label: "Ovis relay" })).toHaveLength(0);
    expect(buttons()).not.toContain("Show the QR code");
    expect(minted()).toEqual([]);
  });

  it("signed out on a relay that refused this PC for its pass, says to sign in first", async () => {
    const refused = relayState({ ...ONLINE, phase: "error", error: "pass", pass: { state: "no_account", relay: "missing", enforce_at: null, refused: true } });
    await mount({ signedIn: false, relay: refused });
    expect(text(section())).toContain("Sign in above first; then this PC can show its QR code.");
    expect(buttons()).not.toContain("Show the QR code");
  });

  it("signed out on a PC that no account was named for, says to sign in first and asks the PC for no code; once one is named, the press draws the QR code", async () => {
    // while the relay is off the part says so, as on any PC
    await mount({ signedIn: false, relay: relayState({ ...ONLINE, phase: "off", account_named: false }) });
    expect(text(section())).toContain("Off. Nothing goes through the relay.");
    expect(text(section())).not.toContain("this PC can show its QR code");
    await update({ signedIn: false, relay: relayState({ ...ONLINE, account_named: false }) });
    expect(text(section())).toContain("Sign in above first; then this PC can show its QR code.");
    expect(buttons()).toEqual([]);
    await advance(ACCOUNT_QR_POLL_MS * 4);
    expect(minted()).toEqual([]);
    // the PC says an account was named for it: its owner added it to an account, or ran `ovis add`
    await update({ signedIn: false, relay: relayState({ ...ONLINE, account_named: true }) });
    expect(text(section())).not.toContain("this PC can show its QR code");
    expect(buttons()).toEqual(["Show the QR code"]);
    await press("Show the QR code");
    expect(offerMarks).toEqual(["1"]);
    expect(qrCodes()).toHaveLength(1);
  });

  it("signed in on a PC that no account was named for, says to add the PC to the account first, with no button and no code asked of the PC", async () => {
    await mount({ signedIn: true, relay: relayState({ ...ONLINE, account_named: false }) });
    expect(text(section())).toContain("Add this PC to your account first; then it can show its QR code.");
    expect(text(section())).not.toContain("Sign in above first");
    expect(buttons()).toEqual([]);
    await advance(ACCOUNT_QR_POLL_MS * 4);
    expect(minted()).toEqual([]);
  });

  it("when the PC refuses the press because no account is named for it, takes the QR code down with no failure and reads the relay's state again, which brings the sentence", async () => {
    let rereads = 0;
    // the page's relay state is up to 15 seconds old: it says an account is named, and none is
    const stale: RelayState = { ...relayState({ ...ONLINE, account_named: true }), reread: () => { rereads += 1; } };
    await mount({ relay: stale });
    offerAnswer = () => Response.json({ error: { code: "no_account_named", message: "This PC is not set up for an Ovis account yet." } }, { status: 409 });
    await press("Show the QR code");
    await flush();
    expect(qrCodes()).toHaveLength(0);
    // no refusal to read, and no New code, which the PC would refuse again
    expect(section().findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(buttons()).not.toContain("New code");
    expect([count("/api/relay/offer"), rereads]).toEqual([1, 1]);
    // the relay's state, read again, says no account is named: the sentence takes the button's place
    await update({ relay: relayState({ ...ONLINE, account_named: false }) });
    expect(text(section())).toContain("Add this PC to your account first; then it can show its QR code.");
    expect(buttons()).toEqual([]);
  });

  it("while a device that paired with the code as it ran out may still link, shows no failure and asks for the next code once the wait the PC named is over", async () => {
    await mount();
    let answers = 0;
    offerAnswer = () => ++answers === 1
      ? Response.json({ error: { code: "pairing_finishing", message: "A device that paired with this PC's code is still linking." } }, { status: 409, headers: { "retry-after": "20" } })
      : Response.json({ url: OFFER_URL, expires_at: new Date(Date.now() + 600_000).toISOString() });
    await press("Show the QR code");
    await flush();
    expect(qrCodes()).toHaveLength(0);
    expect(section().findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(count("/api/relay/offer")).toBe(1);
    await advance(19_000);
    expect(count("/api/relay/offer")).toBe(1);
    await advance(1_000);
    expect(count("/api/relay/offer")).toBe(2);
    expect(qrCodes()).toHaveLength(1);
  });

  it("the relay's state is read again when asked, without waiting for the poll's next round", async () => {
    let relay: RelayState | undefined;
    const Probe = () => { relay = useRelay(); return null; };
    await act(async () => { renderer = create(<Probe />); });
    await flush();
    expect([count("/api/relay"), relay?.status?.phase]).toEqual([1, "online"]);
    // the poll's next round is a quarter of a minute off, and no clock moves here
    await act(async () => { relay!.reread(); });
    await flush();
    expect(count("/api/relay")).toBe(2);
  });

  it("takes the QR code down 30 minutes after the press and ends its code, leaving Show a new code", async () => {
    await mount();
    await press("Show the QR code");
    await advance(ACCOUNT_QR_MAX_MS - 1000);
    expect(qrCodes()).toHaveLength(1);
    expect(ended).toEqual([]);
    await advance(1000);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
    expect(count("/api/relay/code/cancel")).toBe(0);
    expect(ended).toEqual([{ code: "482913" }]);
    expect(count("/api/relay/code")).toBe(0);
    const before = minted().length;
    await advance(ACCOUNT_QR_MAX_MS);
    expect(minted()).toHaveLength(before);
  });

  it("takes the QR code down once the page was hidden for a minute, not before, and not when it came back in time", async () => {
    await mount();
    await press("Show the QR code");
    hidden = true;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    await advance(ACCOUNT_QR_HIDDEN_MS - 1000);
    hidden = false;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    await advance(ACCOUNT_QR_HIDDEN_MS);
    expect(qrCodes()).toHaveLength(1);
    hidden = true;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    await advance(ACCOUNT_QR_HIDDEN_MS);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
    expect(ended).toEqual([{ code: "482913" }]);
  });

  it("takes the QR code down when the page comes back after a sleep that ran no timer", async () => {
    await mount();
    await press("Show the QR code");
    hidden = true;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    const now = Date.now();
    spyOn(Date, "now").mockImplementation(() => now + ACCOUNT_QR_HIDDEN_MS);
    hidden = false;
    await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("takes the QR code down and ends its code when another tab opens, and when the dialog closes", async () => {
    await mount();
    await press("Show the QR code");
    await update({ active: false });
    expect(qrCodes()).toHaveLength(0);
    expect(ended).toEqual([{ code: "482913" }]);
    await update({ active: true });
    expect(buttons()).toEqual(["Show a new code"]);
    codePending = true;
    await press("Show a new code");
    expect(qrCodes()).toHaveLength(1);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await act(async () => {});
    expect(ended).toEqual([{ code: "482913" }, { code: "482913" }]);
    expect(count("/api/relay/code/cancel")).toBe(0);
  });

  it("ends the code with a request that outlives the page when the page goes: a reload, a closed tab", async () => {
    await mount();
    await press("Show the QR code");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    await flush();
    expect(ended).toEqual([{ code: "482913" }]);
    expect(keptAlive).toEqual(["/api/devices/pair/cancel"]);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
    expect(count("/api/devices/pair/cancel")).toBe(1);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    await flush();
    expect(count("/api/devices/pair/cancel")).toBe(1);
  });

  it("never ends a typed code, which is another place's: not when its own code was replaced, not on a PC that cannot end pairings", async () => {
    await mount();
    await press("Show the QR code");
    codePending = false;
    await update({ active: false });
    expect(ended).toEqual([{ code: "482913" }]);
    expect(count("/api/relay/code/cancel")).toBe(0);
    await update({ active: true });
    endsPairings = false;
    await press("Show a new code");
    await update({ active: false });
    expect(count("/api/relay/code/cancel")).toBe(0);
  });

  it("taken down before its offer came, ends nothing: no code was made for it yet", async () => {
    await mount();
    let answer: () => void = () => {};
    offerAnswer = () => new Promise<Response>((resolve) => { answer = () => resolve(Response.json({ url: OFFER_URL, expires_at: new Date(Date.now() + 600_000).toISOString() })); });
    await press("Show the QR code");
    await update({ active: false });
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    await flush();
    expect([count("/api/relay/code/cancel"), count("/api/devices/pair/cancel")]).toEqual([0, 0]);
    await act(async () => { answer(); });
    await flush();
  });

  it("takes the QR code down and ends its code when the relay stops being online", async () => {
    await mount();
    await press("Show the QR code");
    await update({ relay: relayState({ ...ONLINE, phase: "error", error: "lost" }) });
    expect(qrCodes()).toHaveLength(0);
    expect(ended).toEqual([{ code: "482913" }]);
    expect(buttons()).not.toContain("Show the QR code");
    await update();
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("asks for no code when another tab opens while the press still reads the PC", async () => {
    await mount();
    let answer = () => undefined as void;
    statusGate = new Promise((resolve) => { answer = resolve; });
    await press("Show the QR code");
    expect(section().findAll((node) => node.type === "button")[0]!.props.disabled).toBe(true);
    await update({ active: false });
    await act(async () => { answer(); });
    await flush();
    await update({ active: true });
    expect(minted()).toEqual([]);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("takes the QR code down by the clock when the device slept with the page in sight", async () => {
    await mount();
    await press("Show the QR code");
    const now = Date.now();
    spyOn(Date, "now").mockImplementation(() => now + ACCOUNT_QR_MAX_MS);
    await advance(ACCOUNT_QR_POLL_MS);
    expect(qrCodes()).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
    expect(ended).toEqual([{ code: "482913" }]);
  });

  for (const [name, down] of [
    ["another tab opened", async () => { await update({ active: false }); }],
    ["the page was hidden for a minute", async () => {
      hidden = true;
      await act(async () => { visibility.dispatchEvent(new Event("visibilitychange")); });
      await advance(ACCOUNT_QR_HIDDEN_MS);
    }],
  ] as const) {
    it(`still says which account the PC joined when ${name} between a pairing and its link`, async () => {
      await mount();
      await press("Show the QR code");
      devices = [...devices, phoneDevice()];
      codePending = false;
      await down();
      expect(qrCodes()).toHaveLength(0);
      expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-joined" })).toHaveLength(0);
      expect(held.at(-1)).toBe(true);
      devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
      pcAccount = ACCOUNT_ID;
      await advance(ACCOUNT_QR_POLL_MS);
      const notice = renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
      expect(text(notice)).toContain("This PC is in your account (acct_0123456).");
      expect(text(notice)).toContain("Added by iPhone · Safari.");
      expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
      expect(held.at(-1)).toBe(true);
      expect(accountQrNoticeWaiting()).toBe(false);
    });
  }

  it("keeps watching after the dialog closed between a pairing and its link, and says it when the dialog is back", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    codePending = false;
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await flush();
    expect(accountQrPending()).toBe(true);
    devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    let noticed = 0;
    window.addEventListener("ovis:account-qr-watch", (event) => { if ((event as CustomEvent<{ notice: boolean }>).detail.notice) noticed += 1; });
    await advance(ACCOUNT_QR_POLL_MS);
    expect(noticed).toBe(1);
    expect(accountQrNoticeWaiting()).toBe(true);
    expect(accountQrPending()).toBe(false);
    await mount();
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(text(notice)).toContain("Added by iPhone · Safari.");
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
    expect(accountQrNoticeWaiting()).toBe(false);
    expect(minted().filter((path) => path === "/api/relay/offer")).toHaveLength(1);
  });

  it("stops watching with the first read after the code was ended that finds no new device", async () => {
    await mount();
    await press("Show the QR code");
    await update({ active: false });
    expect(accountQrPending()).toBe(false);
    expect(held.at(-1)).toBe(false);
    const asked = count("/api/account/status");
    await advance(ACCOUNT_QR_POLL_MS * 4);
    expect(count("/api/account/status")).toBe(asked);
  });

  it("watches as long as the code can live when the PC did not answer its end, then stops", async () => {
    endsPairings = false;
    await mount();
    await press("Show the QR code");
    await update({ active: false });
    expect(accountQrPending()).toBe(true);
    const asked = count("/api/account/status");
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_POLL_MS);
    expect(count("/api/account/status")).toBe(asked + 2);
    await advance(ACCOUNT_QR_LATE_MS);
    expect(accountQrPending()).toBe(false);
    expect(held.at(-1)).toBe(false);
  });

  it("names a device that paired just before the QR code came down and joined no account", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    codePending = false;
    await update({ active: false });
    await update({ active: true });
    await advance(ACCOUNT_QR_ALONE_MS + ACCOUNT_QR_POLL_MS);
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-alone" }))).toContain("Paired with this PC but not signed in to an Ovis account, so this PC is in no account yet: iPhone · Safari.");
    await press("Keep it");
    expect(buttons()).toEqual(["Show a new code"]);
    expect(held.at(-1)).toBe(false);
    devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }))).toContain("Added by iPhone · Safari.");
  });

  it("a new press while the PC is still watched tells a join it finds instead of showing a QR code", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    codePending = false;
    await update({ active: false });
    await update({ active: true });
    devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    const before = minted().length;
    await press("Show a new code");
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }))).toContain("Added by iPhone · Safari.");
    expect(minted()).toHaveLength(before);
    expect(accountQrPending()).toBe(false);
  });

  it("tells the page's other places that the ended code ran out, only when it was still pending", async () => {
    const announced: string[] = [];
    await mount();
    window.addEventListener("ovis:pairing-code", (event) => { announced.push((event as CustomEvent<{ expires_at: string }>).detail.expires_at); });
    await press("Show the QR code");
    await update({ active: false });
    expect(announced.at(-1)).toBe(new Date(0).toISOString());
    await update({ active: true });
    await press("Show a new code");
    const before = announced.length;
    await update({ active: false });
    expect(announced.slice(before).filter((expires) => expires === new Date(0).toISOString())).toEqual([]);
  });

  it("says which account the PC joined and which device added it, and holds the dialog open for it", async () => {
    await mount();
    expect(held.at(-1)).toBe(false);
    await press("Show the QR code");
    expect(held.at(-1)).toBe(true);
    devices = [...devices, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    expect(qrCodes()).toHaveLength(0);
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(text(notice)).toContain("This PC is in your account (acct_0123456).");
    expect(text(notice)).toContain("Added by iPhone · Safari.");
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
    expect(held.at(-1)).toBe(true);
    await press("Done");
    // the PC is in an account now: no QR code is offered for it again
    expect(buttons()).toEqual([]);
    expect(text(section())).toContain("This PC is in your Ovis account (acct_0123456).");
    expect(text(section())).toContain("To add a device, sign in to this PC's account on it");
    expect(held.at(-1)).toBe(false);
    expect(minted()).toEqual(["/api/relay/offer"]);
  });

  // a device the code let in is asked about before the notice can go, also one still in its ten seconds
  it("offers no Done while a device the code let in is still in its ten seconds, and asks about it once they end", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ id: "s", label: "Stranger · Firefox" })];
    await advance(ACCOUNT_QR_POLL_MS);
    devices = [...devices, phoneDevice({ account: ACCOUNT_ID, created_at: "2026-11-10T00:00:05Z" })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    const notice = () => renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(text(notice())).toContain("Added by iPhone · Safari.");
    expect(text(notice())).toContain("Checking a device that just paired: Stranger · Firefox.");
    expect(buttons()).toEqual(["Not me: revoke every device"]);
    await advance(ACCOUNT_QR_ALONE_MS);
    expect(text(notice())).toContain("not in that account: Stranger · Firefox.");
    expect(text(notice())).not.toContain("Checking a device");
    expect(buttons()).toEqual(["Not me: remove it", "Keep it", "Not me: revoke every device"]);
    await press("Not me: remove it");
    expect(removed).toEqual(["s"]);
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
  });

  it("Done looks at the PC once more, and stays to ask about a device that came since the last look", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
    devices = [...devices, device({ id: "c", label: "Tablet · Chrome", created_at: "2026-11-10T00:00:02Z" })];
    await press("Done");
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }))).toContain("not in that account: Tablet · Chrome.");
    expect(buttons()).toEqual(["Not me: remove it", "Keep it", "Not me: revoke every device"]);
    expect(held.at(-1)).toBe(true);
    await press("Keep it");
    await press("Done");
    expect(buttons()).toEqual([]);
    expect(removed).toEqual([]);
  });

  it("keeps the notice up when Done cannot read the PC, and says so", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    statusGate = Promise.reject(new Error("offline"));
    statusGate.catch(() => undefined);
    await press("Done");
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-joined" })).toHaveLength(1);
    expect(section().findAllByProps({ role: "alert" }).map(text).join("")).toContain("This PC's devices could not be read");
    statusGate = Promise.resolve();
    await press("Done");
    expect(buttons()).toEqual([]);
  });

  it("Not me on one device goes on asking about another that came since the last look", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_ALONE_MS);
    expect(buttons()).toEqual(["Not me: remove it", "Keep it"]);
    devices = [...devices, device({ id: "c", label: "Tablet · Chrome", created_at: "2026-11-10T00:00:02Z" })];
    await press("Not me: remove it");
    expect(removed).toEqual(["b"]);
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-alone" });
    expect(text(notice)).toContain("Tablet · Chrome");
    expect(text(notice)).not.toContain("iPhone · Safari");
    expect(buttons()).toEqual(["Not me: remove it", "Keep it"]);
    expect(held.at(-1)).toBe(true);
  });

  it("when the PC cannot be read after Not me, the page watches on and asks about a device it finds later", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_ALONE_MS);
    devices = [...devices, device({ id: "c", label: "Tablet · Chrome", created_at: "2026-11-10T00:00:02Z" })];
    statusGate = Promise.reject(new Error("offline"));
    statusGate.catch(() => undefined);
    await press("Not me: remove it");
    expect(removed).toEqual(["b"]);
    expect(text(section())).toContain("Removed: iPhone · Safari.");
    expect(accountQrPending()).toBe(true);
    expect(held.at(-1)).toBe(true);
    statusGate = Promise.resolve();
    await advance(ACCOUNT_QR_POLL_MS);
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-alone" }))).toContain("Tablet · Chrome");
    expect(buttons()).toEqual(["Not me: remove it", "Keep it"]);
  });

  it("after an answer, says that a device still in its ten seconds is being checked, and asks about it once they end", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_ALONE_MS);
    devices = [...devices, phoneDevice({ id: "s", label: "Stranger · Firefox" })];
    await press("Keep it");
    const notice = () => renderer!.root.findByProps({ "data-testid": "connect-account-alone" });
    expect(buttons()).toEqual(["Show a new code"]);
    await advance(ACCOUNT_QR_ALONE_MS + ACCOUNT_QR_POLL_MS);
    expect(text(notice())).toContain("Stranger · Firefox");
    expect(text(notice())).not.toContain("iPhone · Safari");
    expect(buttons()).toEqual(["Not me: remove it", "Keep it"]);
    devices = [...devices, phoneDevice({ id: "t", label: "Third · Edge" })];
    await press("Not me: remove it");
    expect(removed).toEqual(["s"]);
    expect(text(notice())).toContain("Checking a device that just paired: Third · Edge.");
    expect(buttons()).toEqual([]);
    expect(held.at(-1)).toBe(true);
    await advance(ACCOUNT_QR_ALONE_MS + ACCOUNT_QR_POLL_MS);
    expect(text(notice())).toContain("Third · Edge");
    expect(buttons()).toEqual(["Not me: remove it", "Keep it"]);
  });

  it("Not me asks before it revokes, and revokes every device once", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    await press("Not me: revoke every device");
    expect(count("/api/devices/revoke-all")).toBe(0);
    const confirm = renderer!.root.findByType(ConfirmDialog);
    expect(confirm.props.body).toContain("this PC leaves that account");
    await act(async () => { await confirm.props.onConfirm(); });
    await flush();
    expect(count("/api/devices/revoke-all")).toBe(1);
    expect(revokedAll).toBe(1);
    expect(renderer!.root.findAllByType(ConfirmDialog)).toHaveLength(0);
    expect(text(section())).toContain("Every paired device was revoked.");
    expect(text(section())).toContain("Add with a QR code");
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("asks about a device that paired without an account, after ten seconds, with Not me first, and still tells a later join", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-alone" })).toHaveLength(0);
    await advance(ACCOUNT_QR_ALONE_MS);
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-alone" });
    expect(text(notice)).toBe("Paired with this PC but not signed in to an Ovis account, so this PC is in no account yet: iPhone · Safari.If that is your device, keep it and sign in on it to add this PC to your account.Not me: remove itKeep it");
    expect(qrCodes()).toHaveLength(0);
    expect(held.at(-1)).toBe(true);
    devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }))).toContain("Added by iPhone · Safari.");
  });

  // (2) a scan by a device that is not signed in gets a Not me too: one press removes it
  it("Not me on a device that paired without an account removes that device, and watches for nothing more", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_ALONE_MS);
    await press("Not me: remove it");
    expect(removed).toEqual(["b"]);
    expect(count("/api/devices/revoke-all")).toBe(0);
    expect(text(section())).toContain("Removed: iPhone · Safari.");
    expect(buttons()).toEqual(["Show a new code"]);
    expect(held.at(-1)).toBe(false);
    expect(accountQrPending()).toBe(false);
    const asked = count("/api/account/status");
    await advance(ACCOUNT_QR_POLL_MS * 4);
    expect(count("/api/account/status")).toBe(asked);
  });

  it("keeps the question up when the device could not be removed, and counts one already gone as removed", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_ALONE_MS);
    removable = false;
    await press("Not me: remove it");
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-alone" })).toHaveLength(1);
    expect(section().findAllByProps({ role: "alert" })).toHaveLength(1);
    removable = true;
    devices = [devices[0]!];
    await press("Not me: remove it");
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-alone" })).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
  });

  it("a question nobody answered waits for the next opening: closing the dialog keeps nobody", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_ALONE_MS);
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-alone" })).toHaveLength(1);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await flush();
    expect(accountQrNoticeWaiting()).toBe(true);
    await mount();
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-alone" }))).toContain("iPhone · Safari");
    expect(buttons()).toEqual(["Not me: remove it", "Keep it"]);
    devices = [devices[0]!, phoneDevice({ account: "acct_stranger_000000000" })];
    pcAccount = "acct_stranger_000000000";
    await advance(ACCOUNT_QR_POLL_MS);
    expect(text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }))).toContain("This PC joined another Ovis account (acct_strange), not the one this browser is signed in to (acct_0123456).");
  });

  it("says so when the PC joined an account that is not the one this browser is signed in to, with Not me first", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ account: "acct_stranger_000000000" })];
    pcAccount = "acct_stranger_000000000";
    await advance(ACCOUNT_QR_POLL_MS);
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(notice.props["data-account"]).toBe("other");
    expect(text(notice)).toContain("This PC joined another Ovis account (acct_strange), not the one this browser is signed in to (acct_0123456).");
    expect(text(notice)).toContain("Added by iPhone · Safari.");
    expect(text(notice)).not.toContain("This PC is in your account");
    expect(buttons()).toEqual(["Not me: revoke every device", "Keep it"]);
    const [notMe, keep] = section().findAll((node) => node.type === "button");
    expect(notMe!.props.className).toContain("btn-danger");
    expect(keep!.props.className).not.toContain("btn-primary");
  });

  it("signed out, says that this browser cannot tell whose account the PC joined, and tells once it is signed in", async () => {
    await mount({ signedIn: false });
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ account: ACCOUNT_ID })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    const notice = () => renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(notice().props["data-account"]).toBe("unknown");
    expect(text(notice())).toContain("This PC joined an Ovis account (acct_0123456).");
    expect(text(notice())).toContain("This browser is not signed in, so it cannot tell whether that account is yours: sign in above to check.");
    // something the owner can answer without knowing an account id, and Not me first: whoever scanned may be a stranger
    expect(text(notice())).toContain("If your own device did not just say that it added this PC, this was not you: revoke every device, and this PC leaves that account.");
    expect(buttons()).toEqual(["Not me: revoke every device", "Keep it"]);
    const [notMe, keep] = section().findAll((node) => node.type === "button");
    expect(notMe!.props.className).toContain("btn-danger");
    expect(keep!.props.className).not.toContain("btn-primary");
    await update({ signedIn: true, accountId: "acct_mine_0000000000000" });
    expect(notice().props["data-account"]).toBe("other");
    await update({ signedIn: true, accountId: ACCOUNT_ID });
    expect(notice().props["data-account"]).toBe("mine");
    expect(text(notice())).toContain("This PC is in your account (acct_0123456).");
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
  });

  it("signed out, goes on saying that the PC is in an account this browser cannot call its own once the notice was kept", async () => {
    await mount({ signedIn: false });
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ account: "acct_stranger_000000000" })];
    pcAccount = "acct_stranger_000000000";
    await advance(ACCOUNT_QR_POLL_MS);
    await press("Keep it");
    expect(buttons()).toEqual([]);
    expect(section().props["data-account"]).toBe("unknown");
    expect(text(section())).toContain("This PC is in an Ovis account (acct_strange).");
    expect(text(section())).toContain("This browser is not signed in, so it cannot tell whether that account is yours: sign in above to check.");
  });

  // (4) only a member of the account is named as the one that added the PC; a device that only holds the code is asked about
  it("never names a device that is no member of the joined account as the one that added the PC, and asks about it", async () => {
    await mount();
    await press("Show the QR code");
    devices = [device({ account: ACCOUNT_ID }), phoneDevice({ label: "Stranger · Firefox" })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    const notice = () => renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(text(notice())).toContain("Added by Laptop · Chrome.");
    expect(text(notice())).not.toContain("Added by Stranger");
    // through the relay it gets its ten seconds to become a member: not asked about yet, and no Done meanwhile
    expect(text(notice())).not.toContain("not in that account");
    expect(text(notice())).toContain("Checking a device that just paired: Stranger · Firefox.");
    expect(buttons()).toEqual(["Not me: revoke every device"]);
    await advance(ACCOUNT_QR_ALONE_MS);
    expect(text(notice())).toContain("Paired with this PC while its QR code was up, and not in that account: Stranger · Firefox.");
    // no Done while a device nobody vouched for is unanswered
    expect(buttons()).toEqual(["Not me: remove it", "Keep it", "Not me: revoke every device"]);
    await press("Not me: remove it");
    expect(removed).toEqual(["b"]);
    expect(text(notice())).toContain("Added by Laptop · Chrome.");
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
  });

  it("with the dialog closed, still names only a member and asks about the device that is none when the dialog is back", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ label: "Stranger · Firefox" })];
    codePending = false;
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await flush();
    expect(accountQrPending()).toBe(true);
    devices = [device({ account: ACCOUNT_ID }), phoneDevice({ label: "Stranger · Firefox" })];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    expect(accountQrNoticeWaiting()).toBe(true);
    await mount();
    const notice = () => renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(text(notice())).toContain("Added by Laptop · Chrome.");
    expect(text(notice())).not.toContain("Added by Stranger");
    // the stranger's ten seconds run from when the watch first saw it, and until it is answered there is no Done
    expect(text(notice())).toContain("Checking a device that just paired: Stranger · Firefox.");
    expect(buttons()).toEqual(["Not me: revoke every device"]);
    await advance(ACCOUNT_QR_ALONE_MS - ACCOUNT_QR_POLL_MS);
    expect(text(notice())).toContain("not in that account: Stranger · Firefox.");
    expect(buttons()).toEqual(["Not me: remove it", "Keep it", "Not me: revoke every device"]);
    await press("Keep it");
    expect(removed).toEqual([]);
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
    await advance(ACCOUNT_QR_POLL_MS * 2);
    expect(buttons()).toEqual(["Done", "Not me: revoke every device"]);
    await press("Done");
    expect(buttons()).toEqual([]);
  });

  it("a joined notice the dialog closed over waits for the next opening, and Done ends it", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice({ account: "acct_stranger_000000000" })];
    pcAccount = "acct_stranger_000000000";
    await advance(ACCOUNT_QR_POLL_MS);
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-joined" })).toHaveLength(1);
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await flush();
    expect(accountQrNoticeWaiting()).toBe(true);
    await mount();
    expect(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }).props["data-account"]).toBe("other");
    await press("Keep it");
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await flush();
    expect(accountQrNoticeWaiting()).toBe(false);
  });

  it("names nobody when no device on the PC is a member of the account it joined", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    pcAccount = ACCOUNT_ID;
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_ALONE_MS);
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-joined" });
    expect(text(notice)).not.toContain("Added by");
    expect(text(notice)).toContain("not in that account: iPhone · Safari.");
  });

  it("asks at once about a device that paired at this PC's own address with the code, and keeping it asks no more", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, device({ id: "c", label: "Tablet · Chrome", created_at: "2026-11-10T00:00:00Z" })];
    await advance(ACCOUNT_QR_POLL_MS);
    const notice = renderer!.root.findByProps({ "data-testid": "connect-account-alone" });
    expect(text(notice)).toContain("Paired with this PC at its own address while its QR code was up, not through the relay: Tablet · Chrome.");
    await press("Keep it");
    expect(removed).toEqual([]);
    expect(buttons()).toEqual(["Show a new code"]);
    await advance(ACCOUNT_QR_POLL_MS * 2);
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-alone" })).toHaveLength(0);
    expect(accountQrNoticeWaiting()).toBe(false);
  });

  it("after Keep it, asks about no device that pairs later at this PC's own address: it came by another code", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice()];
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_ALONE_MS);
    await press("Keep it");
    await advance(5 * 60_000);
    devices = [...devices, device({ id: "p", label: "Pixel · Chrome", created_at: new Date().toISOString() })];
    await advance(ACCOUNT_QR_POLL_MS);
    expect(renderer!.root.findAllByProps({ "data-testid": "connect-account-alone" })).toHaveLength(0);
    expect(buttons()).toEqual(["Show a new code"]);
    pcAccount = ACCOUNT_ID;
    devices = [devices[0]!, phoneDevice({ account: ACCOUNT_ID }), devices[2]!];
    await advance(ACCOUNT_QR_POLL_MS);
    const joined = text(renderer!.root.findByProps({ "data-testid": "connect-account-joined" }));
    expect(joined).toContain("Added by iPhone · Safari.");
    expect(joined).not.toContain("Pixel");
  });

  it("says of each device how it came: one through the relay with the advice to sign in on it, one at this PC's own address apart", async () => {
    await mount();
    await press("Show the QR code");
    devices = [...devices, phoneDevice(), device({ id: "c", label: "Tablet · Chrome", created_at: "2026-11-10T00:00:00Z" })];
    await advance(ACCOUNT_QR_POLL_MS);
    await advance(ACCOUNT_QR_ALONE_MS);
    const notice = text(renderer!.root.findByProps({ "data-testid": "connect-account-alone" }));
    expect(notice).toContain("so this PC is in no account yet: iPhone · Safari.If that is your device, keep it and sign in on it to add this PC to your account.");
    expect(notice).toContain("not through the relay: Tablet · Chrome.");
  });

  it("names as the adder only a member of the account: the newest that came since the press, else the account's newest", () => {
    const known = new Set(["a"]);
    const stranger = phoneDevice({ id: "s", label: "Stranger", created_at: "2026-11-10T09:00:00Z" });
    // a newcomer that is no member is never the adder, however new
    expect(addedBy([device({}), stranger], known, ACCOUNT_ID)).toBeNull();
    expect(addedBy([device({ account: ACCOUNT_ID }), stranger], known, ACCOUNT_ID)?.label).toBe("Laptop · Chrome");
    expect(addedBy([device({ account: ACCOUNT_ID }), stranger, phoneDevice({ account: ACCOUNT_ID })], known, ACCOUNT_ID)?.label).toBe("iPhone · Safari");
    // a member of another account is not vouched for either
    expect(addedBy([device({}), phoneDevice({ account: "acct_other" })], known, ACCOUNT_ID)).toBeNull();
  });

  it("tells the devices to ask about now from the ones still in their ten seconds, by when each was first seen", () => {
    const known = { ids: new Set(["a"]), seen: new Map<string, number>() };
    const list = [device({}), phoneDevice({ id: "s", label: "Stranger" }), device({ id: "c", label: "Tablet" })];
    // one that paired at the PC's own address cannot become a member: asked about at once
    expect(accountQrFindings(list, null, known, 1000)).toEqual({ due: [{ id: "c", label: "Tablet", relay: false }], checking: [{ id: "s", label: "Stranger", relay: true }] });
    expect(accountQrFindings(list, null, known, 1000 + ACCOUNT_QR_ALONE_MS - 1).checking.map((stray) => stray.id)).toEqual(["s"]);
    expect(accountQrFindings(list, null, { ids: known.ids, seen: known.seen }, 1000 + ACCOUNT_QR_ALONE_MS)).toEqual({ due: [{ id: "s", label: "Stranger", relay: true }, { id: "c", label: "Tablet", relay: false }], checking: [] });
    // a member of the PC's account is vouched for
    expect(accountQrFindings([device({}), phoneDevice({ id: "s", account: ACCOUNT_ID })], ACCOUNT_ID, known, 2000)).toEqual({ due: [], checking: [] });
  });

  it("counts as unvouched every device that came since the press and is no member of the PC's account", () => {
    const known = new Set(["a"]);
    const list = [device({}), phoneDevice({ account: ACCOUNT_ID }), phoneDevice({ id: "s", label: "Stranger" }), device({ id: "c", label: "Tablet" })];
    expect(unvouched(list, known, ACCOUNT_ID).map((entry) => entry.id)).toEqual(["s", "c"]);
    expect(unvouched(list, known, null).map((entry) => entry.id)).toEqual(["b", "s", "c"]);
    expect(unvouched(list, new Set(["a", "s", "c"]), ACCOUNT_ID)).toEqual([]);
  });
});
