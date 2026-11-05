import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { PairedDevice } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { DEVICES_CHANGED_EVENT } from "../lib/useRelay.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";

describe("reading the list again after this client's pairing joined the account (#3010)", () => {
  const row = (id: string, label: string): PairedDevice => ({ id, label, role: "drive", created_at: "", last_seen_at: "", current: id === "me" });
  const before = [row("me", "before the link")];
  const after = [row("me", "after the link")];
  let reads: Array<(devices: PairedDevice[]) => void> = [];
  let renderer: ReactTestRenderer | null = null;
  const saved = ["window", "document", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    // just enough page for the settings the panel's words come from (settings.hook.test.ts)
    Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
      setInterval, clearInterval, setTimeout, clearTimeout, localStorage: { getItem: () => null, setItem() {} } }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    // each list read waits for the test to answer it; a rename the PC refuses
    setTransport({ ...nativeTransport, fetch: async (input, init) => {
      if ((init?.method ?? "GET") !== "GET") return Response.json({ error: "rename refused" }, { status: 500 });
      return Response.json({ devices: await new Promise<PairedDevice[]>((resolve) => reads.push(resolve)) });
    } });
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = null;
    reads = [];
    setTransport(nativeTransport);
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    if (languages) Object.defineProperty(navigator, "languages", languages); else Reflect.deleteProperty(navigator, "languages");
  });

  /** lets a read that was answered land: a bounded number of microtask turns, no timer */
  const turns = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
  const mount = async () => {
    await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(DevicesPanel, { auth: null }) })); });
  };
  const answer = async (read: number, devices: PairedDevice[]) => { await act(async () => { reads[read]!(devices); await turns(); }); };
  const changed = async () => { await act(async () => { window.dispatchEvent(new Event(DEVICES_CHANGED_EVENT)); }); };
  const text = () => JSON.stringify(renderer!.toJSON());

  it("shows the list read after the link, even when the read before it answers last", async () => {
    // Given the panel opened before the link, its first read still out
    await mount();
    // When the shell says the list changed, and the reads answer newest first
    await changed();
    expect(reads).toHaveLength(2);
    await answer(1, after);
    await answer(0, before);
    // Then the list is the one read after the link
    expect(text()).toContain("after the link");
    expect(text()).not.toContain("before the link");
  });

  it("keeps a warning on screen through that read", async () => {
    // Given an open panel showing why a rename failed
    await mount();
    await answer(0, before);
    const rename = renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Rename before the link");
    await act(async () => { rename.props.onClick(); });
    const form = renderer!.root.find((node) => node.type === "form");
    await act(async () => { form.props.onSubmit({ preventDefault() {} }); await turns(); });
    expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(1);
    const cancel = renderer!.root.find((node) => node.type === "button" && node.props["aria-label"] === "Cancel");
    await act(async () => { cancel.props.onClick(); });
    // When the list is read again after the link
    await changed();
    await answer(1, after);
    // Then the new list shows, and the warning stays
    expect(text()).toContain("after the link");
    expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(1);
  });
});
