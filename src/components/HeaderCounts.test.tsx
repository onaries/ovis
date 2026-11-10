import { expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { HeaderCounts } from "./HeaderCounts.tsx";

function draw(counts: { working: number; waiting: number; done: number }): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(HeaderCounts, { counts, onOpen: () => {} }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

it("draws nothing while no session runs or finished unseen: a waiting one is More's dot", () => {
  expect(draw({ working: 0, waiting: 0, done: 0 })).toBe("");
  expect(draw({ working: 0, waiting: 2, done: 0 })).toBe("");
});

it("counts the running and the finished sessions in one button that opens the drawer", () => {
  const markup = draw({ working: 2, waiting: 1, done: 3 });
  expect([...markup.matchAll(/class="header-count is-(\w+)"/g)].map((match) => match[1])).toEqual(["working", "done"]);
  expect(markup.match(/<button/g)).toHaveLength(1);
  expect(markup).toContain('aria-label="2 working · 3 done · Open workspace list"');
  expect(draw({ working: 0, waiting: 0, done: 1 })).not.toContain("is-working");
  expect(draw({ working: 1, waiting: 0, done: 0 })).not.toContain("is-done");
});
