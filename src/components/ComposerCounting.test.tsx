import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { usageCounters } from "../lib/usageCounters.ts";

// the usage counts of a send (lib/usageCounters.ts): counted once the send is taken, and never in the way of the draft
const pane = "count-pane", draftKey = `ovis:composer-draft:${pane}`;
const otherPane = "count-other", otherKey = `ovis:composer-draft:${otherPane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let pasteSend = true;
let readText: (() => Promise<string>) | undefined;
let counted: string[];
let countFails: boolean | string = false;

beforeEach(() => {
  pasteSend = true;
  readText = async () => "from the clipboard";
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0, get clipboard() { return readText === undefined ? undefined : { readText: () => readText!() }; } },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout },
    document: { ...listen, querySelector: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, composerPasteSend: pasteSend }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "");
  composerDrafts.set(otherKey, "");
  counted = [];
  countFails = false;
  spyOn(usageCounters, "paneUse").mockImplementation((name) => {
    if (countFails === name || (countFails === true && name === "chat_send")) throw new Error("storage full");
    counted.push(name);
  });
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  composerDrafts.set(otherKey, "");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

function props(sent: unknown[][], result: ReturnType<ComposerProps["onSend"]> = true): ComposerProps {
  return { paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: (...args) => { sent.push(args); return result; }, onAbort() {}, onUploadImage: async () => "" };
}

const button = () => renderer!.root.findAllByProps({ "aria-label": "Paste and send" }).find((node) => node.type === "button");
async function press(): Promise<void> {
  await act(async () => { button()!.props.onClick(); });
}

it("counts a send once it is taken", async () => {
  const sent: unknown[][] = [];
  await act(async () => { renderer = create(<Composer {...props(sent)} />); });
  await press();
  expect(sent).toHaveLength(1);
  expect(counted.filter((name) => name === "chat_send")).toEqual(["chat_send"]);
});

it("counts no send that is refused", async () => {
  const sent: unknown[][] = [];
  await act(async () => { renderer = create(<Composer {...props(sent, "The agent is busy.")} />); });
  await press();
  expect(sent).toHaveLength(1);
  expect(counted).not.toContain("chat_send");
});

it("releases the draft even when counting fails, so the next send goes", async () => {
  const sent: unknown[][] = [];
  const logged = spyOn(console, "error").mockImplementation(() => {});
  countFails = true;
  await act(async () => { renderer = create(<Composer {...props(sent)} />); });
  await press();
  expect(composerDrafts.read(draftKey).text).toBe("");
  readText = async () => "a second message";
  await press();
  expect(sent.map((call) => call[0])).toEqual(["from the clipboard", "a second message"]);
  expect(logged).toHaveBeenCalled();
});

it("sends through Paste and send even when that button's count fails", async () => {
  const sent: unknown[][] = [];
  const logged = spyOn(console, "error").mockImplementation(() => {});
  countFails = "composer_paste_send";
  await act(async () => { renderer = create(<Composer {...props(sent)} />); });
  await press();
  expect(sent.map((call) => call[0])).toEqual(["from the clipboard"]);
  expect(logged).toHaveBeenCalled();
});
