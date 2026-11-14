import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import * as ReactDom from "react-dom";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, InteractivePrompt } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { inboxKey, inboxOrder, type InboxFilter } from "../lib/agentInbox.ts";
import * as api from "../lib/api.ts";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { AGENT_GROUP_SORT_STORAGE_KEY, SettingsProvider } from "../lib/settings.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";

// the prompt read is the only request the list makes: each test answers it itself
let answerPrompt: (prompt: InteractivePrompt | null) => void = () => {};
let promptReads = 0;
let presses: string[] = [];
await mock.module("../lib/api.ts", () => ({
  ...api,
  fetchPanePromptState: () => {
    promptReads++;
    return new Promise<{ prompt: InteractivePrompt | null }>((resolve) => { answerPrompt = (prompt) => resolve({ prompt }); });
  },
}));
await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
// the sheet of PCs as the list hands it over (RowMenu's own drawing is RowMenu's tests'): its props are what is read
const rowMenu = await import("./RowMenu.tsx");
function RowMenu(_props: Parameters<typeof rowMenu.RowMenu>[0]) { return null; }
await mock.module("./RowMenu.tsx", () => ({ ...rowMenu, RowMenu }));
const { AgentInbox } = await import("./AgentInbox.tsx");
const { newQuestionReads } = await import("../lib/useInboxQuestions.ts");

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const activity: SidebarActivity = {
  seqs: () => new Map(),
  status: (_machineId, pane) => pane.agent_status as AgentStatus | undefined,
};

/** the fixture's state, but with some panes in another state: a row that would move */
const statusOf = (moved: Record<string, AgentStatus>): SidebarActivity => ({
  seqs: () => new Map(),
  status: (_machineId, pane) => moved[pane.pane_id] ?? pane.agent_status as AgentStatus | undefined,
});

function roster(edit: (pane: HerdrPane) => HerdrPane = (pane) => pane, state: Machine["state"] = "connected"): Machine[] {
  return structuredClone(fixture).map((machine) => ({
    ...machine, state,
    snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map(edit) },
  }));
}

const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const byClass = (root: ReactTestInstance, name: string): ReactTestInstance[] =>
  root.findAll((node) => typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(" ").includes(name));

describe("AgentInbox", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  // the page's reader (lib/useInbox.ts), which outlives each mount of the list
  let questionReads: ReturnType<typeof newQuestionReads>;

  beforeEach(() => {
    promptReads = 0;
    questionReads = newQuestionReads();
    presses = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      history: { state: null, pushState() {}, replaceState() {}, back() {} },
      cancelAnimationFrame() {},
      location: { href: "http://localhost/", search: "" },
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      body: { nodeType: 1, children: [] },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
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

  interface DrawOptions {
    filter?: InboxFilter; query?: string; watching?: boolean; activity?: SidebarActivity; scrollTop?: number;
    /** how far the scroller can scroll at first: a scrollTop past it is clamped, as a browser does */
    scrollMax?: number;
    onFilter?: (filter: InboxFilter) => void; onQuery?: (query: string) => void;
    onOpen?: (machineId: string, paneId: string) => void; onNew?: (machineId: string) => void;
  }
  // each drawn host node's stand-in, by its class (the section by its tag), and every focus call made on them
  let nodes = new Map<string, { scrollTop: number; focus(options?: FocusOptions): void }>();
  let focused: { node: string; options?: FocusOptions }[] = [];
  let scroll = { current: 0 };
  let scrollMax = Number.POSITIVE_INFINITY;
  let drawn: { machines: Machine[]; options: DrawOptions } = { machines: [], options: {} };
  const view = (machines: Machine[], options: DrawOptions): ReactElement => <SettingsProvider><PanePressContext.Provider value={(machineId, paneId) => presses.push(`${machineId}/${paneId}`)}>
    <AgentInbox machines={machines} activity={options.activity ?? activity} watching={options.watching ?? false} filter={options.filter ?? "all"} onFilter={options.onFilter ?? (() => {})}
      query={options.query ?? ""} onQuery={options.onQuery ?? (() => {})} scroll={scroll} onOpen={options.onOpen ?? (() => {})} onNew={options.onNew ?? (() => {})} questionReads={questionReads} />
  </PanePressContext.Provider></SettingsProvider>;
  const draw = async (machines: Machine[], options: DrawOptions = {}) => {
    nodes = new Map();
    focused = [];
    scroll = { current: options.scrollTop ?? 0 };
    scrollMax = options.scrollMax ?? Number.POSITIVE_INFINITY;
    drawn = { machines, options };
    await act(async () => {
      renderer = create(view(machines, options), { createNodeMock: (element) => {
        const name = element.type === "section" ? "section" : String((element.props as { className?: string }).className ?? element.type);
        let top = 0;
        const node = {
          get scrollTop() { return top; },
          set scrollTop(value: number) { top = Math.min(value, scrollMax); },
          focus(focusOptions?: FocusOptions) { focused.push({ node: name, options: focusOptions }); },
        };
        nodes.set(name, node);
        return node;
      } });
    });
    return renderer!.root;
  };
  /** draws again with the same props but those given */
  const redraw = async (change: { machines?: Machine[] } & DrawOptions) => {
    const { machines = drawn.machines, ...options } = change;
    drawn = { machines, options: { ...drawn.options, ...options } };
    await act(async () => { renderer!.update(view(drawn.machines, drawn.options)); });
  };
  const order = (root: ReactTestInstance) => byClass(root, "inbox-item").map((node) => node.props["data-pane"] as string);
  const twoPcs = (second: Machine["state"] = "connected"): Machine[] => {
    const [local] = roster();
    return [local!, { ...structuredClone(local!), id: "laptop", name: "Laptop", state: second }];
  };
  const newButton = { isConnected: true, focus() {}, querySelector: () => null, closest: () => null };
  const item = (root: ReactTestInstance, paneId: string) => byClass(root, "inbox-item").find((node) => node.props["data-pane"] === paneId)!;

  it("orders the rows inside a state as this device's Within a state does: the longest wait first, or by the Agents list's names", async () => {
    // every agent resting, each changed at another time: by wait, by name and in herdr's order they all differ
    const seqs = new Map([["w1C:p1", 1], ["w1E:p1", 2], ["w1F:p1", 3], ["w1D:p1", 4]]);
    const resting: SidebarActivity = { seqs: () => seqs, status: () => "idle" };
    expect(order(await draw(roster(), { activity: resting }))).toEqual(["w1C:p1", "w1E:p1", "w1F:p1", "w1D:p1"]);
    await act(async () => { renderer?.unmount(); });

    // the device's choice, kept in a key of its own (lib/settings.ts)
    const stored: Record<string, string> = { [AGENT_GROUP_SORT_STORAGE_KEY]: JSON.stringify("name") };
    Object.assign(window, { localStorage: { getItem: (key: string) => stored[key] ?? null, setItem() {}, removeItem() {} } });
    expect(order(await draw(roster(), { activity: resting }))).toEqual(["w1D:p1", "w1C:p1", "w1F:p1", "w1E:p1"]);
  });

  it("draws one row per agent, in the inbox's order", async () => {
    const machines = roster();
    const root = await draw(machines);
    const keys = byClass(root, "inbox-item").map((node) => `${node.props["data-machine"]}:${node.props["data-pane"]}`);
    expect(keys).toEqual(inboxOrder(machines, activity).map(inboxKey));
    expect(keys.length).toBeGreaterThan(1);
  });

  it("marks a waiting row with the dot and the INPUT chip, and a resting one with no chip", async () => {
    const root = await draw(roster());
    const blocked = item(root, "w1D:p1");
    expect(byClass(blocked, "inbox-dot").length).toBe(1);
    const chip = blocked.findAll((node) => node.type === "span" && node.props.className === "badge badge-blocked inbox-chip");
    expect(chip.map(text)).toEqual(["INPUT"]);
    expect(byClass(item(root, "w1E:p1"), "badge").length).toBe(0);
  });

  it("draws only the working rows under the working filter, that filter chosen", async () => {
    const root = await draw(roster(), { filter: "working" });
    expect(byClass(root, "inbox-item").map((node) => node.props["data-state"])).toEqual(["working"]);
    const chosen = byClass(root, "inbox-filter").filter((node) => node.props["aria-checked"] === true);
    expect(chosen.map((node) => node.props["data-status"])).toEqual(["working"]);
  });

  it("opens a row's agent on its PC when pressed", async () => {
    const opened: string[] = [];
    const root = await draw(roster(), { onOpen: (machineId, paneId) => opened.push(`${machineId}/${paneId}`) });
    const row = byClass(item(root, "w1C:p1"), "inbox-row")[0]!;
    await act(async () => { row.props.onPointerDown({ button: 0 }); row.props.onClick(); });
    expect(presses).toEqual(["local/w1C:p1"]);
    expect(opened).toEqual(["local/w1C:p1"]);
  });

  it("says what a working agent is on from its plan", async () => {
    const plan = { current: "Write the export guard test", done: 1, total: 3 };
    const root = await draw(roster((pane) => pane.pane_id === "w1C:p1" ? { ...pane, plan } as HerdrPane : pane));
    expect(byClass(item(root, "w1C:p1"), "inbox-words").map(text)).toEqual(["Write the export guard test"]);
  });

  it("draws a PC that is away as disabled rows that say Offline and open nothing", async () => {
    const opened: string[] = [];
    const root = await draw(roster(undefined, "disconnected"), { onOpen: (machineId, paneId) => opened.push(`${machineId}/${paneId}`) });
    const items = byClass(root, "inbox-item");
    expect(items.length).toBeGreaterThan(0);
    for (const node of items) {
      const row = byClass(node, "inbox-row")[0]!;
      expect(row.props.disabled).toBe(true);
      expect(byClass(node, "inbox-place").map(text).join("")).toContain("Offline");
      await act(async () => { row.props.onPointerDown({ button: 0 }); });
    }
    expect(presses).toEqual([]);
    expect(opened).toEqual([]);
    expect(byClass(root, "inbox-new").length).toBe(0);
  });

  it("offers a watching device no New workspace", async () => {
    expect(byClass(await draw(roster(), { watching: true }), "inbox-new").length).toBe(0);
  });

  it("offers New workspace on the one connected PC", async () => {
    const asked: string[] = [];
    const root = await draw(roster(), { onNew: (machineId) => asked.push(machineId) });
    await act(async () => { byClass(root, "inbox-new")[0]!.props.onClick({ currentTarget: newButton }); });
    expect(asked).toEqual(["local"]);
    expect(root.findAllByType(RowMenu).length).toBe(0);
  });

  it("says no agent matches a query that keeps none, and draws no list", async () => {
    const root = await draw(roster(), { query: "nothing is called this" });
    expect(byClass(root, "inbox-empty").map(text)).toEqual(["No agents match"]);
    expect(byClass(root, "inbox-list").length).toBe(0);
  });

  it("says the agents are loading while no PC has come in", async () => {
    const root = await draw([]);
    expect(byClass(root, "inbox-empty").map(text)).toEqual(["Loading agents…"]);
  });

  it("shows the question a waiting agent asks when it reported no words of its own", async () => {
    const root = await draw(roster());
    expect(promptReads).toBe(1);
    expect(byClass(item(root, "w1D:p1"), "inbox-words").length).toBe(0);
    const prompt = {
      id: "p", agent: "codex", kind: "approval", title: "Approve", question: "Run the export tests?", body: "bun test ./src/export.test.ts",
      options: [], multi_select: false, custom_option_index: null,
    } as InteractivePrompt;
    await act(async () => { answerPrompt(prompt); });
    expect(byClass(item(root, "w1D:p1"), "inbox-words").map(text)).toEqual(["Run the export tests?\nbun test ./src/export.test.ts"]);
  });

  it("moves the filter with the arrows as a radio group does: Right past the last comes to All, Left before All comes to the last", async () => {
    const asked: InboxFilter[] = [];
    const press = async (root: ReactTestInstance, value: InboxFilter, key: string) => {
      const radio = byClass(root, "inbox-filter").find((node) => node.props["data-status"] === value)!;
      await act(async () => { radio.props.onKeyDown({ key, preventDefault() {} }); });
    };
    const root = await draw(roster(), { onFilter: (filter) => asked.push(filter) });
    await press(root, "all", "ArrowRight");
    await press(root, "working", "ArrowRight");
    await press(root, "done", "ArrowRight");
    await press(root, "working", "ArrowLeft");
    await press(root, "all", "ArrowLeft");
    await press(root, "all", "Enter");
    expect(asked).toEqual(["blocked", "done", "all", "blocked", "done"]);
    expect(focused.map((call) => call.node).filter((node) => node === "inbox-filter")).toHaveLength(5);
  });

  it("keeps the drawn order while the focus is in the list, and draws the new order once it leaves", async () => {
    const root = await draw(roster());
    const before = order(root);
    const moved = statusOf({ "w1E:p1": "blocked" });
    expect(inboxOrder(roster(), moved).map((row) => row.entry.pane.pane_id)).not.toEqual(before);
    const list = () => byClass(root, "inbox-list")[0]!;
    await act(async () => { list().props.onFocus(); });
    await redraw({ activity: moved });
    expect(order(root)).toEqual(before);
    await act(async () => { list().props.onBlur({ relatedTarget: null, currentTarget: {} }); });
    expect(order(root)).toEqual(inboxOrder(roster(), moved).map((row) => row.entry.pane.pane_id));
  });

  it("keeps the drawn order after a press in the list", async () => {
    const root = await draw(roster());
    const before = order(root);
    await act(async () => { byClass(root, "inbox-list")[0]!.props.onPointerDown(); });
    await redraw({ activity: statusOf({ "w1E:p1": "blocked" }) });
    expect(order(root)).toEqual(before);
  });

  it("opens at the kept scroll place with the focus on the list's section, and keeps each new place", async () => {
    const root = await draw(roster(), { scrollTop: 240 });
    expect(nodes.get("inbox-scroll")!.scrollTop).toBe(240);
    expect(focused).toEqual([{ node: "section", options: { preventScroll: true } }]);
    await act(async () => { byClass(root, "inbox-scroll")[0]!.props.onScroll({ currentTarget: { scrollTop: 610 } }); });
    expect(scroll.current).toBe(610);
  });

  it("offers Clear search only for a query, and clears it", async () => {
    const queries: string[] = [];
    const root = await draw(roster(), { onQuery: (query) => queries.push(query) });
    expect(byClass(root, "inbox-search-clear").length).toBe(0);
    await redraw({ query: "export" });
    await act(async () => { byClass(root, "inbox-search-clear")[0]!.props.onClick(); });
    expect(queries).toEqual([""]);
  });

  it("asks which PC first when two are connected, and starts on the one picked", async () => {
    const asked: string[] = [];
    const root = await draw(twoPcs(), { onNew: (machineId) => asked.push(machineId) });
    await act(async () => { byClass(root, "inbox-new")[0]!.props.onClick({ currentTarget: newButton }); });
    const [menu] = root.findAllByType(RowMenu);
    expect(menu!.props.items.map((entry: { id: string; label: string }) => `${entry.id}:${entry.label}`)).toEqual(["local:workstation", "laptop:Laptop"]);
    expect(asked).toEqual([]);
    await act(async () => { menu!.props.items[1].run(); });
    expect(asked).toEqual(["laptop"]);
  });

  it("closes the sheet of PCs when the choice goes, and does not bring it back when the PC returns", async () => {
    const root = await draw(twoPcs());
    await act(async () => { byClass(root, "inbox-new")[0]!.props.onClick({ currentTarget: newButton }); });
    expect(root.findAllByType(RowMenu).length).toBe(1);
    await redraw({ machines: twoPcs("disconnected") });
    expect(root.findAllByType(RowMenu).length).toBe(0);
    await redraw({ machines: twoPcs() });
    expect(root.findAllByType(RowMenu).length).toBe(0);
  });

  it("narrows the list to the rows a query matches", async () => {
    const root = await draw(roster(), { query: "Guard the export button" });
    expect(order(root)).toEqual(["w1D:p1"]);
  });

  it("keeps the waiting row when the query is part of the question it shows", async () => {
    const root = await draw(roster());
    await act(async () => { answerPrompt(question("Allow rm of node_modules?")); });
    await redraw({ query: "node_modules" });
    expect(order(root)).toEqual(["w1D:p1"]);
  });

  it("says no agent runs on a loaded PC that has none", async () => {
    const root = await draw(roster().map((machine) => ({ ...machine, snapshot: machine.snapshot && { ...machine.snapshot, panes: [] } })));
    expect(byClass(root, "inbox-empty").map(text)).toEqual(["No agents running"]);
  });

  const question = (asked: string) => ({
    id: "p", agent: "codex", kind: "approval", title: "Approve", question: asked, body: null,
    options: [], multi_select: false, custom_option_index: null,
  }) as InteractivePrompt;

  it("reaches the kept scroll place once the waiting row's question is back and the list is long enough again", async () => {
    await draw(roster(), { scrollTop: 167, scrollMax: 127 });
    expect(nodes.get("inbox-scroll")!.scrollTop).toBe(127);
    scrollMax = 400;
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    expect(nodes.get("inbox-scroll")!.scrollTop).toBe(167);
    expect(scroll.current).toBe(167);
  });

  it("leaves a scroll the reader made after coming back where they put it", async () => {
    const root = await draw(roster(), { scrollTop: 167, scrollMax: 127 });
    const scroller = nodes.get("inbox-scroll")!;
    await act(async () => {
      byClass(root, "agent-inbox")[0]!.props.onTouchStart();
      scroller.scrollTop = 40;
      byClass(root, "inbox-scroll")[0]!.props.onScroll({ currentTarget: scroller });
    });
    expect(scroll.current).toBe(40);
    scrollMax = 400;
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    expect(scroller.scrollTop).toBe(40);
    expect(scroll.current).toBe(40);
  });

  it("reads a waiting agent's question once for the page: not again when the list mounts again, again for a new wait", async () => {
    await draw(roster());
    expect(promptReads).toBe(1);
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    await act(async () => { renderer?.unmount(); });
    const root = await draw(roster());
    expect(promptReads).toBe(1);
    expect(byClass(item(root, "w1D:p1"), "inbox-words").map(text)).toEqual(["Run the export tests?"]);
    await redraw({ activity: { ...activity, seqs: () => new Map([["w1D:p1", 5]]) } });
    expect(promptReads).toBe(2);
    expect(byClass(item(root, "w1D:p1"), "inbox-words").length).toBe(0);
  });

  it("shows at the next mount the question whose read landed after the list closed", async () => {
    await draw(roster());
    await act(async () => { renderer?.unmount(); });
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    const root = await draw(roster());
    expect(promptReads).toBe(1);
    expect(byClass(item(root, "w1D:p1"), "inbox-words").map(text)).toEqual(["Run the export tests?"]);
  });
});
