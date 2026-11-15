import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { SettingsProvider } from "../lib/settings.ts";
import type { InboxRailPcs, InboxRailProps } from "./InboxRail.tsx";

// the list of PCs as the rail hands it over (RowMenu's own drawing is RowMenu's): its props are what is read
const rowMenu = await import("./RowMenu.tsx");
function RowMenu(_props: Parameters<typeof rowMenu.RowMenu>[0]) { return null; }
await mock.module("./RowMenu.tsx", () => ({ ...rowMenu, RowMenu }));
const { InboxRail } = await import("./InboxRail.tsx");

const [workstation] = JSON.parse(JSON.stringify(machinesFixture.machines)) as Machine[];
/** the fixture's PC, or another with its roster, in the state given */
const pc = (state: Machine["state"] = "connected", more: Partial<Machine> = {}): Machine => ({ ...structuredClone(workstation!), state, ...more });

describe("InboxRail", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  /** every press the rail handed on, in order */
  let pressed: string[];
  /** the animation frames asked for and not run yet: a case that waits for the status line's word runs them */
  let frames: FrameRequestCallback[];
  const runFrames = (): Promise<void> => act(async () => { for (const run of frames.splice(0)) run(0); });

  beforeEach(() => {
    pressed = [];
    frames = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const on = { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...on, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), requestAnimationFrame: (run: FrameRequestCallback) => frames.push(run), cancelAnimationFrame() {} } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { ...on, body: { nodeType: 1, children: [] }, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null } });
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

  /** one connected PC, the one the app is on, and a connection with nothing to say */
  const pcs = (change: Partial<InboxRailPcs> = {}): InboxRailPcs => ({ machines: [pc()], selectedId: "local", connection: null, saidByThread: false, onSelect: (machineId) => pressed.push(`pc:${machineId}`), ...change });
  const props = (change: Partial<InboxRailProps> = {}): InboxRailProps => ({
    onExit: () => pressed.push("exit"), onInbox: () => pressed.push("inbox"),
    waiting: null, alerts: { on: true, title: "Alerts on in the app. Tap to turn them off", toggle: () => pressed.push("alerts") },
    onSettings: () => pressed.push("settings"), pcs: pcs(),
    // the shell's own: a shortcut's keys after the label, where the shortcut has keys
    shortcutTitle: (label, id) => id === "settings" ? `${label} (Ctrl+,)` : label,
    ...change,
  });
  const view = (change: Partial<InboxRailProps>) => createElement(SettingsProvider, null, createElement(InboxRail, props(change)));
  const draw = async (change: Partial<InboxRailProps> = {}): Promise<ReactTestInstance> => {
    await act(async () => { renderer = create(view(change)); });
    return renderer!.root;
  };
  const redraw = (change: Partial<InboxRailProps>) => act(async () => { renderer!.update(view(change)); });
  const buttons = (root: ReactTestInstance): ReactTestInstance[] => root.findAll((node) => node.type === "button");
  /** which button a node is: the class the rail gives it alone */
  const kind = (node: ReactTestInstance): string => String(node.props.className).split(" ").find((name) => name.startsWith("inbox-rail-") && name !== "inbox-rail-item") ?? "";
  const button = (root: ReactTestInstance, name: string): ReactTestInstance => buttons(root).find((node) => kind(node) === `inbox-rail-${name}`)!;
  const named = (node: ReactTestInstance): [name: unknown, tooltip: unknown] => [node.props["aria-label"], node.props.title];
  /** the lucide glyph a button draws */
  const glyph = (node: ReactTestInstance): string => String(node.findByType("svg").props.className).split(" ").find((name) => name.startsWith("lucide-")) ?? "";
  const press = (node: ReactTestInstance) => act(async () => { node.props.onClick(); });

  it("is a navigation landmark named for the mode, apart from the list's own", async () => {
    const nav = (await draw()).findByType("nav");
    expect(nav.props["aria-label"]).toBe("Inbox mode");
  });

  it("holds the way out and the place at its top, then alerts, Settings and the PC in its lower group, each a plain button, and no magnifier", async () => {
    const root = await draw();
    const groups = root.findAll((node) => node.type === "div" && String(node.props.className).split(" ").includes("inbox-rail-group"));
    // the list's search field is the screen's one magnifier: the command palette is under its shortcut and the thread's More
    expect(root.findAll((node) => node.type === "svg").some((node) => String(node.props.className).split(" ").includes("lucide-search"))).toBe(false);
    expect(groups.map((group) => [String(group.props.className).split(" ").at(-1), buttons(group).map(kind)])).toEqual([
      ["is-top", ["inbox-rail-exit", "inbox-rail-place"]],
      ["is-lower", ["inbox-rail-alerts", "inbox-rail-settings", "inbox-rail-pcs"]],
    ]);
    // a plain Tab stop each: none is taken out of the keyboard's order or disabled
    for (const node of buttons(root)) expect([node.props.type, node.props.tabIndex, node.props.disabled === true]).toEqual(["button", undefined, false]);
  });

  it("begins with the way out: the app's mark, named and titled Back to Ovis, which a press takes", async () => {
    const root = await draw();
    const exit = buttons(root)[0]!;
    expect(kind(exit)).toBe("inbox-rail-exit");
    expect(named(exit)).toEqual(["Back to Ovis", "Back to Ovis"]);
    // the mark is the app's own, drawn as a picture that says nothing: the button's name says it
    const mark = exit.findByType("img");
    expect([mark.props.src, mark.props.alt]).toEqual(["/icons/icon-192.png?v=sheep1", ""]);
    await press(exit);
    expect(pressed).toEqual(["exit"]);
  });

  it("marks the inbox as the current page, the one place the rail has, and a press asks the list for its top", async () => {
    const root = await draw();
    const place = button(root, "place");
    expect(named(place)).toEqual(["Agent inbox", "Agent inbox"]);
    expect(buttons(root).filter((node) => node.props["aria-current"] !== undefined).map((node) => [kind(node), node.props["aria-current"]])).toEqual([["inbox-rail-place", "page"]]);
    await press(place);
    expect(pressed).toEqual(["inbox"]);
  });

  it("draws the waiting count only while an agent waits, first in the lower group, and a press opens the next one", async () => {
    const root = await draw();
    expect(buttons(root).map(kind)).not.toContain("inbox-rail-waiting");
    await redraw({ waiting: { count: 12, open: () => pressed.push("next") } });
    const lower = root.findAll((node) => node.type === "div" && String(node.props.className).split(" ").includes("is-lower"))[0]!;
    expect(buttons(lower).map(kind)).toEqual(["inbox-rail-waiting", "inbox-rail-alerts", "inbox-rail-settings", "inbox-rail-pcs"]);
    const waiting = button(root, "waiting");
    // the name says the number; the tooltip says what a press does
    expect(named(waiting)).toEqual(["12 waiting for you", "Open the next session waiting for you"]);
    // the count is the app's own waiting pill, drawn from its number and hidden from a screen reader
    const pill = waiting.findByProps({ "data-count": 12 });
    expect([pill.props.className, pill.props["aria-hidden"]]).toEqual(["header-more-dot is-waiting", "true"]);
    await press(waiting);
    expect(pressed).toEqual(["next"]);
    await redraw({ waiting: null });
    expect(buttons(root).map(kind)).not.toContain("inbox-rail-waiting");
  });

  it("switches this device's alerts: pressed and a bell while on, not pressed and a struck bell while off, the bell's own sentence as its tooltip", async () => {
    const root = await draw();
    const alerts = () => button(root, "alerts");
    expect([...named(alerts()), alerts().props["aria-pressed"], glyph(alerts())]).toEqual(["Alerts", "Alerts on in the app. Tap to turn them off", true, "lucide-bell"]);
    await press(alerts());
    expect(pressed).toEqual(["alerts"]);
    await redraw({ alerts: { on: false, title: "Alerts off on this device. Tap to turn them on", toggle: () => pressed.push("alerts") } });
    expect([...named(alerts()), alerts().props["aria-pressed"], glyph(alerts())]).toEqual(["Alerts", "Alerts off on this device. Tap to turn them on", false, "lucide-bell-off"]);
  });

  it("opens Settings, its shortcut in the tooltip where one is set", async () => {
    const root = await draw({ shortcutTitle: (label, id) => id === "settings" ? `${label} (Ctrl+Shift+,)` : label });
    const settings = button(root, "settings");
    expect(named(settings)).toEqual(["Settings", "Settings (Ctrl+Shift+,)"]);
    await press(settings);
    expect(pressed).toEqual(["settings"]);
  });

  describe("the PC", () => {
    const pcButton = (root: ReactTestInstance) => button(root, "pcs");
    /** the dot hung on the PC's glyph: its state's class, or none drawn */
    const dot = (root: ReactTestInstance): string | null => {
      const [drawn] = pcButton(root).findAll((node) => node.type === "span" && String(node.props.className).split(" ").includes("inbox-rail-dot"));
      return drawn ? String(drawn.props.className).split(" ").find((name) => name.startsWith("is-")) ?? "" : null;
    };
    const status = (root: ReactTestInstance) => root.findAll((node) => node.props.role === "status").map((node) => [node.props.className, node.children.join("")]);
    const laptop = (state: Machine["state"] = "connected") => pc(state, { id: "laptop", name: "Laptop" });

    it("names the one PC with its state in words, the same in its tooltip, and strikes its monitor only while the PC is away", async () => {
      const root = await draw();
      const facts = () => [...named(pcButton(root)), glyph(pcButton(root))];
      expect(facts()).toEqual(["PC workstation · Connected", "PC workstation · Connected", "lucide-monitor"]);
      await redraw({ pcs: pcs({ machines: [pc("disconnected")] }) });
      expect(facts()).toEqual(["PC workstation · Offline", "PC workstation · Offline", "lucide-monitor-off"]);
      // a PC that fails, or was never reached, is away as its rows in the list are
      for (const state of ["error", "connecting"] as const) {
        await redraw({ pcs: pcs({ machines: [pc(state)] }) });
        expect(facts()).toEqual(["PC workstation · Offline", "PC workstation · Offline", "lucide-monitor-off"]);
      }
      // one being reached again is not struck: it is the PC to wait for
      await redraw({ pcs: pcs({ machines: [pc("reconnecting")] }) });
      expect(facts()).toEqual(["PC workstation · Reconnecting…", "PC workstation · Reconnecting…", "lucide-monitor"]);
    });

    it("says Reconnecting… of every PC while the page has lost the stream its rows come from", async () => {
      const root = await draw({ pcs: pcs({ connection: "reconnecting" }) });
      expect(named(pcButton(root))).toEqual(["PC workstation · Reconnecting…", "PC workstation · Reconnecting…"]);
      await redraw({ pcs: pcs({ machines: [pc(), laptop()], connection: "reconnecting" }) });
      expect(named(pcButton(root))).toEqual(["PCs · Reconnecting…", "PCs · Reconnecting…"]);
      // back, the hold says Connected: the name is the steady one again
      await redraw({ pcs: pcs({ connection: "connected" }) });
      expect(named(pcButton(root))).toEqual(["PC workstation · Connected", "PC workstation · Connected"]);
    });

    it("sums several PCs up by how many are connected, struck only when none is", async () => {
      const root = await draw({ pcs: pcs({ machines: [pc(), laptop("disconnected")] }) });
      const facts = () => [...named(pcButton(root)), glyph(pcButton(root))];
      expect(facts()).toEqual(["PCs, 1 of 2 connected", "PCs, 1 of 2 connected", "lucide-monitor"]);
      await redraw({ pcs: pcs({ machines: [pc("error"), laptop("disconnected")] }) });
      expect(facts()).toEqual(["PCs, 0 of 2 connected", "PCs, 0 of 2 connected", "lucide-monitor-off"]);
    });

    it("draws its dot only while the connection has something to say, and none while the open thread's chip says the same word", async () => {
      // Given a connection with nothing to say: no dot, whatever the PC's own state.
      const root = await draw();
      expect(dot(root)).toBeNull();
      await redraw({ pcs: pcs({ machines: [pc("disconnected")] }) });
      expect(dot(root)).toBeNull();

      // When the connection is lost, and when it is back for its moment: a dot of that state.
      await redraw({ pcs: pcs({ connection: "reconnecting" }) });
      expect(dot(root)).toBe("is-reconnecting");
      await redraw({ pcs: pcs({ connection: "connected" }) });
      expect(dot(root)).toBe("is-connected");
      // the dot is a drawing: the word is the button's name
      expect(pcButton(root).findByProps({ className: "inbox-rail-dot is-connected" }).props["aria-hidden"]).toBe("true");

      // When the thread's chip says the same word: one fact, one place.
      await redraw({ pcs: pcs({ connection: "reconnecting", saidByThread: true }) });
      expect(dot(root)).toBeNull();
      // the name still says how the PC stands
      expect(named(pcButton(root))[0]).toBe("PC workstation · Reconnecting…");
      await redraw({ pcs: pcs() });
      expect(dot(root)).toBeNull();
    });

    it("announces the connection's word from a line that is in the document before it, and nothing the thread's chip says", async () => {
      const root = await draw();
      await runFrames();
      expect(status(root)).toEqual([["visually-hidden", ""]]);
      await redraw({ pcs: pcs({ connection: "reconnecting" }) });
      expect(status(root)).toEqual([["visually-hidden", "Reconnecting…"]]);
      await redraw({ pcs: pcs({ connection: "connected" }) });
      expect(status(root)).toEqual([["visually-hidden", "Connected"]]);
      await redraw({ pcs: pcs({ connection: "reconnecting", saidByThread: true }) });
      expect(status(root)).toEqual([["visually-hidden", ""]]);
    });

    it("opens the list of PCs as a menu from its button: each PC's name and state, the one the app is on marked", async () => {
      const root = await draw({ pcs: pcs({ machines: [pc(), laptop(), pc("disconnected", { id: "studio", name: "Studio" })] }) });
      const menus = () => root.findAllByType(RowMenu);
      expect([pcButton(root).props["aria-haspopup"], pcButton(root).props["aria-expanded"], menus().length]).toEqual(["menu", false, 0]);

      const anchor = { isConnected: true };
      await act(async () => { pcButton(root).props.onClick({ currentTarget: anchor }); });
      expect(pcButton(root).props["aria-expanded"]).toBe(true);
      const menu = menus()[0]!.props;
      // it opens from its own button, which takes the focus back when it closes (RowMenu's own rule for its anchor)
      expect([menu.anchor, menu.title]).toEqual([anchor, "PCs"]);
      expect(menu.items.map((item: { id: string; label: string; hint: string; current: boolean; disabled: boolean }) => [item.id, item.label, item.hint, item.current, item.disabled])).toEqual([
        ["local", "workstation", "Connected", true, false],
        ["laptop", "Laptop", "Connected", false, false],
        ["studio", "Studio", "Offline", false, true],
      ]);

      // a press on another connected PC opens it; one on the PC the app is on changes nothing
      await act(async () => { menu.items[0]!.run(); });
      expect(pressed).toEqual([]);
      await act(async () => { menu.items[1]!.run(); });
      expect(pressed).toEqual(["pc:laptop"]);

      // the button's press again, or the menu's own close, puts it away
      await act(async () => { menu.onClose(); });
      expect([pcButton(root).props["aria-expanded"], menus().length]).toEqual([false, 0]);
    });

    it("keeps a connected PC's row pressable while the page has lost its stream, as its rows in the list are, and says Reconnecting… of it", async () => {
      const root = await draw({ pcs: pcs({ machines: [pc(), laptop(), pc("disconnected", { id: "studio", name: "Studio" })], connection: "reconnecting" }) });
      await act(async () => { pcButton(root).props.onClick({ currentTarget: { isConnected: true } }); });
      const menu = root.findAllByType(RowMenu)[0]!.props;
      expect(menu.items.map((item: { id: string; hint: string; disabled: boolean }) => [item.id, item.hint, item.disabled])).toEqual([
        ["local", "Reconnecting…", false], ["laptop", "Reconnecting…", false], ["studio", "Reconnecting…", true],
      ]);
      await act(async () => { menu.items[1]!.run(); });
      expect(pressed).toEqual(["pc:laptop"]);
    });

    it("takes no press before any PC is known: it keeps its place, named for the PCs", async () => {
      const root = await draw({ pcs: pcs({ machines: [] }) });
      expect([...named(pcButton(root)), pcButton(root).props.disabled, glyph(pcButton(root))]).toEqual(["PCs", "PCs", true, "lucide-monitor"]);
      await redraw({ pcs: pcs() });
      expect(pcButton(root).props.disabled).toBe(false);
    });
  });
});
