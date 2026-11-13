import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as ReactDom from "react-dom";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, InteractivePrompt, PaneSummaries, PaneSummary } from "../../shared/protocol.ts";
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
const { SummaryReads } = await import("../lib/useInboxSummaries.ts");
const { InboxWaits } = await import("../lib/useInbox.ts");

// the summary reads the page's reader makes: each case answers them itself
type SummaryCall = { machineId: string; paneIds: readonly string[]; resolve(answer: PaneSummaries | null): void };
let summaryCalls: SummaryCall[] = [];
/** an ISO time this many minutes ago */
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const said = (text: string, at: string | null, more: Partial<PaneSummary> = {}): PaneSummary => ({ role: "assistant", text, at, asked_at: null, ...more });

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
  let summaryReads: InstanceType<typeof SummaryReads>;
  // when the page saw each wait begin (lib/useInbox.ts), which outlives the list too
  let waits: InstanceType<typeof InboxWaits>;

  beforeEach(() => {
    waits = new InboxWaits();
    promptReads = 0;
    // no case runs a reader's retry: their waits never fire, so no timer outlives a case to read into the next one
    const never = () => () => {};
    questionReads = newQuestionReads(never);
    summaryCalls = [];
    summaryReads = new SummaryReads((machineId, paneIds) => new Promise((resolve) => { summaryCalls.push({ machineId, paneIds, resolve }); }), never);
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
      query={options.query ?? ""} onQuery={options.onQuery ?? (() => {})} scroll={scroll} onOpen={options.onOpen ?? (() => {})} onNew={options.onNew ?? (() => {})} questionReads={questionReads} summaryReads={summaryReads} waits={waits} />
  </PanePressContext.Provider></SettingsProvider>;
  const draw = async (machines: Machine[], options: DrawOptions = {}) => {
    nodes = new Map();
    focused = [];
    scroll = { current: options.scrollTop ?? 0 };
    scrollMax = options.scrollMax ?? Number.POSITIVE_INFINITY;
    drawn = { machines, options };
    await act(async () => {
      renderer = create(view(machines, options), { createNodeMock: (element) => {
        // by the first class: the scroller is "inbox-scroll" with or without its modifier
        const name = element.type === "section" ? "section" : String((element.props as { className?: string }).className ?? element.type).split(" ")[0]!;
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

  it("reads a waiting agent's question again each time the list mounts, keeping its words until the answer lands, and again for a new wait", async () => {
    await draw(roster());
    expect(promptReads).toBe(1);
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    await act(async () => { renderer?.unmount(); });
    // the same wait and counter: a bridge with no counter, or a second prompt in the same state, looks the same
    const root = await draw(roster());
    expect(promptReads).toBe(2);
    expect(byClass(item(root, "w1D:p1"), "inbox-words").map(text)).toEqual(["Run the export tests?"]);
    await act(async () => { answerPrompt(question("Deploy to staging?")); });
    expect(byClass(item(root, "w1D:p1"), "inbox-words").map(text)).toEqual(["Deploy to staging?"]);
    await redraw({ activity: { ...activity, seqs: () => new Map([["w1D:p1", 5]]) } });
    expect(promptReads).toBe(3);
    expect(byClass(item(root, "w1D:p1"), "inbox-words").length).toBe(0);
  });

  it("starts no second read when the list mounts again while the first is on its way", async () => {
    await draw(roster());
    expect(promptReads).toBe(1);
    await act(async () => { renderer?.unmount(); });
    const root = await draw(roster());
    expect(promptReads).toBe(1);
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    expect(byClass(item(root, "w1D:p1"), "inbox-words").map(text)).toEqual(["Run the export tests?"]);
  });

  /** answers the newest summary read: every pane it asked about, null where the case gives nothing */
  const answerSummaries = async (summaries: Record<string, PaneSummary>) => {
    const call = summaryCalls.at(-1)!;
    await act(async () => { call.resolve({ server_time: new Date().toISOString(), summaries: Object.fromEntries(call.paneIds.map((id) => [id, summaries[id] ?? null])) }); });
  };
  const words = (root: ReactTestInstance, paneId: string) => byClass(item(root, paneId), "inbox-words").map(text);
  const times = (root: ReactTestInstance, paneId: string) => item(root, paneId).findAll((node) => node.type === "time");
  const age = (root: ReactTestInstance, paneId: string) => times(root, paneId).map(text);

  it("shows a done agent's last words and how long it has been done", async () => {
    const at = ago(6.5);
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    expect(words(root, "w1E:p1")).toEqual([]);
    await answerSummaries({ "w1E:p1": said("All six export tests pass.", at) });
    expect(words(root, "w1E:p1")).toEqual(["All six export tests pass."]);
    expect(age(root, "w1E:p1")).toEqual(["6m"]);
    const [time] = times(root, "w1E:p1");
    expect(time!.props.className).toBe("inbox-time");
    expect(Math.abs(Date.parse(time!.props.dateTime) - Date.parse(at))).toBeLessThan(1000);
  });

  it("marks the user's own last message as theirs", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await answerSummaries({ "w1E:p1": said("Run the export tests again", ago(2.5), { role: "user" }) });
    expect(words(root, "w1E:p1")).toEqual(["You: Run the export tests again"]);
  });

  it("keeps a waiting agent's question as its words and says how long it has waited since the page saw the wait begin", async () => {
    waits.observe([["local:w1D:p1", "working"]], Date.now() - 40 * 60_000);
    waits.observe([["local:w1D:p1", "blocked"]], Date.now() - 3.5 * 60_000);
    const root = await draw(roster());
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    // the agent last spoke before it worked for half an hour: its words' time is not its wait's
    await answerSummaries({ "w1D:p1": said("I will run the export tests next.", ago(40.5)) });
    expect(words(root, "w1D:p1")).toEqual(["Run the export tests?"]);
    expect(age(root, "w1D:p1")).toEqual(["3m"]);
  });

  it("says nothing of how long a row has waited when it was already waiting as the page opened", async () => {
    waits.observe([["local:w1D:p1", "blocked"]], Date.now() - 3.5 * 60_000);
    const root = await draw(roster());
    await answerSummaries({ "w1D:p1": said("I will run the export tests next.", ago(40.5)) });
    expect(times(root, "w1D:p1")).toEqual([]);
  });

  it("draws a wait seen to begin while the list is shown", async () => {
    waits.observe([["local:w1D:p1", "working"]], Date.now() - 60 * 60_000);
    const root = await draw(roster());
    expect(times(root, "w1D:p1")).toEqual([]);
    await act(async () => { waits.observe([["local:w1D:p1", "blocked"]], Date.now() - 2.5 * 60_000); });
    expect(age(root, "w1D:p1")).toEqual(["2m"]);
  });

  it("draws a done row whose last words are a failed request with the Turn failed chip, as the blocked badge", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done", "w1F:p1": "done" }) });
    await answerSummaries({ "w1E:p1": said("Error: rate limited", ago(1.5), { failed: true }), "w1F:p1": said("All good.", ago(1.5)) });
    const chip = (paneId: string) => byClass(item(root, paneId), "inbox-chip").map((node) => [text(node), node.props.className]);
    expect(chip("w1E:p1")).toEqual([["Turn failed", "badge badge-blocked inbox-chip"]]);
    expect(chip("w1F:p1")).toEqual([["DONE", "badge badge-done inbox-chip"]]);
  });

  it("draws nothing, and throws nothing, for a summary whose text is not text", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await answerSummaries({ "w1E:p1": { text: 5 } as unknown as PaneSummary });
    expect(words(root, "w1E:p1")).toEqual([]);
    expect(times(root, "w1E:p1")).toEqual([]);
  });

  it("keeps a working agent's plan step as its words and times it from the user's last ask", async () => {
    const plan = { current: "Write the export guard test", done: 1, total: 3 };
    const root = await draw(roster((pane) => pane.pane_id === "w1C:p1" ? { ...pane, plan } as HerdrPane : pane));
    await answerSummaries({ "w1C:p1": said("Reading the export module.", ago(30.5), { asked_at: ago(2.5) }) });
    expect(words(root, "w1C:p1")).toEqual(["Write the export guard test"]);
    expect(age(root, "w1C:p1")).toEqual(["2m"]);
  });

  it("draws no last words and no time for a row without a summary", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await answerSummaries({ "w1F:p1": said("Ready when you are.", ago(5.5)) });
    expect(words(root, "w1E:p1")).toEqual([]);
    expect(times(root, "w1E:p1")).toEqual([]);
    expect(age(root, "w1F:p1")).toEqual(["5m"]);
  });

  it("draws the last words without Markdown's marks", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    // one line, as the route sends it: its block marks are gone already, its inline marks are the list's to drop
    await answerSummaries({ "w1E:p1": said("Pinned the `clock` in **retry.test.ts**, see [the run](https://example.com/run)", ago(1.5)) });
    expect(words(root, "w1E:p1")).toEqual(["Pinned the clock in retry.test.ts, see the run"]);
    expect(byClass(item(root, "w1E:p1"), "inbox-words")[0]!.props.dir).toBe("auto");
  });

  it("reads the rows' last words once for the page: not again when the list mounts again with the same rows", async () => {
    const machines = roster();
    await draw(machines);
    expect(summaryCalls).toHaveLength(1);
    await answerSummaries({ "w1E:p1": said("Ready when you are.", ago(4.5)) });
    await act(async () => { renderer?.unmount(); });
    const root = await draw(machines);
    expect(summaryCalls).toHaveLength(1);
    expect(words(root, "w1E:p1")).toEqual(["Ready when you are."]);
    expect(age(root, "w1E:p1")).toEqual(["4m"]);
  });

  it("draws a timed row a filter brings back from the clock as it is now, not as it was when the last time was drawn", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await answerSummaries({ "w1E:p1": said("Done.", ago(6.5)) });
    expect(age(root, "w1E:p1")).toEqual(["6m"]);
    // a filter that draws no time while an hour passes: no clock ticks meanwhile
    await redraw({ filter: "working" });
    const later = Date.now() + 60 * 60_000;
    const clock = spyOn(Date, "now").mockReturnValue(later);
    try {
      await redraw({ filter: "all" });
      expect(age(root, "w1E:p1")).toEqual(["1h"]);
    } finally { clock.mockRestore(); }
  });

  it("reads a time in the future (another clock) as under a minute, never a negative age", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await answerSummaries({ "w1E:p1": said("Done.", ago(-10)) });
    expect(age(root, "w1E:p1")).toEqual(["<1m"]);
  });

  it("titles the time with the full local time in the interface language", async () => {
    const stored: Record<string, string> = { "ovis:settings": JSON.stringify({ language: "ko" }) };
    Object.assign(window, { localStorage: { getItem: (key: string) => stored[key] ?? null, setItem() {}, removeItem() {} } });
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await answerSummaries({ "w1E:p1": said("Done.", ago(6.5)) });
    const [time] = times(root, "w1E:p1");
    const at = new Date(time!.props.dateTime);
    expect(time!.props.title).toBe(at.toLocaleString("ko"));
    expect(time!.props.title).not.toBe(at.toLocaleString("en"));
  });

  it("starts no summary read for a filter or a search: the reads cover the whole list", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    expect(summaryCalls).toHaveLength(1);
    await answerSummaries({ "w1E:p1": said("All six export tests pass.", ago(6.5)) });
    await redraw({ filter: "working" });
    await redraw({ filter: "all", query: "export" });
    await redraw({ query: "" });
    expect(summaryCalls).toHaveLength(1);
    expect(words(root, "w1E:p1")).toEqual(["All six export tests pass."]);
  });

  it("keeps a done row when the query is part of the last words it shows", async () => {
    const root = await draw(roster(), { activity: statusOf({ "w1E:p1": "done" }) });
    await redraw({ query: "jq quirk" });
    expect(order(root)).toEqual([]);
    await answerSummaries({ "w1E:p1": said("Fixed the `jq` quirk in the zsh prompt.", ago(3.5)) });
    expect(order(root)).toEqual(["w1E:p1"]);
    expect(words(root, "w1E:p1")).toEqual(["Fixed the jq quirk in the zsh prompt."]);
  });

  it("shows at the next mount the question whose read landed after the list closed, while it is read again", async () => {
    await draw(roster());
    await act(async () => { renderer?.unmount(); });
    await act(async () => { answerPrompt(question("Run the export tests?")); });
    const root = await draw(roster());
    expect(promptReads).toBe(2);
    expect(byClass(item(root, "w1D:p1"), "inbox-words").map(text)).toEqual(["Run the export tests?"]);
  });
});
