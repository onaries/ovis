import "./AccessGate.css";

import { type FormEvent, useEffect, useRef, useState } from "react";

import { ApiError, authenticate, pairDevice } from "../lib/api.ts";
import { deviceLabel } from "../lib/phone.ts";
import type { AccessRefusal } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { changePc, inNativeApp } from "../lib/nativeApp.ts";
import { userErrorMessage, type UserError } from "../lib/userError.ts";


export interface AccessGateProps {
  /** why the server refused this browser, when it said */
  reason: AccessRefusal | null;
  /** the unconsumed address code to display; automatic submission must claim it first */
  initialCode: string;
  /** claim the address code before sending it, even if the request fails; empty means already consumed */
  consumePairCode: () => string;
  /** a successful pairing was followed by a health check that still refused this browser */
  pairingUnconfirmed: boolean;
  /** notify a caller tracking whether the successful pairing survives the next health check */
  onPaired?: () => void;
  /** Fires once the server set a cookie: the shell can mount, and every later fetch and the WebSocket carry it. */
  onUnlocked: () => void;
}

/**
 * Sign-in screen rendered instead of the shell while the server does not know this
 * browser. Pairing is the usual way in: a six-digit code the owner started on the PC
 * (Settings → Devices), typed once, or carried by the QR code's address. The shared
 * token stays as the other way. Nothing is stored here: the server answers with an
 * HttpOnly cookie either way.
 */
export function AccessGate({ reason, initialCode, consumePairCode, pairingUnconfirmed, onPaired, onUnlocked }: AccessGateProps) {
  const t = useT();
  const codeRef = useRef<HTMLInputElement | null>(null);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const [code, setCode] = useState(initialCode);
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState<"code" | "token" | null>(null);
  const [error, setError] = useState<UserError | null>(null);
  const [codeShort, setCodeShort] = useState(false);
  const scanned = useRef(code.length === 6);

  const pair = async (value: string): Promise<void> => {
    if (submitting) return;
    setSubmitting("code");
    setError(null);
    try {
      await pairDevice(value, deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0));
      onPaired?.();
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? { message: t("That code is wrong, used up or expired. Start a new pairing on the PC."), detail: null } : userErrorMessage(err));
      setSubmitting(null);
      codeRef.current?.select();
    }
  };

  // a scanned QR code brings the code along: no typing on the phone
  useEffect(() => {
    if (!scanned.current) return;
    scanned.current = false;
    // the address code goes once: a failed attempt leaves an empty field, not a spent code to send again
    setCode("");
    const value = consumePairCode();
    if (value) void pair(value);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submitCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (code.length !== 6) { setCodeShort(true); codeRef.current?.focus(); return; }
    void pair(code);
  };

  const submitToken = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    if (token === "") { tokenRef.current?.focus(); return; }
    setSubmitting("token");
    setError(null);
    try {
      await authenticate(token);
      onUnlocked();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? { message: t("Token does not match."), detail: null } : userErrorMessage(err));
      setSubmitting(null);
      tokenRef.current?.select();
    }
  };

  return (
    <main className="access-gate-screen">
      <div className="access-gate" data-testid="token-gate">
        <img src="/icons/icon-192.png?v=sheep1" alt="" width="44" height="44" className="access-gate-mark" />
        <h1 id="access-gate-title" className="access-gate-title">
          Ovis
        </h1>
        {reason === "other_user" && (
          <p className="access-gate-refused" role="status">{t("Tailscale says this device belongs to someone other than this PC's owner. The owner can still let it in with a pairing code.")}</p>
        )}
        <p className="access-gate-copy">
          {t(reason === "token_required" ? "This server requires an access token or a pairing code." : "Pair this device with a code from the PC: Settings → Devices there, or the pair command in its terminal.")}
        </p>
        <form aria-labelledby="access-gate-title" onSubmit={submitCode}>
          <label className="access-gate-label" htmlFor="access-gate-code">{t("Pairing code")}</label>
          <input
            ref={codeRef}
            id="access-gate-code"
            className="access-gate-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={7}
            placeholder="000 000"
            autoFocus
            aria-invalid={codeShort || (error !== null && submitting !== "token")}
            aria-describedby={codeShort ? "access-gate-code-error" : error !== null ? "access-gate-error" : undefined}
            value={code}
            onChange={(event) => { setCodeShort(false); setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); }}
          />
          {codeShort && <p id="access-gate-code-error" className="access-gate-error" role="alert">{t("Enter all 6 digits of the pairing code.")}</p>}
          <button type="submit" className="access-gate-submit" disabled={submitting !== null}>
            {t(submitting === "code" ? "Pairing…" : "Pair this device")}
          </button>
        </form>
        <details className="access-gate-alt">
          <summary>{t("Have an access token instead?")}</summary>
          <form onSubmit={(event) => void submitToken(event)}>
            <label className="access-gate-label" htmlFor="access-gate-token">{t("Access token")}</label>
            <input
              ref={tokenRef}
              id="access-gate-token"
              className="access-gate-input"
              type="password"
              name="token"
              autoComplete="current-password"
              inputMode="text"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <button type="submit" className="access-gate-submit" disabled={submitting !== null}>
              {t(submitting === "token" ? "Unlocking…" : "Unlock")}
            </button>
          </form>
        </details>
        {pairingUnconfirmed && error === null && (
          <p className="access-gate-error" role="alert">{t("Could not confirm this browser is paired. Check that cookies are enabled, then try again.")}</p>
        )}
        {error !== null && (
          <p id="access-gate-error" className="access-gate-error" role="alert">{error.message}{error.detail !== null && <><br /><code>{error.detail}</code></>}</p>
        )}
        {/* in the iOS app (app/) this page is all there is: the way back to its list of PCs */}
        {inNativeApp() && (
          <p className="access-gate-copy"><button type="button" className="btn" onClick={() => void changePc()}>{t("Change PC")}</button></p>
        )}
      </div>
    </main>
  );
}
