// the list's rows are the relay shell's (.relay-shell-pc*), also in Settings, where RelayShell.tsx is not loaded
import "./RelayShell.css";
import "./AccountPcs.css";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { newPcs, type MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { AccountView } from "../lib/relay/shellState.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { ConnectionLine } from "./ConnectionLine.tsx";

export const PROVIDER_NAMES: Record<AccountProvider, string> = { github: "GitHub", google: "Google", apple: "Apple" };

/**
 * The providers' own marks, as their brand rules ask for a sign-in button: GitHub's and Apple's in
 * one colour (currentColor), Google's "G" always in its four colours, never recoloured.
 */
export function ProviderMark({ provider }: { provider: AccountProvider }) {
  if (provider === "google") {
    return (
      <svg className="account-provider-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
    );
  }
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
 * Sign in with GitHub, Google or Apple, alike and stacked: App Review 4.8 asks for Sign in with Apple
 * wherever another provider is offered, and Apple's button is black or white, so all take the
 * theme's strongest ink (black in light, white in dark) and none looks like the one to pick.
 * Google's dark and light buttons are that same black or white, with its four-colour "G".
 */
export function AccountSignIn({ onSignIn, error, providers = ["github"] }: { onSignIn: (provider: AccountProvider) => void; error: string | null; providers?: readonly AccountProvider[] }) {
  const t = useT();
  return (
    <div className="account-sign-in">
      <div className="account-providers">
        {providers.includes("github") && <button type="button" className="btn account-provider" onClick={() => onSignIn("github")}><ProviderMark provider="github" />{t("Continue with GitHub")}</button>}
        {providers.includes("google") && <button type="button" className="btn account-provider" data-provider="google" onClick={() => onSignIn("google")}><ProviderMark provider="google" />{t("Continue with Google")}</button>}
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

/** How a saved PC answered the latest check (pcStatus.ts): its way and round trip, or why it did not. */
export function PcStatusLine({ status, lastSeenAt = null }: { status: PcStatus; lastSeenAt?: string | null }) {
  const t = useT();
  if (status.kind === "answered") return <ConnectionLine state={{ kind: "answered", route: status.route, ...(status.relay === undefined ? {} : { relay: status.relay }), rttMs: status.rttMs }} />;
  if (status.kind === "checking") return <ConnectionLine state={{ kind: "checking" }} />;
  return <ConnectionLine state={{ kind: "offline", text: lastSeenAt === null ? t("Offline") : t("Offline · {when}", { when: lastSeen(lastSeenAt) }) }}
    reason={status.reason === "pc" ? t("The PC is off, or Ovis is not running on it.") : t("The relay did not answer. Check this device's network.")} />;
}

/** Check now, beside a list of PCs: probes each saved one again. */
export function CheckPcsButton({ status, onCheck }: { status: ReadonlyMap<string, PcStatus>; onCheck: () => void }) {
  const t = useT();
  const checking = [...status.values()].some((one) => one.kind === "checking");
  return <div className="relay-shell-check"><button type="button" className="account-link" onClick={onCheck} disabled={checking}>{checking ? t("Checking…") : t("Check now")}</button></div>;
}

/** The account's PCs: a paired one opens and says how it answered the latest check; the others say what they wait for. */
export function AccountPcList({ pcs, onJoin, status }: { pcs: readonly MyPc[]; onJoin?: (pc: MyPc) => void; status?: ReadonlyMap<string, PcStatus> }) {
  const t = useT();
  return (
    <ul className="relay-shell-pcs">
      {pcs.map((pc) => {
        const body = (
          <span className="account-pc-text">
            <span className="relay-shell-pc-name">{pc.name}</span>
            {pc.paired && status?.get(pc.server_id)
              ? <PcStatusLine status={status.get(pc.server_id)!} lastSeenAt={pc.last_seen_at} />
              : <span className="account-pc-state"><span className="account-pc-dot" aria-hidden="true" />{accountPcStateText(pc, t)}</span>}
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
export function AccountPcs({ view, onJoin, onSignOut, onLeave, status, onCheck }: {
  view: Extract<AccountView, { kind: "signed-in" }>; onJoin?: (pc: MyPc, options?: { typed?: boolean }) => void;
  /** how each saved PC answered the latest check, and Check now */
  status?: ReadonlyMap<string, PcStatus>;
  onCheck?: () => void;
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
        : <>
          {onCheck && view.pcs.some((pc) => pc.paired) && <CheckPcsButton status={status ?? new Map()} onCheck={onCheck} />}
          <AccountPcList pcs={view.pcs} {...(onJoin ? { onJoin } : {})} {...(status ? { status } : {})} />
        </>}
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
