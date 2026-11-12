import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderUsage, StatuslineState, UsageCredits, UsageProviderId, UsageRecorder, UsageReport, UsageWindow } from "../../shared/protocol.ts";
import { RECORDED_STALE_AFTER_MS } from "../../shared/usage.ts";
import { ApiError, fetchStatusline, fetchUsage, setStatusline } from "./api.ts";
import type { UsageCount, UsageGlance } from "./settings.ts";
import { currentLocale, t } from "./i18n.ts";
import { lastSeen } from "./lastSeen.ts";
import { usePageVisible } from "./visibility.ts";

/** The server asks a provider at most every 5 minutes; a minute here only picks that up sooner. */
const POLL_MS = 60_000;
/** from this much used, a limit is near enough to show in the blocked color */
export const HIGH_PERCENT = 80;

export const PROVIDER_NAME: Readonly<Record<UsageProviderId, string>> = {
  claude: "Claude", codex: "Codex", cursor: "Cursor", copilot: "GitHub Copilot", grok: "Grok", antigravity: "Antigravity", opencode: "OpenCode",
};

/** AgentMark's name for each provider's logo */
export const PROVIDER_MARK: Readonly<Record<UsageProviderId, string>> = {
  claude: "claude", codex: "codex", cursor: "cursor", copilot: "copilot", grok: "grok", antigravity: "agy", opencode: "opencode",
};

export const WINDOW_LABEL: Readonly<Record<UsageWindow["kind"], string>> = {
  session: "Session",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** The tools whose own record of an account's limits the server reads, as their users know them. */
export const RECORDER_NAME: Readonly<Record<UsageRecorder, string>> = { omp: "Oh My Pi", gjc: "Gajae Code" };

/** A recorder's name; its id for one this page does not know yet (a newer server's). */
function recorderName(by: string): string {
  return (RECORDER_NAME as Readonly<Record<string, string | undefined>>)[by] ?? by;
}

/** A pane's agent selects a provider, not an inferred active account. */
export function providerForAgent(agent: string | null | undefined): UsageProviderId | null {
  return (Object.keys(PROVIDER_MARK) as UsageProviderId[]).find((id) => PROVIDER_MARK[id] === agent) ?? null;
}

/**
 * The providers a pi-family harness (gjc, omp, omo, pi) names that only a subscription signs in to:
 * `openai-codex` is ChatGPT's sign-in, `anthropic-subscription` OmO's Claude one (it runs Claude
 * Code). A plain `anthropic` is recorded the same for a Claude sign-in and an API key, so it, like
 * any other provider, is no plan.
 */
const PLAN_PROVIDER: Readonly<Record<string, UsageProviderId>> = { "anthropic-subscription": "claude", "openai-codex": "codex" };

/**
 * The plan a pane draws on: its agent's, else the one the provider its conversation runs at
 * (ConversationMetadata.provider) names. Neither: no plan, rather than one guessed.
 */
export function planForPane(agent: string | null | undefined, provider: string | null | undefined): UsageProviderId | null {
  return providerForAgent(agent) ?? (provider && Object.hasOwn(PLAN_PROVIDER, provider) ? PLAN_PROVIDER[provider]! : null);
}

/** The first visible account in Settings order supplies the composer's compact reference. */
export function composerUsage(providers: readonly ProviderUsage[], agent: string | null, order: readonly string[], hidden: readonly string[], provider?: string | null): ProviderUsage | undefined {
  const providerId = planForPane(agent, provider);
  return orderProviders(providers, order).find((usage) => usage.id === providerId && !hidden.includes(usage.key));
}

/** Plan-wide five-hour session first, then week; scoped limits do not stand in for either. */
export function statusWindows(usage: ProviderUsage): UsageWindow[] {
  return (["session", "week"] as const)
    .map((kind) => usage.windows.find((window) => window.kind === kind && window.scope === null))
    .filter((window): window is UsageWindow => window !== undefined);
}

/** The limit closest to running out: what a chip shows when the plan has no limit of the chosen kind. */
export function tightestWindow(usage: ProviderUsage): UsageWindow | null {
  return usage.windows.reduce<UsageWindow | null>((tightest, window) => tightest === null || window.used_percent > tightest.used_percent ? window : tightest, null);
}

/**
 * The limit a chip shows: the plan-wide one of the kind chosen in Settings (the week, or the
 * short session), never a model's own. A plan without it shows its limit closest to running out.
 */
export function glanceWindow(usage: ProviderUsage, glance: UsageGlance): UsageWindow | null {
  return usage.windows.find((window) => window.kind === glance && window.scope === null) ?? tightestWindow(usage);
}

export function windowLabel(window: UsageWindow): string {
  const kind = t(WINDOW_LABEL[window.kind]);
  if (window.scope === null) return kind;
  const scope = window.scope === "Other models" ? t("Other models") : window.scope === "Cursor models" ? t("Cursor models") : window.scope;
  return `${kind} · ${scope}`;
}

/** A provider and, when known, whose account it is: "Codex · me@example.com". */
export function usageName(usage: ProviderUsage): string {
  return usage.account ? `${PROVIDER_NAME[usage.id]} · ${usage.account}` : PROVIDER_NAME[usage.id];
}

/** An account read through the hub: its sign-in lives in the hub, not on this PC. */
export function isHubAccount(usage: ProviderUsage): boolean {
  return usage.key.startsWith(`${usage.id}:cliproxy:`);
}

/** Whose record an account's numbers are ("Recorded by Oh My Pi"); null for a reading the server made itself. */
export function recordedBy(usage: ProviderUsage): string | null {
  return usage.recorded ? t("Recorded by {tool}", { tool: recorderName(usage.recorded.by) }) : null;
}

/** For a recorder this page does not know yet: as long as any tool it knows is given. */
const LONGEST_STALE_AFTER_MS = Math.max(...Object.values(RECORDED_STALE_AFTER_MS));

/**
 * This device's two clocks, read together. A correction can set the wall clock back or forward; the running one only
 * moves on, but stands still on some devices while they sleep.
 */
export interface DeviceTime {
  readonly wall: number;
  readonly running: number;
}

const deviceTime = (): DeviceTime => ({ wall: Date.now(), running: performance.now() });

/**
 * The time gone by from one reading to a later one: the longer of the two clocks' answers. A sleep shortens one and a
 * wall clock set back the other, and neither may make a record younger than it is.
 */
export function goneBy(from: DeviceTime, to: DeviceTime): number {
  return Math.max(0, to.wall - from.wall, to.running - from.running);
}

/**
 * What the PC last said, to be aged on this device: `report` without the PC's time, the one object handed on while
 * the PC keeps saying the same; `serverTime`, the PC's clock in its latest answer; `heardAt`, when that one arrived.
 */
export interface HeldReport {
  readonly report: UsageReport;
  readonly serverTime: string | undefined;
  readonly heardAt: DeviceTime;
}

/** What to hold once `next` arrives: the report object in hand while `next` says the same but for the PC's time, so that an unchanged answer redraws nothing. */
export function heldReport(held: HeldReport | null, next: UsageReport, heardAt: DeviceTime): HeldReport {
  const { server_time: serverTime, ...said } = next;
  return { report: held !== null && JSON.stringify(held.report) === JSON.stringify(said) ? held.report : said, serverTime, heardAt };
}

/**
 * How old a record the PC has just called current was when the PC said so: the PC's time less the record's, both on
 * the PC's clock, so that no device's clock is held against the PC's. An older server says no time. Then this
 * device's clock is asked, and believed only where it agrees with the PC: between no age and `limit`, past which the
 * PC would have called the record stale. A clock far from the PC's is thus not believed, and the record counts as
 * just read.
 */
function ageWhenHeard(held: HeldReport, checkedAt: string | null, limit: number): number {
  if (checkedAt === null) return 0;
  if (held.serverTime !== undefined) {
    const seen = Date.parse(held.serverTime) - Date.parse(checkedAt);
    return Number.isFinite(seen) ? Math.max(0, seen) : 0;
  }
  const guessed = held.heardAt.wall - Date.parse(checkedAt);
  return guessed >= 0 && guessed <= limit ? guessed : 0;
}

/**
 * The report in hand, `since` milliseconds after the PC's last answer: a record older by then than its tool leaves
 * between reads is stale, whatever the PC said of it. Its age is the one it had when the PC last answered plus the time
 * gone by on this device since. The held report itself where nothing has aged.
 */
export function agedReport(held: HeldReport, since: number): UsageReport {
  const aged = (usage: ProviderUsage): ProviderUsage => {
    if (!usage.recorded || usage.recorded.stale) return usage;
    const limit = (RECORDED_STALE_AFTER_MS as Readonly<Record<string, number | undefined>>)[usage.recorded.by] ?? LONGEST_STALE_AFTER_MS;
    return ageWhenHeard(held, usage.checked_at, limit) + since > limit ? { ...usage, recorded: { ...usage.recorded, stale: true } } : usage;
  };
  const providers = held.report.providers.map(aged);
  return providers.some((usage, index) => usage !== held.report.providers[index]) ? { ...held.report, providers } : held.report;
}

/**
 * What tells a record from a reading, a line each: who recorded it and when ("Recorded by Oh My Pi, 4 min ago"), and,
 * once that tool has stopped reading, that the numbers may have moved. Null for a reading the server made itself.
 */
export function recordedNote(usage: ProviderUsage, now: number): readonly string[] | null {
  if (!usage.recorded) return null;
  const by = t("Recorded by {tool}, {when}", { tool: recorderName(usage.recorded.by), when: lastSeen(usage.checked_at, now) });
  return usage.recorded.stale ? [by, t("It may have changed since.")] : [by];
}

/**
 * Whether the server's PC holds a sign-in of this account. Not so for one known only from another tool's record of
 * it: that is the tool's sign-in, and the agent itself is still to be signed in.
 */
export function isSignIn(usage: ProviderUsage): boolean {
  return usage.recorded?.signed_in !== false;
}

/**
 * Whether an account's numbers can stand for what is used now: read by the server without a problem, or recorded by a
 * tool that still updates them. A problem is the sign-in's, and says nothing of a record standing in for its numbers.
 */
export function isCurrent(usage: ProviderUsage): boolean {
  return usage.recorded ? !usage.recorded.stale : usage.problem === null;
}

/**
 * An expired sign-in this PC's own CLI can renew in a terminal tab, in the account's own home:
 * Claude's and Codex's, whose CLIs sign in to the home they are given. The other CLIs may keep a
 * sign-in apart from the one read here (Cursor's app, Copilot's editor), and a hub's account signs
 * in in the hub.
 */
export function canSignInAgain(usage: ProviderUsage): boolean {
  return usage.problem === "expired" && (usage.id === "claude" || usage.id === "codex") && !isHubAccount(usage);
}

/** What a meter shows of a limit: the share used, or what is left. */
export function meterPercent(window: UsageWindow, count: UsageCount): number {
  return count === "left" ? Math.round((100 - window.used_percent) * 10) / 10 : window.used_percent;
}

/** A meter's value as text: "77%" used, "23% left". */
export function meterText(window: UsageWindow, count: UsageCount): string {
  const value = formatPercent(meterPercent(window, count));
  return count === "left" ? t("{percent} left", { percent: value }) : value;
}

/** "2d 4h", "3h 12m", "12m" until a reset; null when it is unknown or already past. */
export function formatResetIn(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return t("{m}m", { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{h}h {m}m", { h: hours, m: minutes % 60 });
  return t("{d}d {h}h", { d: Math.floor(hours / 24), h: hours % 24 });
}

/**
 * What a credits row says: money in the provider's currency ("€12.19 / €15.39" against a cap,
 * "€4.00 spent" without one), or Codex's balance in whole credits as Codex's /status rounds it.
 */
export function creditsText(credits: UsageCredits): string {
  const locale = currentLocale();
  if (credits.kind === "balance") {
    if (credits.unlimited) return t("Unlimited");
    return credits.balance === null ? t("Available") : t("{n} credits", { n: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(credits.balance) });
  }
  const money = (amount: number): string => {
    try { return new Intl.NumberFormat(locale, { style: "currency", currency: credits.currency }).format(amount); } catch { return `${amount} ${credits.currency}`; }
  };
  if (credits.limit !== null) return `${credits.used === null ? "—" : money(credits.used)} / ${money(credits.limit)}`;
  return credits.used === null ? t("Unlimited") : t("{amount} spent", { amount: money(credits.used) });
}

/** Percent as the meters print it: whole numbers, except the tenth that keeps a sliver above 0 visible. */
export function formatPercent(value: number): string {
  return value > 0 && value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

/** The accounts in the user's order (`order`, by key), then the rest as the server lists them. */
export function orderProviders(providers: readonly ProviderUsage[], order: readonly string[] = []): ProviderUsage[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...providers].sort((a, b) => {
    const ranked = [rank.get(a.key), rank.get(b.key)];
    if (ranked[0] !== undefined && ranked[1] !== undefined) return ranked[0] - ranked[1];
    if (ranked[0] !== undefined || ranked[1] !== undefined) return ranked[0] !== undefined ? -1 : 1;
    return 0;
  });
}

/**
 * The order after moving `key` one place up or down among the accounts shown (`shown`, in their
 * current order). Accounts remembered but not reported now keep their place after them.
 */
export function moveInOrder(shown: readonly string[], saved: readonly string[], key: string, by: -1 | 1): string[] {
  const next = [...shown];
  const from = next.indexOf(key);
  const to = from + by;
  if (from < 0 || to < 0 || to >= next.length) return [...shown, ...saved.filter((known) => !shown.includes(known))];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return [...next, ...saved.filter((known) => !shown.includes(known))];
}

export function useUsage(enabled: boolean) {
  const [held, setHeld] = useState<HeldReport | null>(null);
  const [loading, setLoading] = useState(false);
  /**
   * How long the PC has been silent, from its last answer (`from`) up to the last ask (`at`). At each ask it is the
   * longer of two: what it was plus what surely went by since the ask before, which is the running clock's stretch; and
   * what the two clocks say of the whole time since the answer. So a clock put right takes nothing back and no record
   * grows younger, a clock set back and forward again counts for nothing, and a sleep still counts.
   */
  const [silence, setSilence] = useState<{ readonly since: number; readonly at: DeviceTime; readonly from: DeviceTime }>(() => { const opened = deviceTime(); return { since: 0, at: opened, from: opened }; });
  const visible = usePageVisible();
  const generation = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const current = ++generation.current;
    setLoading(true);
    // asked, not yet answered: a server that never answers must not leave the report in hand as young as it arrived
    const askedAt = deviceTime();
    setSilence((before) => ({ since: Math.max(before.since + Math.max(0, askedAt.running - before.at.running), goneBy(before.from, askedAt)), at: askedAt, from: before.from }));
    try {
      const next = await fetchUsage(refresh);
      if (current === generation.current) { const heardAt = deviceTime(); setHeld((previous) => heldReport(previous, next, heardAt)); setSilence({ since: 0, at: heardAt, from: heardAt }); }
    } catch { /* offline or restarting: the last report stays, and ages with each ask */ }
    finally { if (current === generation.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!enabled) { generation.current++; setHeld(null); setLoading(false); return; }
    if (!visible) return;
    void load(false);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, visible, load]);

  useEffect(() => {
    if (!enabled) return;
    const changed = () => void load(true);
    window.addEventListener("herdr-usage-changed", changed);
    return () => window.removeEventListener("herdr-usage-changed", changed);
  }, [enabled, load]);

  const refresh = useCallback(() => { if (enabled) void load(true); }, [enabled, load]);
  const report = useMemo(() => held === null ? null : agedReport(held, silence.since), [held, silence.since]);
  return { report, loading, refresh };
}

const STATUSLINE_CHANGED = "herdr-statusline-changed";

/**
 * Settings' switch for reading Claude's limits from its status line on the server's PC, and the
 * usage popover's offer of it: `watch` reads the state (the offer only turns it on). A change asks
 * every usage view for fresh limits, and every switch for the new state.
 */
export function useStatuslineSwitch(watch: boolean) {
  const [state, setState] = useState<StatuslineState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!watch) return;
    let live = true;
    const read = () => void fetchStatusline().then((next) => { if (live) setState(next); }, () => { /* an older server: no switch */ });
    read();
    window.addEventListener(STATUSLINE_CHANGED, read);
    return () => { live = false; window.removeEventListener(STATUSLINE_CHANGED, read); };
  }, [watch]);
  const set = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setState(await setStatusline(enabled));
    } catch (cause) {
      // the server's own words (what was refused, and why), without the URL and status in front
      setError(cause instanceof ApiError ? cause.detail : t("Could not change Claude's status line"));
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event(STATUSLINE_CHANGED));
      window.dispatchEvent(new Event("herdr-usage-changed"));
    }
  }, []);
  return { state, busy, error, set };
}
