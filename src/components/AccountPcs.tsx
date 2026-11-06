// the list's rows are the relay shell's (.relay-shell-pc*), also in Settings, where RelayShell.tsx is not loaded
import "./RelayShell.css";
import "./AccountPcs.css";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { newPcs, type MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import type { AccountView } from "../lib/relay/shellState.ts";
import { serverScopePath } from "../lib/shellMode.ts";

const PROVIDER_NAMES: Record<AccountProvider, string> = { github: "GitHub", apple: "Apple" };

/** The providers' own marks, one colour (currentColor), as their brand rules ask for a sign-in button. */
function ProviderMark({ provider }: { provider: AccountProvider }) {
  return provider === "github" ? (
    <svg className="account-provider-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  ) : (
    <svg className="account-provider-mark" viewBox="0 0 17 20" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M14.04 10.63c-.02-2.33 1.9-3.45 1.99-3.5-1.08-1.59-2.77-1.8-3.37-1.83-1.43-.15-2.8.85-3.53.85-.73 0-1.85-.83-3.05-.81-1.57.02-3.02.92-3.83 2.33-1.63 2.83-.42 7.02 1.17 9.32.78 1.13 1.7 2.39 2.91 2.35 1.17-.05 1.61-.76 3.02-.76 1.41 0 1.81.76 3.04.73 1.26-.02 2.05-1.14 2.82-2.28.89-1.31 1.25-2.58 1.27-2.64-.03-.01-2.43-.93-2.45-3.69ZM11.73 3.79c.64-.78 1.08-1.86.96-2.94-.93.04-2.06.62-2.72 1.4-.6.69-1.12 1.79-.98 2.85 1.04.08 2.1-.53 2.74-1.31Z" />
    </svg>
  );
}

/**
 * Sign in with GitHub or Apple, alike and side by side: App Review 4.8 asks for Sign in with Apple
 * wherever another provider is offered, and Apple's button is black or white, so both take the
 * theme's strongest ink (black in light, white in dark) and neither looks like the one to pick.
 */
export function AccountSignIn({ onSignIn, error, providers = ["github"] }: { onSignIn: (provider: AccountProvider) => void; error: string | null; providers?: readonly AccountProvider[] }) {
  const t = useT();
  return (
    <div className="account-sign-in">
      <div className="account-providers">
        {providers.includes("github") && <button type="button" className="btn account-provider" onClick={() => onSignIn("github")}><ProviderMark provider="github" />{t("Continue with GitHub")}</button>}
        {providers.includes("apple") && <button type="button" className="btn account-provider" onClick={() => onSignIn("apple")}><ProviderMark provider="apple" />{t("Continue with Apple")}</button>}
      </div>
      {error !== null && <p className="account-error" role="alert">{error}</p>}
    </div>
  );
}

/** One line at the card's foot: what the account service sees. */
export function AccountFinePrint() {
  const t = useT();
  return <p className="account-fineprint">{t("The account only lists your PCs. Sessions stay end-to-end encrypted.")}</p>;
}

export function accountPcStateText(pc: MyPc, t: ReturnType<typeof useT>): string {
  switch (pc.state) {
    // a pairing from before the account: removing this device through the account does not reach it yet
    case "paired": return pc.linked ? t("Ready") : t("Ready · not in the account yet");
    case "needs-approval": return t("Needs approval");
    case "offline": return t("Offline · {when}", { when: lastSeen(pc.last_seen_at) });
    case "needs-update": return t("Update Ovis on it");
  }
}

/** The account's PCs: a paired one opens; the others say what they wait for. */
export function AccountPcList({ pcs, onJoin }: { pcs: readonly MyPc[]; onJoin?: (pc: MyPc) => void }) {
  const t = useT();
  return (
    <ul className="relay-shell-pcs">
      {pcs.map((pc) => {
        const body = (
          <span className="account-pc-text">
            <span className="relay-shell-pc-name">{pc.name}</span>
            <span className="account-pc-state"><span className="account-pc-dot" aria-hidden="true" />{accountPcStateText(pc, t)}</span>
          </span>
        );
        return (
          <li key={pc.server_id} data-pc-state={pc.state}>
            {pc.paired
              ? <a className="relay-shell-pc" href={serverScopePath(pc.server_id)}>{body}<ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" /></a>
              : pc.join && onJoin
                ? <button type="button" className="relay-shell-pc account-pc-join" onClick={() => onJoin(pc)}>{body}<ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" /></button>
                : <div className="relay-shell-pc account-pc-waiting">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** The front page once signed in: the account's PCs, then how another one joins. */
export function AccountPcs({ view, onJoin, onSignOut, onLeave }: {
  view: Extract<AccountView, { kind: "signed-in" }>; onJoin?: (pc: MyPc, options?: { typed?: boolean }) => void;
  /** ends the sign-in; every pairing stays */
  onSignOut?: () => void;
  /** removes this device from every PC of the account, then signs out */
  onLeave?: () => void;
}) {
  const t = useT();
  const [leaving, setLeaving] = useState(false);
  return (
    <>
      <h1 className="relay-shell-title">{t("Your PCs")}</h1>
      <p className="relay-shell-copy account-subtitle">{t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}</p>
      {view.pcs !== null && onJoin && newPcs(view.pcs, Date.now()).map((pc) => (
        <section key={pc.server_id} className="account-new-pc" aria-label={t("New PC")}>
          <p className="account-new-pc-title">{t("Add {name} to your account?", { name: pc.name })}</p>
          <p className="account-fineprint">{t("You type the number {name} shows on its own screen, then approve there. Every device of your account can then use it.", { name: pc.name })}</p>
          <button type="button" className="btn btn-primary" onClick={() => onJoin(pc, { typed: true })}>{t("Add this PC")}</button>
        </section>
      ))}
      {view.pcs === null
        ? <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Loading your PCs…")}</span></div>
        : <AccountPcList pcs={view.pcs} {...(onJoin ? { onJoin } : {})} />}
      {view.error !== null && <p className="relay-shell-detail" role="alert">{view.error}</p>}
      <p className="account-fineprint">{t("To add a PC, sign in on it or scan its QR code.")}</p>
      {(onSignOut || onLeave) && (
        <div className="account-actions">
          {leaving && onLeave ? (
            <>
              <p className="account-fineprint">{t("Every PC of the account removes this device. You can pair it again later.")}</p>
              <button type="button" className="btn btn-danger" onClick={onLeave}>{t("Remove this device")}</button>
              <button type="button" className="btn" onClick={() => setLeaving(false)}>{t("Cancel")}</button>
            </>
          ) : (
            <>
              {onSignOut && <button type="button" className="account-link" onClick={onSignOut}>{t("Sign out")}</button>}
              {onLeave && <button type="button" className="account-link account-link-danger" onClick={() => setLeaving(true)}>{t("Remove this device from your account")}</button>}
            </>
          )}
        </div>
      )}
    </>
  );
}
