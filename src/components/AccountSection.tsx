/**
 * Settings → Phone & devices → Account: sign in with GitHub or Apple, see the account's PCs, sign
 * out. The desktop app signs in through the system browser (lib/account/desktop.ts); a browser on
 * the PC's own secure address, which no sign-in can be sent back to, signs in with GitHub's device
 * flow and a code (lib/account/deviceSignIn.ts). Elsewhere, and with the account off, none of this.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { listThisPc, thisPcInNoAccount } from "../lib/account/addThisPc.ts";
import { desktopAccount, desktopProviders, desktopSignIn } from "../lib/account/desktop.ts";
import { ApiError } from "../lib/api.ts";
import { startDeviceSignIn } from "../lib/account/deviceSignIn.ts";
import { myPcs, type MyPc } from "../lib/account/myPcs.ts";
import { AccountService, pcAccountServiceOf, SignedOutError } from "../lib/account/service.ts";
import { SignInError } from "../lib/account/signin.ts";
import { indexedAccountStore, type AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { inMacApp, inNativeApp } from "../lib/nativeApp.ts";
import { AccountPcList, AccountSignIn } from "./AccountPcs.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

type View =
  | { kind: "loading" }
  | { kind: "signed-out"; error: string | null }
  | { kind: "signing-in" }
  | { kind: "device-code"; userCode: string | null; verificationUri: string }
  | { kind: "signed-in"; provider: AccountProvider; account: string; pcs: MyPc[] | null; error: string | null };

const PROVIDER_NAMES: Record<AccountProvider, string> = { github: "GitHub", apple: "Apple" };

/** The pairing window this screen keeps open is reopened a minute before its ten minutes end. */
const RELIST_MS = 9 * 60_000;

/**
 * This PC, signed in and in no account yet: listed in the account with one tap, then it waits for a
 * device already in the account to add it, which the owner approves here (docs/account.md, "Adding a PC").
 */
function AddThisPc() {
  const t = useT();
  const [state, setState] = useState<{ kind: "hidden" } | { kind: "offer" } | { kind: "waiting"; name: string } | { kind: "error"; message: string }>({ kind: "hidden" });
  /** Reopens the window while this PC still waits; once a device added it, the screen is done and stops. */
  const relist = useCallback(async () => {
    if (!await thisPcInNoAccount()) { setState({ kind: "hidden" }); return; }
    await listThisPc(new AccountService({ store: indexedAccountStore }), { relistMs: RELIST_MS });
  }, []);
  useEffect(() => {
    let live = true;
    thisPcInNoAccount().then((none) => { if (live && none) setState({ kind: "offer" }); }, (error: unknown) => console.warn("Ovis: this PC's account could not be read", error instanceof Error ? error.name : error));
    return () => { live = false; };
  }, []);
  const waiting = state.kind === "waiting";
  useEffect(() => {
    if (!waiting) return;
    // the window this screen opened closes after ten minutes: kept open while the screen waits
    const timer = setInterval(() => { relist().catch((error: unknown) => console.warn("Ovis: this PC's pairing window was not reopened", error instanceof Error ? error.name : error)); }, RELIST_MS);
    return () => clearInterval(timer);
  }, [waiting, relist]);
  const add = (): void => {
    listThisPc(new AccountService({ store: indexedAccountStore }), { relistMs: RELIST_MS }).then((name) => setState({ kind: "waiting", name }), (error: unknown) => {
      console.warn("Ovis: this PC was not listed in the account", error instanceof Error ? error.name : error);
      setState({ kind: "error", message: error instanceof ApiError && error.code === "relay_off"
        ? t("Turn on remote access through the Ovis relay above first.") : t("This PC could not be listed in your account. Try again.") });
    });
  };
  if (state.kind === "hidden") return null;
  return (
    <div className="settings-item account-add-pc">
      {state.kind === "waiting" ? (
        <>
          <p className="settings-description" role="status">{t("On a phone already in your account, open the Ovis app and tap Add on {name}. Then approve it here.", { name: state.name })}</p>
          <p className="settings-description">{t("Every device of your account can use this PC after that.")}</p>
        </>
      ) : (
        <>
          <p className="settings-description">{t("Add this PC to your account, so every device of your account can use it with one approval.")}</p>
          <button type="button" className="btn btn-primary" onClick={add}>{t("Add this PC to my account")}</button>
          {state.kind === "error" && <p className="settings-condition" role="alert">{state.message}</p>}
        </>
      )}
    </div>
  );
}

/** What Settings → Devices and PCs needs of the account: signed in or not, and the account's PCs for My devices. */
export interface AccountState { signedIn: boolean; account: string | null; pcs: MyPc[] | null }

/** the phone and Mac apps sign in their own way, never with a code from a PC's page */
const pcServiceHere = (): string | null => desktopAccount() === null && !inNativeApp() && !inMacApp() ? pcAccountServiceOf(document, window.isSecureContext) : null;

/** whether this page can sign in to the account: the desktop app's bridge, or the account service a PC's page names */
export const accountOffered = (): boolean => desktopAccount() !== null || pcServiceHere() !== null;

/** `onAccount`: the page lists the account's PCs itself (My devices), so this group does not */
export function AccountSection({ onAccount }: { onAccount?: (state: AccountState) => void } = {}) {
  const t = useT();
  const bridge = desktopAccount();
  const pcService = pcServiceHere();
  const offered = bridge !== null || pcService !== null;
  const [view, setView] = useState<View>({ kind: "loading" });
  const deviceSignIn = useRef<AbortController | null>(null);
  // bumped by a sign-out and on unmount: a load still waiting for the account's PCs then shows nothing
  const loads = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loads.current;
    const show = (next: View) => { if (loads.current === generation) setView(next); };
    const service = new AccountService({ store: indexedAccountStore });
    const session = await service.session();
    if (session === undefined) { show({ kind: "signed-out", error: null }); return; }
    show({ kind: "signed-in", provider: session.provider, account: session.account, pcs: null, error: null });
    try {
      show({ kind: "signed-in", provider: session.provider, account: session.account, pcs: myPcs(await service.listPcs(), [], { now: Date.now() }), error: null });
    } catch (error) {
      if (error instanceof SignedOutError) show({ kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") });
      else show({ kind: "signed-in", provider: session.provider, account: session.account, pcs: [], error: t("The account service could not be reached. The PCs this device is paired with still work.") });
    }
  }, [t]);

  useEffect(() => { if (offered) void load(); }, [offered, load]);
  useEffect(() => {
    onAccount?.({ signedIn: view.kind === "signed-in", account: view.kind === "signed-in" ? view.account : null, pcs: view.kind === "signed-in" ? view.pcs : null });
  }, [onAccount, view]);
  // closing Settings ends a device sign-in still waiting: its session is then never kept
  useEffect(() => () => { deviceSignIn.current?.abort(); loads.current++; }, []);

  if (!offered) return null;

  const cancelDeviceSignIn = (): void => {
    deviceSignIn.current?.abort();
    deviceSignIn.current = null;
  };

  const signInWithCode = (service: string): void => {
    cancelDeviceSignIn();
    const controller = new AbortController();
    deviceSignIn.current = controller;
    setView({ kind: "device-code", userCode: null, verificationUri: "" });
    void (async () => {
      const started = await startDeviceSignIn({ service, store: indexedAccountStore });
      if (controller.signal.aborted) return;
      setView({ kind: "device-code", userCode: started.userCode, verificationUri: started.verificationUri });
      await started.finish(controller.signal);
      if (!controller.signal.aborted) await load();
    })().catch((error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("Ovis: the sign-in did not finish", error instanceof SignInError ? error.code : error instanceof Error ? error.name : error);
      const message = !(error instanceof SignInError) ? t("The sign-in did not finish. Try again.")
        : error.code === "denied" ? t("GitHub refused the sign-in.")
        : error.code === "expired" ? t("The code expired. Sign in again to get a new one.")
        : error.code === "unsupported" ? t("This account service can't sign in a browser on this PC yet.")
        : t("The sign-in did not finish. Try again.");
      setView({ kind: "signed-out", error: message });
    }).finally(() => { if (deviceSignIn.current === controller) deviceSignIn.current = null; });
  };

  const signIn = (provider: AccountProvider): void => {
    if (bridge === null) {
      if (pcService !== null) signInWithCode(pcService);
      return;
    }
    setView({ kind: "signing-in" });
    desktopSignIn(provider, bridge, indexedAccountStore).then(load, (error: unknown) => {
      console.warn("Ovis: the sign-in did not finish", error instanceof Error ? error.name : error);
      setView({ kind: "signed-out", error: t("The sign-in did not finish. Try again.") });
    });
  };

  const signOut = (): void => {
    cancelDeviceSignIn();
    loads.current++;
    void new AccountService({ store: indexedAccountStore }).signOut()
      .catch((error: unknown) => console.warn("Ovis: the account service did not confirm the sign-out", error instanceof Error ? error.name : error))
      .finally(() => setView({ kind: "signed-out", error: null }));
  };

  return (
    <SettingsGroup title={t("Account")} section="account">
      {view.kind === "signed-out" && <div className="settings-item"><AccountSignIn onSignIn={signIn} error={view.error} providers={bridge ? desktopProviders(bridge) : ["github"]} /></div>}
      {view.kind === "signing-in" && <SettingsRow label={t("Signing in…")} description={t("Finish signing in in your browser.")}>{null}</SettingsRow>}
      {view.kind === "device-code" && (
        <div className="settings-item account-device">
          {view.userCode === null
            ? <p className="settings-description" role="status">{t("Signing in…")}</p>
            : (
              <>
                <p className="settings-description">{t("Open GitHub and enter this code. Enter it only if you started this sign-in on this page.")}</p>
                <output className="account-device-code" aria-live="polite">{view.userCode}</output>
                <p className="settings-description" role="status">{t("Waiting for GitHub…")}</p>
              </>
            )}
          <div className="account-device-actions">
            {view.userCode !== null && <a className="btn btn-primary" href={view.verificationUri} target="_blank" rel="noopener noreferrer">{t("Open GitHub")}</a>}
            <button type="button" className="btn" onClick={() => { cancelDeviceSignIn(); setView({ kind: "signed-out", error: null }); }}>{t("Cancel")}</button>
          </div>
        </div>
      )}
      {view.kind === "signed-in" && (
        <>
          <SettingsRow label={t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}>
            <button type="button" className="btn" onClick={signOut}>{t("Sign out of {provider}", { provider: PROVIDER_NAMES[view.provider] })}</button>
          </SettingsRow>
          <AddThisPc />
          {view.pcs !== null && onAccount === undefined && <div className="settings-item"><AccountPcList pcs={view.pcs} /></div>}
          {view.error !== null && <p className="settings-condition" role="alert">{view.error}</p>}
        </>
      )}
    </SettingsGroup>
  );
}
