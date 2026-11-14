import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test";
import { sheetStep } from "./historyKeys.ts";

/**
 * The module on a browser whose Back skips the entries of a page that added one with no tap since
 * the last Back or Forward (Chromium): it is told by `navigator.userActivation` and a Chrome user
 * agent, read once when the module loads, so this file has a browser of its own.
 */
let originalWindow: PropertyDescriptor | undefined;
let originalNavigator: PropertyDescriptor | undefined;

/** A history with the browser's key for each entry (kept by a replace, new with a push), the Navigation API's way onto one, and taps. */
function fakeBrowser() {
  let keys = 0;
  const entries: Array<{ state: unknown; href: string; key: string }> = [{ state: null, href: "/?pane=a", key: "k0" }];
  let index = 0;
  const activation = { isActive: false };
  /** the browser drops the next traversal asked for by key, as when another one overtakes it */
  let dropping = false;
  type Pop = { state: unknown; stopImmediatePropagation: () => void };
  const listeners = new Map<string, Array<(event: Pop) => void>>();
  const land = (next: number): void => {
    if (next === index || next < 0 || next >= entries.length) return;
    index = next;
    queueMicrotask(() => {
      // one event for every listener in the order they were added, until one stops it
      let stopped = false;
      const event: Pop = { state: entries[index]!.state, stopImmediatePropagation: () => { stopped = true; } };
      for (const listener of listeners.get("popstate") ?? []) { if (stopped) break; listener(event); }
    });
  };
  const history = {
    get state() { return entries[index]!.state; },
    pushState(state: unknown, _title: string, url?: string | null) { entries.splice(index + 1); keys += 1; entries.push({ state, href: url ?? entries[index]!.href, key: `k${keys}` }); index += 1; },
    replaceState(state: unknown, _title: string, url?: string | null) { entries[index] = { state, href: url ?? entries[index]!.href, key: entries[index]!.key }; },
    back() { land(index - 1); },
    forward() { land(index + 1); },
    go(by: number) { land(index + by); },
  };
  const window = {
    history,
    get location() { return { href: entries[index]!.href }; },
    navigation: {
      get currentEntry() { return { key: entries[index]!.key, index }; },
      traverseTo(key: string) {
        if (dropping) return { committed: Promise.reject(new Error("dropped")), finished: Promise.reject(new Error("dropped")) };
        land(entries.findIndex((entry) => entry.key === key));
        return { committed: Promise.resolve(), finished: Promise.resolve() };
      },
    },
    addEventListener(type: string, listener: (event: Pop) => void) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  return {
    window, entries, activation,
    at: () => index,
    key: () => entries[index]!.key,
    drop: (on: boolean) => { dropping = on; },
    /** a tap the browser counts as one */
    tap: () => { activation.isActive = true; for (const listener of listeners.get("pointerup") ?? []) listener({ state: null, stopImmediatePropagation: () => {} }); },
  };
}
const fake = fakeBrowser();
const h = fake.window.history;
const settled = async () => {
  jest.advanceTimersByTime(1);
  for (let i = 0; i < 6; i++) await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
};
let sheetHistory: typeof import("./sheetHistory.ts");
const enter = (onBack: () => boolean | void, returns = false): (() => void) => { const id = sheetHistory.enterSheet(onBack, null, false, returns); return () => sheetHistory.leaveSheet(id); };

beforeAll(async () => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fake.window });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36", userActivation: fake.activation } });
  const modulePath = "./sheetHistory.ts?sheet-history-skips-test";
  sheetHistory = await import(modulePath);
});
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator");
});

describe("a phone's sheet where Back skips an entry made with no tap", () => {
  it("waits for a tap to make the entry of a sheet that opened with none, and makes it then", async () => {
    const start = fake.at();
    let closed = 0;
    // the page has seen no tap yet: a request that shows by itself
    const leave = enter(() => { closed += 1; });
    expect(fake.entries.length).toBe(start + 1);
    fake.tap();
    expect(fake.entries.length).toBe(start + 2); expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("makes no entry for a sheet that opens after a Back with no new tap, until one comes", async () => {
    const start = fake.at();
    fake.tap();
    const leaveFirst = enter(() => {});
    h.back(); await settled();
    leaveFirst(); await settled();
    expect(fake.at()).toBe(start);
    const entries = fake.entries.length;
    const leaveSecond = enter(() => {});
    await settled();
    expect(fake.entries.length).toBe(entries); expect(fake.at()).toBe(start);
    fake.tap();
    expect(fake.at()).toBe(start + 1);
    leaveSecond(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("goes again onto the entry of a sheet that refuses Back, and tells the app both steps were the sheet's own", async () => {
    const start = fake.at();
    let busy = true;
    let asked = 0;
    const own: boolean[] = [];
    fake.window.addEventListener("popstate", () => { own.push(sheetHistory.sheetSteppedOff()); });
    fake.tap();
    const leave = enter(() => { asked += 1; if (busy) return false; });
    const entry = fake.key();
    const entries = fake.entries.length;
    h.back(); await settled();
    // the same entry, by the browser's key: none was added, so the next Back still finds it
    expect(asked).toBe(1); expect(fake.key()).toBe(entry); expect(fake.entries.length).toBe(entries);
    expect(own).toEqual([true, true]);
    busy = false;
    h.back(); await settled();
    expect(asked).toBe(2); expect(fake.at()).toBe(start);
    expect(own).toEqual([true, true, false]);
    leave(); await settled();
  });

  it("makes the entry of a sheet that refused Back at the next tap, when the way back onto its old one is dropped", async () => {
    const start = fake.at();
    let busy = true;
    fake.tap();
    const leave = enter(() => { if (busy) return false; });
    const entries = fake.entries.length;
    fake.drop(true);
    h.back(); await settled();
    fake.drop(false);
    // still up, on the entry it opened over, with none added behind the user's back
    expect(fake.at()).toBe(start); expect(fake.entries.length).toBe(entries);
    fake.tap();
    expect(fake.at()).toBe(start + 1);
    busy = false;
    h.back(); await settled();
    expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("goes again onto the entry the sheet on top took from the one under it, which Back leaves up", async () => {
    const start = fake.at();
    let drawerClosed = 0;
    let menuClosed = 0;
    fake.tap();
    const leaveDrawer = enter(() => { drawerClosed += 1; });
    const entry = fake.key();
    fake.tap();
    const leaveMenu = enter(() => { menuClosed += 1; });
    const entries = fake.entries.length;
    expect(fake.key()).toBe(entry);
    h.back(); await settled();
    expect(menuClosed).toBe(1); expect(drawerClosed).toBe(0);
    expect(fake.key()).toBe(entry); expect(fake.entries.length).toBe(entries);
    leaveMenu(); await settled();
    expect(fake.key()).toBe(entry);
    // with no tap between: the entry Back lands off is the drawer's own again
    h.back(); await settled();
    expect(drawerClosed).toBe(1); expect(fake.at()).toBe(start);
    leaveDrawer(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("steps off the entry again when the sheet it came back for closed before the way back landed", async () => {
    const start = fake.at();
    let drawerClosed = 0;
    fake.tap();
    const leaveDrawer = enter(() => { drawerClosed += 1; });
    fake.tap();
    const leaveMenu = enter(() => {});
    // the drawer closes by itself while the history is on its way back onto the entry for it: an
    // app's listener, after the module's, closes it as the Back that closed the menu is heard, and
    // its own leave runs before that way back lands (a browser lands a traversal later than a timer)
    let closing = true;
    fake.window.addEventListener("popstate", () => { if (closing) { closing = false; leaveDrawer(); jest.advanceTimersByTime(1); } });
    h.back(); await settled(); await settled();
    leaveMenu(); await settled();
    // no entry is left marked for a drawer that is gone: the next Back would have closed nothing
    expect(fake.at()).toBe(start);
    expect(drawerClosed).toBe(0);
    expect(sheetHistory.sheetSteppedOff()).toBe(true);
  });

  it("makes the entry of a sheet that opens with no new tap after a closed sheet's own step: the tap before it still counts", async () => {
    const start = fake.at();
    fake.tap();
    const leaveFirst = enter(() => {});
    expect(fake.at()).toBe(start + 1);
    // closed by its own control: the page steps back by itself, no Back of the user's
    leaveFirst(); await settled();
    expect(fake.at()).toBe(start);
    let closed = 0;
    const leaveSecond = enter(() => { closed += 1; });
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leaveSecond(); await settled();
  });

  it("takes the entry the user's Back left for the file list that comes back in front with it, and tells the file's viewer the way onto it is not its own", async () => {
    const start = fake.at();
    const address = fake.window.location.href;
    // the file viewer's listener, added after the module's as the app's are: the file each traversal lands on, unless told it is being taken
    const shown: unknown[] = [];
    fake.window.addEventListener("popstate", (event) => { shown.push(sheetStep.taking(event as unknown as Event) ? "taken" : (event.state as Record<string, unknown> | null)?.["file"] ?? null); });
    fake.tap();
    // a file opened from the file list, which gave it its entry and Back with it, then the user's Back
    h.pushState({ file: "notes.txt" }, "", "/?pane=a&file=notes.txt");
    const fileEntry = fake.key();
    h.back(); await settled();
    expect(shown).toEqual([null]);
    // the list is in front again, with no tap since: it goes onto the file's old entry and takes it
    let closed = 0;
    const entries = fake.entries.length;
    const leave = enter(() => { closed += 1; }, true);
    await settled();
    expect(fake.key()).toBe(fileEntry); expect(fake.entries.length).toBe(entries);
    expect((h.state as Record<string, unknown>)["file"]).toBeUndefined();
    expect(typeof (h.state as Record<string, unknown>)["ovis:sheet"]).toBe("string");
    expect(fake.window.location.href).toBe(address);
    expect(sheetHistory.sheetSteppedOff()).toBe(true);
    expect(shown).toEqual([null, "taken"]);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    expect(shown).toEqual([null, "taken", null]);
    leave(); await settled();
  });

  it("goes back off that entry when the list closed before the way onto it landed, and the file is not shown again", async () => {
    const start = fake.at();
    const shown: unknown[] = [];
    fake.window.addEventListener("popstate", (event) => { shown.push(sheetStep.taking(event as unknown as Event) ? "taken" : (event.state as Record<string, unknown> | null)?.["file"] ?? null); });
    fake.tap();
    h.pushState({ file: "notes.txt" }, "");
    h.back(); await settled();
    const leave = enter(() => {}, true);
    // the way onto the file's old entry is under way, and the list closes before it lands
    expect(fake.at()).toBe(start + 1);
    leave();
    await settled(); await settled();
    expect(fake.at()).toBe(start);
    expect(shown).toEqual([null, "taken", null]);
    expect(sheetHistory.sheetSteppedOff()).toBe(true);
  });

  it("waits for a tap after all when the browser drops the way onto the entry the Back left", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ file: "notes.txt" }, "");
    h.back(); await settled();
    fake.drop(true);
    let closed = 0;
    const leave = enter(() => { closed += 1; }, true);
    await settled();
    fake.drop(false);
    expect(fake.at()).toBe(start);
    fake.tap();
    expect(fake.at()).toBe(start + 1);
    expect(typeof (h.state as Record<string, unknown>)["ovis:sheet"]).toBe("string");
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("leaves the entry ahead alone once a tap came: the sheet makes its own", async () => {
    const start = fake.at();
    fake.tap();
    h.pushState({ file: "notes.txt" }, "");
    const fileEntry = fake.key();
    h.back(); await settled();
    fake.tap();
    const leave = enter(() => {}, true);
    await settled();
    expect(fake.at()).toBe(start + 1); expect(fake.key()).not.toBe(fileEntry);
    leave(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("makes the entry of a dialog that comes back from under a file closed by its own control, with no new tap", async () => {
    const start = fake.at();
    fake.tap();
    // Files, and a file opened from it: the file takes Files' entry, and Files gives up Back while the file is up
    const leaveFiles = enter(() => {});
    h.pushState({ file: true }, "");
    leaveFiles(); await settled();
    expect(fake.at()).toBe(start + 1);
    // the file closes by its X: its own step back, told to the sheets (lib/historyNavigation.ts)
    expect(sheetStep.goingBack(h.state)).toBe(false);
    h.go(-1); await settled();
    expect(fake.at()).toBe(start);
    // Files is on top again: its entry is made at once, and Back closes it
    let closed = 0;
    const leaveAgain = enter(() => { closed += 1; });
    expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leaveAgain(); await settled();
  });

  it("makes the entry of a sheet left up by a step the app took by itself at once, where the step landed", async () => {
    const start = fake.at();
    fake.tap();
    // a dialog with an entry of its own (Settings), and a sheet that opens as the dialog closes by itself
    h.pushState({ dialog: true }, "");
    let closed = 0;
    const leave = enter(() => { closed += 1; });
    expect(fake.at()).toBe(start + 2);
    // the dialog steps back past its own entry and the sheet's over it
    expect(sheetStep.goingBack(h.state)).toBe(true);
    h.go(-2); await settled();
    expect(closed).toBe(0);
    expect(fake.at()).toBe(start + 1); expect(fake.entries.length).toBe(start + 2);
    expect((h.state as Record<string, unknown>)["dialog"]).toBeUndefined();
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });
});
