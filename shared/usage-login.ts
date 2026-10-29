import type { UsageProviderId } from "./protocol.ts";

export type LocalUsageProvider = Exclude<UsageProviderId, "antigravity">;

/** Local account sign-in never accepts a command or a credential path from the browser. */
export type UsageLoginRequest =
  | { readonly provider: "claude" | "codex"; readonly name: string }
  | { readonly provider: Exclude<LocalUsageProvider, "claude" | "codex">; readonly replace?: true }
  /** Signs in again to an account GET /api/usage lists, by its key: the server finds its credential home. */
  | { readonly provider: "claude" | "codex"; readonly account: string };

/** Local PATH and credential discovery only, never a provider usage request or a credential. */
export interface UsageLoginProvider {
  readonly id: UsageProviderId;
  readonly cli: string;
  readonly installed: boolean;
  readonly local: boolean;
  readonly separate_home: boolean;
}

export interface UsageLoginAccounts {
  readonly accounts: readonly (string | null)[];
}

export interface UsageLoginStarted {
  readonly pane_id: string;
  readonly workspace_id: string;
  readonly manual: boolean;
  readonly device_auth: boolean;
}
