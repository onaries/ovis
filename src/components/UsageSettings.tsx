import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Eye, EyeOff, Network, Plus } from "lucide-react";
import type { CLIProxyStatus, ProviderUsage, UsageProviderId } from "../../shared/protocol.ts";
import { useSettings } from "../lib/settings.ts";
import { useT } from "../lib/i18n.ts";
import { canSignInAgain, isHubAccount, moveInOrder, orderProviders, PROVIDER_MARK, PROVIDER_NAME, usageName, useUsage } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";
import { cliProxyRequest } from "../lib/api.ts";
import { UsageAccountDialog } from "./UsageAccountDialog.tsx";
import { UsageSignInAgain } from "./UsageLocalLogin.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Segmented, SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";
import "./UsageSettings.css";

function ProviderAccounts({ id, providers, onLocalLogin }: { readonly id: UsageProviderId; readonly providers: readonly ProviderUsage[]; readonly onLocalLogin: ((paneId: string) => void) | undefined }) {
  const { settings, update } = useSettings();
  const t = useT();
  const all = orderProviders(providers, settings.usageOrder);
  const ordered = all.filter((usage) => usage.id === id);
  const move = (key: string, by: -1 | 1) => {
    const group = moveInOrder(ordered.map((usage) => usage.key), [], key, by);
    let index = 0;
    const keys = all.map((usage) => usage.id === id ? group[index++] ?? usage.key : usage.key);
    update({ usageOrder: [...keys, ...settings.usageOrder.filter((known) => !keys.includes(known))] });
  };
  return ordered.length === 0 ? <p className="settings-item settings-hint">{t("No accounts signed in")}</p> : <ol aria-label={PROVIDER_NAME[id]}>
    {ordered.map((usage, index) => {
      const name = usageName(usage);
      const hidden = settings.usageHidden.includes(usage.key);
      const status = usage.problem === null ? t("Signed in") : {
        expired: t("Expired"), failed: t("Failed"), rate_limited: t("Failed"), locked: t("Failed"),
      }[usage.problem];
      return <li key={usage.key} className={`usage-accounts-row${hidden ? " is-hidden" : ""}`}>
        <div className="usage-account-identity">
          <span className="usage-accounts-account" title={usage.account ?? undefined}>{usage.account ?? PROVIDER_NAME[id]}</span>
          <span className="usage-account-meta">
            <span>{isHubAccount(usage) ? t("Hub") : t("This PC")}{usage.plan ? ` · ${usage.plan}` : ""}</span>
            <span className={`usage-account-status${usage.problem ? " has-problem" : ""}`}>{status}</span>
          </span>
          {onLocalLogin && canSignInAgain(usage) && <UsageSignInAgain usage={usage} onStarted={onLocalLogin} />}
        </div>
        <span className="usage-accounts-actions">
          <button type="button" className="icon-button" aria-label={t("Move {name} up", { name })} disabled={index === 0} onClick={() => move(usage.key, -1)}><ChevronUp aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label={t("Move {name} down", { name })} disabled={index === ordered.length - 1} onClick={() => move(usage.key, 1)}><ChevronDown aria-hidden="true" /></button>
          <button type="button" className="icon-button usage-accounts-visibility" role="switch" aria-checked={!hidden} aria-label={t("Show {name}", { name })}
            onClick={() => update({ usageHidden: hidden ? settings.usageHidden.filter((key) => key !== usage.key) : [...settings.usageHidden, usage.key] })}>
            {hidden ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </span>
      </li>;
    })}
  </ol>;
}

export function UsageSettings({ onLocalLogin, watching = false }: { readonly onLocalLogin: (paneId: string) => void; /** a watching device signs in to nothing */ readonly watching?: boolean }) {
  const { settings, update } = useSettings();
  const t = useT();
  // The existing switch still controls whether sign-ins are sent to usage endpoints.
  const usage = useUsage(settings.showUsage);
  const [hub, setHub] = useState<CLIProxyStatus | null>(null);
  const [dialog, setDialog] = useState<"add" | "hub" | null>(null);
  const [hubError, setHubError] = useState<string | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void cliProxyRequest<CLIProxyStatus>("", { signal: controller.signal }).then(setHub)
      .catch((cause: unknown) => { if (!controller.signal.aborted) setHubError(cause instanceof Error ? cause.message : t("Hub request failed")); });
    return () => controller.abort();
  }, [t]);
  const providers = usage.report?.providers ?? [];
  const ids: readonly UsageProviderId[] = [...new Set(providers.map((usage) => usage.id))];
  const orderedIds = ["claude", "codex", ...ids.filter((id) => id !== "claude" && id !== "codex")]
    .filter((id): id is UsageProviderId => ids.some((known) => known === id));
  return <>
    <SettingsGroup>
      <SettingsRow label={t("Show plan limits")} description={t("Shows plan usage beside Settings. Sign-ins are sent to each provider's usage API; never refreshed here.")}>
        <Toggle label={t("Show plan limits")} checked={settings.showUsage} onChange={(showUsage) => update({ showUsage })} />
      </SettingsRow>
      {settings.showUsage && <>
        <SettingsRow label={t("Meters show")}>
          <Segmented label={t("Meters show")} value={settings.usageCount} onChange={(usageCount) => update({ usageCount })} options={[{ value: "used", label: t("Used") }, { value: "left", label: t("Remaining") }]} />
        </SettingsRow>
        <SettingsRow label={t("Limit shown")} description={t("Session is the 5-hour limit. Without it, the closest limit is shown.")} wide>
          <Segmented label={t("Limit shown")} value={settings.usageGlance} onChange={(usageGlance) => update({ usageGlance })} options={[{ value: "week", label: t("Weekly") }, { value: "session", label: t("Session") }]} />
        </SettingsRow>
      </>}
    </SettingsGroup>
    <div className="usage-accounts-intro">
      <div className="usage-accounts-header">
        <h3 className="usage-accounts-caption">{t("Accounts")} <span className="usage-account-count">{providers.length}</span></h3>
        <button ref={addButton} className="btn" type="button" onClick={() => setDialog("add")}><Plus size={16} aria-hidden="true" />{t("Add account")}</button>
      </div>
      {!settings.showUsage && <p className="settings-description settings-note">{t("Turn on plan limits to see accounts.")}</p>}
    </div>
    {settings.showUsage && orderedIds.map((id) => <SettingsGroup key={id} className="usage-accounts usage-provider" section={`accounts-${id}`}>
      <div className="settings-item usage-provider-heading">
        <AgentMark agent={PROVIDER_MARK[id]} size={20} /><span>{PROVIDER_NAME[id]}</span>
        <span className="usage-account-count">{providers.filter((usage) => usage.id === id).length}</span>
      </div>
      <ProviderAccounts id={id} providers={providers} onLocalLogin={watching ? undefined : onLocalLogin} />
    </SettingsGroup>)}
    {settings.showUsage && providers.length === 0 && <p className="settings-note settings-hint">{usage.loading ? t("Loading…") : t("No accounts yet.")}</p>}
    {hubError && <p className="settings-hint account-error" role="alert">{hubError}</p>}
    {hub?.configured && <SettingsGroup className="usage-connection-card" section="usage-connection">
      <div className="settings-item usage-connection">
        <Network size={20} aria-hidden="true" />
        <div className="usage-connection-info"><span className="settings-label">{t("Hub")}</span><span className="settings-hint" role="status">{hub.url} · {hub.ok ? t("Connected") : hub.problem ?? t("Check the hub connection")}</span></div>
        <div className="usage-connection-actions">
          <button className="btn btn-ghost" type="button" onClick={() => setDialog("hub")}>{t("Edit")}</button>
          <button className="btn btn-ghost" type="button" onClick={() => setConfirmRemoval(true)}>{t("Remove")}</button>
        </div>
      </div>
    </SettingsGroup>}
    {confirmRemoval && <ConfirmDialog title={t("Remove hub?")}
      body={t("Its accounts disappear from this list. The hub itself is not changed.")}
      confirmLabel={t("Remove")} onClose={() => setConfirmRemoval(false)} onConfirm={async () => {
        const status = await cliProxyRequest<CLIProxyStatus>("", { method: "DELETE" });
        setHub(status); setConfirmRemoval(false); usage.refresh();
        requestAnimationFrame(() => addButton.current?.focus());
      }} />}
    {dialog && <UsageAccountDialog editHub={dialog === "hub"} hub={hub} onHubChanged={setHub} onAccountsChanged={usage.refresh} onLocalLogin={onLocalLogin} onClose={() => setDialog(null)} />}
  </>;
}
