import { afterEach, beforeEach, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DEFAULT_SETTINGS } from "./settings.ts";
import { FILE_PREVIEW_KEY, sheetStep } from "./historyKeys.ts";
import { useFilePanels } from "./useFilePanels.ts";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let panels: ReturnType<typeof useFilePanels>;
let entries: unknown[];
let index: number;
let events: EventTarget;

beforeEach(() => {
  for (const key of ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  entries = [{ "ovis:nav": true }];
  index = 0;
  events = new EventTarget();
  // a history whose Back lands at once, with its popstate
  const go = (steps: number): void => {
    index += steps;
    events.dispatchEvent(Object.assign(new Event("popstate"), { state: entries[index] }));
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: new URL("http://localhost:7317/"),
    history: {
      get state() { return entries[index]; },
      replaceState: (next: unknown) => { entries[index] = next; },
      pushState: (next: unknown) => { entries.splice(index + 1); entries.push(next); index += 1; },
      go,
    },
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

async function mount(reopenFileOnReturn: boolean): Promise<void> {
  function Probe() {
    panels = useFilePanels({
      settings: { ...DEFAULT_SETTINGS, reopenFileOnReturn },
      filePanelAvailable: true, selectedPaneId: "p1", selectedMachineId: "local",
    });
    return null;
  }
  await act(async () => { renderer = create(createElement(Probe)); });
}

const fileOn = (pane: string, path = `/r/${pane}.md`) => ({ path, paneId: pane, machineId: "local" });
const fileOf = (state: unknown): unknown => (state as Record<string, unknown> | undefined)?.[FILE_PREVIEW_KEY];
/** What useAddressBar does for a move to another pane: the move's entry, then the file left there. */
async function moveTo(pane: string, kept: boolean): Promise<void> {
  await act(async () => {
    if (kept) window.history.pushState({ "ovis:nav": true }, "");
    else window.history.replaceState({ "ovis:nav": true }, "");
    panels.restoreFile("local", pane);
  });
}

it("off: a tab switch releases the file from its entry and the file never comes back", async () => {
  // Given a file open on p1 with Reopen files on return off.
  await mount(false);
  await act(async () => { panels.openFile(fileOn("p1")); });

  // When the selection moves to p2 and back to p1.
  let kept = true;
  await act(async () => { kept = panels.leaveFile(); });
  await moveTo("p2", kept);
  await moveTo("p1", false);

  // Then the entry lost the file and the viewer stays closed.
  expect(kept).toBe(false);
  expect(panels.viewing).toBeNull();
  expect(entries.some((entry) => fileOf(entry) !== undefined)).toBe(false);
});

it("on: the file's entry keeps it for Back, and a switch back opens it over the move's entry", async () => {
  // Given a file open on p1 with Reopen files on return on.
  await mount(true);
  await act(async () => { panels.openFile(fileOn("p1")); });

  // When the selection moves to p2.
  let kept = false;
  await act(async () => { kept = panels.leaveFile(); });
  await moveTo("p2", kept);

  // Then the viewer closes, but the entry under the move still holds the file.
  expect(kept).toBe(true);
  expect(panels.viewing).toBeNull();
  expect(fileOf(entries[1])).toEqual(fileOn("p1"));

  // When an in-app switch goes back to p1.
  await moveTo("p1", true);

  // Then the file shows again on an entry of its own above the move's.
  expect(panels.viewing).toEqual(fileOn("p1"));
  expect(fileOf(entries[index])).toEqual(fileOn("p1"));
  expect(fileOf(entries[index - 1])).toBeUndefined();

  // When it is closed there.
  await act(async () => { panels.closeFile(); });

  // Then Close steps back onto the move's entry only, and the next switch back does not reopen it.
  expect(panels.viewing).toBeNull();
  expect(fileOf(entries[index])).toBeUndefined();
  await moveTo("p1", true);
  expect(panels.viewing).toBeNull();
});

it("on: a file shown again by Back and closed there is not reopened by a later switch", async () => {
  // Given a file left on p1 by a switch to p2.
  await mount(true);
  await act(async () => { panels.openFile(fileOn("p1")); });
  await act(async () => { panels.leaveFile(); });
  await moveTo("p2", true);

  // When Back shows it again on p1, and it is closed there.
  await act(async () => { window.history.go(-1); });
  expect(panels.viewing).toEqual(fileOn("p1"));
  await act(async () => { panels.closeFile(); });

  // Then a later switch back to p1 leaves it closed.
  await moveTo("p1", true);
  expect(panels.viewing).toBeNull();
});

it("on: a closed tab's file gives its place up before the oldest live one is forgotten", async () => {
  // Given files left on ten panes, one of which (p5) has since closed.
  await mount(true);
  for (let pane = 0; pane < 10; pane++) {
    await act(async () => { panels.openFile(fileOn(`p${pane}`)); });
    await act(async () => { panels.leaveFile(); });
    await moveTo("elsewhere", true);
  }

  // When an eleventh is left while p5 is no longer in the roster.
  await act(async () => { panels.openFile(fileOn("p10")); });
  await act(async () => { panels.leaveFile((_machine, pane) => pane !== "p5"); });
  await moveTo("elsewhere", true);

  // Then p0, the oldest, keeps its place, which the closed tab gave up.
  await moveTo("p0", true);
  expect(panels.viewing).toEqual(fileOn("p0"));
});

it("on: the file of a tab that just closed, or one opened for another pane than the one shown, is released", async () => {
  // Given a file open on p1 with Reopen files on return on.
  await mount(true);
  await act(async () => { panels.openFile(fileOn("p1")); });

  // When the move leaves it while p1 is no longer in the roster.
  let kept = true;
  await act(async () => { kept = panels.leaveFile((_machine, pane) => pane !== "p1"); });

  // Then its entry loses it and nothing waits for p1.
  expect(kept).toBe(false);
  expect(fileOf(entries[index])).toBeUndefined();
  await moveTo("p1", true);
  expect(panels.viewing).toBeNull();

  // When a file opened for p2 while another pane is shown is left.
  await act(async () => { panels.openFile(fileOn("p2")); });
  await act(async () => { kept = panels.leaveFile(undefined, false); });

  // Then it is released as well.
  expect(kept).toBe(false);
  expect(fileOf(entries[index])).toBeUndefined();
  await moveTo("p2", true);
  expect(panels.viewing).toBeNull();
});

it("on: a remembered tab that closes is forgotten, so a later pane with its id opens no file", async () => {
  // Given a file left on p1.
  await mount(true);
  await act(async () => { panels.openFile(fileOn("p1")); });
  await act(async () => { panels.leaveFile(); });
  await moveTo("p2", true);

  // When the roster no longer lists p1, and a new pane with that id is selected later.
  await act(async () => { panels.forgetLeftFiles((_machine, pane) => pane !== "p1"); });
  await moveTo("p1", true);

  // Then no file opens on it.
  expect(panels.viewing).toBeNull();
});

it("on: keeps the files of the ten panes left last", async () => {
  // Given files left on eleven panes in turn.
  await mount(true);
  for (let pane = 0; pane <= 10; pane++) {
    await act(async () => { panels.openFile(fileOn(`p${pane}`)); });
    await act(async () => { panels.leaveFile(); });
    await moveTo("elsewhere", true);
  }

  // Then the oldest is forgotten and the newest still comes back.
  await moveTo("p0", true);
  expect(panels.viewing).toBeNull();
  await moveTo("p10", true);
  expect(panels.viewing).toEqual(fileOn("p10"));
});

it("does not show again a file whose entry the file list goes onto to take for its own", async () => {
  // Given a file the user's Back closed: its entry lies ahead, still naming the file.
  await mount(false);
  await act(async () => { panels.openFile(fileOn("p1")); });
  await act(async () => { window.history.go(-1); });
  expect(panels.viewing).toBeNull();
  expect(fileOf(entries[1])).toEqual(fileOn("p1"));

  // When the file list, in front again, goes onto that entry (lib/sheetHistory.ts says so for the event).
  const answering = sheetStep.taking;
  sheetStep.taking = () => true;
  try { await act(async () => { window.history.go(1); }); } finally { sheetStep.taking = answering; }

  // Then the file stays closed; a Forward of the user's onto a file's entry still shows it.
  expect(panels.viewing).toBeNull();
  await act(async () => { window.history.go(-1); });
  await act(async () => { window.history.go(1); });
  expect(panels.viewing).toEqual(fileOn("p1"));
});

it("does not show again a diff whose entry the file list goes onto to take for its own", async () => {
  // Given a diff the user's Back closed: its entry lies ahead, still naming the diff.
  await mount(false);
  const diff = { machineId: "local", paneId: "p1", directory: "/r", path: "b.md", oldPath: null, scope: "workspace" as const, base: null, head: null, comparison: null };
  await act(async () => { panels.openDiff(diff); });
  expect(panels.diffViewing).toEqual(diff);
  await act(async () => { window.history.go(-1); });
  expect(panels.diffViewing).toBeNull();

  // When the file list goes onto that entry.
  const answering = sheetStep.taking;
  sheetStep.taking = () => true;
  try { await act(async () => { window.history.go(1); }); } finally { sheetStep.taking = answering; }

  // Then the diff stays closed.
  expect(panels.diffViewing).toBeNull();
});
