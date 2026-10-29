import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PromptCard } from "./PromptCard.tsx";

const goal: InteractivePrompt = {
  id: "g", agent: "claude", kind: "menu", title: "Goal active", question: "the file hello.txt exists", body: "running 25s · 0 tokens",
  options: [{ label: "Close", description: null }], multi_select: false, custom_option_index: null,
  own_text: { title: { key: "Goal active" }, labels: { 0: { key: "Close" } } },
};

const render = (prompt: InteractivePrompt, languages: string[], screenWords: string | null = null): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PromptCard, {
      paneId: "w1:p1", prompt, onPromptChanged: () => {}, onAnswered: () => {}, screenWords,
    }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("a prompt card's own words", () => {
  it("shows the words the bridge wrote in the reader's language, and the agent's as written (#1482)", () => {
    for (const language of ["ko", "ja", "zh"] as const) {
      const html = render(goal, [language]);
      expect(html).toContain(`<h2>${translate(language, "Goal active")}</h2>`);
      expect(html).toContain(translate(language, "Close"));
      expect(html).not.toContain("<h2>Goal active</h2>");
      expect(html).toContain("the file hello.txt exists");
      expect(html).toContain("running 25s · 0 tokens");
    }
  });

  it("shows an older bridge's card, which names no words of its own, as it came", () => {
    const { own_text: _, ...older } = goal;
    expect(render(older, ["ko"])).toContain("<h2>Goal active</h2>");
  });
});

describe("Claude's words over its question, read off the screen (#2088)", () => {
  const asked: InteractivePrompt = {
    id: "q", agent: "claude", kind: "question", title: "Fix", question: "Which fix do you want?", body: null,
    options: [{ label: "Patch", description: null }, { label: "Rewrite", description: null }], multi_select: false, custom_option_index: null,
  };

  it("shows them over the question, saying where they came from in the reader's language", () => {
    const html = render(asked, ["ko"], "There are two ways to fix it.\n\nPatch adds the newline.");
    expect(html).toContain("There are two ways to fix it.\n\nPatch adds the newline.");
    expect(html).toContain(translate("ko", "From the terminal, until the agent saves this turn"));
    expect(html.indexOf("There are two ways")).toBeLessThan(html.indexOf("Which fix do you want?"));
  });

  it("shows no words and no caption without them", () => {
    expect(render(asked, ["en"])).not.toContain("prompt-card-words");
  });
});

describe("an omp Ask card in the agent's own Markdown (#1644)", () => {
  const ask: InteractivePrompt = {
    id: "a", agent: "omp", kind: "question", title: "Question", body: null, text_format: "markdown",
    question: "Which **route** carries it? See [the guide](https://example.com/guide).",
    options: [{ label: "Use `local` socket", description: "Goes through [the relay](https://example.com/relay)." }],
    multi_select: false, custom_option_index: 1,
  };

  it("draws the question and options as Markdown, with links only in the question", () => {
    const html = render(ask, ["en"]);
    expect(html).toContain("<strong><span>route</span></strong>");
    expect(html).toContain('href="https://example.com/guide"');
    expect(html).toContain("<code>local</code>");
    // an option answers when clicked: its link is its words
    expect(html).not.toContain("https://example.com/relay");
    expect(html).toContain("the relay");
  });

  it("draws an option's Markdown whole, never reading a link to `recommended` as the Recommended tag (#2220 review)", () => {
    const twins: InteractivePrompt = { ...ask, options: [{ label: "Keep [production](recommended)", description: null }, { label: "Keep [production]", description: null }], custom_option_index: 2 };
    const html = render(twins, ["en"]);
    const labels = [...html.matchAll(/<span class="prompt-card-option-label">(.*?)<\/span><\/span>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, ""));
    expect(labels).toEqual(["Keep production", "Keep [production]"]);
    expect(html).not.toContain("prompt-card-tag");
  });

  it("draws a card read off the screen as plain text", () => {
    const { text_format: _, ...plain } = ask;
    const html = render(plain, ["en"]);
    expect(html).toContain("Which **route** carries it?");
    expect(html).toContain("Use `local` socket");
  });
});
