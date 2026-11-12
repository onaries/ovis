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

test("visible input excludes cache while the hit rate uses all input tokens", () => {
  const markup = renderToStaticMarkup(<SettingsProvider><TurnUsage usage={{ input: 100, output: 25, cache_read: 300, cache_write: 100 }} /></SettingsProvider>);
  expect(markup).toContain('aria-label="Input: 100"');
  expect(markup).toContain("↑100");
  expect(markup).toContain("↓25");
  expect(markup).toContain("Input including cache: 500");
  expect(markup).toContain(': 25"');
  expect(markup).toContain("60%");
  expect(markup).toContain("300 / 500");
});

test("OmO compact counters keep uncached 4.0k input apart from millions of cache reads", () => {
  const markup = renderToStaticMarkup(<SettingsProvider><TurnUsage usage={{ input: 4023, output: 2370, cache_read: 4357632, cache_write: 0 }} /></SettingsProvider>);
  expect(markup).toContain("↑4.0k");
  expect(markup).toContain("↓2.4k");
  expect(markup).toContain("99.9%");
});

test("missing usage stays hidden and zero input has no invented hit rate", () => {
  expect(renderToStaticMarkup(<SettingsProvider><TurnUsage usage={undefined} /></SettingsProvider>)).toBe("");
  const markup = renderToStaticMarkup(<SettingsProvider><TurnUsage usage={{ input: 0, output: 0, cache_read: 0, cache_write: 0 }} /></SettingsProvider>);
  expect(markup).not.toContain("%");
  expect(markup).not.toContain("NaN");
});
