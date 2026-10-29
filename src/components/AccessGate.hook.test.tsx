import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { SettingsProvider } from "../lib/settings.ts";
import { useEffect } from "react";
import { useAccessState, usePairFromAddress } from "../lib/useAccess.ts";
import { AccessGate } from "./AccessGate.tsx";

describe("pairing link access gate", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let access: ReturnType<typeof useAccessState>;
  let gateKey = 0;
  let pairRequests: number;
  let pairStatus: number;
  let initiallyOpen: boolean;

  beforeEach(() => {
    initiallyOpen = false;
    pairRequests = 0;
    pairStatus = 204;
    gateKey = 0;
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "https://ovis.example/?pair=123456" },
      history: { state: null, replaceState() {} },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    const fetch = async (input: string | URL | Request) => {
      if (String(input).includes("/api/devices/pair")) {
        pairRequests++;
        return pairStatus === 204 && pairRequests === 1 ? new Response(null, { status: 204 })
          : Response.json({ error: { code: "invalid_code", message: "spent" } }, { status: 401 });
      }
      return Response.json({ ok: true, auth: { required: !initiallyOpen, authenticated: false }, bridge_protocol: 1 });
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

  function Page() {
    access = useAccessState();
    usePairFromAddress({ ...access, loadHealth: access.readBridgeHealth });
    useEffect(() => { if (initiallyOpen) void access.readBridgeHealth(); }, []);
    if (access.locked === false || (initiallyOpen && access.locked === null)) return null;
    return <AccessGate key={gateKey} reason={access.lockReason} initialCode={access.pairCode}
      consumePairCode={access.consumePairCode} pairingUnconfirmed={access.pairingUnconfirmed}
      onPaired={access.onPaired} onUnlocked={() => access.setLocked(false)} />;
  }
  const view = () => <SettingsProvider><Page /></SettingsProvider>;

  it("does not let the App effect submit a code already sent by the gate after unlock", async () => {
    await act(async () => { renderer = create(view()); });
    expect(access!.locked).toBe(false);
    expect(pairRequests).toBe(1);
    expect(access!.pairCode).toBe("");
  });

  it("leaves no link code in the field after a failed automatic attempt", async () => {
    pairStatus = 401;
    await act(async () => { renderer = create(view()); });
    expect(pairRequests).toBe(1);
    expect(renderer!.root.findByProps({ id: "access-gate-code" }).props.value).toBe("");
  });

  it("pairs an already-open browser from the address once, without mounting the gate", async () => {
    initiallyOpen = true;
    await act(async () => { renderer = create(view()); });
    expect(access!.locked).toBe(false);
    expect(pairRequests).toBe(1);
    expect(access!.pairCode).toBe("");
    expect(renderer!.root.findAllByType(AccessGate)).toHaveLength(0);
    await act(async () => { await access!.readBridgeHealth(); });
    expect(pairRequests).toBe(1);
  });

  it("does not replay a successful link when health rejects the cookie, and explains the relock", async () => {
    await act(async () => { renderer = create(view()); });
    expect(pairRequests).toBe(1);
    expect(access!.locked).toBe(false);
    await act(async () => { await access!.readBridgeHealth(); });
    expect(access!.locked).toBe(true);
    expect(pairRequests).toBe(1);
    const alerts = renderer!.root.findAllByProps({ role: "alert" }).map((node) => node.children.join(""));
    expect(alerts).toContain("Could not confirm this browser is paired. Check that cookies are enabled, then try again.");
    expect(alerts.join(" ")).not.toContain("That code is wrong");
    const input = renderer!.root.findByProps({ id: "access-gate-code" });
    expect(input.props.value).toBe("");
    expect(input.props["aria-invalid"]).toBe(false);
    expect(input.props["aria-describedby"]).toBeUndefined();
  });

  it("does not replay a failed link when the gate remounts", async () => {
    pairStatus = 401;
    await act(async () => { renderer = create(view()); });
    expect(pairRequests).toBe(1);
    gateKey++;
    await act(async () => { renderer!.update(view()); });
    expect(pairRequests).toBe(1);
    expect(renderer!.root.findByProps({ id: "access-gate-code" }).props.value).toBe("");
  });
});
