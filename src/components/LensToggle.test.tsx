import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PaneView } from "../lib/actions.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { LensToggle } from "./LensToggle.tsx";

function draw(view: PaneView, peek = false, terminalAttach = true): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    const toggle = createElement(LensToggle, { view, peek, terminalAttach, title: (label: string) => `${label} (Ctrl+Shift+J)`, onToggle: () => {} });
    return renderToStaticMarkup(createElement(SettingsProvider, { children: toggle }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

it("is one button named for the lens a press opens", () => {
  const chat = draw("chat");
  expect(chat.match(/<button/g)).toHaveLength(1);
  expect(chat).toContain('data-view="chat"');
  expect(chat).toContain('aria-label="Switch to terminal"');
  expect(chat).toContain('title="Switch to terminal (Ctrl+Shift+J)"');
  expect(chat).not.toContain("aria-pressed");
  expect(draw("terminal")).toContain('aria-label="Switch to chat"');
});

it("takes a terminal peek over the chat for the terminal: a press goes back to the chat", () => {
  const peek = draw("chat", true);
  expect(peek).toContain('data-view="terminal"');
  expect(peek).toContain('aria-label="Switch to chat"');
});

it("says a Windows PC's terminal is coming, only on the way to it", () => {
  const soon = draw("chat", false, false);
  expect(soon).toContain('aria-label="Switch to terminal · soon"');
  expect(soon).toContain('title="Live terminal: coming to Windows PCs once herdr can attach there"');
  expect(draw("terminal", false, false)).toContain('aria-label="Switch to chat"');
});
