import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { AppLink } from "./deepLink.ts";
import { INBOX_FROM_KEY, useInbox } from "./useInbox.ts";
import { QuestionReads } from "./useInboxQuestions.ts";

describe("useInbox", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let inbox: ReturnType<typeof useInbox>;
  let phone: boolean;
  let historyState: unknown;
  let backs: number;
  let events: EventTarget;
  const drawerOpenRef: RefObject<boolean> = { current: false };

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    phone = true;
    historyState = null;
    backs = 0;
    events = new EventTarget();
    drawerOpenRef.current = false;
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
      history: { get state() { return historyState; }, back: () => { backs += 1; } },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  async function mount(setting: boolean, initialLink: AppLink | null = null): Promise<void> {
    function Probe() {
      inbox = useInbox({ setting, initialLink, drawerOpenRef });
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  }

  const paneLink: AppLink = { machine: "local", workspace: "w1", pane: "p1", view: "chat", settings: null };

  it("opens on a phone with the setting and no link, cold, and covers the selected pane", async () => {
    await mount(true);

    expect([inbox.enabled, inbox.shown, inbox.cold]).toEqual([true, true, true]);
    expect(inbox.coveredRef.current).toBe(true);
  });

  it("leaving clears shown and cold for good: the list shown again keeps the pane mounted under it", async () => {
    await mount(true);

    await act(async () => { inbox.leave(); });
    expect([inbox.shown, inbox.cold]).toEqual([false, false]);
    expect(inbox.coveredRef.current).toBe(false);

    await act(async () => { inbox.show(); });
    expect([inbox.shown, inbox.cold]).toEqual([true, false]);
  });

  it("keeps one question reader while the list is left and shown again", async () => {
    await mount(true);
    const reads = inbox.questionReads;
    expect(reads).toBeInstanceOf(QuestionReads);

    await act(async () => { inbox.leave(); });
    await act(async () => { inbox.show(); });

    expect(inbox.questionReads).toBe(reads);
  });

  it("starts closed on a link naming a pane", async () => {
    await mount(true, paneLink);

    expect([inbox.enabled, inbox.shown]).toEqual([true, false]);
  });

  it("is never shown in a window wider than a phone, nor with the setting off", async () => {
    phone = false;
    await mount(true);
    await act(async () => { inbox.show(); });
    expect([inbox.enabled, inbox.shown]).toEqual([false, false]);
    await act(async () => { renderer?.unmount(); });

    phone = true;
    await mount(false);
    await act(async () => { inbox.show(); });
    expect([inbox.enabled, inbox.shown]).toEqual([false, false]);
  });

  it("covers the pane while the drawer is open", async () => {
    await mount(true, paneLink);

    drawerOpenRef.current = true;
    expect(inbox.coveredRef.current).toBe(true);
  });

  it("opens the list in place when the history entry was not pushed by leaving it", async () => {
    await mount(true, paneLink);
    historyState = { other: true };

    await act(async () => { inbox.back(); });

    expect(inbox.shown).toBe(true);
    expect(backs).toBe(0);
  });

  it("goes back through the history from an entry pushed on leaving the list", async () => {
    await mount(true, paneLink);
    historyState = { [INBOX_FROM_KEY]: true };

    await act(async () => { inbox.back(); });

    expect(backs).toBe(1);
    expect(inbox.shown).toBe(false);
  });

  it("steps back once for two presses in a row, and takes a press again once that step has landed", async () => {
    await mount(true, paneLink);
    historyState = { [INBOX_FROM_KEY]: true };

    await act(async () => { inbox.back(); inbox.back(); });
    expect(backs).toBe(1);
    await act(async () => { inbox.back(); });
    expect(backs).toBe(1);

    // the step lands on an entry that still says it was pushed from the list (a Back further down the history)
    await act(async () => { events.dispatchEvent(new Event("popstate")); });
    await act(async () => { inbox.back(); });
    expect(backs).toBe(2);
  });

  it("takes a press again once the page shows again with no popstate (a cancelled leave, a restore from the page cache)", async () => {
    await mount(true, paneLink);
    historyState = { [INBOX_FROM_KEY]: true };

    await act(async () => { inbox.back(); inbox.back(); });
    expect(backs).toBe(1);
    await act(async () => { events.dispatchEvent(new Event("pageshow")); });
    await act(async () => { inbox.back(); });
    expect(backs).toBe(2);
  });

  it("takes a press again once the list has shown", async () => {
    await mount(true, paneLink);
    historyState = { [INBOX_FROM_KEY]: true };

    await act(async () => { inbox.back(); });
    await act(async () => { inbox.show(); });
    await act(async () => { inbox.leave(); });
    await act(async () => { inbox.back(); });
    expect(backs).toBe(2);
  });
});
