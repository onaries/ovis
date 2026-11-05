/**
 * The seam for an agent's own command list: native observers register an async per-pane provider
 * here, and /api/pane/commands merges what it answers over the static and scanned rows. A provider
 * only reads (no process is started here); it gets an abort signal that fires at the budget.
 */
import type { CommandForm, SlashCommand } from "../shared/protocol.ts";
import type { paneContext } from "./pane-context.ts";

export type CatalogPane = Awaited<ReturnType<typeof paneContext>>["pane"];

/** The asking server's own stores: a provider reads these, never a process-wide default, when they are set. */
export interface CatalogContext {
  codexHome?: string;
  openCodeStateDir?: string;
}

export interface CatalogSource {
  /** the agent whose rows this provider answers for, as resolveAgent names it */
  agent: string;
  /**
   * the kinds of rows this provider is the authority for: an answer (even an empty one) replaces the
   * scanned rows of these kinds. Without it, the kinds present in an answer are owned.
   */
  owns?: readonly ("commands" | "skills")[];
  /**
   * the agent runs a row of this provider before any scanned row of the same trigger and name (pi
   * dispatches an extension command before it expands a prompt template): those scanned rows go
   */
  shadows?: boolean;
  /** the backend commands and skills the agent reports for this pane, or null when it has no answer */
  rows(pane: CatalogPane, cwd: string, signal: AbortSignal, context?: CatalogContext): Promise<SlashCommand[] | null>;
}

/** how long one provider may take before its rows are left out */
export const CATALOG_SOURCE_BUDGET_MS = 1500;

const sources: CatalogSource[] = [];

/** Adds a provider; returns a function that removes it again. */
export function registerCatalogSource(provider: CatalogSource): () => void {
  sources.push(provider);
  return () => {
    const index = sources.indexOf(provider);
    if (index >= 0) sources.splice(index, 1);
  };
}

const UNKNOWN_FORMS: readonly CommandForm[] = [{ match: "bare", interaction: "unknown" }];

/** one provider's rows, or null on timeout, error or no answer */
async function ask(provider: CatalogSource, pane: CatalogPane, cwd: string, budgetMs: number, context: CatalogContext): Promise<SlashCommand[] | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(null); }, budgetMs);
  });
  try {
    // a throwing or non-async provider is the same as no answer
    const answer = Promise.resolve().then(() => provider.rows(pane, cwd, controller.signal, context));
    answer.catch(() => undefined);
    const rows = await Promise.race([answer, budget]);
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merges the registered providers for `agent` over `base` (the static and scanned rows). A provider
 * owns the backend commands and the skills it answered with: the scanned rows of the same kind are
 * replaced by its rows, marked native and verified. Builtin rows are never removed and a provider
 * cannot add one. A provider that times out, throws or answers null leaves `base` as it was.
 */
export async function mergeCatalogSources(agent: string | null, pane: CatalogPane, cwd: string, base: SlashCommand[], budgetMs = CATALOG_SOURCE_BUDGET_MS, context: CatalogContext = {}): Promise<SlashCommand[]> {
  if (!agent) return base;
  const providers = sources.filter((source) => source.agent === agent);
  if (providers.length === 0) return base;
  const answers = await Promise.all(providers.map((provider) => ask(provider, pane, cwd, budgetMs, context)));
  let merged = base;
  for (const [index, answer] of answers.entries()) {
    if (!answer) continue;
    const owns = providers[index]!.owns;
    const seen = new Set<string>();
    const native = answer.filter((row) => {
      if (row.source === "builtin") return false;
      if (row.id === undefined) return true;
      const key = JSON.stringify([row.trigger ?? "/", row.name, row.id]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((row): SlashCommand => ({
      ...row,
      forms: row.forms ?? [...UNKNOWN_FORMS],
      visibility: row.visibility ?? "offered",
      provenance: { transport: "native", verified: true },
    }));
    const ownsSkills = owns ? owns.includes("skills") : native.some((row) => row.source === "skill");
    const ownsCommands = owns ? owns.includes("commands") : native.some((row) => row.source !== "skill");
    const identity = (row: SlashCommand): string | null => row.id === undefined ? null : JSON.stringify([row.trigger ?? "/", row.name, row.id]);
    const nativeIdentities = new Set(native.map(identity).filter((key) => key !== null));
    const typed = (row: SlashCommand): string => JSON.stringify([row.trigger ?? "/", row.name]);
    const shadowed = providers[index]!.shadows ? new Set(native.map(typed)) : null;
    merged = [
      ...merged.filter((row) => row.source === "builtin" || ((row.source === "skill" ? !ownsSkills : !ownsCommands) && !nativeIdentities.has(identity(row) ?? "") && !shadowed?.has(typed(row)))),
      ...native,
    ].sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
  }
  return merged;
}
