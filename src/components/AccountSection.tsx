/**
 * Settings → Phone & devices → Account: sign in with GitHub, Google or Apple, see the account's PCs,
 * add or remove a sign-in method, sign out. The desktop app signs in through the system browser
 * (lib/account/desktop.ts); a browser on the PC's own secure address, which no sign-in can be sent
 * back to, signs in with the provider's device flow and a code (lib/account/deviceSignIn.ts). Only
 * the providers the service says it offers get a button. Elsewhere, and with the account off, none
 * of this.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { listThisPc, thisPcInNoAccount } from "../lib/account/addThisPc.ts";
import { desktopAccount, desktopProviders, desktopSignIn } from "../lib/account/desktop.ts";
import { ApiError } from "../lib/api.ts";
import { startDeviceSignIn } from "../lib/account/deviceSignIn.ts";
import { myPcs, type MyPc } from "../lib/account/myPcs.ts";
import { AccountService, AccountServiceError, DEVICE_PROVIDERS, offeredProviders, pcAccountServiceOf, SignedOutError, type AccountIdentity, type DeviceProvider, type OfferedProviders } from "../lib/account/service.ts";
import { SignInError } from "../lib/account/signin.ts";
import { indexedAccountStore, type AccountProvider, type AccountSession } from "../lib/account/store.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { inMacApp, inNativeApp } from "../lib/nativeApp.ts";
import { AccountPcList, AccountSignIn, PROVIDER_NAMES, ProviderMark } from "./AccountPcs.tsx";
import { SettingsGroup, SettingsRow } from "./SettingsControls.tsx";

type View =
  | { kind: "loading" }
  | { kind: "signed-out"; error: string | null }
  | { kind: "signing-in" }
  | { kind: "device-code"; provider: DeviceProvider; userCode: string | null; verificationUri: string }
  | { kind: "signed-in"; provider: AccountProvider; account: string; pcs: MyPc[] | null; methods: AccountIdentity[] | null; error: string | null };

const isDeviceProvider = (provider: AccountProvider): provider is DeviceProvider => (DEVICE_PROVIDERS as readonly string[]).includes(provider);

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
  const fallback: AccountProvider[] = bridge ? desktopProviders(bridge) : ["github"];
  const [offer, setOffer] = useState<OfferedProviders | null>(null);
  /** a change to the ways in that waits for a fresh sign-in (403 reauth_required) */
  const [reauth, setReauth] = useState<{ action: "add" | "remove"; provider: AccountProvider } | null>(null);
  const deviceSignIn = useRef<AbortController | null>(null);
  const service = bridge?.service ?? pcService;
  const fallbackKey = fallback.join(",");
  useEffect(() => {
    if (service === null) return;
    let live = true;
    offeredProviders(service, fallbackKey.split(",") as AccountProvider[]).then((offered) => { if (live) setOffer(offered); }, (error: unknown) => console.warn("Ovis: the account service's sign-ins could not be read", error instanceof Error ? error.name : error));
    return () => { live = false; };
  }, [service, fallbackKey]);
  /** the desktop app comes back over loopback with any provider; a PC's page only through a device flow */
  const providers: AccountProvider[] = bridge !== null ? offer?.providers ?? fallback : offer?.device ?? ["github"];
  // bumped by a sign-out and on unmount: a load still waiting for the account's PCs then shows nothing
  const loads = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loads.current;
    const show = (next: View) => { if (loads.current === generation) setView(next); };
    const service = new AccountService({ store: indexedAccountStore });
    const session = await service.session();
    if (session === undefined) { show({ kind: "signed-out", error: null }); return; }
    const signedIn = { kind: "signed-in", provider: session.provider, account: session.account } as const;
    show({ ...signedIn, pcs: null, methods: null, error: null });
    try {
      const [pcs, methods] = await Promise.all([service.listPcs(), service.identities().catch((error: unknown) => {
        // a service from before sign-in methods: the list is left out, the rest works
        if (error instanceof AccountServiceError) return null;
        throw error;
      })]);
      show({ ...signedIn, pcs: myPcs(pcs, [], { now: Date.now() }), methods, error: null });
    } catch (error) {
      if (error instanceof SignedOutError) show({ kind: "signed-out", error: t("Your sign-in ended. Sign in again to see every PC of your account.") });
      else show({ ...signedIn, pcs: [], methods: null, error: t("The account service could not be reached. The PCs this device is paired with still work.") });
    }
  }, [t]);

  useEffect(() => { if (offered) void load(); }, [offered, load]);
  useEffect(() => {
    onAccount?.({ signedIn: view.kind === "signed-in", account: view.kind === "signed-in" ? view.account : null, pcs: view.kind === "signed-in" ? view.pcs : null });
  }, [onAccount, view]);
  // closing Settings ends a device sign-in still waiting: its session is then never kept
  useEffect(() => () => { deviceSignIn.current?.abort(); loads.current++; }, []);

  if (!offered) return null;

  const unlinked = bridge !== null && view.kind === "signed-in" && view.methods !== null
    ? providers.filter((provider) => !view.methods?.some((method) => method.provider === provider)) : [];

  const cancelDeviceSignIn = (): void => {
    deviceSignIn.current?.abort();
    deviceSignIn.current = null;
  };

  const failureText = (error: unknown, provider: AccountProvider): string => {
    const name = PROVIDER_NAMES[provider];
    if (error instanceof AccountServiceError && error.code === "identity_exists") return t("Your account already signs in with {provider}.", { provider: name });
    if (!(error instanceof SignInError)) return t("The sign-in did not finish. Try again.");
    switch (error.code) {
      case "denied": return t("{provider} refused the sign-in.", { provider: name });
      case "expired": return t("The code expired. Sign in again to get a new one.");
      case "unsupported": return t("This account service can't sign in a browser on this PC yet.");
      case "in_use": return t("This {provider} sign-in already belongs to another Ovis account. Nothing was changed.", { provider: name });
      case "no_sign_in": return t("The sign-in did not finish. Try again.");
    }
  };

  /** A device sign-in on a PC's own page: shows the provider's code until it is approved. */
  const signInWithCode = (pcServiceOrigin: string, provider: DeviceProvider): Promise<AccountSession> => {
    cancelDeviceSignIn();
    const controller = new AbortController();
    deviceSignIn.current = controller;
    setView({ kind: "device-code", provider, userCode: null, verificationUri: "" });
    return (async () => {
      const started = await startDeviceSignIn({ service: pcServiceOrigin, store: indexedAccountStore, provider });
      controller.signal.throwIfAborted();
      setView({ kind: "device-code", provider, userCode: started.userCode, verificationUri: started.verificationUri });
      return started.finish(controller.signal);
    })().finally(() => { if (deviceSignIn.current === controller) deviceSignIn.current = null; });
  };

  /** Runs one provider's sign-in the way this page can; null when it cannot here. */
  const runSignIn = (provider: AccountProvider): Promise<AccountSession> | null => {
    if (bridge !== null) return desktopSignIn(provider, bridge, indexedAccountStore);
    return pcService !== null && isDeviceProvider(provider) ? signInWithCode(pcService, provider) : null;
  };

  const signIn = (provider: AccountProvider): void => {
    if (bridge !== null) setView({ kind: "signing-in" });
    runSignIn(provider)?.then(load, (error: unknown) => {
      // cancelled, or Settings closed: the page already moved on
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Ovis: the sign-in did not finish", error instanceof SignInError ? error.code : error instanceof Error ? error.name : error);
      setView({ kind: "signed-out", error: failureText(error, provider) });
    });
  };

  const needsReauth = (error: unknown): boolean => error instanceof AccountServiceError && error.code === "reauth_required";

  /**
   * Adds `provider` to the signed-in account on purpose, from the desktop app only: a link goes
   * through a redirect sign-in, never a device code someone else could have typed.
   */
  const addMethod = (provider: AccountProvider): void => {
    if (bridge === null) return;
    setView({ kind: "signing-in" });
    new AccountService({ store: indexedAccountStore }).addMethod(provider, (linkToken, bearer) => desktopSignIn(provider, bridge, indexedAccountStore, { linkToken, bearer }))
      .then(() => load(), async (error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.warn("Ovis: the sign-in method was not added", error instanceof SignInError || error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
        await load();
        if (needsReauth(error)) { setReauth({ action: "add", provider }); return; }
        const message = failureText(error, provider);
        setView((current) => current.kind === "signed-in" ? { ...current, error: message } : current);
      });
  };

  const removeMethod = (provider: AccountProvider): void => {
    new AccountService({ store: indexedAccountStore }).removeIdentity(provider).then(() => load(), (error: unknown) => {
      console.warn("Ovis: the sign-in method was not removed", error instanceof AccountServiceError ? error.code : error instanceof Error ? error.name : error);
      if (needsReauth(error)) { setReauth({ action: "remove", provider }); return; }
      const message = error instanceof AccountServiceError && error.code === "last_identity"
        ? t("Add another way to sign in before removing this one.") : t("The sign-in method could not be removed. Try again.");
      setView((current) => current.kind === "signed-in" ? { ...current, error: message } : current);
    });
  };

  /**
   * The service wants a sign-in from the last ten minutes to change the ways in: sign in again
   * with the method this device uses, then repeat the change, on the same account only.
   */
  const signInAgain = (): void => {
    if (reauth === null || view.kind !== "signed-in") return;
    const { action, provider } = reauth;
    const { account, provider: current } = view;
    setReauth(null);
    runSignIn(current)?.then(async (session) => {
      await load();
      if (session.account !== account) return;
      if (action === "add") addMethod(provider);
      else removeMethod(provider);
    }, async (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.warn("Ovis: the sign-in did not finish", error instanceof SignInError ? error.code : error instanceof Error ? error.name : error);
      await load();
      setView((now) => now.kind === "signed-in" ? { ...now, error: failureText(error, current) } : now);
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
      {view.kind === "signed-out" && <div className="settings-item" data-offer={offer === null ? "build" : "service"}><AccountSignIn onSignIn={signIn} error={view.error} providers={providers} /></div>}
      {view.kind === "signing-in" && <SettingsRow label={t("Signing in…")} description={t("Finish signing in in your browser.")}>{null}</SettingsRow>}
      {view.kind === "device-code" && (
        <div className="settings-item account-device">
          {view.userCode === null
            ? <p className="settings-description" role="status">{t("Signing in…")}</p>
            : (
              <>
                <p className="settings-description">{t("Open {provider} and enter this code. Enter it only if you started this sign-in on this page.", { provider: PROVIDER_NAMES[view.provider] })}</p>
                <output className="account-device-code" aria-live="polite">{view.userCode}</output>
                <p className="settings-description" role="status">{t("Waiting for {provider}…", { provider: PROVIDER_NAMES[view.provider] })}</p>
              </>
            )}
          <div className="account-device-actions">
            {view.userCode !== null && <a className="btn btn-primary" href={view.verificationUri} target="_blank" rel="noopener noreferrer">{t("Open {provider}", { provider: PROVIDER_NAMES[view.provider] })}</a>}
            <button type="button" className="btn" onClick={() => { cancelDeviceSignIn(); void load(); }}>{t("Cancel")}</button>
          </div>
        </div>
      )}
      {view.kind === "signed-in" && (
        <>
          <SettingsRow label={t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}>
            <button type="button" className="btn" onClick={signOut}>{t("Sign out of {provider}", { provider: PROVIDER_NAMES[view.provider] })}</button>
          </SettingsRow>
          {view.methods !== null && (
            <div className="settings-item account-methods">
              <p className="settings-label">{t("Ways to sign in")}</p>
              <ul className="account-method-list">
                {view.methods.map((method) => (
                  <li key={method.provider} className="account-method" data-provider={method.provider}>
                    <ProviderMark provider={method.provider} />
                    <span className="account-method-text">
                      <span>{PROVIDER_NAMES[method.provider]}</span>
                      <span className="settings-description">{t("Added {date}", { date: new Date(method.added_at).toLocaleDateString(currentLocale()) })}</span>
                    </span>
                    {/* the method this device signed in with stays: removing it would end this sign-in */}
                    {view.methods !== null && view.methods.length > 1 && method.provider !== view.provider && (
                      <button type="button" className="btn" onClick={() => removeMethod(method.provider)}>{t("Remove")}</button>
                    )}
                  </li>
                ))}
              </ul>
              {reauth !== null && (
                <div className="account-reauth" role="alert">
                  <p className="settings-description">{t("To change how you sign in, sign in again with {provider} first.", { provider: PROVIDER_NAMES[view.provider] })}</p>
                  {(bridge !== null || isDeviceProvider(view.provider)) && <button type="button" className="btn btn-primary" onClick={signInAgain}>{t("Sign in again")}</button>}
                </div>
              )}
              {bridge === null && <p className="settings-description">{t("Add another way to sign in from the Ovis desktop app.")}</p>}
              {unlinked.length > 0 && (
                <div className="account-method-add">
                  {unlinked.map((provider) => (
                    <button key={provider} type="button" className="btn" onClick={() => addMethod(provider)}>
                      <ProviderMark provider={provider} />{t("Add {provider}", { provider: PROVIDER_NAMES[provider] })}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <AddThisPc />
          {view.pcs !== null && onAccount === undefined && <div className="settings-item"><AccountPcList pcs={view.pcs} /></div>}
          {view.error !== null && <p className="settings-condition" role="alert">{view.error}</p>}
        </>
      )}
    </SettingsGroup>
  );
}
