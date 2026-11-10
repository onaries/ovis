import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusDot, type StatusDotSize, type StatusDotState } from "./StatusDot.tsx";

const STATES: readonly StatusDotState[] = ["ready", "needs-you", "offline", "updating", "checking", "failed"];

type Part = { readonly tag: string; readonly attrs: Readonly<Record<string, string>> };

const render = (state: StatusDotState, size?: StatusDotSize): string =>
  renderToStaticMarkup(createElement(StatusDot, size === undefined ? { state } : { state, size }));

const attrsOf = (source: string): Record<string, string> => Object.fromEntries([...source.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name!, value!]));
const svgAttrs = (html: string): Record<string, string> => attrsOf(/<svg([^>]*)>/.exec(html)?.[1] ?? "");
const paintedParts = (html: string): Part[] => [...html.matchAll(/<(circle|path)([^>]*)\/?>/g)].map(([, tag, source]) => ({ tag: tag!, attrs: attrsOf(source!) }));
const outline = (html: string): string => paintedParts(html).map(({ tag, attrs }) => `${tag}:${attrs["d"] ?? attrs["r"]}:${attrs["fill"]}`).join("|");

describe("StatusDot", () => {
  it("draws a different shape for every state, so no state is told by colour alone", () => {
    expect(new Set(STATES.map((state) => outline(render(state)))).size).toBe(STATES.length);
  });

  it("fills the ready disc, outlines the offline ring and half-fills needs you", () => {
    const filled = (state: StatusDotState) => paintedParts(render(state)).filter(({ attrs }) => attrs["fill"] === "currentColor").length;
    expect([filled("ready"), filled("offline"), filled("needs-you")]).toEqual([1, 0, 1]);
    expect(paintedParts(render("offline")).map(({ tag, attrs }) => [tag, attrs["stroke"]])).toEqual([["circle", "currentColor"]]);
  });

  it("paints only in currentColor, so forced colours keep every shape in the system ink", () => {
    for (const state of STATES) {
      const paints = paintedParts(render(state)).flatMap(({ attrs }) => [attrs["fill"], attrs["stroke"]]);
      expect(paints.filter((paint) => paint !== "currentColor" && paint !== "none")).toEqual([]);
      expect(paints).toContain("currentColor");
    }
  });

  it("stays out of the accessibility tree and the tab order beside its word", () => {
    for (const state of STATES) {
      const attrs = svgAttrs(render(state));
      expect([attrs["aria-hidden"], attrs["focusable"], attrs["data-state"]]).toEqual(["true", "false", state]);
    }
  });

  it("is the data glyph unless a line of text asks for the inline one, with the same shape", () => {
    expect(svgAttrs(render("ready"))["data-size"]).toBe("glyph");
    expect(svgAttrs(render("ready", "inline"))["data-size"]).toBe("inline");
    for (const state of STATES) expect(outline(render(state, "inline"))).toBe(outline(render(state)));
  });
});
