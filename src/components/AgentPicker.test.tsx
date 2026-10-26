import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMark } from "./AgentMark.tsx";
import { AgentPicker, type AgentPickerProps } from "./AgentPicker.tsx";

const agents = [{ kind: "codex", label: "Codex" }, { kind: "claude", label: "Claude Code" }];
const render = (props: Partial<AgentPickerProps>): string =>
  renderToStaticMarkup(createElement(AgentPicker, { agents, value: "", labelledBy: "agent", onChange: () => {}, ...props }));
const mark = (agent: string): string => renderToStaticMarkup(createElement(AgentMark, { agent, size: 16 }));
/** the name the closed picker shows: its text, without the icons' drawing */
const shownName = (markup: string): string => markup.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "");

describe("AgentPicker", () => {
  it("leads with a plain shell, and shows the chosen agent's mark with its name", () => {
    const shell = render({});
    expect(shownName(shell)).toBe("Shell");
    for (const { kind } of agents) expect(shell).not.toContain(mark(kind));
    const claude = render({ value: "claude" });
    expect(shownName(claude)).toBe("Claude Code");
    expect(claude).toContain(mark("claude"));
  });

  it("lists the agents alone when told so: no shell, and a value outside the list falls to the first agent", () => {
    const codex = render({ shell: false, value: "codex" });
    expect(shownName(codex)).toBe("Codex");
    expect(codex).toContain(mark("codex"));
    const unlisted = render({ shell: false, value: "" });
    expect(shownName(unlisted)).toBe("Codex");
    expect(unlisted).toContain(mark("codex"));
  });
});
