import { useLayoutEffect, useRef } from "react";

import { useT } from "../lib/i18n.ts";
import { SignInError } from "../lib/account/signin.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { useLinkPageSignIn } from "../lib/account/useLinkPageSignIn.ts";
import { PROVIDER_NAMES } from "./AccountPcs.tsx";
import { linkAddress } from "./AccountSection.tsx";

/** what a sign-in that ended without a session says, as Settings' does; the link page named no provider */
function failureText(t: ReturnType<typeof useT>, error: unknown): string {
  if (!(error instanceof SignInError)) return t("The sign-in did not finish. Try again.");
  switch (error.code) {
    case "expired": return t("The code expired. Sign in again to get a new one.");
    case "denied": return t("The sign-in was refused.");
    case "unsupported": return t("This account service can't sign in a browser on this PC yet.");
    case "in_use": return t("This sign-in already belongs to another Ovis account. Nothing was changed.");
    case "no_sign_in": return t("The sign-in did not finish. Try again.");
  }
}

/**
 * The relay tab's sign-in, signed out: Sign in opens the Ovis link page in a new tab and this sheet
 * waits for it, showing the code the page carries, and says it is signed in once the person
 * confirmed there; `onSignedIn` then lets the page read the account again (the tab moves on to how
 * this PC joins). A blocked tab leaves the page's link and code here, as Settings shows them.
 */
export function RelaySignIn({ service, onSignedIn, onOpenAccount }: { service: string; onSignedIn: (session: AccountSession) => void; onOpenAccount: () => void }) {
  const t = useT();
  const { state, ready, start, cancel } = useLinkPageSignIn(service, onSignedIn, onOpenAccount);
  const signInButton = useRef<HTMLButtonElement>(null);
  const signInPage = useRef<HTMLAnchorElement>(null);
  const previous = useRef(state.kind);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = state.kind;
    switch (state.kind) {
      case "waiting": signInPage.current?.focus(); break;
      case "idle": if (before !== "idle") signInButton.current?.focus(); break;
      case "failed": signInButton.current?.focus(); break;
      case "starting":
      case "signed-in": break;
      default: state satisfies never;
    }
  }, [state.kind]);
  if (state.kind === "signed-in") return <p className="connect-signin-lead">{t("Signed in with {provider}", { provider: PROVIDER_NAMES[state.session.provider] })}</p>;
  if (state.kind === "waiting") {
    const { provider, userCode, verificationUri, verificationUriComplete } = state.started;
    const page = verificationUriComplete ?? verificationUri;
    return (
      <div className="account-device" data-testid="relay-signin-waiting">
        <p className="settings-description">{provider !== "ovis"
          ? t("Open {provider} and enter this code. Enter it only if you started this sign-in on this page.", { provider: PROVIDER_NAMES[provider] })
          : state.opened
            ? verificationUriComplete === null
              ? t("The sign-in page opened in a new tab. Enter this code there, then continue with GitHub or Google.")
              : t("The sign-in page opened in a new tab with this code. Continue there with GitHub or Google.")
            : t("On any device, open {address} and enter this code, then continue with GitHub or Google. Enter it only if you started this sign-in on this page.", { address: linkAddress(verificationUri) })}</p>
        <output className="account-device-code" aria-live="polite">{userCode}</output>
        <p className="settings-description" role="status">{provider === "ovis" ? t("Waiting for the sign-in…") : t("Waiting for {provider}…", { provider: PROVIDER_NAMES[provider] })}</p>
        <div className="account-device-actions">
          <a ref={signInPage} className={state.opened ? "btn" : "btn btn-primary"} href={page} target="_blank" rel="noopener noreferrer">
            {provider === "ovis" ? t("Open the sign-in page") : t("Open {provider}", { provider: PROVIDER_NAMES[provider] })}
          </a>
          <button type="button" className="btn" onClick={cancel}>{t("Cancel")}</button>
        </div>
      </div>
    );
  }
  const failure = state.kind === "failed" ? failureText(t, state.error) : null;
  return (
    <>
      <p className="settings-description">{t("Connect from anywhere through your Ovis account.")}</p>
      <button ref={signInButton} type="button" className="btn btn-primary connect-signin-button" aria-disabled={!ready || state.kind === "starting"} onClick={() => { if (ready && state.kind !== "starting") start(); }}>{state.kind === "starting" ? t("Signing in…") : t("Sign in to Ovis")}</button>
      {failure !== null && <p className="account-error" role="alert">{failure}</p>}
    </>
  );
}
