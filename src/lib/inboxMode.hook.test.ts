import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { NAV_KEY } from "./deepLink.ts";
import { SEEN_KEY } from "./historyKeys.ts";
import { useInboxMode, type InboxMode } from "./inboxMode.ts";

describe("useInboxMode", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let mode: InboxMode;
  /** every history write: the method, the entry it was made on and the address it left there */
  let writes: string[];
  let entries: Array<{ state: unknown; url: URL }>;
  let index: number;
  let listeners: Array<{ type: string; listener: (event: Event) => void }>;
  /** what a listener registered after the hook's saw of each pop: the event must reach it */
  let heardAfter: number;
  /** the history writes made as the page loaded */
  let loadWrites: string[];

  beforeEach(() => {
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    writes = [];
    listeners = [];
    heardAfter = 0;
    const write = (method: "pushState" | "replaceState") => (state: unknown, _unused: string, url?: string): void => {
      const entry = { state, url: url === undefined ? entries[index]!.url : new URL(url, entries[index]!.url) };
      if (method === "pushState") { entries.splice(index + 1); entries.push(entry); index += 1; } else entries[index] = entry;
      writes.push(`${method} ${index} ${entry.url.search}${entry.url.hash}`);
    };
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      get location() { return entries[index]!.url; },
      history: {
        get state() { return entries[index]!.state; },
        pushState: write("pushState"), replaceState: write("replaceState"),
        go: (steps: number): void => {
          index += steps;
          let stopped = false;
          const event = Object.assign(new Event("popstate"), { state: entries[index]!.state, stopImmediatePropagation: () => { stopped = true; } });
          for (const { type, listener } of [...listeners]) { if (type === "popstate" && !stopped) listener(event); }
        },
      },
      addEventListener: (type: string, listener: (event: Event) => void) => { listeners.push({ type, listener }); },
      removeEventListener: (type: string, listener: (event: Event) => void) => { listeners = listeners.filter((other) => other.type !== type || other.listener !== listener); },
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

  async function mount(addresses: string[], startsIn = false): Promise<void> {
    entries = addresses.map((address) => ({ state: null, url: new URL(`http://localhost:7317${address}`) }));
    index = entries.length - 1;
    function Probe() { mode = useInboxMode({ startsIn: () => startsIn }); return null; }
    await act(async () => { renderer = create(createElement(Probe)); });
    window.addEventListener("popstate", () => { heardAfter += 1; });
    loadWrites = writes;
    writes = [];
  }
  const back = (): Promise<void> => act(async () => { window.history.go(-1); });
  const forward = (): Promise<void> => act(async () => { window.history.go(1); });
  const searches = (): string[] => entries.map((entry) => entry.url.search);
  /** the page's own events, which no history step raises */
  const emit = (type: string): void => { for (const item of [...listeners]) if (item.type === type) item.listener(new Event(type)); };

  it("is off on the app's own address and on on the mode's, and at load only marks the entry the page loaded on, its address as it was", async () => {
    await mount(["/?ws=w1-api&pane=p1&view=chat"]);
    expect([mode.on, mode.at()]).toEqual([false, false]);
    expect(loadWrites).toEqual(["replaceState 0 ?ws=w1-api&pane=p1&view=chat"]);
    expect(entries[0]!.state).toEqual({ [SEEN_KEY]: true });
    await act(async () => { renderer?.unmount(); });

    // opened by its own address: the mode, with nothing of the app pushed under or over it
    await mount(["/?app=inbox"]);
    expect([mode.on, mode.at()]).toEqual([true, true]);
    expect(loadWrites).toEqual(["replaceState 0 ?app=inbox"]);
    expect(entries).toHaveLength(1);
    await act(async () => { renderer?.unmount(); });

    // reloaded on an entry of the app's own: nothing is written on it
    entries = [{ state: { [NAV_KEY]: true }, url: new URL("http://localhost:7317/?app=inbox") }];
    index = 0;
    function Probe() { mode = useInboxMode({}); return null; }
    await act(async () => { renderer = create(createElement(Probe)); });
    expect(writes).toEqual([]);
    expect(entries[0]!.state).toEqual({ [NAV_KEY]: true });
  });

  it("marks an entry left without a state by the time the page is hidden or left, and writes on none that has one", async () => {
    const page = { visibilityState: "visible", changed: [] as Array<() => void> };
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      get visibilityState() { return page.visibilityState; },
      // no hosted shell around the app (lib/shellMode.ts)
      querySelector: () => null,
      addEventListener: (_type: "visibilitychange", listener: () => void) => { page.changed.push(listener); },
      removeEventListener: (_type: "visibilitychange", listener: () => void) => { page.changed = page.changed.filter((other) => other !== listener); },
    } });
    const visibility = (state: string): void => { page.visibilityState = state; for (const listener of [...page.changed]) listener(); };
    await mount(["/?pane=p1"]);
    // Given the entry has no state again, as the auth link's own replace leaves it.
    window.history.replaceState(null, "", "/?pane=p1");
    writes = [];

    // When the page comes to the front, nothing is written; when it is hidden, the entry is marked where it stands.
    visibility("visible");
    expect(writes).toEqual([]);
    visibility("hidden");
    expect(writes).toEqual(["replaceState 0 ?pane=p1"]);
    expect(entries[0]!.state).toEqual({ [SEEN_KEY]: true });

    // an entry that has a state is written on no more: hidden again, left, or one of the app's own
    visibility("hidden");
    emit("pagehide");
    await act(async () => { mode.enter(); });
    emit("pagehide");
    expect(writes).toEqual(["replaceState 0 ?pane=p1", "pushState 1 ?pane=p1&app=inbox"]);
    expect(entries[1]!.state).toEqual({ [NAV_KEY]: true });

    // leaving the page marks one too
    window.history.replaceState(null, "", "/?pane=p1&app=inbox");
    emit("pagehide");
    expect(entries[1]!.state).toEqual({ [SEEN_KEY]: true });

    // and nothing listens once the app is gone
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    expect(page.changed).toEqual([]);
    expect(listeners.filter((item) => item.type === "pagehide")).toEqual([]);
  });

  it("enters by one entry that keeps the address's other parameters, and Back and Forward follow it", async () => {
    await mount(["/?ws=w1-api&pane=p1&view=chat"]);

    await act(async () => { mode.enter(); });
    expect(mode.on).toBe(true);
    expect(writes).toEqual(["pushState 1 ?ws=w1-api&pane=p1&view=chat&app=inbox"]);
    expect(entries[1]!.state).toEqual({ [NAV_KEY]: true });

    await back();
    expect([mode.on, mode.at()]).toEqual([false, false]);
    await forward();
    expect([mode.on, mode.at()]).toEqual([true, true]);
    expect(writes).toHaveLength(1);
    expect(heardAfter).toBe(2);
  });

  it("leaves by one entry, and Back returns to the mode", async () => {
    await mount(["/?app=inbox&ws=w1-api&pane=p1&view=chat"]);

    await act(async () => { mode.leave(); });
    expect(mode.on).toBe(false);
    expect(writes).toEqual(["pushState 1 ?ws=w1-api&pane=p1&view=chat"]);

    await back();
    expect(mode.on).toBe(true);
    expect(searches()).toEqual(["?app=inbox&ws=w1-api&pane=p1&view=chat", "?ws=w1-api&pane=p1&view=chat"]);
  });

  it("pushes nothing when asked for the mode it is already in", async () => {
    await mount(["/?app=inbox"]);
    await act(async () => { mode.enter(); });
    expect(writes).toEqual([]);
    await act(async () => { renderer?.unmount(); });

    await mount(["/?pane=p1"]);
    await act(async () => { mode.leave(); });
    expect(writes).toEqual([]);
  });

  it("says where the history is before React has drawn it", async () => {
    await mount(["/?pane=p1", "/?app=inbox"]);
    let seen: boolean[] = [];
    // registered before the hook's own listener would be: it reads the entry the pop landed on, not the drawn mode
    listeners.unshift({ type: "popstate", listener: () => { seen = [mode.on, mode.at()]; } });

    await back();

    expect(seen).toEqual([true, false]);
    expect(mode.on).toBe(false);
  });

  it("starts in the mode on a device that says so, its address taking the mark by a replace with nothing pushed", async () => {
    await mount(["/"], true);
    expect([mode.on, mode.at()]).toEqual([true, true]);
    // one replace says the mode and marks the entry
    expect(loadWrites).toEqual(["replaceState 0 ?app=inbox"]);
    expect(entries).toEqual([{ state: { [SEEN_KEY]: true }, url: new URL("http://localhost:7317/?app=inbox") }]);
    await act(async () => { renderer?.unmount(); });

    // a tapped alert's address keeps its pane: the mode opens on that thread
    await mount(["/?pane=p1&view=chat"], true);
    expect(mode.on).toBe(true);
    expect(loadWrites).toEqual(["replaceState 0 ?pane=p1&view=chat&app=inbox"]);
    await act(async () => { renderer?.unmount(); });

    // an address already the mode's is left as it is
    await mount(["/?app=inbox"], true);
    expect(loadWrites).toEqual(["replaceState 0 ?app=inbox"]);
  });

  it("hands the shell one ref for its blocked drawer, set from the mode the page loads in", async () => {
    await mount(["/?app=inbox"]);
    const blocked = mode.drawerBlocked;
    expect(blocked.current).toBe(true);
    // the shell says later whether its drawer is blocked (the setup guide keeps the classic one): the ref is the same object
    await act(async () => { mode.leave(); });
    expect(mode.drawerBlocked).toBe(blocked);
    await act(async () => { renderer?.unmount(); });
    await mount(["/"]);
    expect(mode.drawerBlocked.current).toBe(false);
  });

  it("writes the mode into the hosted shell's fragment", async () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelector: () => ({ getAttribute: () => "relay" }), addEventListener: () => {}, removeEventListener: () => {} } });
    const scope = `/s/${"ab".repeat(16)}/`;
    await mount([`${scope}#pane=p1`]);
    expect(mode.on).toBe(false);

    await act(async () => { mode.enter(); });

    expect(writes).toEqual(["pushState 1 #pane=p1&app=inbox"]);
    expect([mode.on, mode.at()]).toEqual([true, true]);
  });
});
