import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, useLayoutEffect, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import { linksSomewhere, readLink, type AppLink, type CreateDraft } from "./deepLink.ts";
import { pageStartsInInbox, useInboxMode, type InboxMode } from "./inboxMode.ts";
import type { SelectionMark } from "./selectionMark.ts";
import * as settingsHistory from "./settingsHistory.ts";
import * as sheetHistory from "./sheetHistory.ts";
import { useAddressBar } from "./useAddressBar.ts";
import { INBOX_FROM_KEY, useInbox } from "./useInbox.ts";

// The mode, the list and the address bar together, as App wires them, on a browser's history: what entering,
// leaving, opening a row and Back each leave in it. The two history modules answer from the window they loaded
// with, which is not this file's (lib/useAddressBar.hook.test.ts): here no pop is theirs.
const loaded = { settings: { ...settingsHistory }, sheet: { ...sheetHistory } };
beforeAll(() => {
  mock.module("./settingsHistory.ts", () => ({ ...loaded.settings, settingsSteppedOff: () => false }));
  mock.module("./sheetHistory.ts", () => ({ ...loaded.sheet, sheetSteppedOff: () => false }));
});
afterAll(() => {
  mock.module("./settingsHistory.ts", () => loaded.settings);
  mock.module("./sheetHistory.ts", () => loaded.sheet);
});

type Params = Parameters<typeof useAddressBar>[0];
type Snapshot = NonNullable<Machine["snapshot"]>;

const P1 = "?ws=w1-api&pane=p1&view=chat";
const P2 = "?ws=w2-docs&pane=p2&view=chat";
const LIST = "?app=inbox";
const thread = (pane: string): string => `${LIST}&${pane.slice(1)}`;
const snapshot = {
  workspaces: [{ workspace_id: "w1", label: "api" }, { workspace_id: "w2", label: "docs" }],
  panes: [{ pane_id: "p1", workspace_id: "w1", focused: true }, { pane_id: "p2", workspace_id: "w2", focused: false }],
  layouts: [],
} as unknown as Snapshot;

describe("the inbox mode in the history", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  /** the pane the app has selected: the one a thread shows, or the one under the list */
  let paneId: string | null;
  let shell: { mode: InboxMode; inbox: ReturnType<typeof useInbox> };
  let entries: Array<{ state: unknown; url: URL }>;
  let index: number;
  let listeners: Array<{ type: string; listener: (event: Event) => void }>;
  const refs = {
    selection: { current: { machineId: "local", paneId: null, generation: 0 } as SelectionMark },
    machines: { current: [] as Machine[] },
    selectTarget: { current: (_machineId: string, _paneId: string | null): void => {} },
    pendingFile: { current: null as string | null },
    pendingLink: { current: null as AppLink | null },
    pendingCreate: { current: null as CreateDraft | null },
    newSessionPending: { current: false },
    linkSince: { current: 0 },
    rosterSeq: { current: 0 },
    drawerOpen: { current: false } as RefObject<boolean>,
  };

  /** Settings → Start in the agent inbox on a phone, on a phone-width window */
  let setting: boolean;
  /** how the browser says the page was loaded; undefined where it does not say */
  let navigation: string | undefined;
  function Probe({ link }: { link: AppLink | null }) {
    const mode = useInboxMode({ startsIn: () => pageStartsInInbox(setting, true, link) });
    const inbox = useInbox({ on: mode.on, initialLink: link, drawerOpenRef: refs.drawerOpen });
    shell = { mode, inbox };
    const machine = { id: "local", name: "workstation", kind: "local", enabled: true, state: "connected", error: null, snapshot } as Machine;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId) as HerdrPane;
    refs.machines.current = [machine];
    useLayoutEffect(() => { refs.selection.current = { machineId: "local", paneId, generation: 0 }; }, [paneId]);
    useAddressBar({
      inbox, mode: { on: mode.on, lands: mode.at },
      newSessionOpen: false, newSessionMachineId: "local", newFields: null, sidebarCollapsed: false, snapshot, selectedPaneId: paneId, selectedPane: pane,
      selectedWorkspace: snapshot.workspaces.find((workspace) => workspace.workspace_id === pane?.workspace_id) as HerdrWorkspace,
      selectedMachineId: "local", selectedMachine: machine, machines: refs.machines.current, machinesRef: refs.machines,
      viewing: null, leaveFile: () => false, restoreFile: () => {}, fileFromPop: () => 0, forgetLeftFiles: () => {}, openFile: () => {},
      locked: false, linkLanded: true, view: "chat", wideScreen: true, autoSelected: false, newTab: null,
      settingsOpen: false, settingsPage: null, settingsLinkPage: null, settingsLinkSection: null,
      pendingFile: refs.pendingFile, pendingLink: refs.pendingLink, pendingCreate: refs.pendingCreate, newSessionPending: refs.newSessionPending, linkSince: refs.linkSince, rosterSeq: refs.rosterSeq,
      selectTargetRef: refs.selectTarget, selectionRef: refs.selection,
      setLinkLanded: () => {}, setHeaderNote: () => {}, setNewSessionOpen: () => {},
    } as unknown as Params);
    return null;
  }
  let link: AppLink | null;
  const draw = (): void => { renderer?.update(createElement(Probe, { link })); };

  beforeEach(() => {
    for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    listeners = [];
    setting = false;
    navigation = "navigate";
    // the app picks a pane as its selection does (lib/useSelection.ts): a pick leaves the list
    refs.selectTarget.current = (_machineId, picked) => { if (picked !== null) { paneId = picked; shell.inbox.leave(); draw(); } };
    const write = (method: "pushState" | "replaceState") => (state: unknown, _unused: string, url?: string): void => {
      const entry = { state, url: url === undefined ? entries[index]!.url : new URL(url, entries[index]!.url) };
      if (method === "pushState") { entries.splice(index + 1); entries.push(entry); index += 1; } else entries[index] = entry;
    };
    const go = (steps: number): void => {
      index += steps;
      const event = Object.assign(new Event("popstate"), { state: entries[index]!.state });
      for (const { type, listener } of [...listeners]) {
        if (type !== "popstate") continue;
        page.event = event;
        try { listener(event); } finally { page.event = undefined; }
      }
    };
    const page = {
      event: undefined as Event | undefined,
      get location() { return entries[index]!.url; },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      performance: { getEntriesByType: (kind: string) => kind === "navigation" && navigation !== undefined ? [{ type: navigation }] : [] },
      history: { get state() { return entries[index]!.state; }, pushState: write("pushState"), replaceState: write("replaceState"), go, back: () => go(-1) },
      addEventListener: (type: string, listener: (event: Event) => void) => { listeners.push({ type, listener }); },
      removeEventListener: (type: string, listener: (event: Event) => void) => { listeners = listeners.filter((other) => other.type !== type || other.listener !== listener); },
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: page });
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

  /** opens the page at the last of `addresses`, the others under it in the history, with `selected` as the app's pane; `state` is what that last entry carries */
  async function open(addresses: string[], selected: string | null, state: unknown = null): Promise<void> {
    entries = addresses.map((search) => ({ state: null, url: new URL(`http://localhost:7317/${search}`) }));
    index = entries.length - 1;
    entries[index]!.state = state;
    paneId = selected;
    const search = entries[index]!.url.search;
    link = linksSomewhere(search) ? readLink(search) : null;
    await act(async () => { renderer = create(createElement(Probe, { link })); });
  }
  const addresses = (): string[] => entries.map((entry) => entry.url.search);
  const at = (): string => entries[index]!.url.search;
  /** what is on screen: the app, the mode's list, or a thread of the mode, with the pane shown or under it */
  const screen = (): string => `${!shell.mode.on ? "app" : shell.inbox.shown ? "list" : "thread"}:${paneId}`;
  // as App's enterInbox and its Back to Ovis
  const enter = (): Promise<void> => act(async () => { shell.mode.enter(); shell.inbox.show(); });
  const leave = (): Promise<void> => act(async () => { shell.mode.leave(); });
  const openRow = (picked: string): Promise<void> => act(async () => { refs.selectTarget.current("local", picked); });
  const back = (): Promise<void> => act(async () => { window.history.go(-1); });
  const forward = (): Promise<void> => act(async () => { window.history.go(1); });

  it("enters from a pane by one entry, onto the list with the pane still the app's, and Back returns to it", async () => {
    await open([P1], "p1");
    expect(screen()).toBe("app:p1");

    await enter();
    expect(screen()).toBe("list:p1");
    expect(addresses()).toEqual([P1, LIST]);

    await back();
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual([P1, LIST]);
  });

  it("keeps the list as the floor: a row is one entry above it, another row takes that entry, and Back shows the list", async () => {
    await open([P1], "p1");
    await enter();

    await openRow("p2");
    expect(screen()).toBe("thread:p2");
    expect(addresses()).toEqual([P1, LIST, thread(P2)]);
    expect((entries[2]!.state as Record<string, unknown>)[INBOX_FROM_KEY]).toBe(true);

    await openRow("p1");
    expect(screen()).toBe("thread:p1");
    expect(addresses()).toEqual([P1, LIST, thread(P1)]);
    expect((entries[2]!.state as Record<string, unknown>)[INBOX_FROM_KEY]).toBe(true);

    await back();
    expect(screen()).toBe("list:p1");
    expect(at()).toBe(LIST);
    await back();
    expect(screen()).toBe("app:p1");
  });

  it("leaves from the list by one entry, onto the pane under it, and Back returns to the list", async () => {
    await open([P1], "p1");
    await enter();

    await leave();
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual([P1, LIST, P1]);

    await back();
    expect(screen()).toBe("list:p1");
    expect(addresses()).toEqual([P1, LIST, P1]);
  });

  it("leaves from a thread onto that thread's pane in the app, and Back returns to the thread", async () => {
    await open([P1], "p1");
    await enter();
    await openRow("p2");

    await leave();
    expect(screen()).toBe("app:p2");
    expect(addresses()).toEqual([P1, LIST, thread(P2), P2]);

    await back();
    expect(screen()).toBe("thread:p2");
    await back();
    expect(screen()).toBe("list:p2");
  });

  it("Forward from the app onto the mode's list shows the list, and on onto its thread the thread", async () => {
    await open([P1], "p1");
    await enter();
    await openRow("p2");
    await back();
    await back();
    expect(screen()).toBe("app:p1");

    await forward();
    expect(screen()).toBe("list:p1");
    await forward();
    expect(screen()).toBe("thread:p2");
    expect(addresses()).toEqual([P1, LIST, thread(P2)]);
  });

  it("opened by its own address the list has nothing of the app under it, and a row's thread goes back to it", async () => {
    await open([LIST], "p1");
    expect(screen()).toBe("list:p1");
    expect(addresses()).toEqual([LIST]);

    await openRow("p2");
    expect(addresses()).toEqual([LIST, thread(P2)]);
    // the header's Back on a thread the list opened is the history's own step
    await act(async () => { shell.inbox.back(); });
    expect(screen()).toBe("list:p2");
    expect(at()).toBe(LIST);
  });

  it("a thread opened by its own address opens the list in its place from the header's Back, adding no entry", async () => {
    await open([thread(P1)], "p1");
    expect(screen()).toBe("thread:p1");

    await act(async () => { shell.inbox.back(); });

    expect(screen()).toBe("list:p1");
    expect(addresses()).toEqual([LIST]);
  });

  it("a device that starts in the inbox opens the app's start on the list by a replace, with nothing under it", async () => {
    setting = true;
    await open([""], "p1");

    expect(screen()).toBe("list:p1");
    expect(addresses()).toEqual([LIST]);

    // a row is one entry above the list, and Back from it is the list: one more Back leaves the app
    await openRow("p2");
    await back();
    expect(screen()).toBe("list:p2");
    expect([index, addresses()]).toEqual([0, [LIST, thread(P2)]]);
  });

  it("a device that starts in the inbox opens a pane's address as that pane's thread, the list behind its Back", async () => {
    setting = true;
    await open([P1], "p1");

    expect(screen()).toBe("thread:p1");
    expect(addresses()).toEqual([thread(P1)]);

    await act(async () => { shell.inbox.back(); });
    expect(screen()).toBe("list:p1");
    expect(addresses()).toEqual([LIST]);
  });

  it("a device that starts in the inbox stays in the classic app it went back to, over a reload and a restored page", async () => {
    // Given a phone with the setting on that started in the mode and went Back to Ovis, onto p1.
    setting = true;
    await open([""], "p1");
    await leave();
    expect(screen()).toBe("app:p1");
    const left = addresses();
    expect(left).toEqual([LIST, P1]);
    await act(async () => { renderer?.unmount(); });

    // When the page is reloaded there.
    navigation = "reload";
    await open(left, "p1", entries[index]!.state);

    // Then it is the classic app still, and nothing was written.
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual(left);
    await act(async () => { renderer?.unmount(); });

    // When the system restores the page later, on that same entry, without saying how.
    navigation = undefined;
    await open(left, "p1", { "ovis:nav": true });

    // Then the entry the app wrote keeps it classic.
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual(left);
    await act(async () => { renderer?.unmount(); });

    // When the first entry of a page, which carries no state, is reloaded on a pane's address.
    navigation = "reload";
    await open([P1], "p1");

    // Then it is classic too: a reload never starts the mode.
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual([P1]);
  });

  it("a tab the browser loads again on the entry the page loaded on starts nothing, though it calls that a navigation: the app marked the entry", async () => {
    // Given a phone in the classic app with the setting off, on the entry it loaded on, whose address the app wrote to say its pane.
    await open([""], "p1");
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual([P1]);
    const stood = entries[0]!.state;
    await act(async () => { renderer?.unmount(); });

    // When the setting has been turned on since, and the browser restores the tab on that entry as a navigation.
    setting = true;
    navigation = "navigate";
    await open([P1], "p1", stood);

    // Then it opens where its address says, the classic app.
    expect(screen()).toBe("app:p1");
    expect(addresses()).toEqual([P1]);
    await act(async () => { renderer?.unmount(); });

    // And the same address on an entry no page of the app has stood on is a fresh navigation: that pane's thread.
    await open([P1], "p1");
    expect(screen()).toBe("thread:p1");
  });

  it("a reload keeps the mode and what it showed", async () => {
    await open([P1, LIST, thread(P2)], "p2");
    expect(screen()).toBe("thread:p2");
    await act(async () => { renderer?.unmount(); });

    await open([P1, LIST], "p1");
    expect(screen()).toBe("list:p1");
    expect(addresses()).toEqual([P1, LIST]);
  });
});
