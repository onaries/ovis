import "./RelayShell.css";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import type { MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import type { AccountView, KeyMismatch } from "../lib/relay/shellState.ts";
import { AccountFinePrint, AccountPcs, AccountSignIn } from "./AccountPcs.tsx";
import { KeyId } from "./KeyId.tsx";
import { describeUpdate } from "../lib/updateProgress.ts";
import type { RelayShellState } from "../lib/relay/shellState.ts";
import { codeFailureText, type TypedCodeFailure } from "./codeFailureText.ts";
import { serverScopePath } from "../lib/shellMode.ts";

export interface RelayShellProps {
  state: RelayShellState;
  /** on a PC's own page (`/s/<id>/`), where Back leads to the front page; the front page has no Back */
  scoped: boolean;
  /** an iPhone or iPad browser tab, where the pairing may not survive a week unvisited */
  iosTab: boolean;
  onPair: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onBack: () => void;
  onForget: () => void;
  /** a PC below the shell's minimum version with a managed install: install its latest release */
  onUpdate: () => void;
  /** pairing without a code: the digits on this screen are the ones the PC shows */
  /** `typed`: the digits typed from the PC's screen, when this phone may not show its own (state.typed) */
  onMatch: (typed?: string) => void;
  /** the front page's sign-in: off to the provider's pages */
  onSignIn?: (provider: AccountProvider) => void;
  /** a PC of the account this device is not paired with: compare digits with it */
  /** `typed`: added from the new-PC card, so this device types the number that PC shows */
  onJoin?: (pc: MyPc, options?: { typed?: boolean }) => void;
  onSignOut?: () => void;
  onLeave?: () => void;
  /** the sign-ins the account service offers (accountProvidersOf); GitHub alone by default */
  accountProviders?: readonly AccountProvider[];
  /** Pair with a code: the field to type it in */
  onCodeStart: () => void;
  /** the code as typed; it is not kept anywhere else */
  onCodeSubmit: (code: string) => void;
  /** the ID a typed code found is the one the PC's screen shows */
  onCodeMatch: () => void;
}

/**
 * Adding a PC listed in the account: the six digits come from that PC's own screen, typed here, so a
 * PC someone else listed under a familiar name cannot be added with a tap. Kept in the input itself.
 */
function TypedDigits({ pc, onSubmit, cancel }: { pc: string; onSubmit: (digits: string) => void; cancel: ReactNode }) {
  const t = useT();
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("digits") as HTMLInputElement;
    onSubmit(field.value.replace(/\s/g, ""));
  };
  return (
    <>
      <h1 className="relay-shell-title">{t("Type the number {name} shows", { name: pc })}</h1>
      <p className="relay-shell-copy">{t("{name} shows six digits on its own screen now. Type them here, then approve on {name}.", { name: pc })}</p>
      <p className="relay-shell-detail">{t("No number on {name}? Cancel, then tap {name} in your list.", { name: pc })}</p>
      <form className="relay-shell-code-form" onSubmit={submit}>
        <input name="digits" className="relay-shell-code-input" aria-label={t("Number on {name}", { name: pc })} inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} autoComplete="one-time-code" required autoFocus />
        <div className="relay-shell-actions"><button type="submit" className="btn btn-primary">{t("Add this PC")}</button>{cancel}</div>
      </form>
    </>
  );
}

/**
 * The field a code is typed in, kept in the input itself (src/AGENTS.md: secret input stays in the
 * DOM), as GitHub's device sign-in asks for the code its other screen shows.
 */
function CodeEntry({ failure, onSubmit, back }: { failure: TypedCodeFailure | null; onSubmit: (code: string) => void; back: ReactNode }) {
  const t = useT();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const field = event.currentTarget.elements.namedItem("code") as HTMLInputElement;
    const code = field.value;
    field.value = "";
    onSubmit(code);
  };
  return (
    <>
      <h1 className="relay-shell-title">{t("Pair with a code")}</h1>
      <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs and choose Connect (Show a code to type on an older Ovis). Type the code it shows here.")}</p>
      <form className="relay-shell-code-form" onSubmit={submit}>
        <input name="code" className="relay-shell-code-input" aria-label={t("Code from the PC")} placeholder="XXXXX-XXXXX"
          autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={32} required autoFocus />
        {failure !== null && <p className="relay-shell-detail" role="alert">{codeFailureText(t, failure)}</p>}
        <div className="relay-shell-actions">
          <button type="submit" className="btn btn-primary">{t("Pair")}</button>
          {back}
        </div>
      </form>
    </>
  );
}

/**
 * The id named and the id of the key that is not it, groups that differ marked, each labelled by
 * where it came from. Neither is called the PC's: a link names any id it likes, and only the PC's
 * own screen (Phone & devices) says which id is the PC's.
 */
function KeyIds({ mismatch, named }: { mismatch: KeyMismatch; named: "link" | "paired" }) {
  const t = useT();
  const expected = named === "link" ? t("ID this link names") : t("ID this phone paired with");
  const received = mismatch.from === "link" ? t("ID of the key this link carries") : t("ID of the key this phone saved");
  return (
    <>
    <dl className="relay-shell-keys">
      <dt>{expected}</dt>
      <dd><KeyId id={mismatch.expected} label={expected} /></dd>
      <dt>{received}</dt>
      <dd>
        {mismatch.received === null
          ? <span className="relay-shell-copy">{t("Not a valid key")}</span>
          : <KeyId id={mismatch.received} against={mismatch.expected} label={received} />}
      </dd>
    </dl>
    <p className="relay-shell-detail">{t("Only the PC itself shows its ID, at the top of My devices in Settings → Devices and PCs (under the code on an older Ovis). Marked groups differ.")}</p>
    </>
  );
}

/** How a PC whose Ovis does not update itself is brought up to date: the installer, or herdr's plugin. */
export const INSTALLER_COMMAND = "curl -fsSL https://ovis.sh/install.sh | sh";
export const PLUGIN_COMMANDS = "herdr plugin install devswha/ovis\nherdr plugin action invoke devswha.ovis.stop\nherdr plugin action invoke devswha.ovis.start";

/**
 * The hosted shell's screens before the app: the saved PCs to pick from, the question before a
 * new PC is paired, the wait for the connection, and why one did not come up, each named in
 * `data-relay-state` for scripts. One card in the token gate's frame (AccessGate.css), so a phone
 * that pairs through the relay and one that pairs with a code see the same room.
 */
export function RelayShell({ state, scoped, iosTab, onPair, onRetry, onCancel, onBack, onForget, onUpdate, onMatch, onCodeStart, onCodeSubmit, onCodeMatch, onSignIn, onJoin, onSignOut, onLeave, accountProviders }: RelayShellProps) {
  const t = useT();
  const account: AccountView | null = (state.kind === "list" || state.kind === "empty") && onSignIn ? state.account ?? null : null;
  const signIn = account?.kind === "signed-out" && onSignIn ? <AccountSignIn onSignIn={onSignIn} error={account.error} {...(accountProviders ? { providers: accountProviders } : {})} /> : null;
  // signed out with no saved PC, the QR route waits behind a link under the sign-in
  const [qr, setQr] = useState(false);
  const signInFirst = account?.kind === "signed-out" && state.kind === "empty" && !qr;
  const name = state.kind === "confirm" || state.kind === "code-compare" ? state.offer.name ?? null
    : state.kind === "list" || state.kind === "empty" || state.kind === "code-entry" || state.kind === "code-looking" ? null : state.name;
  const pc = name ?? t("this PC");
  // a forged link is the identity-changed warning in its own words: there is no key of its to forget
  const stateName = state.kind === "failed" ? state.failure : state.kind === "outdated" ? "pc-outdated" : state.kind === "forged" ? "identity-changed" : state.kind;
  const back = scoped ? <button type="button" className="btn" onClick={onBack}>{t("Back")}</button> : null;
  const progress = state.kind === "outdated" && state.update.phase === "installing" ? describeUpdate({ phase: "building", step: state.update.step }) : null;
  const retry = <button type="button" className="btn btn-primary" onClick={onRetry}>{t("Try again")}</button>;
  return (
    <main className="relay-shell-screen" data-relay-state={stateName} {...(account ? { "data-account-state": account.kind } : {})}>
      <div className={signInFirst || state.kind === "compare" ? "relay-shell account-centered" : "relay-shell"}>
        <img src="/icons/icon-192.png?v=sheep1" alt="" width="44" height="44" className="relay-shell-mark" />
        {account?.kind === "signed-in" && <AccountPcs view={account} {...(onJoin ? { onJoin } : {})} {...(onSignOut ? { onSignOut } : {})} {...(onLeave ? { onLeave } : {})} />}
        {account?.kind === "signing-in" && (
          <>
            <h1 className="relay-shell-title">{t("Signing in…")}</h1>
            <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Signing in…")}</span></div>
          </>
        )}
        {signInFirst && (
          <>
            <h1 className="relay-shell-title">{t("Sign in to Ovis")}</h1>
            <p className="relay-shell-copy account-subtitle">{t("See every PC on your account.")}</p>
            {signIn}
            <button type="button" className="account-link" onClick={() => setQr(true)}>{t("Other ways: QR code or pairing code")}</button>
            <AccountFinePrint />
          </>
        )}
        {state.kind === "list" && (account === null || account.kind === "signed-out") && (
          <>
            <h1 className="relay-shell-title">{t("Your PCs")}</h1>
            <ul className="relay-shell-pcs">
              {state.devices.map((device) => (
                <li key={device.server_id}>
                  <a className="relay-shell-pc" href={serverScopePath(device.server_id)}>
                    <span className="relay-shell-pc-name">{device.name ?? t("Unnamed PC")}</span>
                    <ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
            {signIn ? (
              <>
                <div className="account-or"><p className="relay-shell-copy">{t("Sign in to see every PC on your account and add new ones with one approval.")}</p>{signIn}<AccountFinePrint /></div>
                <details className="relay-shell-other-ways">
                  <summary>{t("Other ways")}</summary>
                  <p className="relay-shell-copy">{t("To add another PC, scan the QR code it shows under Devices and PCs (Phone & devices on an older Ovis).")}</p>
                  <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCodeStart}>{t("Pair with a code")}</button></div>
                </details>
              </>
            ) : (
              <>
                <p className="relay-shell-copy">{t("To add another PC, scan the QR code it shows under Devices and PCs (Phone & devices on an older Ovis).")}</p>
                <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCodeStart}>{t("Pair with a code")}</button></div>
              </>
            )}
          </>
        )}
        {state.kind === "empty" && (account === null || (account.kind === "signed-out" && qr)) && (
          <>
            <h1 className="relay-shell-title">{t("Scan the QR code on your PC")}</h1>
            <p className="relay-shell-copy">{t("On the PC, open Settings → Devices and PCs (Phone & devices on an older Ovis) and turn on remote access through the Ovis relay. The QR code there opens this app paired with that PC.")}</p>
            <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCodeStart}>{t("Pair with a code")}</button>{back}</div>
            {account && <div className="relay-shell-actions"><button type="button" className="btn" onClick={() => setQr(false)}>{t("Sign in instead")}</button></div>}
          </>
        )}
        {state.kind === "code-entry" && <CodeEntry failure={state.failure} onSubmit={onCodeSubmit} back={<button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>} />}
        {state.kind === "code-looking" && (
          <>
            <h1 className="relay-shell-title">{t("Looking for the PC…")}</h1>
            <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Looking for the PC…")}</span></div>
            <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button></div>
          </>
        )}
        {state.kind === "code-compare" && (
          <>
            <h1 className="relay-shell-title">{t("Does {name}'s screen show this ID?", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("The PC shows its ID at the top of My devices in Settings → Devices and PCs (under the code on an older Ovis). Pair only if every group matches.")}</p>
            <p className="relay-shell-code-id"><KeyId id={state.offer.server_id} label={t("ID of the PC this code found")} /></p>
            <div className="relay-shell-actions">
              <button type="button" className="btn btn-primary" onClick={onCodeMatch}>{t("It matches")}</button>
              <button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>
            </div>
          </>
        )}
        {state.kind === "confirm" && (
          <>
            <h1 className="relay-shell-title">{t("Pair with {name}?", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("This phone gets a key of its own for {name}. The PC lists it under Devices and PCs (Phone & devices on an older Ovis), where it can be removed.", { name: pc })}</p>
            <div className="relay-shell-actions">
              <button type="button" className="btn btn-primary" onClick={onPair}>{t("Pair")}</button>
              <button type="button" className="btn" onClick={onCancel}>{t("Not now")}</button>
            </div>
          </>
        )}
        {state.kind === "connecting" && (
          <>
            <h1 className="relay-shell-title">{t("Connecting to {name}…", { name: pc })}</h1>
            <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Connecting to {name}…", { name: pc })}</span></div>
            <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button></div>
          </>
        )}
        {state.kind === "compare" && state.typed && !state.confirmed && (
          state.wrong ? (
            <>
              <h1 className="relay-shell-title">{t("That is not the number {name} shows", { name: pc })}</h1>
              <p className="relay-shell-copy">{t("Nothing was added. Tap the PC again to compare a new number, and type the one its own screen shows.")}</p>
              <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCancel}>{t("Back")}</button></div>
            </>
          ) : <TypedDigits pc={pc} onSubmit={onMatch} cancel={<button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>} />
        )}
        {state.kind === "compare" && !(state.typed && !state.confirmed) && (
          <>
            <h1 className="relay-shell-title">{t("Does {name} show this number?", { name: pc })}</h1>
            <p className="relay-shell-digits" aria-label={state.digits.split("").join(" ")}>{`${state.digits.slice(0, 3)} ${state.digits.slice(3)}`}</p>
            {state.confirmed ? (
              <div className="relay-shell-wait" role="status">
                <div className="boot-spinner" aria-hidden="true" />
                <p className="relay-shell-detail">{t("Approve this phone on {name} to finish.", { name: pc })}</p>
              </div>
            ) : (
              <p className="relay-shell-copy">{t("If they match, approve this phone on {name}.", { name: pc })}</p>
            )}
            <div className="relay-shell-actions">
              {!state.confirmed && <button type="button" className="btn btn-primary" onClick={() => onMatch()}>{t("The numbers match")}</button>}
              <button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button>
            </div>
          </>
        )}
        {state.kind === "failed" && state.failure === "pair-declined" && (
          <>
            <h1 className="relay-shell-title">{t("{name} did not approve this phone", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("It was declined on the PC, or not approved in time. Open the link again to compare new numbers.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.failure === "pair-unavailable" && (
          <>
            <h1 className="relay-shell-title">{t("{name} is not taking new phones right now", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("Its link may have run out (it works for 10 minutes), or it may be paused after too many tries or busy with other phones. Copy a new link on the PC, or wait a few minutes.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.failure === "not-added-yet" && (
          <>
            <h1 className="relay-shell-title">{t("{name} has not added this device yet", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("It adds the devices of your account a few minutes after they join. Try again in a moment.")}</p>
            <div className="relay-shell-actions">{retry}{back}</div>
          </>
        )}
        {state.kind === "failed" && state.failure === "pc-offline" && (
          <>
            <h1 className="relay-shell-title">{t("{name} is offline", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("Its Ovis is not connected to the relay right now. Start Ovis on the PC, or check its connection, then try again.")}</p>
            <div className="relay-shell-actions">{retry}{back}</div>
          </>
        )}
        {state.kind === "failed" && state.failure === "pc-unresponsive" && (
          <>
            <h1 className="relay-shell-title">{t("{name} did not finish connecting", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("The PC answered through the relay but did not complete the connection. Try again; if it keeps happening, restart Ovis on the PC.")}</p>
            <div className="relay-shell-actions">{retry}{back}</div>
          </>
        )}
        {state.kind === "failed" && state.failure === "relay-unreachable" && (
          <>
            <h1 className="relay-shell-title">{t("The relay could not be reached")}</h1>
            <p className="relay-shell-copy">{t("Check this phone's connection, then try again.")}</p>
            <div className="relay-shell-actions">{retry}{back}</div>
          </>
        )}
        {state.kind === "failed" && state.failure === "needs-update" && (
          <>
            <h1 className="relay-shell-title">{t("Update needed")}</h1>
            <p className="relay-shell-copy">{t("{name} and this app speak different versions of the relay protocol. Update Ovis on the PC, then try again.", { name: pc })}</p>
            <div className="relay-shell-actions">{retry}{back}</div>
          </>
        )}
        {state.kind === "outdated" && (
          <>
            <h1 className="relay-shell-title">{t("Update Ovis on {name}", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("{name} runs Ovis {version}; this app needs {min} or newer.", { name: pc, version: state.serverVersion, min: state.minVersion })}</p>
            {state.update.phase === "reading" && <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /></div>}
            {state.update.phase === "offer" && (
              <>
                <p className="relay-shell-copy relay-shell-more">{t("Update it from here: the PC installs the latest release and restarts Ovis, then this app reconnects.")}</p>
                <div className="relay-shell-actions">
                  <button type="button" className="btn btn-primary" onClick={onUpdate}>{t("Update now")}</button>
                  {back}
                </div>
              </>
            )}
            {state.update.phase === "manual" && (
              <>
                <p className="relay-shell-copy relay-shell-more">{t("Its Ovis does not update itself. On the PC, run the installer:")}</p>
                <pre className="relay-shell-command"><code>{INSTALLER_COMMAND}</code></pre>
                <p className="relay-shell-copy relay-shell-more">{t("Or, for the herdr plugin, reinstall it and restart Ovis:")}</p>
                <pre className="relay-shell-command"><code>{PLUGIN_COMMANDS}</code></pre>
                <div className="relay-shell-actions">{retry}{back}</div>
              </>
            )}
            {state.update.phase === "installing" && (
              <div className="relay-shell-wait" role="status">
                <div className="boot-spinner" aria-hidden="true" />
                <p className="relay-shell-detail">{progress ? `${progress.step}: ${t(progress.label)}` : t("Asking the PC to update…")}</p>
              </div>
            )}
            {state.update.phase === "restarting" && (
              <div className="relay-shell-wait" role="status">
                <div className="boot-spinner" aria-hidden="true" />
                <p className="relay-shell-detail">{t("Waiting for {name} to restart…", { name: pc })}</p>
              </div>
            )}
            {state.update.phase === "failed" && (
              <>
                <p className="relay-shell-copy relay-shell-more">{t("The update did not finish.")}</p>
                {state.update.detail !== null && <p className="relay-shell-detail"><code>{state.update.detail}</code></p>}
                <div className="relay-shell-actions">
                  <button type="button" className="btn btn-primary" onClick={onUpdate}>{t("Update now")}</button>
                  {back}
                </div>
              </>
            )}
          </>
        )}
        {state.kind === "failed" && state.failure === "revoked" && (
          <>
            <h1 className="relay-shell-title">{t("This phone was removed from {name}", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("Its pairing was revoked on the PC, so this phone's key for it is gone. To pair again, scan a new QR code on the PC.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.failure === "identity-changed" && (
          <>
            <h1 className="relay-shell-title">{t("{name} has a new identity", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("The PC's relay key is not the one this phone paired with, so the saved pairing cannot be trusted. Forget it, then pair again from a new QR code on the PC.")}</p>
            {state.mismatch && <KeyIds mismatch={state.mismatch} named="paired" />}
            <div className="relay-shell-actions">
              <button type="button" className="btn btn-danger" onClick={onForget}>{t("Forget this PC")}</button>
              {back}
            </div>
          </>
        )}
        {state.kind === "forged" && (
          <>
            <h1 className="relay-shell-title">{t("This link is not {name}'s", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("It carries a key that is not this PC's, so this phone will not pair with it. To pair, scan a new QR code on the PC itself.")}</p>
            {state.mismatch && <KeyIds mismatch={state.mismatch} named="link" />}
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "forgotten" && (
          <>
            <h1 className="relay-shell-title">{t("This phone forgot {name}", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("The link you opened carried a different key, so it is not used to pair again. To pair, scan a new QR code on the PC itself.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.failure === "code-expired" && (
          <>
            <h1 className="relay-shell-title">{t("That pairing code no longer works")}</h1>
            <p className="relay-shell-copy">{t("The code was wrong, used up or expired. Scan a new QR code on the PC.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.failure === "bad-offer" && (
          <>
            <h1 className="relay-shell-title">{t("This pairing link is damaged")}</h1>
            <p className="relay-shell-copy">{t("Part of the link is missing or changed. Scan the QR code on the PC again, or copy its link whole.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.detail !== null && <p className="relay-shell-detail"><code>{state.detail}</code></p>}
        {iosTab && scoped && <p className="relay-shell-hint">{t("Add to Home Screen to stay paired: Safari may clear this page's storage after a week without a visit.")}</p>}
      </div>
    </main>
  );
}
