import { describe, expect, it } from "bun:test";
import { desktopLocale, desktopText } from "./text.ts";

describe("desktopLocale", () => {
  it("takes the languages the app's pages have, from the app's locale", () => {
    expect(desktopLocale("ko")).toBe("ko");
    expect(desktopLocale("ko-KR")).toBe("ko");
    expect(desktopLocale("ja-JP")).toBe("ja");
    expect(desktopLocale("zh-CN")).toBe("zh");
    expect(desktopLocale("zh-TW")).toBe("zh");
  });

  it("speaks English otherwise", () => {
    expect(desktopLocale("en-US")).toBe("en");
    expect(desktopLocale("de-DE")).toBe("en");
    expect(desktopLocale("")).toBe("en");
  });
});

describe("desktopText", () => {
  it("fills in the count", () => {
    expect(desktopText("en")("Keeping this computer awake: {count} agents working", { count: 3 })).toBe("Keeping this computer awake: 3 agents working");
    expect(desktopText("ko")("Keeping this computer awake: {count} agents working", { count: 3 })).toContain("3");
  });
});
