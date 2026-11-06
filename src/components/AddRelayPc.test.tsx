import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import { KeyId } from "./KeyId.tsx";
import { AddRelayPc } from "./AddRelayPc.tsx";

// Settings → Devices and PCs → Connect → Enter a code from another device with the code the other PC shows: this PC's server finds that
// PC, the person matches its ID, and only then is it added. The code never leaves the input.
const SERVER_ID = "0123456789abcdef0123456789abcdef";

describe("Add a PC through the relay with a typed code", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let requests: { path: string; body: unknown }[];
  let codeAnswer: Response;
  const field = { value: "" };

  beforeEach(() => {
    requests = [];
    field.value = "";
    codeAnswer = Response.json({ ticket: "t1", server_id: SERVER_ID, name: "Lab" });
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    const events = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7421/", origin: "http://127.0.0.1:7421", pathname: "/" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
    } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7421").pathname;
      requests.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
      if (path === "/api/machines/relay/code") return codeAnswer;
      if (path === "/api/machines/relay") return Response.json({ machine: { id: "m1", name: "Lab", kind: "relay" } }, { status: 201 });
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

  const mount = async () => {
    await act(async () => { renderer = create(<SettingsProvider><AddRelayPc /></SettingsProvider>, { createNodeMock: (element) => element.type === "input" ? field : null }); });
  };
  const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
  const button = (label: string) => renderer!.root.find((node) => node.type === "button" && text(node).trim() === label);
  const submit = async (value: string) => {
    field.value = value;
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  };

  it("finds the PC by its code, shows its ID to match, and adds it only after It matches", async () => {
    await mount();
    await submit(" 7k3qd-m2xha ");
    expect(requests).toEqual([{ path: "/api/machines/relay/code", body: { code: "7k3qd-m2xha" } }]);
    // one try per tap: the code is gone from the field
    expect(field.value).toBe("");
    expect(renderer!.root.findByType(KeyId).props.id).toBe(SERVER_ID);
    expect(renderer!.root.findAll((node) => node.type === "form")).toHaveLength(0);

    await act(async () => { button("It matches").props.onClick(); });
    expect(requests.at(-1)).toEqual({ path: "/api/machines/relay", body: { found: "t1" } });
    expect(text(renderer!.root.find((node) => node.props.role === "status"))).toContain("Lab was added");
  });

  it("says why a code found no PC, in the code screen's words, and adds nothing", async () => {
    codeAnswer = Response.json({ error: { code: "typed_code_wrong", message: "That code did not work" } }, { status: 400 });
    await mount();
    await submit("7K3QD-M2XHB");
    expect(text(renderer!.root.find((node) => node.props.role === "alert"))).toBe("That code did not work. Check it and try again; after three wrong tries the PC needs a new code.");
    expect(requests.map(({ path }) => path)).toEqual(["/api/machines/relay/code"]);
  });

  it("still adds a PC from a pasted link in one step", async () => {
    await mount();
    await submit("https://app.ovis.sh/s/" + SERVER_ID + "/#offer=abc");
    expect(requests).toEqual([{ path: "/api/machines/relay", body: { link: "https://app.ovis.sh/s/" + SERVER_ID + "/#offer=abc" } }]);
  });
});
