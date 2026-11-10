import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsProvider } from "../lib/settings.ts";
import { ConnectionLine, type LineState } from "./ConnectionLine.tsx";

const render = (state: LineState, reason: string | null = null): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ConnectionLine, { state, reason }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const glyphState = (html: string): string | undefined => /class="status-dot" data-state="([\w-]+)" data-size="inline"/.exec(html)?.[1];
const words = (html: string): string => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "");

describe("ConnectionLine", () => {
  it("keeps Connected and Answers apart in words while both draw the ready glyph", () => {
    const connected = render({ kind: "connected", route: "lan", rttMs: 12 });
    const answered = render({ kind: "answered", route: "lan", rttMs: 12 });
    expect([glyphState(connected), glyphState(answered)]).toEqual(["ready", "ready"]);
    expect(words(connected)).toContain("Connected");
    expect(words(answered)).toContain("Answers");
    expect(words(answered)).not.toContain("Connected");
  });

  it("draws the checking arc while connecting and the hollow offline ring when down", () => {
    expect(glyphState(render({ kind: "checking" }))).toBe("checking");
    expect(glyphState(render({ kind: "offline", text: "Offline" }))).toBe("offline");
  });

  it("adds the reason line only to an offline row", () => {
    const reason = "The app is closed, or its network is off.";
    expect(render({ kind: "offline", text: "Offline" }, reason)).toContain("connection-reason");
    expect(render({ kind: "connected", route: "relay", rttMs: null }, reason)).not.toContain("connection-reason");
  });
});
