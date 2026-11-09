import { expect, test } from "bun:test";
import type { RelayStatus } from "../../shared/protocol.ts";
import { statusText } from "./RelayPanel.tsx";

const t = ((text: string, values?: Record<string, string | number>) => Object.entries(values ?? {}).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text)) as Parameters<typeof statusText>[0];
const base: RelayStatus = { phase: "online", relay: "wss://relay.ovis.sh", app: "https://app.ovis.sh", sessions: 0, blocked: null, error: null };

test("the relay row says when Ovis's relay needs an account, and nothing new otherwise", () => {
  expect(statusText(t, base)).toBe("Online. No phone connected.");
  expect(statusText(t, { ...base, pass: { state: "ok", relay: "ok", enforce_at: null, refused: false } })).toBe("Online. No phone connected.");
  // refused: told what to do, never the raw close reason
  expect(statusText(t, { ...base, phase: "error", error: "The Ovis relay needs a signed-in account (relay pass required).", pass: { state: "no_account", relay: null, enforce_at: null, refused: true } }))
    .toBe("The Ovis relay needs an Ovis account. Sign in, or connect over the same Wi-Fi or Tailscale.");
  expect(statusText(t, { ...base, phase: "error", pass: { state: "limit", relay: null, enforce_at: null, refused: true } })).toStartWith("This account has as many PCs");
  expect(statusText(t, { ...base, phase: "error", pass: { state: "unavailable", relay: null, enforce_at: null, refused: true } })).toBe("Cannot reach the Ovis account service for a relay pass. Retrying.");
  // in grace: still online, with the date
  expect(statusText(t, { ...base, pass: { state: "no_account", relay: "missing", enforce_at: "2027-01-01T00:00:00.000Z", refused: false } })).toStartWith("Online. Sign in to keep using the Ovis relay after ");
  // passes off on the relay (today): a PC without an account still sees the relay's own error
  expect(statusText(t, { ...base, phase: "error", error: "Relay connection lost; reconnecting.", pass: { state: "no_account", relay: null, enforce_at: null, refused: false } })).toBe("Error: Relay connection lost; reconnecting.");
  expect(statusText(t, { ...base, phase: "error", error: "Relay connection lost; reconnecting.", pass: { state: "unavailable", relay: null, enforce_at: null, refused: false } })).toBe("Error: Relay connection lost; reconnecting.");
  expect(statusText(t, { ...base, phase: "error", pass: { state: "not_listed", relay: null, enforce_at: null, refused: true } })).toStartWith("Add this PC to your Ovis account");
  // refused, but a new pass came since: the relay's own error until the PC is back
  expect(statusText(t, { ...base, phase: "error", error: "x", pass: { state: "ok", relay: null, enforce_at: null, refused: true } })).toBe("Error: x");
  // a pass renewed on the open control socket: no stale grace notice
  expect(statusText(t, { ...base, pass: { state: "ok", relay: "missing", enforce_at: "2027-01-01T00:00:00.000Z", refused: false } })).toBe("Online. No phone connected.");
  // a passing outage of the account service while the relay is unreachable is the old error
  expect(statusText(t, { ...base, phase: "error", error: "Relay connection lost; reconnecting.", pass: { state: "ok", relay: "ok", enforce_at: null, refused: false } })).toBe("Error: Relay connection lost; reconnecting.");
});
