import { useState } from "react";
import { Smartphone } from "lucide-react";

import "./DevicePairedNotice.css";
import "./RelayPairingPrompt.css";

import type { RelayPairingRequest } from "../../shared/protocol.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { failureText } from "./RelayPanel.tsx";

export function RelayPairingPrompt({ pairings }: { pairings: readonly RelayPairingRequest[] }) {
  const t = useT();
  const [busy, setBusy] = useState<{ id: string; decision: "approve" | "decline" } | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const decide = async (id: string, decision: "approve" | "decline") => {
    setBusy({ id, decision });
    setFailure(null);
    try { await decideRelayPairing(id, decision); }
    catch (error) { setFailure({ id, text: failureText(error instanceof Error ? error : new Error(String(error))) }); }
    finally { setBusy(null); }
  };
  return <div className="relay-pairing-layer" role="region" aria-live="assertive" aria-label={t("Pair a phone through the relay")}>{pairings.map((pairing) => {
    const deciding = busy?.id === pairing.id ? busy.decision : null;
    return (
      <div key={pairing.id} className="update-notice is-paired relay-pairing-prompt" data-testid="relay-pairing-prompt">
        <Smartphone aria-hidden="true" />
        <span>
          {t("{name} wants to pair through the relay. Approve it only if its screen shows", { name: pairing.label })}{" "}
          <strong className="relay-pairing-digits">{`${pairing.digits.slice(0, 3)} ${pairing.digits.slice(3)}`}</strong>
          {failure?.id === pairing.id && <span className="relay-error" role="alert"> {failure.text}</span>}
        </span>
        <div className="device-paired-actions">
          <button type="button" className="btn btn-primary" disabled={deciding !== null} aria-busy={deciding === "approve" ? true : undefined} onClick={() => void decide(pairing.id, "approve")}>{t("Approve")}</button>
          <button type="button" className="btn" disabled={deciding !== null} aria-busy={deciding === "decline" ? true : undefined} onClick={() => void decide(pairing.id, "decline")}>{t("Decline")}</button>
        </div>
      </div>
    );
  })}</div>;
}
