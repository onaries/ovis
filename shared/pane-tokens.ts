/**
 * One of a `$name` token's `rules`, kept only for whether it hides the token: the web UI draws
 * every token in its own dim style, so herdr's `fg`, `bold` and `dim` overrides are left out.
 * Each rule has exactly one condition.
 */
export interface PaneTokenRule {
  equals?: string;
  contains?: string;
  starts_with?: string;
  gt?: number;
  lt?: number;
  /** ASCII letters only, as herdr matches */
  ignore_case?: boolean;
  hide?: boolean;
}

export interface PaneTokenSpec {
  /** the token's name, without its `$` */
  name: string;
  /** in herdr's order: the first rule that matches decides; absent when none of them hides the token */
  rules?: PaneTokenRule[];
}

/** The `$name` tokens of herdr's `[ui.sidebar.agents]`, in the order its rows name them; a token named in two places is listed at each. */
export interface AgentRowTokens {
  /** from `rows`; null when the config sets none (herdr's default rows name no token), and a row then draws every token */
  rows: PaneTokenSpec[] | null;
  /** `rows_by_agent`: a canonical agent id's own rows, in place of `rows` */
  by_agent: Record<string, PaneTokenSpec[]>;
}

export const PANE_TOKEN_NAME = /^[A-Za-z0-9_-]{1,32}$/;

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

export const ROLE_TOKEN = "role";

export function isBackgroundRole(value: unknown): boolean {
  return typeof value === "string" && asciiLower(value.trim()) === "background";
}

export function paneTokenRuleMatches(rule: PaneTokenRule, value: string): boolean {
  if (rule.gt !== undefined || rule.lt !== undefined) {
    if (!NUMBER.test(value)) return false;
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    return rule.gt !== undefined ? number > rule.gt : number < rule.lt!;
  }
  const fold = rule.ignore_case ? asciiLower : (text: string) => text;
  if (rule.equals !== undefined) return fold(value) === fold(rule.equals);
  if (rule.contains !== undefined) return fold(value).includes(fold(rule.contains));
  if (rule.starts_with !== undefined) return fold(value).startsWith(fold(rule.starts_with));
  return false;
}

export function paneTokenSpecs(layout: AgentRowTokens | null, agent: string | null): PaneTokenSpec[] | null {
  return (layout && agent !== null && Object.hasOwn(layout.by_agent, agent) ? layout.by_agent[agent] : undefined) ?? layout?.rows ?? null;
}

export function paneTokenValues(layout: AgentRowTokens | null, agent: string | null, tokens: Readonly<Record<string, unknown>> | null | undefined): string[] {
  if (!tokens) return [];
  const valueOf = (name: string): string | null => {
    const value = Object.hasOwn(tokens, name) ? tokens[name] : undefined;
    return typeof value === "string" && value.trim() ? value : null;
  };
  const specs = paneTokenSpecs(layout, agent);
  if (specs === null) return Object.keys(tokens).sort().flatMap((name) => name === ROLE_TOKEN && isBackgroundRole(tokens[name]) ? [] : valueOf(name)?.trim() ?? []);
  const shown: string[] = [];
  const said = new Set<string>();
  for (const { name, rules } of specs) {
    if (said.has(name)) continue;
    const value = valueOf(name);
    if (value === null || rules?.find((rule) => paneTokenRuleMatches(rule, value))?.hide) continue;
    said.add(name);
    shown.push(value.trim());
  }
  return shown;
}
