import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { ChatRowMemoryContext, type ChatRowMemory } from "../lib/chatRowState.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatView.tsx";

const text = (value: string): ConversationPart => ({ kind: "text", text: value });
const tool = (command: string): ConversationPart => ({ kind: "tool", name: "Bash", summary: command, input: JSON.stringify({ command }), output: "" });

const render = (parts: ConversationPart[], state: { live: boolean; waiting?: boolean }): string => {
  const turn: ConversationTurn = { role: "assistant", ts: "2026-01-01T12:00:00Z", end_ts: "2026-01-01T12:01:00Z", parts };
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Turn, {
      paneId: "w1:p1", turn, rowKey: "turn:1", live: state.live, waiting: state.waiting ?? false, showThinking: false,
    }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const titles = (html: string) => [...html.matchAll(/class="work-block-title">([^<]*)</g)].map((match) => match[1]);
const expanded = (html: string) => [...html.matchAll(/class="work-block-head" aria-expanded="(true|false)"/g)].map((match) => match[1] === "true");

describe("an agent turn's work blocks", () => {
  it("says Working… for a running turn that has written no work or words yet", () => {
    for (const parts of [[], [text("\n\n")]]) {
      const html = render(parts, { live: true });
      expect(html).toContain("work-block is-live is-pending");
      expect(titles(html)).toEqual(["Working…"]);
      expect(titles(render(parts, { live: false }))).toEqual([]);
    }
  });

  it("draws each run where the agent ran it, with the turn's state and duration on the last", () => {
    const parts = [text("Checking first."), tool("ls"), text("Now the loans."), tool("cat loans"), text("No book is on loan.")];
    const settled = render(parts, { live: false });
    const order = ["Checking first.", "Worked<", "Now the loans.", "Worked for 1m", "No book is on loan."].map((needle) => settled.indexOf(needle));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(titles(settled)).toEqual(["Worked", "Worked for 1m"]);
    expect(expanded(settled)).toEqual([false, false]);
    const live = render(parts, { live: true });
    expect(titles(live)).toEqual(["Worked", "Working…"]);
    expect(expanded(live)).toEqual([false, true]);
    expect(titles(render(parts, { live: true, waiting: true }))).toEqual(["Worked", "Needs you"]);
  });

  it("keeps one block for tools followed by the answer", () => {
    const html = render([tool("ls"), tool("cat a"), text("Done.")], { live: false });
    expect(titles(html)).toEqual(["Worked for 1m"]);
    expect(html.indexOf("Worked for 1m")).toBeLessThan(html.indexOf("Done."));
  });
});

describe("a run of todo updates, opened", () => {
  // omp's todo: operations in, the whole list as it now stands out
  const LIST = ["Read the fixture", "Patch the parser"];
  const todo = (id: string, ops: unknown[], done: number): ConversationPart => ({
    kind: "tool", name: "todo", summary: "todo", input: JSON.stringify({ ops }), call_id: id,
    output: `Overall: ${done}/${LIST.length} done.\n  Fix:\n${LIST.map((item, index) => `    - [${index < done ? "X" : " "}] ${item}`).join("\n")}`,
  });

  it("shows each update's own input and output, not only the list it left (#1601)", () => {
    const parts = [todo("t1", [{ op: "init", list: [{ phase: "Fix", items: LIST }] }], 0), todo("t2", [{ op: "done", task: LIST[0] }], 1)];
    // the reader opened both updates: the run opens with them
    const memory: ChatRowMemory = { toggles: new Map([["tool:0", true], ["tool:1", true]]), outputs: new Map(), runs: new Map() };
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    let html: string;
    try {
      html = renderToStaticMarkup(createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(SettingsProvider, { children: createElement(Turn, {
        paneId: "w1:p1", turn: { role: "assistant", ts: "2026-01-01T12:00:00Z", parts }, rowKey: "turn:1", live: true, waiting: false, showThinking: false,
      }) }) }));
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
    const attempts = html.slice(html.indexOf("work-todo-attempts"));
    expect(html).toContain("work-todo-attempts");
    expect(attempts.match(/aria-expanded="true"/g)?.length).toBe(2);
    for (const [op, done] of [["init", 0], ["done", 1]] as const) {
      expect(attempts).toContain(`&quot;op&quot;: &quot;${op}&quot;`);
      expect(attempts).toContain(`Overall: ${done}/2 done.`);
    }
  });
});

describe("an agent turn's folded work, drawn again", () => {
  const commentary = (value: string): ConversationPart => ({ kind: "text", text: value, phase: "commentary" });
  const answer = (value: string): ConversationPart => ({ kind: "text", text: value, phase: "final_answer" });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let memory: ChatRowMemory;
  let renderer: ReactTestRenderer | undefined;

  const view = (parts: ConversationPart[]) => createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(SettingsProvider, { children: createElement(Turn, {
    paneId: "w1:p1", turn: { role: "assistant", ts: "2026-01-01T12:00:00Z", parts }, rowKey: "turn:1", live: true, waiting: false, showThinking: false,
  }) }) });
  const draw = async (parts: ConversationPart[]) => {
    await act(async () => { if (renderer) renderer.update(view(parts)); else renderer = create(view(parts)); });
  };
  const heads = () => renderer!.root.findAll((node) => node.props.className === "work-block-head");
  const opened = () => heads().map((node) => node.props["aria-expanded"] as boolean);
  const toggle = async (index: number) => { await act(async () => { heads()[index]!.props.onClick(); }); };
  // the row scrolled out of the list and back: only its memory is left
  const remount = async (parts: ConversationPart[]) => {
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await draw(parts);
  };

  beforeEach(() => {
    for (const key of ["window", "document", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    descriptors.set("languages", Object.getOwnPropertyDescriptor(navigator, "languages"));
    const listeners = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...listeners, matchMedia: () => ({ matches: false, ...listeners }) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { ...listeners, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    memory = { toggles: new Map(), outputs: new Map(), runs: new Map() };
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      const target = key === "languages" ? navigator : globalThis;
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  });

  it("keeps a block folded when the words before its tools join it (#2063)", async () => {
    // a later Codex record marks the words commentary; an empty commentary record is filled in
    for (const [before, after] of [[text("Checking."), commentary("Checking.")], [commentary(""), commentary("Checking.")]] as const) {
      memory = { toggles: new Map(), outputs: new Map(), runs: new Map() };
      await draw([before, tool("ls")]);
      await toggle(0);
      expect(opened()).toEqual([false]);
      await draw([after, tool("ls")]);
      expect(opened()).toEqual([false]);
      await remount([after, tool("ls")]);
      expect(opened()).toEqual([false]);
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
    }
  });

  it("keeps a merged block's fold when a part leaves it", async () => {
    await draw([tool("ls"), text("One shelf."), commentary("Checking it.")]);
    expect(opened()).toEqual([false, true]);
    // the reader folds the working run and opens it again
    await toggle(1);
    await toggle(1);
    // the words between become commentary: one run, which the reader folds
    await draw([tool("ls"), commentary("One shelf."), commentary("Checking it.")]);
    expect(opened()).toEqual([true]);
    await toggle(0);
    expect(opened()).toEqual([false]);
    // its last words become the answer and leave it
    await draw([tool("ls"), commentary("One shelf."), answer("Checking it.")]);
    expect(opened()).toEqual([false]);
    await remount([tool("ls"), commentary("One shelf."), answer("Checking it.")]);
    expect(opened()).toEqual([false]);
  });
});
