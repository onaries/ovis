import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import "./RelayPanel.css";

import { ApiError, requestRelayOffer, startPairing, type RelayOffer } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { announcePairingCode, PAIRING_CODE_EVENT } from "../lib/useRelay.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { QrCode } from "./QrCode.tsx";

export const failureText = (error: unknown): string => error instanceof ApiError ? error.detail : error instanceof Error ? error.message : String(error);

export function statusText(t: ReturnType<typeof useT>, status: RelayStatus): string {
  if (status.blocked === "serve_only") return t("Blocked: OVIS_TAILSCALE_SERVE_ONLY says tailscale serve is the only way in. Unset it on this PC and restart the app.");
  if (status.blocked === "identity_unreadable") return t("Blocked: this PC's relay identity cannot be read. Reset it in Connect a phone to use the relay again.");
  switch (status.phase) {
    case "off": return t("Off. Nothing goes through the relay.");
    case "connecting": return t("Connecting…");
    case "online":
      return status.sessions === 0 ? t("Online. No phone connected.") : status.sessions === 1 ? t("Online. 1 phone connected.") : t("Online. {n} phones connected.", { n: status.sessions });
    default: return t("Error: {message}", { message: status.error ?? t("Could not reach the relay.") });
  }
}

/**
 * The QR code of the pending pairing offer, counted down to its expiry. An offer is asked for when
 * this opens with the relay online, when the Devices group starts a new code (the server keeps one
 * pending code, so both show the same), when the code ran out, and on New code, which starts a
 * new code first; never on a timer or a render.
 */
export function RelayPairing() {
  const t = useT();
  const [offer, setOffer] = useState<RelayOffer | null>(null);
  const [left, setLeft] = useState("");
  const [state, setState] = useState<"minting" | "live" | "expired" | "failed">("minting");
  const [failure, setFailure] = useState<string | null>(null);
  // the effect below asks for an offer once per value
  const [generation, setGeneration] = useState(0);
  // this panel's own announcement must not make it ask twice
  const announcing = useRef(false);
  const again = () => setGeneration((value) => value + 1);

  useEffect(() => {
    let cancelled = false;
    setState("minting");
    requestRelayOffer().then((next) => {
      if (cancelled) return;
      setOffer(next);
      setState("live");
      // the server made this offer's code, maybe with no New code pressed: the page watches it like any other
      // (the Devices group re-reads its list while a code is out and closes the dialog once the phone is in)
      const code = decodeOffer(next.url)?.code;
      if (code !== undefined) {
        announcing.current = true;
        try { announcePairingCode({ code, expires_at: next.expires_at }); } finally { announcing.current = false; }
      }
    }, (reason: unknown) => {
      if (cancelled) return;
      setOffer(null);
      setFailure(failureText(reason));
      setState("failed");
    });
    return () => { cancelled = true; };
  }, [generation]);

  useEffect(() => {
    const onCode = () => { if (!announcing.current) again(); };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    return () => window.removeEventListener(PAIRING_CODE_EVENT, onCode);
  }, []);

  useEffect(() => {
    if (offer === null) return;
    let wasLive = false;
    const tick = () => {
      const ms = Date.parse(offer.expires_at) - Date.now();
      if (ms <= 0) {
        setOffer(null);
        // a code that ran out while shown is replaced by itself; one that arrived already expired
        // (the PC's clock and this one apart) is not, or the asking would never end
        if (wasLive) again(); else setState("expired");
        return;
      }
      wasLive = true;
      setLeft(`${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [offer]);

  const renew = async () => {
    setState("minting");
    try {
      const code = await startPairing();
      announcing.current = true;
      try { announcePairingCode(code); } finally { announcing.current = false; }
      again();
    } catch (reason) {
      setOffer(null);
      setFailure(failureText(reason));
      setState("failed");
    }
  };

  return (
    <div className="settings-item relay-pairing" role="status">
      {offer !== null && <QrCode value={offer.url} label={t("QR code that pairs a phone through the relay")} />}
      <div className="relay-pairing-text">
        <p className="settings-label">{t("Scan it with the phone's camera")}</p>
        <p className="settings-description">
          {t("It opens Ovis on the phone and pairs it with this PC.")}{" "}
          {state === "live" && t("Expires in {time}.", { time: left })}
          {state === "expired" && t("This code expired.")}
          {state === "minting" && t("Getting a code…")}
        </p>
        {state === "failed" && failure !== null && <p className="settings-hint relay-error" role="alert">{failure}</p>}
        <div className="phone-actions">
          <button type="button" className="btn" disabled={state === "minting"} onClick={() => void renew()}><RefreshCw aria-hidden="true" />{t("New code")}</button>
        </div>
      </div>
    </div>
  );
}
