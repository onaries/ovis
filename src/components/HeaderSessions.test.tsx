import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { HeaderSessions } from "./HeaderSessions.tsx";

function draw(counts: { working: number; waiting: number; done: number }, onNextWaiting: (() => void) | null, compact = false): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(HeaderSessions, { counts, onNextWaiting, compact }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

it("draws nothing while every session rests", () => {
  expect(draw({ working: 0, waiting: 0, done: 0 }, null)).toBe("");
});

it("draws a figure per state that has any, the waiting one a button that opens the next", () => {
  const markup = draw({ working: 2, waiting: 1, done: 3 }, () => {});
  expect([...markup.matchAll(/class="header-session-count is-(\w+)"/g)].map((match) => match[1])).toEqual(["working", "blocked", "done"]);
  expect(markup.match(/<button/g)).toHaveLength(1);
  expect(markup).toContain('aria-label="1 waiting for you · Open the next session waiting for you"');
  expect(draw({ working: 0, waiting: 0, done: 1 }, null)).not.toContain("is-working");
});

it("keeps the waiting button, with nothing to open, when only the selected session waits", () => {
  const markup = draw({ working: 0, waiting: 1, done: 0 }, null);
  expect(markup).toContain('aria-disabled="true"');
  expect(markup).toContain('aria-label="1 waiting for you"');
});

it("draws one pill on a phone: the waiting figure when one waits, else the running one, else the done one", () => {
  const states = (markup: string) => [...markup.matchAll(/class="header-session-count is-(\w+)"/g)].map((match) => match[1]);
  expect(states(draw({ working: 2, waiting: 1, done: 3 }, () => {}, true))).toEqual(["blocked"]);
  expect(states(draw({ working: 2, waiting: 0, done: 3 }, null, true))).toEqual(["working"]);
  expect(states(draw({ working: 0, waiting: 0, done: 3 }, null, true))).toEqual(["done"]);
});
