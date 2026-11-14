import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { AppLink } from "./deepLink.ts";
import { INBOX_FROM_KEY, useInbox, useInboxShell } from "./useInbox.ts";
import { QuestionReads } from "./useInboxQuestions.ts";
import { SummaryReads } from "./useInboxSummaries.ts";

describe("useInboxShell", () => {
  let renderer: ReactTestRenderer | undefined;
  let reactAct: PropertyDescriptor | undefined;
  let calls: string[];
  let shell: ReturnType<typeof useInboxShell>;
  interface Place { inMode: boolean; shown: boolean; selectedPaneId: string | null; linkLanded: boolean; thread?: string | null; focusInput?: () => void }

  beforeEach(() => {
    reactAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    calls = [];
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    if (reactAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", reactAct);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  const show = (): void => { calls.push("show"); };
  const enter = (): void => { calls.push("enter"); };
  const setDrawerOpen = (open: boolean): void => { calls.push(`drawer ${open}`); };
  const hideFile = (): void => { calls.push("hide file"); };
  function Probe(place: Place) {
    shell = useInboxShell({ thread: null, ...place, show, enter, setDrawerOpen, hideFile });
    return null;
  }
  const draw = async (place: Place): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, place));
      else renderer = create(createElement(Probe, place));
    });
  };

  it("leaves the classic app alone, and its way in closes the drawer, leaves an open file behind, enters the mode and shows the list", async () => {
    await draw({ inMode: false, shown: false, selectedPaneId: "p1", linkLanded: true });
    expect(calls).toEqual([]);
    await act(async () => { shell.enterInbox(); });
    // the file is hidden before the mode's entry is pushed: its own entry stays under it, so Back shows it again
    expect(calls).toEqual(["drawer false", "hide file", "enter", "show"]);
  });

  it("names the row a Back onto the list returns to: the thread that was shown, and none for a list opened any other way", async () => {
    // Given a thread of the mode, then Back onto the list.
    await draw({ inMode: true, shown: false, selectedPaneId: "p1", linkLanded: true, thread: "local:p1" });
    expect(shell.returnTo).toBeNull();
    await draw({ inMode: true, shown: true, selectedPaneId: "p1", linkLanded: true, thread: null });
    expect(shell.returnTo).toBe("local:p1");

    // When another thread opens, and the mode is then left and entered again from the classic app.
    // a thread the list opens, and leaving, each ask a frame of the window for the focus's sake (below): this case has no use for it
    const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { requestAnimationFrame: () => 0 } });
    try {
      await draw({ inMode: true, shown: false, selectedPaneId: "p2", linkLanded: true, thread: "local:p2" });
      expect(shell.returnTo).toBeNull();
      await draw({ inMode: false, shown: false, selectedPaneId: "p2", linkLanded: true, thread: null });
      await draw({ inMode: true, shown: true, selectedPaneId: "p2", linkLanded: true, thread: null });
    } finally {
      if (saved) Object.defineProperty(globalThis, "window", saved);
      else Reflect.deleteProperty(globalThis, "window");
    }

    // Then that list was opened by a way in, not by a Back: it returns to no row.
    expect(shell.returnTo).toBeNull();
  });

  it("returns to no row when the list opens for a link whose pane is gone: no thread was shown", async () => {
    await draw({ inMode: true, shown: false, selectedPaneId: null, linkLanded: false, thread: null });
    await draw({ inMode: true, shown: true, selectedPaneId: "p9", linkLanded: true, thread: null });
    expect(shell.returnTo).toBeNull();
  });

  it("puts the drawer away when the mode's shell stands, however it came to (a Forward onto its entry)", async () => {
    await draw({ inMode: false, shown: false, selectedPaneId: "p1", linkLanded: true });
    await draw({ inMode: true, shown: false, selectedPaneId: "p1", linkLanded: true });
    expect(calls).toEqual(["drawer false"]);
  });

  it("gives a focus that was lost with the mode's shell to the classic header's toggle, and leaves one that is somewhere", async () => {
    const saved = { document: Object.getOwnPropertyDescriptor(globalThis, "document"), window: Object.getOwnPropertyDescriptor(globalThis, "window") };
    const body = {};
    const page = { activeElement: body as unknown, body, toggles: [{ getClientRects: () => [{}], focus: () => { calls.push("focus toggle"); } }] };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get activeElement() { return page.activeElement; }, body,
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector.includes(".drawer-toggle") ? page.toggles : [],
    } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { requestAnimationFrame: (run: () => void) => { run(); return 0; } } });
    try {
      // Given the mode's shell, left by Back to Ovis: the button pressed went with it, and nothing has the focus.
      await draw({ inMode: true, shown: true, selectedPaneId: "p1", linkLanded: true });
      calls = [];
      await draw({ inMode: false, shown: false, selectedPaneId: "p1", linkLanded: true });
      expect(calls).toEqual(["focus toggle"]);

      // Given the mode left while the focus is in the pane (the composer of the thread that classic now shows).
      await draw({ inMode: true, shown: false, selectedPaneId: "p1", linkLanded: true });
      calls = [];
      page.activeElement = {};
      await draw({ inMode: false, shown: false, selectedPaneId: "p1", linkLanded: true });
      expect(calls).toEqual([]);
    } finally {
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  it("gives a focus that a row's thread left nowhere to the thread's Back, and leaves one that is somewhere", async () => {
    const saved = { document: Object.getOwnPropertyDescriptor(globalThis, "document"), window: Object.getOwnPropertyDescriptor(globalThis, "window") };
    const body = {};
    const page = { activeElement: body as unknown, body, back: [{ getClientRects: () => [{}], focus: () => { calls.push("focus back"); } }] };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get activeElement() { return page.activeElement; }, body,
      querySelector: () => null,
      // a phone's thread draws Back in the drawer toggle's place: no toggle is shown
      querySelectorAll: (selector: string) => selector.includes(".inbox-back") ? page.back : [],
    } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { requestAnimationFrame: (run: () => void) => { run(); return 0; } } });
    try {
      // Given a page that opens on a thread: nothing was taken from the reader, and the focus is left alone.
      await draw({ inMode: true, shown: false, selectedPaneId: "p1", linkLanded: true, thread: "local:p1" });
      expect(calls).toEqual(["drawer false"]);

      // Given the list, and a row opened from the keyboard: the list left the screen with the row that had the focus.
      await draw({ inMode: true, shown: true, selectedPaneId: "p1", linkLanded: true, thread: null });
      calls = [];
      await draw({ inMode: true, shown: false, selectedPaneId: "p1", linkLanded: true, thread: "local:p1" });
      expect(calls).toEqual(["focus back"]);

      // a thread that takes that thread's place was not opened from the list: nothing more is asked
      await draw({ inMode: true, shown: false, selectedPaneId: "p2", linkLanded: true, thread: "local:p2" });
      expect(calls).toEqual(["focus back"]);

      // Given the list again, and a row whose pane takes the typing as it is picked (a pointer that is fine).
      await draw({ inMode: true, shown: true, selectedPaneId: "p2", linkLanded: true, thread: null });
      calls = [];
      page.activeElement = {};
      await draw({ inMode: true, shown: false, selectedPaneId: "p1", linkLanded: true, thread: "local:p1" });
      expect(calls).toEqual([]);
    } finally {
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  it("gives the focus to the thread's input under a fine pointer, and to Back under a coarse one, for a row whose pane classic was showing", async () => {
    const saved = { document: Object.getOwnPropertyDescriptor(globalThis, "document"), window: Object.getOwnPropertyDescriptor(globalThis, "window") };
    const body = {}, composer = {};
    let coarse = false;
    const page = { activeElement: body as unknown, back: [{ getClientRects: () => [{}], focus: () => { calls.push("focus back"); page.activeElement = {}; } }] };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get activeElement() { return page.activeElement; }, body,
      querySelector: () => null,
      querySelectorAll: (selector: string) => selector.includes(".inbox-back") ? page.back : [],
    } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      requestAnimationFrame: (run: () => void) => { run(); return 0; },
      matchMedia: (query: string) => ({ matches: query === "(pointer: coarse)" && coarse }),
    } });
    const focusInput = (): void => { calls.push("focus input"); page.activeElement = composer; };
    try {
      for (const pointer of ["fine", "coarse"] as const) {
        coarse = pointer === "coarse";
        // Given the classic app on p1, entered into the mode: p1 stays the app's pane, under the list.
        await draw({ inMode: false, shown: false, selectedPaneId: "p1", linkLanded: true, focusInput });
        await draw({ inMode: true, shown: true, selectedPaneId: "p1", linkLanded: true, focusInput });
        calls = [];
        page.activeElement = body;

        // When the keyboard opens p1's own row: the same pane, so nothing is picked anew, and the row left with the list.
        await draw({ inMode: true, shown: false, selectedPaneId: "p1", linkLanded: true, thread: "local:p1", focusInput });

        // Then the focus is in the thread: its input under a fine pointer, its Back under a coarse one.
        expect(calls).toEqual(pointer === "fine" ? ["focus input"] : ["focus back"]);
        await draw({ inMode: false, shown: false, selectedPaneId: "p1", linkLanded: true, focusInput });
      }
    } finally {
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });

  it("shows the list for a mode with no pane to show a thread of, once the page's link has landed", async () => {
    await draw({ inMode: true, shown: false, selectedPaneId: null, linkLanded: false });
    expect(calls).toEqual(["drawer false"]);
    await draw({ inMode: true, shown: false, selectedPaneId: null, linkLanded: true });
    expect(calls).toEqual(["drawer false", "show"]);
    // the list shown, or a pane picked: nothing more is asked
    await draw({ inMode: true, shown: true, selectedPaneId: null, linkLanded: true });
    await draw({ inMode: true, shown: false, selectedPaneId: "p1", linkLanded: true });
    expect(calls).toEqual(["drawer false", "show"]);
  });
});

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

  async function mount(on: boolean, initialLink: AppLink | null = null): Promise<void> {
    function Probe() {
      inbox = useInbox({ on, initialLink, drawerOpenRef });
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  }

  const paneLink: AppLink = { machine: "local", workspace: "w1", pane: "p1", view: "chat", settings: null };

  it("opens in the mode with no link, cold, and covers the selected pane", async () => {
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

  it("keeps one summary reader while the list is left and shown again", async () => {
    await mount(true);
    const reads = inbox.summaryReads;
    expect(reads).toBeInstanceOf(SummaryReads);

    await act(async () => { inbox.leave(); });
    await act(async () => { inbox.show(); });

    expect(inbox.summaryReads).toBe(reads);
  });

  it("counts each time the list opens, and keeps one note of the opening it took the focus for", async () => {
    // the page opens on the list
    await mount(true);
    const taken = inbox.focus.taken;
    expect(inbox.focus.opening).toBe(1);
    // a thread, then Back onto the list
    await act(async () => { inbox.leave(); });
    expect(inbox.focus.opening).toBe(1);
    await act(async () => { inbox.show(); });
    expect(inbox.focus.opening).toBe(2);
    // asked to show while it shows: nothing opened
    await act(async () => { inbox.show(); });
    expect(inbox.focus.opening).toBe(2);
    expect(inbox.focus.taken).toBe(taken);
  });

  it("has opened no list on a page that opens on a thread", async () => {
    await mount(true, paneLink);
    expect(inbox.focus.opening).toBe(0);
    await act(async () => { inbox.back(); });
    expect(inbox.focus.opening).toBe(1);
  });

  it("starts closed on a link naming a pane", async () => {
    await mount(true, paneLink);

    expect([inbox.enabled, inbox.shown]).toEqual([true, false]);
  });

  it("is never shown outside the mode", async () => {
    await mount(false);
    await act(async () => { inbox.show(); });
    expect([inbox.enabled, inbox.shown]).toEqual([false, false]);
  });

  it("is a place of the mode at every width: a window wider than a phone opens on it too", async () => {
    phone = false;
    await mount(true);
    expect([inbox.enabled, inbox.shown, inbox.cold]).toEqual([true, true, true]);
    await act(async () => { inbox.leave(); });
    expect([inbox.enabled, inbox.shown]).toEqual([true, false]);
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
