import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock } from "bun:test";
import { createElement, useLayoutEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane, HerdrWorkspace } from "../../shared/protocol.ts";
import { NAV_KEY, readLink, type AppLink, type CreateDraft } from "./deepLink.ts";
import { FILE_PREVIEW_KEY } from "./historyKeys.ts";
import type { SelectionMark } from "./selectionMark.ts";
import * as settingsHistory from "./settingsHistory.ts";
import * as sheetHistory from "./sheetHistory.ts";
import { popUnread, useAddressBar } from "./useAddressBar.ts";
import { INBOX_FROM_KEY } from "./useInbox.ts";

// The two history modules answer the handler from what their own popstate listeners last saw, on the
// window they loaded with. That is not this file's window (another test file may have loaded them,
// and left its last answer): here no pop is Settings closing, and a sheet's step only where a test says so.
const loaded = { settings: { ...settingsHistory }, sheet: { ...sheetHistory } };
let sheetStep = false;
beforeAll(() => {
  mock.module("./settingsHistory.ts", () => ({ ...loaded.settings, settingsSteppedOff: () => false }));
  mock.module("./sheetHistory.ts", () => ({ ...loaded.sheet, sheetSteppedOff: () => sheetStep }));
});
afterAll(() => {
  mock.module("./settingsHistory.ts", () => loaded.settings);
  mock.module("./sheetHistory.ts", () => loaded.sheet);
});

type Params = Parameters<typeof useAddressBar>[0];
type Snapshot = NonNullable<Machine["snapshot"]>;
type Preview = NonNullable<Params["viewing"]>;

const P1 = "?ws=w1-api&pane=p1&view=chat";
const P2 = "?ws=w2-docs&pane=p2&view=chat";
const roster = (): Snapshot => ({
  workspaces: [{ workspace_id: "w1", label: "api" }, { workspace_id: "w2", label: "docs" }],
  panes: [{ pane_id: "p1", workspace_id: "w1", focused: true }, { pane_id: "p2", workspace_id: "w2", focused: false }],
  layouts: [],
}) as unknown as Snapshot;

/** what the app shows: the hook's inputs that the tests move */
let place: { machineId: string; paneId: string | null; newSessionOpen: boolean; newFields: Omit<CreateDraft, "kind"> | null; sidebarCollapsed: boolean; snapshot: Snapshot; viewing: Preview | null; linkLanded: boolean; inbox: { open: boolean; enabled: boolean }; dialogMachineId?: string; rosterOut?: boolean;
  /** the inbox mode as last drawn (lib/inboxMode.ts); absent, the hook is given no mode, as before it existed */
  mode?: boolean };
/** what the handler asked of a phone's agent list */
let inboxCalls: string[];
/** Reopen files on return: whether a file left behind is kept on its entry */
let reopenFiles: boolean;
/** the panes the handler asked the app to select */
let asked: Array<string | null>;
/** every history write: the method, the entry it was made on and the address it left there */
let writes: string[];
let entries: Array<{ state: unknown; url: URL }>;
let index: number;
let listeners: Array<(event: Event) => void>;
/** an update still waiting when Back lands: React draws it between two popstate listeners */
let waiting: (() => void) | null;
let renderer: ReactTestRenderer | undefined;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
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
};

function Probe() {
  const { machineId, paneId, newSessionOpen, newFields, sidebarCollapsed, snapshot, viewing, linkLanded, inbox, dialogMachineId, rosterOut, mode } = place;
  const machine = { id: machineId, name: "workstation", kind: "local", enabled: true, state: "connected", error: null, snapshot } as Machine;
  const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId) as HerdrPane;
  // the PCs are not in yet: the page has no roster to settle an entry against
  refs.machines.current = rosterOut ? [] : [machine];
  // the app marks its selection at commit (lib/useSelection.ts)
  useLayoutEffect(() => { refs.selection.current = { machineId, paneId, generation: 0 }; }, [machineId, paneId]);
  useAddressBar({
    // the list stands in the pane's place while open on a phone (lib/useInbox.ts)
    inbox: {
      shown: inbox.open && inbox.enabled, enabled: inbox.enabled,
      show: () => { inboxCalls.push("show"); place.inbox = { ...place.inbox, open: true }; draw(); },
      leave: () => { inboxCalls.push("leave"); place.inbox = { ...place.inbox, open: false }; draw(); },
    },
    // the mode an entry is in is what its address says, whatever was last drawn
    mode: mode === undefined ? undefined : { on: mode, lands: () => new URLSearchParams(window.location.search).get("app") === "inbox" },
    // the New workspace dialog's PC: the selected one, unless it was opened for another (the list's sheet of PCs)
    newSessionOpen, newSessionMachineId: dialogMachineId ?? machineId, newFields, sidebarCollapsed, snapshot, selectedPaneId: paneId, selectedPane: pane,
    // a pane its roster does not list yet (one New workspace just made) has no workspace
    selectedWorkspace: snapshot.workspaces.find((workspace) => workspace.workspace_id === pane?.workspace_id) as HerdrWorkspace,
    selectedMachineId: machineId, selectedMachine: machine, machines: refs.machines.current, machinesRef: refs.machines,
    // Reopen files on return: a file left behind is hidden and its entry keeps it (lib/useFilePanels.ts)
    viewing, leaveFile: () => { place.viewing = null; draw(); return reopenFiles; },
    restoreFile: () => {}, fileFromPop: () => 0, forgetLeftFiles: () => {}, openFile: () => {},
    locked: false, linkLanded, view: "chat", wideScreen: true, autoSelected: false, newTab: null,
    settingsOpen: false, settingsPage: null, settingsLinkPage: null, settingsLinkSection: null,
    pendingFile: refs.pendingFile, pendingLink: refs.pendingLink, pendingCreate: refs.pendingCreate, newSessionPending: refs.newSessionPending, linkSince: refs.linkSince, rosterSeq: refs.rosterSeq,
    selectTargetRef: refs.selectTarget, selectionRef: refs.selection,
    setLinkLanded: () => {}, setHeaderNote: () => {},
    setNewSessionOpen: (open: boolean) => { place.newSessionOpen = open; draw(); },
  } as unknown as Params);
  return null;
}

const draw = (): void => { renderer?.update(createElement(Probe)); };
/** Draws at once, effects included, as React does in the microtask after a popstate listener that set state. */
const drawNow = (): void => { (renderer as unknown as { unstable_flushSync(run: () => void): void }).unstable_flushSync(draw); };

beforeEach(() => {
  for (const key of ["window", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  place = { machineId: "local", paneId: "p2", newSessionOpen: false, newFields: null, sidebarCollapsed: false, snapshot: roster(), viewing: null, linkLanded: true, inbox: { open: false, enabled: false } };
  inboxCalls = [];
  reopenFiles = true;
  sheetStep = false;
  asked = [];
  writes = [];
  listeners = [];
  waiting = null;
  refs.selectTarget.current = (_machineId, paneId) => { asked.push(paneId); if (paneId !== null) { place.paneId = paneId; draw(); } };
  refs.pendingCreate.current = null;
  refs.newSessionPending.current = false;
  const write = (method: "pushState" | "replaceState") => (state: unknown, _unused: string, url?: string): void => {
    const entry = { state, url: url === undefined ? entries[index]!.url : new URL(url, entries[index]!.url) };
    if (method === "pushState") { entries.splice(index + 1); entries.push(entry); index += 1; } else entries[index] = entry;
    writes.push(`${method} ${index} ${entry.url.search}`);
  };
  const page = {
    event: undefined as Event | undefined,
    get location() { return entries[index]!.url; },
    history: {
      get state() { return entries[index]!.state; },
      pushState: write("pushState"), replaceState: write("replaceState"),
      // a traversal lands at once, and the browser names the event (`window.event`) to each listener in turn
      go: (steps: number): void => {
        index += steps;
        let stopped = false;
        const event = Object.assign(new Event("popstate"), { state: entries[index]!.state, stopImmediatePropagation: () => { stopped = true; } });
        for (const listener of [...listeners]) {
          if (stopped) break;
          page.event = event;
          try { listener(event); } finally { page.event = undefined; }
        }
      },
    },
    addEventListener: (_type: "popstate", listener: (event: Event) => void) => { listeners.push(listener); },
    removeEventListener: (_type: "popstate", listener: (event: Event) => void) => { listeners = listeners.filter((other) => other !== listener); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: page });
  // a listener from before the app mounts, as lib/settingsHistory.ts's is: what it sets is drawn, with
  // whatever else was waiting, before the address bar's listener runs
  window.addEventListener("popstate", () => {
    if (waiting === null) return;
    waiting();
    waiting = null;
    drawNow();
  });
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

async function mount(addresses: string[]): Promise<void> {
  entries = addresses.map((search) => ({ state: null, url: new URL(`http://localhost:7317/${search}`) }));
  index = entries.length - 1;
  await act(async () => { renderer = create(createElement(Probe)); });
  writes = [];
}
const addresses = (): string[] => entries.map((entry) => entry.url.search);
const back = (): Promise<void> => act(async () => { window.history.go(-1); });
const forward = (): Promise<void> => act(async () => { window.history.go(1); });
const FROM_INBOX = { [NAV_KEY]: true, [INBOX_FROM_KEY]: true };

it("says a popstate is unread only while it is being dispatched and the handler has not read it", () => {
  const pop = new Event("popstate");
  expect(popUnread(undefined, null)).toBe(false);
  expect(popUnread(undefined, pop)).toBe(false);
  expect(popUnread(pop, null)).toBe(true);
  expect(popUnread(pop, new Event("popstate"))).toBe(true);
  expect(popUnread(pop, pop)).toBe(false);
  expect(popUnread(new Event("click"), null)).toBe(false);
});

it("Back with nothing waiting selects the entry's pane and writes nothing", async () => {
  await mount([P1, P2]);

  await back();

  expect(asked).toEqual(["p1"]);
  expect(writes).toEqual([]);
  expect(addresses()).toEqual([P1, P2]);
});

it("keeps a parameter it does not own through a move between panes, a lens change and Back", async () => {
  // Given p1 shown at an address that also says the inbox mode (lib/inboxMode.ts), a parameter of that module's own.
  place = { ...place, paneId: "p1" };
  await mount([`?app=inbox&${P1.slice(1)}`]);

  // When p2 is selected.
  await act(async () => { place.paneId = "p2"; draw(); });

  // Then the move is pushed with the parameter still in its address.
  expect(writes).toEqual([`pushState 1 ?app=inbox&${P2.slice(1)}`]);

  // When Back lands on p1's entry.
  await back();

  // Then p1 is selected and neither entry is rewritten.
  expect(asked).toEqual(["p1"]);
  expect(addresses()).toEqual([`?app=inbox&${P1.slice(1)}`, `?app=inbox&${P2.slice(1)}`]);
});

it("Back selects the entry's pane while a roster is waiting to be drawn", async () => {
  // Given p2 shown on its entry, and a roster that has arrived and is not drawn yet.
  await mount([P1, P2]);
  waiting = () => { place.snapshot = roster(); };

  // When Back lands on p1's entry and React draws the roster before the address bar's listener runs.
  await back();

  // Then the entry still says p1 when it is read, and its pane is selected.
  expect(asked).toEqual(["p1"]);
  expect(place.paneId).toBe("p1");
  expect(writes).toEqual([]);
  expect(addresses()).toEqual([P1, P2]);
});

it("Back off the New workspace dialog's entry closes it while its fields are on their way to the address", async () => {
  // Given the dialog open on its entry, and its fields reported (after the dialog's 400 ms) but not drawn yet.
  const held = `${P1}&new=workspace&name=Held`;
  place = { ...place, paneId: "p1", newSessionOpen: true, newFields: { cwd: null, name: "Held", agent: null } };
  await mount([P1, held]);
  waiting = () => { place.newFields = { cwd: "/home/demo/api", name: "Held", agent: "codex" }; };

  // When Back lands on the entry without the dialog.
  await back();

  // Then the dialog closes, and neither entry was written over.
  expect(place.newSessionOpen).toBe(false);
  expect(addresses()).toEqual([P1, held]);
});

/**
 * New workspace open over the list, as App has it: its sheet's entry over the list's. lib/sheetHistory.ts listens
 * before the address bar; while the create is in flight the sheet refuses Back, and that module pushes the sheet's
 * entry again over where Back landed, with no URL. Simulated here exactly so, by a listener ahead of the hook's.
 */
async function dialogOverList(): Promise<string> {
  place = { ...place, newSessionOpen: true, newFields: { cwd: null, name: "New", agent: null }, inbox: { open: true, enabled: true } };
  window.addEventListener("popstate", () => { if (refs.newSessionPending.current) window.history.pushState({ "ovis:sheet": "sheet-1" }, ""); });
  await mount(["", ""]);
  await act(async () => { draw(); });
  expect(addresses()[0]).toBe("");
  expect(addresses()[1]).toContain("new=workspace");
  return addresses()[1]!;
}

it("Back while New workspace's create is in flight over the list leaves it open, its entry made again saying its address (the sheet's push simulated)", async () => {
  const dialog = await dialogOverList();
  refs.newSessionPending.current = true;

  await back();

  expect(place.newSessionOpen).toBe(true);
  expect(index).toBe(1);
  expect(addresses()).toEqual(["", dialog]);
});

it("Back once New workspace's create has settled closes it onto the list's entry, after a Back it refused while in flight (the sheet's push simulated)", async () => {
  const dialog = await dialogOverList();
  refs.newSessionPending.current = true;
  await back();
  expect(place.newSessionOpen).toBe(true);

  refs.newSessionPending.current = false;
  await back();

  expect(place.newSessionOpen).toBe(false);
  expect(index).toBe(0);
  expect(addresses()).toEqual(["", dialog]);
  expect(window.location.search).toBe("");
});

it("writes the place held back over the entry landed on, once, when that entry leads nowhere else", async () => {
  // Given two entries of the same pane, and a sidebar that collapsed but is not drawn yet.
  place = { ...place, paneId: "p1" };
  await mount([P1, P1]);
  waiting = () => { place.sidebarCollapsed = true; };

  // When Back lands on the first.
  await back();

  // Then the entry says what is shown, by one replace, and the entry left keeps its address.
  expect(asked).toEqual([]);
  expect(writes).toEqual([`replaceState 0 ${P1}&sidebar=hidden`]);
  expect(addresses()).toEqual([`${P1}&sidebar=hidden`, P1]);
});

it("replaces the entry landed on, and pushes nothing over it, when a waiting move to that entry's own pane is drawn first", async () => {
  // Given p2 shown on its entry, and a move to p1 with the sidebar collapsed that is not drawn yet.
  await mount([P1, P2]);
  waiting = () => { place.paneId = "p1"; place.sidebarCollapsed = true; };

  // When Back lands on p1's entry and React draws the move before the address bar's listener runs.
  await back();

  // Then the handler has no pane to select, the entry says what is shown by one replace, and Forward's entry is kept.
  expect(asked).toEqual([]);
  expect(writes).toEqual([`replaceState 0 ${P1}&sidebar=hidden`]);
  expect(addresses()).toEqual([`${P1}&sidebar=hidden`, P2]);
});

it("takes no file off a later entry after a move that kept a file was drawn while Back was landing", async () => {
  // Given a file shown over p1 on its own entry, and a move to p2 that is not drawn yet.
  const file: Preview = { path: "README.md", paneId: "p1", machineId: "local" };
  place = { ...place, paneId: "p1", viewing: file };
  await mount([P2, `${P1}&file=README.md`]);
  entries[1]!.state = { [FILE_PREVIEW_KEY]: file };
  waiting = () => { place.paneId = "p2"; };

  // When Back lands on p2's entry: the move is drawn first and leaves the file behind, kept on its entry.
  await back();

  // Then p2's entry already says what is shown, so nothing is written.
  expect(place.viewing).toBeNull();
  expect(writes).toEqual([]);

  // When a file then opens over p2 as an entry of its own, and its path goes to the address.
  const opened = { [FILE_PREVIEW_KEY]: { path: "notes.md", paneId: "p2", machineId: "local" } };
  await act(async () => { window.history.pushState(opened, ""); place.viewing = opened[FILE_PREVIEW_KEY]; draw(); });

  // Then that entry still holds its file: the file kept earlier was not this write's to take off.
  expect(addresses()).toEqual([P2, `${P2}&file=notes.md`]);
  expect(entries[index]!.state).toEqual(opened);
});

it("writes at once what a listener after the handler changes: the entry is read by then", async () => {
  // Given a listener added after the hook's (App.tsx has one) whose change is drawn before the dispatch ends.
  place = { ...place, paneId: "p1" };
  await mount([P1, P1]);
  let during: string[] = [];
  window.addEventListener("popstate", () => { place.sidebarCollapsed = true; drawNow(); during = [...writes]; });

  // When Back lands.
  await back();

  // Then the place shown was written while the popstate was still being dispatched.
  expect(during).toEqual([`replaceState 0 ${P1}&sidebar=hidden`]);
  expect(writes).toEqual(during);
});

it("holds nothing once the dispatch is over, though the handler never heard the pop", async () => {
  // Given a listener that draws what was waiting and then keeps the event from every later listener.
  await mount([P1, P2]);
  waiting = () => { place.snapshot = roster(); };
  window.addEventListener("popstate", (event) => { event.stopImmediatePropagation(); });
  // the listeners run in the order they were added: that one goes before the hook's
  listeners.splice(1, 0, listeners.pop()!);

  // When Back lands.
  await back();

  // Then nothing was written over the entry while it was unread, and the handler asked for nothing.
  expect(asked).toEqual([]);
  expect(writes).toEqual([]);

  // When the app draws again after the dispatch.
  await act(async () => { place.sidebarCollapsed = true; draw(); });

  // Then the address says what is shown.
  expect(writes).toEqual([`replaceState 0 ${P2}&sidebar=hidden`]);
});

it("writes the list's place with no pane, and leaving it for the pane under it pushes one entry marked as from the list", async () => {
  // Given a phone on its list, with the app's own pick p2 under it.
  place = { ...place, inbox: { open: true, enabled: true } };
  await mount([P2]);

  // Then the address is the app's own start.
  expect(addresses()).toEqual([""]);

  // When p2 is opened from the list.
  await act(async () => { place.inbox = { ...place.inbox, open: false }; draw(); });

  // Then one entry is pushed, and its state says it was left from the list.
  expect(writes).toEqual([`pushState 1 ${P2}`]);
  expect(entries[1]!.state).toEqual(FROM_INBOX);
});

it("pushes the pane opened from the list though nothing was written while the list showed", async () => {
  // Given a phone that opened on its list before its link landed.
  place = { ...place, linkLanded: false, inbox: { open: true, enabled: true } };
  await mount([""]);

  // When the link lands with p1 opened from the list.
  await act(async () => { place.linkLanded = true; place.paneId = "p1"; place.inbox = { ...place.inbox, open: false }; draw(); });

  // Then the list's entry stays under p1's.
  expect(writes).toEqual([`pushState 1 ${P1}`]);
  expect(entries[1]!.state).toEqual(FROM_INBOX);
});

it("Back onto the list's entry shows the list and Forward its pane again, writing nothing", async () => {
  // Given p1 opened from the list.
  place = { ...place, paneId: "p1", inbox: { open: false, enabled: true } };
  await mount(["", P1]);
  entries[1]!.state = FROM_INBOX;

  // When Back lands on the list's entry.
  await back();

  // Then the list shows, and nothing is selected or written.
  expect(inboxCalls).toEqual(["show"]);
  expect(asked).toEqual([]);
  expect(writes).toEqual([]);

  // When Forward lands on p1's entry, p1 still selected under the list.
  await forward();

  // Then the list is left, and neither entry is written over nor another pushed.
  expect(inboxCalls).toEqual(["show", "leave"]);
  expect(asked).toEqual([]);
  expect(writes).toEqual([]);
  expect(addresses()).toEqual(["", P1]);
});

it("Forward from the list onto another pane selects it and pushes nothing", async () => {
  // Given the list shown by Back from p1's entry, and p2 picked under it since (a moved tab picked again).
  place = { ...place, paneId: "p1", inbox: { open: false, enabled: true } };
  await mount(["", P1]);
  entries[1]!.state = FROM_INBOX;
  await back();
  await act(async () => { place.paneId = "p2"; draw(); });
  expect(writes).toEqual([]);

  // When Forward lands on p1's entry.
  await forward();

  // Then p1 is selected over the list's place, and the history keeps its two entries.
  expect(asked).toEqual(["p1"]);
  expect(inboxCalls).toEqual(["show", "leave"]);
  expect(addresses()).toEqual(["", P1]);
  expect(entries).toHaveLength(2);
});

it("in the inbox mode another thread takes the thread's entry and keeps its mark, so Back still shows the list", async () => {
  // Given the mode's list with p1 opened from it.
  const LIST = "?app=inbox";
  const thread = (pane: string): string => `${LIST}&${pane.slice(1)}`;
  place = { ...place, paneId: "p1", mode: true, inbox: { open: false, enabled: true } };
  await mount([LIST, thread(P1)]);
  entries[1]!.state = FROM_INBOX;

  // When p2 is opened from the thread (another row beside it, the next waiting agent).
  await act(async () => { place.paneId = "p2"; draw(); });

  // Then p2 takes the thread's entry: nothing is pushed, and the entry still says the list lies under it.
  expect(writes).toEqual([`replaceState 1 ${thread(P2)}`]);
  expect(entries[1]!.state).toEqual(FROM_INBOX);
  expect(addresses()).toEqual([LIST, thread(P2)]);

  // When Back lands on the list's entry.
  await back();

  // Then the list shows.
  expect(inboxCalls).toEqual(["show"]);
});

it("outside the inbox mode a move between two panes opened from the list is still an entry", async () => {
  // Given a list that is enabled while the mode's shell is not drawn (the setup guide stands over it), with p1 opened from it.
  place = { ...place, paneId: "p1", mode: false, inbox: { open: false, enabled: true } };
  await mount(["", P1]);
  entries[1]!.state = FROM_INBOX;

  // When p2 is selected.
  await act(async () => { place.paneId = "p2"; draw(); });

  // Then the move is pushed, as it always was.
  expect(writes).toEqual([`pushState 2 ${P2}`]);
});

it("Back from the app onto the inbox mode's list shows the list, though no list was enabled as last drawn", async () => {
  // Given the app on p2, entered from the mode's list (Back to Ovis): the list is not enabled as drawn.
  place = { ...place, paneId: "p2", mode: false, inbox: { open: false, enabled: false } };
  await mount(["?app=inbox", P2]);

  // When Back lands on the list's entry.
  await back();

  // Then the list is asked to show, for the mode the entry's address says.
  expect(inboxCalls).toEqual(["show"]);
  expect(asked).toEqual([]);
  expect(writes).toEqual([]);
});

it("Back from an inbox mode thread onto the app's own start shows no list, though one was enabled as last drawn", async () => {
  // Given a thread of the mode over the app's start, which names no pane and is not the mode's.
  place = { ...place, paneId: "p1", mode: true, inbox: { open: false, enabled: true } };
  await mount(["", `?app=inbox&${P1.slice(1)}`]);

  // When Back lands on the start.
  await back();

  // Then the list is not shown: that entry is the app's, where no list stands.
  expect(inboxCalls).toEqual([]);
});

it("opens the list in place by a replace, and a window widened past a phone's leaves it by a replace", async () => {
  // Given p1 opened cold from a link on a phone that has the list.
  place = { ...place, paneId: "p1", inbox: { open: false, enabled: true } };
  await mount([P1]);

  // When the list opens over it, the window widens, and narrows again.
  await act(async () => { place.inbox = { ...place.inbox, open: true }; draw(); });
  await act(async () => { place.inbox = { ...place.inbox, enabled: false }; draw(); });
  await act(async () => { place.inbox = { ...place.inbox, enabled: true }; draw(); });

  // Then each place was written over the one entry.
  expect(writes).toEqual(["replaceState 0 ", `replaceState 0 ${P1}`, "replaceState 0 "]);
  expect(entries).toHaveLength(1);
});

it("with no list on this screen, Back onto a place with no pane shows nothing", async () => {
  // Given p1 on its entry over the app's start, the list off.
  place = { ...place, paneId: "p1" };
  await mount(["", P1]);

  // When Back lands on the start.
  await back();

  // Then nothing is asked of the list or the selection, and nothing is written.
  expect(inboxCalls).toEqual([]);
  expect(asked).toEqual([]);
  expect(writes).toEqual([]);
});

it("leaves the list alone on a Settings entry and on a sheet's step off its entry", async () => {
  // Given p1 on its entry, over an entry of Settings with no pane in its address.
  place = { ...place, paneId: "p1", inbox: { open: false, enabled: true } };
  await mount(["", P1]);
  entries[0]!.state = { "ovis:settings": { page: null, keyBar: false, depth: 1 } };

  // When Back lands on Settings' entry, and a sheet then steps off its own entry onto p1's.
  await back();
  sheetStep = true;
  await forward();

  // Then neither showed nor left the list, nor selected anything.
  expect(inboxCalls).toEqual([]);
  expect(asked).toEqual([]);
});

it("pushes a row opened from the list over the list's entry while a file is still up, not in its place", async () => {
  // Given a phone on its list over p2, a file still up on p2, and files not kept on return.
  place = { ...place, viewing: { path: "README.md", paneId: "p2", machineId: "local" }, inbox: { open: true, enabled: true } };
  await mount([""]);
  reopenFiles = false;

  // When p1 is opened from the list, leaving the file behind.
  await act(async () => { place.paneId = "p1"; place.inbox = { ...place.inbox, open: false }; draw(); });

  // Then p1's entry is pushed over the list's, which stays for Back.
  expect(writes).toEqual([`pushState 1 ${P1}`]);
  expect(addresses()).toEqual(["", P1]);
  expect(entries[1]!.state).toEqual(FROM_INBOX);
});

it("takes the New workspace dialog off its entry once it closes, before the pane it made is listed", async () => {
  // Given the dialog open over the list.
  place = { ...place, newSessionOpen: true, newFields: { cwd: null, name: "New", agent: null }, inbox: { open: true, enabled: true } };
  await mount([""]);
  await act(async () => { draw(); });
  expect(addresses()[0]).toContain("new=workspace");

  // When it closes on a new pane p3 that no roster lists yet.
  await act(async () => { place.newSessionOpen = false; place.newFields = null; place.paneId = "p3"; place.inbox = { ...place.inbox, open: false }; draw(); });

  // Then the entry it was open on says the list's place again.
  expect(addresses()).toEqual([""]);

  // When the roster lists p3.
  const listed = roster();
  listed.panes.push({ pane_id: "p3", workspace_id: "w1", focused: false } as unknown as HerdrPane);
  await act(async () => { place.snapshot = listed; draw(); });

  // Then p3's entry is pushed over the list's, and Back from it finds no dialog.
  expect(addresses()).toEqual(["", "?ws=w1-api&pane=p3&view=chat"]);
});

it("with the list off, leaves the New workspace dialog's entry as it was once it closes before the pane it made is listed", async () => {
  // Given a wide window with the list off, another PC selected with no pane, and the dialog open over it.
  place = { ...place, machineId: "remote", paneId: null, newSessionOpen: true, newFields: { cwd: null, name: "New", agent: null } };
  await mount([""]);
  await act(async () => { draw(); });
  const dialog = addresses()[0]!;
  expect(dialog).toContain("machine=remote");
  expect(dialog).toContain("new=workspace");
  writes = [];

  // When it closes on a new pane p3 that no roster lists yet.
  await act(async () => { place.newSessionOpen = false; place.newFields = null; place.paneId = "p3"; draw(); });

  // Then the entry keeps the dialog's address and PC.
  expect(writes).toEqual([]);
  expect(addresses()).toEqual([dialog]);
});

it("with the list shown, the New workspace dialog opened for another PC writes that PC, and closing it returns the list's address", async () => {
  // Given a phone on its list, the local PC selected under it.
  place = { ...place, inbox: { open: true, enabled: true } };
  await mount([""]);

  // When the dialog opens for another PC picked in the sheet of PCs, with a name typed.
  await act(async () => { place.newSessionOpen = true; place.dialogMachineId = "remote"; place.newFields = { cwd: null, name: "New", agent: null }; draw(); });

  // Then the address names that PC and the dialog's fields, over the list's one entry.
  const dialog = readLink(addresses()[0]!);
  expect(dialog.machine).toBe("remote");
  expect(dialog.create).toEqual({ kind: "workspace", cwd: null, name: "New", agent: null });
  expect(dialog.pane).toBeNull();
  expect(entries).toHaveLength(1);

  // When the dialog closes onto the list.
  await act(async () => { place.newSessionOpen = false; place.newFields = null; draw(); });

  // Then the entry says the list's place again, and no entry was added.
  expect(addresses()).toEqual([""]);
  expect(writes.every((write) => write.startsWith("replaceState 0 "))).toBe(true);
});

it("Back onto an entry that names only an absolute file keeps the list closed and the file in the address", async () => {
  // Given p1 opened from the list over an entry that names a file and no pane.
  const fileOnly = "?file=%2Ftmp%2Fnotes.txt";
  place = { ...place, paneId: "p1", inbox: { open: false, enabled: true } };
  await mount([fileOnly, P1]);
  entries[1]!.state = FROM_INBOX;
  // the file viewer's listener shows the entry's file before the address bar's runs
  waiting = () => { place.viewing = { path: "/tmp/notes.txt", paneId: null, machineId: "local" }; };

  // When Back lands on it.
  await back();

  // Then the list is not shown, and the entry still names the file.
  expect(inboxCalls).toEqual([]);
  expect(place.inbox.open).toBe(false);
  expect(readLink(addresses()[0]!).file).toBe("/tmp/notes.txt");
});

it("Back onto an entry that names only an absolute file before the PCs are in keeps the list closed and the file in the address", async () => {
  // Given p1 opened from the list over an entry that names a file and no pane, and no roster in yet.
  const fileOnly = "?file=%2Ftmp%2Fnotes.txt";
  place = { ...place, paneId: "p1", rosterOut: true, inbox: { open: false, enabled: true } };
  await mount([fileOnly, P1]);
  entries[1]!.state = FROM_INBOX;
  waiting = () => { place.viewing = { path: "/tmp/notes.txt", paneId: null, machineId: "local" }; };

  // When Back lands on it.
  await back();

  // Then the list is not shown, and the entry is left as it was.
  expect(inboxCalls).toEqual([]);
  expect(place.inbox.open).toBe(false);
  expect(addresses()).toEqual([fileOnly, P1]);

  // When the PCs come in.
  await act(async () => { place.rosterOut = false; draw(); });

  // Then the place written over the entry still names the file.
  expect(readLink(addresses()[0]!).file).toBe("/tmp/notes.txt");
});

it("with the list offered and a thread shown, the New workspace dialog opened for another PC writes the selected PC and pane, as with the list off", async () => {
  // Given p2 shown on a phone that has the list, the list not shown.
  place = { ...place, inbox: { open: false, enabled: true } };
  await mount([P2]);

  // When the dialog opens for another PC (the drawer's row of that PC), with a name typed.
  await act(async () => { place.newSessionOpen = true; place.dialogMachineId = "remote"; place.newFields = { cwd: null, name: "New", agent: null }; draw(); });

  // Then the address names the selected PC and pane with the dialog's fields, as main writes it.
  const dialog = readLink(addresses()[0]!);
  expect(dialog.machine).toBe("local");
  expect(dialog.pane).toBe("p2");
  expect(dialog.create).toEqual({ kind: "workspace", cwd: null, name: "New", agent: null });
  expect(entries).toHaveLength(1);
});

it("Back from the shown list onto an entry that names only an absolute file leaves the list over that entry, adding none", async () => {
  // Given the list shown on its entry, p1 under it, over an entry that names a file and no pane.
  const fileOnly = "?file=%2Ftmp%2Fnotes.txt";
  place = { ...place, paneId: "p1", inbox: { open: true, enabled: true } };
  await mount([fileOnly, ""]);
  waiting = () => { place.viewing = { path: "/tmp/notes.txt", paneId: null, machineId: "local" }; };

  // When Back lands on it.
  await back();

  // Then the list is left, the place is written over that entry, and the list's entry is kept for Forward.
  expect(inboxCalls).toEqual(["leave"]);
  // the entry landed on is written over once, with the pane under the list beside its file
  expect(writes).toEqual([`replaceState 0 ${P1}&file=%2Ftmp%2Fnotes.txt`]);
  expect(addresses()).toEqual([`${P1}&file=%2Ftmp%2Fnotes.txt`, ""]);
});

it("Back from the shown list onto an entry that names only an absolute file before the PCs are in leaves the list over that entry, adding none", async () => {
  // Given the list shown on its entry, p1 under it, over an entry that names a file and no pane, and no roster in yet.
  const fileOnly = "?file=%2Ftmp%2Fnotes.txt";
  place = { ...place, paneId: "p1", rosterOut: true, inbox: { open: true, enabled: true } };
  await mount([fileOnly, ""]);
  waiting = () => { place.viewing = { path: "/tmp/notes.txt", paneId: null, machineId: "local" }; };

  // When Back lands on it, and the PCs come in.
  await back();
  expect(inboxCalls).toEqual(["leave"]);
  // nothing is written before the PCs are in
  expect(writes).toEqual([]);
  expect(addresses()).toEqual([fileOnly, ""]);
  await act(async () => { place.rosterOut = false; draw(); });

  // Then the place is written over that entry, and the list's entry is kept for Forward.
  // the entry landed on is written over once, with the pane under the list beside its file
  expect(writes).toEqual([`replaceState 0 ${P1}&file=%2Ftmp%2Fnotes.txt`]);
  expect(addresses()).toEqual([`${P1}&file=%2Ftmp%2Fnotes.txt`, ""]);
});
