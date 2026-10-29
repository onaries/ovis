import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProviderUsage } from "../../shared/protocol.ts";
import type { UsageLoginProvider } from "../../shared/usage-login.ts";
import { fetchUsageLoginAccounts, startUsageLogin } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { usageName } from "../lib/usage.ts";

/**
 * Signs in again to an expired account this PC lists: the same sign-in as Add account, in a new
 * terminal tab, but in that account's own credential home, which the server finds by its key.
 */
export function UsageSignInAgain({ usage, onStarted }: { readonly usage: ProviderUsage; readonly onStarted: (paneId: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = usage.id;
  if (provider !== "claude" && provider !== "codex") return null;
  return <span className="usage-sign-in-again">
    {/* busy, not disabled: a disabled button drops focus, and the popover's Escape with it */}
    <button type="button" className="btn" aria-busy={busy} aria-label={t("Sign in again to {name}", { name: usageName(usage) })} onClick={() => {
      if (busy) return;
      setBusy(true); setError(null);
      void startUsageLogin({ provider, account: usage.key }).then((started) => onStarted(started.pane_id))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t("Could not start account sign-in")))
        .finally(() => setBusy(false));
    }}>{busy ? t("Starting…") : t("Sign in again")}</button>
    {error && <span className="settings-hint account-error" role="alert">{error}</span>}
  </span>;
}

export function UsageLocalLogin({ provider, onStarted }: { readonly provider: UsageLoginProvider; readonly onStarted: (paneId: string) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<readonly (string | null)[] | null>(provider.separate_home ? [] : null);
  const [confirmed, setConfirmed] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (!provider.separate_home) action.current?.focus(); }, [accounts, confirmed, provider.separate_home]);
  useEffect(() => {
    if (provider.separate_home) return;
    const controller = new AbortController();
    void fetchUsageLoginAccounts(provider.id, controller.signal).then((result) => setAccounts(result.accounts))
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("Could not load sign-in options")); });
    return () => controller.abort();
  }, [provider, t]);
  if (accounts === null) return <p className={`settings-hint${error ? " account-error" : ""}`} role={error ? "alert" : "status"}>{error ?? t("Loading…")}</p>;
  if (accounts.length > 0 && !confirmed) return <div className="account-auth-form">
    <p className="settings-hint">{t("Signed in as {account}. Continuing may replace it.", { account: accounts.map((account) => account ?? t("an existing account")).join(", ") })}</p>
    <button ref={action} type="button" className="btn" onClick={() => setConfirmed(true)}>{t("Continue")}</button>
  </div>;
  return <form className="account-auth-form" onSubmit={(event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    const id = provider.id;
    if (id === "antigravity") return;
    if ((id === "claude" || id === "codex") && typeof name !== "string") return;
    setBusy(true); setError(null);
    const request = id === "claude" || id === "codex"
      ? { provider: id, name: String(name) }
      : { provider: id, ...(confirmed ? { replace: true as const } : {}) };
    void startUsageLogin(request).then((started) => {
      onStarted(started.pane_id);
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : t("Could not start account sign-in"));
    }).finally(() => setBusy(false));
  }}>
    {provider.separate_home && <>
    <label className="settings-label" htmlFor="usage-account-name">{t("Account name")}</label>
    <input className="input" id="usage-account-name" name="name" pattern="[a-z0-9-]{1,32}" maxLength={32} required autoComplete="off" placeholder="work" disabled={busy} />
    <p className="settings-hint">{t("Lowercase letters, numbers and hyphens")}</p>
    </>}
    <p className="settings-hint">{provider.id === "claude"
      ? t("On another device, follow the steps in the tab.")
      : provider.id === "codex" ? t("Uses a device code when available.")
        : provider.id === "opencode" ? t("Choose OpenCode Go or Zen for plan limits.")
          : t("Follow the steps in the new tab.")}</p>
    {error && <p className="settings-hint account-error" role="alert">{error}</p>}
    <button ref={action} className="btn" type="submit" disabled={busy}>{busy ? t("Starting…") : t("Start sign-in")}</button>
  </form>;
}
