import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Machine } from "../../shared/machines.ts";
import type { AgentInfo, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { setAgentRowTokens } from "../lib/agentRowTokens.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentSidebar } from "./AgentSidebar.tsx";

const pane = (pane_id: string, extra: Partial<HerdrPane> = {}): HerdrPane => ({
  pane_id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: `term-${pane_id}`, focused: false, revision: 1,
  agent: "claude", agent_status: "idle", ...extra,
});
const agentOf = (row: HerdrPane): AgentInfo => ({
  pane_id: row.pane_id, workspace_id: row.workspace_id, tab_id: row.tab_id, terminal_id: row.terminal_id, focused: false, revision: 1,
  agent: row.agent, agent_status: row.agent_status, ...(row.display_agent ? { display_agent: row.display_agent } : {}), ...(row.tokens ? { tokens: row.tokens } : {}),
});
const snapshot = (panes: HerdrPane[]): SessionSnapshot => ({
  protocol: 22, version: "0.9.5", layouts: [], panes, agents: panes.map(agentOf),
  workspaces: [{ workspace_id: "w1", label: "checkout-api", number: 1, focused: false, pane_count: panes.length, tab_count: 1, active_tab_id: "w1:t1", agent_status: "idle" }],
  tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1", number: 1, focused: false, pane_count: panes.length, agent_status: "idle" }],
});
const machine = (panes: HerdrPane[], state: Machine["state"] = "connected"): Machine => ({ id: "local", name: "workstation", kind: "local", enabled: true, state, error: null, snapshot: snapshot(panes) });

function render(machines: Machine[]): string {
  return renderToStaticMarkup(createElement(SettingsProvider, {
    children: createElement(AgentSidebar, { machines, selectedMachineId: "local", selectedPaneId: null, stateWord: () => "disconnected", onSelect: () => {} }),
  }));
}
const decode = (text: string): string => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** the text of each element with this class, entities as the browser reads them */
const texts = (html: string, className: string): string[] =>
  [...html.matchAll(new RegExp(`<span class="${className}">(.*?)</span>`, "g"))].map((match) => decode(match[1]!));
/** each agent row's tooltip, line by line */
const tooltips = (html: string): string[][] =>
  [...html.matchAll(/class="agent-select agent-row"[^>]* title="([^"]*)"/g)].map((match) => decode(match[1]!).split("\n"));

describe("AgentSidebar plugin tokens", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
  beforeEach(() => {
    // the drawer query AgentSidebar asks at its first render, on a desktop, in English
    Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }) } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "window", saved);
    else Reflect.deleteProperty(globalThis, "window");
    if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages);
    else Reflect.deleteProperty(navigator, "languages");
    setAgentRowTokens(null);
  });

  test("a row draws every token its pane has, by name, as text; a pane without any draws no line", () => {
    const html = render([machine([
      pane("w1:p1", { tokens: { summary: "<b>reviewing</b> auth", quota: "5h 95% · Wk 67%", blank: "  " } }),
      pane("w1:p2"),
    ])]);
    expect(texts(html, "agent-tokens")).toEqual(["5h 95% · Wk 67% · <b>reviewing</b> auth"]);
    // escaped, never markup
    expect(html).not.toContain("<b>reviewing</b>");
    expect(html.match(/class="agent-tokens"/g)?.length).toBe(1);
  });

  test("herdr's `[ui.sidebar.agents]` rows choose which tokens a row draws, in their order, hide rules included", () => {
    setAgentRowTokens({
      rows: [{ name: "progress" }, { name: "quota", rules: [{ equals: "unknown", hide: true }] }],
      by_agent: { codex: [{ name: "summary" }] },
    });
    const html = render([machine([
      pane("w1:p1", { tokens: { quota: "5h 95%", progress: "40% 12m", summary: "not in the rows" } }),
      pane("w1:p2", { tokens: { quota: "unknown", progress: "90% 1m" } }),
      pane("w1:p3", { agent: "codex", tokens: { quota: "5h 95%", summary: "codex's own rows" } }),
    ])]);
    expect(texts(html, "agent-tokens")).toEqual(["40% 12m · 5h 95%", "90% 1m", "codex's own rows"]);
  });

  test("the row's tooltip says each token whole; a PC that is away draws none", () => {
    const long = `summary ${"x".repeat(200)}`;
    const online = render([machine([pane("w1:p1", { tokens: { summary: long, quota: "5h 95%" } })])]);
    expect(tooltips(online)[0]).toEqual(["w1:p1", "checkout-api", "5h 95%", long, "claude"]);
    const away = render([machine([pane("w1:p1", { tokens: { summary: long } })], "disconnected")]);
    expect(away).not.toContain("agent-tokens");
    expect(away).not.toContain(long);
  });

  test("display_agent, a plugin's line for the agent, is said where it says more than the agent's kind", () => {
    const html = render([machine([
      pane("w1:p1", { display_agent: "needs a login · 8m ago", title: "PRJ-1 Add a greeting" }),
      pane("w1:p2", { display_agent: "Claude", title: "Refactor" }),
    ])]);
    const lines = [...html.matchAll(/<span class="agent-context">(.*?)<\/span>/g)].map((match) => match[1]);
    expect(lines[0]).toStartWith("needs a login · 8m ago · checkout-api");
    // the mark already draws Claude: the line does not say it again
    expect(lines[1]).toBe("checkout-api");
  });

  test("a live Codex title replaces a stale roster title while user labels and absent-title fallbacks remain", () => {
    const host = machine([
      pane("w1:p1", { agent: "codex", title: "Old task", terminal_title_stripped: "Continue review | api" }),
      pane("w1:p2", { agent: "codex", label: "My review", terminal_title_stripped: "Continue review | api" }),
      pane("w1:p3", { agent: "codex" }),
    ]);
    if (!host.snapshot) throw new Error("Missing test snapshot");
    host.snapshot.agents = host.snapshot.agents.map((entry) => ({ ...entry, title: "Old task", display_agent: "Old task" }));
    const html = render([host]);
    expect(texts(html, "agent-title")).toEqual(["Continue review", "My review", "Old task"]);
    expect(texts(html, "agent-context")[0]).toBe("checkout-api");
    expect(tooltips(html)[0]).not.toContain("Old task");
  });

  test("a live title keeps a plugin's distinct display line", () => {
    const host = machine([pane("w1:p1", { agent: "codex", terminal_title_stripped: "Continue review | api" })]);
    if (!host.snapshot) throw new Error("Missing test snapshot");
    host.snapshot.agents = host.snapshot.agents.map((entry) => ({ ...entry, title: "Old task", display_agent: "needs a login · 8m ago" }));
    const html = render([host]);
    expect(texts(html, "agent-title")).toEqual(["Continue review"]);
    expect(texts(html, "agent-context")[0]).toBe("needs a login · 8m ago · checkout-api");
  });
});
