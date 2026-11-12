import { afterEach, beforeEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import { TurnUsage } from "./TurnUsage.tsx";

const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
beforeEach(() => Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] }));
afterEach(() => {
  if (languages) Object.defineProperty(navigator, "languages", languages);
  else Reflect.deleteProperty(navigator, "languages");
});

test("answer usage includes cached input and weights cache hits by input tokens", () => {
  const markup = renderToStaticMarkup(<SettingsProvider><TurnUsage usage={{ input: 100, output: 25, cache_read: 300, cache_write: 100 }} /></SettingsProvider>);
  expect(markup).toContain(': 500"');
  expect(markup).toContain(': 25"');
  expect(markup).toContain("60%");
  expect(markup).toContain("300 / 500");
});

test("missing usage stays hidden and zero input has no invented hit rate", () => {
  expect(renderToStaticMarkup(<SettingsProvider><TurnUsage usage={undefined} /></SettingsProvider>)).toBe("");
  const markup = renderToStaticMarkup(<SettingsProvider><TurnUsage usage={{ input: 0, output: 0, cache_read: 0, cache_write: 0 }} /></SettingsProvider>);
  expect(markup).not.toContain("%");
  expect(markup).not.toContain("NaN");
});
