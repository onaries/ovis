import { describe, expect, it } from "bun:test";
import type { ProviderUsage, UsageWindow } from "../../shared/protocol.ts";
import { canSignInAgain, composerUsage, formatPercent, formatResetIn, glanceWindow, meterPercent, meterText, moveInOrder, orderProviders, providerForAgent, statusWindows, tightestWindow, usageName, windowLabel } from "./usage.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const window = (used_percent: number, kind: UsageWindow["kind"] = "week", scope: string | null = null): UsageWindow => ({ kind, scope, used_percent, resets_at: null, starts_at: null });
const provider = (id: ProviderUsage["id"], windows: UsageWindow[], account: string | null = null): ProviderUsage => ({
  id, key: account ? `${id}:${account}` : id, account, plan: null, windows, problem: null, checked_at: null,
});

describe("usage meters", () => {
  it("uses the agent's provider and the first visible account in Settings order", () => {
    const accounts = [provider("claude", [window(40)]), provider("codex", [window(20)], "a@x"), provider("codex", [window(80)], "b@x")];
    expect(composerUsage(accounts, "codex", ["codex:b@x"], [])?.account).toBe("b@x");
    expect(composerUsage(accounts, "codex", ["codex:b@x"], ["codex:b@x"])?.account).toBe("a@x");
    expect(composerUsage(accounts, "pi", [], [])).toBeUndefined();
    expect(composerUsage(accounts, null, [], [])).toBeUndefined();
    expect(providerForAgent("agy")).toBe("antigravity");
    expect(providerForAgent("opencode")).toBe("opencode");
  });

  it("prioritizes the plan-wide five-hour session, with weekly fallback only", () => {
    expect(statusWindows(provider("claude", [window(99, "week", "Sonnet"), window(84), window(22, "session")]))).toEqual([window(22, "session"), window(84)]);
    expect(statusWindows(provider("codex", [window(84)]))).toEqual([window(84)]);
    expect(statusWindows(provider("claude", [window(22, "session", "Opus"), window(84)]))).toEqual([window(84)]);
    expect(statusWindows(provider("cursor", [window(80, "month")]))).toEqual([]);
  });
  it("shows the limit closest to running out", () => {
    expect(tightestWindow(provider("codex", [window(12, "session"), window(77)]))).toEqual(window(77));
    expect(tightestWindow(provider("claude", []))).toBeNull();
  });

  it("shows the chosen limit of the whole plan, and the closest to running out where a plan has none", () => {
    const claude = provider("claude", [window(80, "session"), window(30), window(95, "week", "Sonnet")]);
    expect(glanceWindow(claude, "week")).toEqual(window(30));
    expect(glanceWindow(claude, "session")).toEqual(window(80, "session"));
    expect(glanceWindow(provider("codex", [window(30)]), "session")).toEqual(window(30));
    expect(glanceWindow(provider("cursor", [window(20, "month"), window(60, "month", "Premium")]), "week")).toEqual(window(60, "month", "Premium"));
    expect(glanceWindow(provider("grok", []), "week")).toBeNull();
  });

  it("keeps the server's order until the user arranges the accounts", () => {
    const order = orderProviders([provider("claude", []), provider("codex", [window(40)]), provider("copilot", [window(90, "month")])]);
    expect(order.map((usage) => usage.id)).toEqual(["claude", "codex", "copilot"]);
  });

  it("follows the user's order first, then the server's", () => {
    const providers = [provider("claude", [window(10)]), provider("codex", [window(40)], "a@x"), provider("codex", [window(90)], "b@x"), provider("grok", [window(50)])];
    const keys = (order: string[]) => orderProviders(providers, order).map((usage) => usage.key);
    expect(keys([])).toEqual(["claude", "codex:a@x", "codex:b@x", "grok"]);
    expect(keys(["claude", "codex:a@x", "gone"])).toEqual(["claude", "codex:a@x", "codex:b@x", "grok"]);
  });

  it("moves an account one place and keeps accounts not reported now", () => {
    expect(moveInOrder(["a", "b", "c"], ["x", "b"], "c", -1)).toEqual(["a", "c", "b", "x"]);
    expect(moveInOrder(["a", "b", "c"], [], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b"], [], "a", 1)).toEqual(["b", "a"]);
  });

  it("offers signing in again only for an expired sign-in this PC's own CLI holds", () => {
    const expired = (id: ProviderUsage["id"], key: string, problem: ProviderUsage["problem"] = "expired"): ProviderUsage => ({ ...provider(id, []), key, problem });
    expect(canSignInAgain(expired("claude", "claude:team"))).toBe(true);
    expect(canSignInAgain(expired("codex", "codex@0123456789ab"))).toBe(true);
    expect(canSignInAgain(expired("codex", "codex:cliproxy:hub-1"))).toBe(false);
    expect(canSignInAgain(expired("antigravity", "antigravity@keychain"))).toBe(false);
    expect(canSignInAgain(expired("cursor", "cursor:c1"))).toBe(false);
    expect(canSignInAgain(expired("opencode", "opencode@0123456789ab"))).toBe(false);
    expect(canSignInAgain(expired("claude", "claude:team", null))).toBe(false);
    expect(canSignInAgain(expired("claude", "claude:team", "failed"))).toBe(false);
  });

  it("counts a meter as used or left, and names the account", () => {
    expect(meterPercent(window(77.4), "used")).toBe(77.4);
    expect(meterPercent(window(77.4), "left")).toBe(22.6);
    expect(meterText(window(77), "used")).toBe("77%");
    expect(meterText(window(77), "left")).toBe("23% left");
    expect(usageName(provider("codex", [], "me@example.com"))).toBe("Codex · me@example.com");
    expect(usageName(provider("grok", []))).toBe("Grok");
  });

  it("formats the time to a reset, and nothing for a past or unknown one", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(formatResetIn(at(12 * 60_000), NOW)).toBe("12m");
    expect(formatResetIn(at(3 * 3600_000 + 5 * 60_000), NOW)).toBe("3h 5m");
    expect(formatResetIn(at(23 * 3600_000 + 59 * 60_000), NOW)).toBe("23h 59m");
    expect(formatResetIn(at(50 * 3600_000), NOW)).toBe("2d 2h");
    expect(formatResetIn(at(-1000), NOW)).toBeNull();
    expect(formatResetIn(null, NOW)).toBeNull();
  });

  it("keeps a sliver above zero visible and rounds the rest", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.4)).toBe("0.4%");
    expect(formatPercent(2.2)).toBe("2%");
    expect(formatPercent(99.6)).toBe("100%");
  });

  it("names a window by its span and its scope", () => {
    expect(windowLabel(window(1, "session"))).toBe("Session");
    expect(windowLabel(window(1, "week", "Sonnet"))).toBe("Weekly · Sonnet");
    expect(windowLabel(window(1, "month", "Premium"))).toBe("Monthly · Premium");
    expect(windowLabel(window(1, "month", "Cursor models"))).toBe("Monthly · Cursor models");
  });
});
