import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, X } from "lucide-react";

import "./ConnectPhoneDialog.css";
import "./DevicesPanel.css";

import { startPairing } from "../lib/api.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import type { PhonePlan } from "../lib/phone.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { announcePairingCode, inRelayShell, PAIRING_CODE_EVENT, type RelayState } from "../lib/useRelay.ts";
import type { PairingCode } from "../../shared/protocol.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { PhonePanel } from "./PhonePanel.tsx";
import { QrCode } from "./QrCode.tsx";
import { failureText, RelayPairing, statusText } from "./RelayPanel.tsx";
import { Toggle } from "./SettingsControls.tsx";

const README_PHONE = "https://github.com/devswha/ovis#on-your-phone";
const README_SAFETY = "https://github.com/devswha/ovis#access-and-safety";

export type ConnectRoute = "relay" | "tailscale" | "code";

/** whether the relay can be offered here at all: a server with the route, a direct page, not the hosted shell */
export const relayOffered = (relay: RelayState): boolean => !relay.unsupported && relay.status !== null && !inRelayShell();

/** Tailscale already gives a phone an address for this PC */
const tailscaleWorks = (plan: PhonePlan): boolean => plan.kind === "here" || plan.kind === "served";

/** the relay is on: connecting or online, nothing blocking it */
const relayOn = (relay: RelayState): boolean => relay.status !== null && relay.status.blocked === null && relay.status.phase !== "off";

/**
 * The way the dialog opens on: the relay whenever it is offered, since it needs nothing installed,
 * except when it is off and Tailscale already works; then Tailscale, with the relay's switch on its
 * choice so it can be turned on right there.
 */
export function defaultRoute(plan: PhonePlan, relay: RelayState): ConnectRoute {
  if (!relayOffered(relay)) return "tailscale";
  return !relayOn(relay) && tailscaleWorks(plan) ? "tailscale" : "relay";
}

export interface ConnectPhoneDialogProps {
  route: ConnectRoute;
  plan: PhonePlan;
  loading: boolean;
  onRefresh: () => void;
  /** an address a phone can open now, for the pairing code's QR code; null shows the code alone */
  pairUrl: string | null;
  relay: RelayState;
  /** a watching device or a Portal visitor: it reads, and starts nothing */
  readOnly: boolean;
  /** turning the relay on closes the open device gate */
  closesGate: boolean;
  /** a Portal visitor may not start pairing codes (the server refuses it) */
  canPair: boolean;
  /** Pair a device opened it: the code route starts a code at once, as the button always did */
  startCode?: boolean;
  onClose: () => void;
}

/**
 * Settings → Phone & devices → Connect a phone: the ways a phone reaches this PC as choices at the
 * top, each with its one-line hint, then the chosen one's details, and the QR codes, which show only
 * here. The Ovis relay (from anywhere, nothing to install),
 * Tailscale (the PC's tailnet address, or the command that publishes it) and a pairing code (a
 * phone that can already open this address: the same Wi-Fi, a tunnel, a proxy). The relay is
 * controlled only here: its switch on its card, and its reset and start failures in its details.
 * The settings page keeps the relay's state in the Connect a phone row and the device list; the
 * long explanations wait behind How it works.
 */
export function ConnectPhoneDialog({ route: initial, plan, loading, onRefresh, pairUrl, relay, readOnly, closesGate, canPair, startCode = false, onClose }: ConnectPhoneDialogProps) {
  const t = useT();
  const id = useId();
  // until a way is picked, the dialog follows the default as the relay's and Tailscale's answers arrive, so a
  // dialog opened before they did does not stay on the way it guessed; a caller's own route (Pair a device) is a pick
  const [picked, setRoute] = useState<ConnectRoute | null>(initial === defaultRoute(plan, relay) && !startCode ? null : initial);
  const route = picked ?? defaultRoute(plan, relay);
  const surface = useFocusTrap<HTMLDivElement>(true);
  useSheetSwipe(surface, onClose);
  // it stays up under the relay identity's confirmation, which Back or its own close then leaves for it
  usePhoneSheetBack(() => { onClose(); }, true, true);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current)) return;
      // the relay identity's confirmation, opened over this dialog, takes its own Escape
      if (document.querySelector('[role="alertdialog"]') !== null) return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, surface]);

  const offered = relayOffered(relay);
  // the relay's one switch, on its card, for the PC's owner where nothing blocks it
  const switchOnChoice = offered && !readOnly && relay.status?.blocked === null;
  const [switchError, setSwitchError] = useState<string | null>(null);
  // a failed switch's reason goes once the relay is on, however it came on (Try again in its details too)
  const on = relayOn(relay);
  useEffect(() => { if (on) setSwitchError(null); }, [on]);
  const routes: { value: ConnectRoute; label: string; hint: string }[] = [
    ...(offered ? [{ value: "relay" as const, label: t("Ovis relay"), hint: t("From anywhere. Nothing to install.") }] : []),
    // on this page's own HTTPS address (maybe not Tailscale's), the hint names the address, not the app
    { value: "tailscale", label: "Tailscale", hint: plan.kind === "here" ? t("At this page's HTTPS address.") : t("With the Tailscale app on the phone.") },
    ...(canPair ? [{ value: "code" as const, label: t("Pairing code"), hint: t("On the same Wi-Fi, or through a tunnel.") }] : []),
  ];
  const shown = routes.some((option) => option.value === route) ? route : routes[0]!.value;
  const switchRelay = async (next: boolean) => {
    setSwitchError(null);
    // the switch picks the relay: turned on, its details follow (its state, then its QR code once it is online),
    // and turned off they stay, rather than the default moving back to Tailscale under the hand that switched it
    setRoute("relay");
    try { await relay.request(next ? "start" : "stop"); } catch (reason) { setSwitchError(failureText(reason)); }
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={surface} className="modal connect-phone-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}>
        <header className="modal-header">
          <h2 className="modal-title" id={`${id}-title`}>{t("Connect a phone")}</h2>
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="modal-body connect-phone-body">
          {routes.length > 1 && (
            <div className="connect-phone-choices" role="group" aria-label={t("How the phone connects")}>
              {routes.map((option) => (
                <div key={option.value} className="connect-phone-choice">
                  <button type="button" className="connect-phone-choice-button" aria-pressed={shown === option.value}
                    aria-labelledby={`${id}-${option.value}`} aria-describedby={`${id}-${option.value}-hint`} onClick={() => setRoute(option.value)}>
                    <span className="connect-phone-choice-label" id={`${id}-${option.value}`}>{option.label}</span>
                    <span className="connect-phone-choice-hint" id={`${id}-${option.value}-hint`}>{option.hint}</span>
                  </button>
                  {option.value === "relay" && switchOnChoice && (
                    <Toggle label={t("Ovis relay")} checked={on} describedBy={closesGate && !on ? `${id}-gate` : undefined} onChange={(next) => { if (!relay.pending) void switchRelay(next); }} />
                  )}
                </div>
              ))}
            </div>
          )}
          {switchOnChoice && closesGate && !on && <p className="settings-condition connect-phone-gate" id={`${id}-gate`}>{t("Turning on the relay closes the device gate: a new browser then needs a pairing code or the access token.")}</p>}
          {switchError !== null && <p className="settings-hint relay-error" role="alert">{switchError}</p>}
          {/* every way stays mounted while the dialog is up, the others hidden: the relay's QR and the pairing
              code follow each other's New code (the server keeps one pending code), as they did side by side */}
          {offered && <div className="connect-phone-route" data-route="relay" hidden={shown !== "relay"}><RelayRoute relay={relay} readOnly={readOnly} /></div>}
          <div className="connect-phone-route" data-route="tailscale" hidden={shown !== "tailscale"}><PhonePanel plan={plan} loading={loading} onRefresh={onRefresh} /></div>
          {canPair && <div className="connect-phone-route" data-route="code" hidden={shown !== "code"}><CodeRoute pairUrl={pairUrl} startAtOnce={startCode && initial === "code"} /></div>}
          <details className="settings-details connect-phone-how">
            <summary><span className="settings-details-toggle">{t("How it works")}</span></summary>
            <p className="settings-hint">{t("Use Ovis from your phone anywhere, without Tailscale. Traffic is end-to-end encrypted; the relay sees only when and how much.")}</p>
            <p className="settings-hint">{t("Your own Tailscale devices get in as you.")} {t("With an access token set, each asks for it once. Anyone else's device, or a LAN or public address, needs pairing: Devices, below.")}</p>
            <p className="settings-hint"><a href={README_PHONE} target="_blank" rel="noreferrer">{t("Other routes")}</a> · <a href={README_SAFETY} target="_blank" rel="noreferrer">{t("Access and safety")}</a></p>
          </details>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The relay's way: its state (Blocked says why), a start that failed with Try again, the pairing QR
 * code once it is online, and the identity reset as a quiet last action. The switch is on its card.
 */
function RelayRoute({ relay, readOnly }: { relay: RelayState; readOnly: boolean }) {
  const t = useT();
  const { status, pending, request } = relay;
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const resetButton = useRef<HTMLButtonElement>(null);
  if (status === null) return null;
  // a start that failed before the link existed: the relay is off and nothing retries it (server/relay/service.ts)
  const notStarted = status.blocked === null && status.phase === "off" && status.error !== null;
  const start = async () => {
    setError(null);
    try { await request("start"); } catch (reason) { setError(failureText(reason)); }
  };
  return (
    <div className="connect-phone-relay">
      <p className="relay-status" role="status">{statusText(t, status)}</p>
      {readOnly && <p className="settings-condition" data-testid="relay-owner-help">{t("Only the PC's owner can control the relay, using a direct connection. Open Ovis on the PC or at its direct address.")}</p>}
      {notStarted && <p className="settings-hint relay-error" role="alert">{t("The relay did not start: {message}", { message: status.error })}</p>}
      {notStarted && !readOnly && (
        <div className="phone-actions">
          <button type="button" className="btn" disabled={pending} onClick={() => void start()}><RefreshCw aria-hidden="true" />{t("Try again")}</button>
        </div>
      )}
      {error !== null && <p className="settings-hint relay-error" role="alert">{error}</p>}
      {status.phase === "online" && !readOnly && <RelayPairing />}
      {/* a serve-only install refuses the reset too; an unreadable identity is what the reset mends */}
      {!readOnly && status.blocked !== "serve_only" && (
        <div className="phone-actions connect-phone-reset">
          <button ref={resetButton} type="button" className="btn btn-ghost" disabled={pending} onClick={() => setConfirmingReset(true)}>{t("Reset relay identity")}</button>
        </div>
      )}
      {confirmingReset && (
        <ConfirmDialog title={t("Reset the relay identity?")} body={t("Phones paired through the relay will need to scan a new code.")}
          confirmLabel={t("Reset")} onClose={() => setConfirmingReset(false)} onConfirm={async () => {
            await request("reset-identity");
            setConfirmingReset(false);
            // the confirmation hands focus back only when it is dismissed: after the reset it goes back here
            window.requestAnimationFrame(() => resetButton.current?.focus());
          }} />
      )}
    </div>
  );
}

/**
 * A pairing code for a phone that can already open this address, with the QR code that opens it
 * with the code filled in. The server keeps one pending code: a code started here is announced, so
 * the Devices group watches for the phone it lets in (and closes the dialog once it is in), and the
 * relay's offer carries the same code.
 */
function CodeRoute({ pairUrl, startAtOnce }: { pairUrl: string | null; startAtOnce: boolean }) {
  const t = useT();
  const [code, setCode] = useState<PairingCode | null>(null);
  const [left, setLeft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const announcing = useRef(false);

  useEffect(() => {
    const onCode = (event: Event) => { if (!announcing.current) setCode((event as CustomEvent<PairingCode>).detail); };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    return () => window.removeEventListener(PAIRING_CODE_EVENT, onCode);
  }, []);

  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      const ms = Date.parse(code.expires_at) - Date.now();
      if (ms <= 0) { setCode(null); return; }
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [code]);

  const pair = async () => {
    setError(null);
    try {
      const fresh = await startPairing();
      setCode(fresh);
      announcing.current = true;
      try { announcePairingCode(fresh); } finally { announcing.current = false; }
    } catch (reason) { setError(failureText(reason)); }
  };

  // once per opening from Pair a device; switching back to this route later waits for the button
  const started = useRef(false);
  useEffect(() => {
    if (!startAtOnce || started.current) return;
    started.current = true;
    void pair();
  }, [startAtOnce]);

  const spaced = code ? `${code.code.slice(0, 3)} ${code.code.slice(3)}` : "";
  const qrValue = code && pairUrl ? `${pairUrl.replace(/\/$/, "")}/?pair=${code.code}` : null;
  return (
    <div className="connect-phone-code">
      {code === null ? (
        <>
          <p className="settings-description">{t("For a phone that can already open this address: on the same Wi-Fi, or through a tunnel or proxy.")}</p>
          <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={() => void pair()}>{t("Get a pairing code")}</button></div>
        </>
      ) : (
        <div className="devices-pairing" role="status">
          {qrValue !== null && <QrCode value={qrValue} label={t("QR code that pairs a phone with code {code}", { code: code.code })} />}
          <div>
            <p className="settings-label">{t("On the other device, enter this code")}</p>
            <p className="devices-code">{spaced}</p>
            <p className="settings-description">
              {t(qrValue !== null ? "Or scan the QR code: it opens the app with the code filled in." : "Open the app's address on that device and enter it.")} {t("Expires in {time}.", { time: left })}
            </p>
            {qrValue !== null && (
              <p className="devices-link">
                <span className="settings-description">{t("Or send this link to it:")}</span>
                <a ref={linkRef} href={qrValue}>{qrValue}</a>
                <button type="button" className="btn btn-ghost" onClick={() => void copyText(qrValue, linkRef.current).then((ok) => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1600); } })}>{t(copied ? "Copied" : "Copy")}</button>
              </p>
            )}
            <div className="phone-actions">
              <button type="button" className="btn" onClick={() => void pair()}><RefreshCw aria-hidden="true" />{t("New code")}</button>
            </div>
          </div>
        </div>
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}
