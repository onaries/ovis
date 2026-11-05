import { useState } from "react";
import { Smartphone } from "lucide-react";

import "./DevicePairedNotice.css";
import "./RelayPairingPrompt.css";

import type { RelayPairingRequest } from "../../shared/protocol.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { failureText } from "./RelayPanel.tsx";

/**
 * A phone that opened a pairing link without a code waits for this PC's owner (`relay-pairings`
 * on the machines event stream, sent only to windows that may approve it). Like a Bluetooth
 * pairing's "Does this code match?": the same six digits are on the phone, and only the owner
 * comparing them makes the pairing. Approve adds the phone as a device; Decline ends it. The
 * line goes once the server's list no longer holds it, whichever window answered. It sits above
 * every dialog (Connect a phone is where the link is copied, and usually still open), in a live
 * region rather than a dialog: it blocks nothing, and a pane behind it still counts as in front.
 */
export function RelayPairingPrompt({ pairings }: { pairings: readonly RelayPairingRequest[] }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const decide = async (id: string, decision: "approve" | "decline") => {
    setBusy(id);
    setFailure(null);
    try { await decideRelayPairing(id, decision); }
    catch (error) { setFailure({ id, text: failureText(error) }); }
    finally { setBusy(null); }
  };
  return <div className="relay-pairing-layer" role="region" aria-live="assertive" aria-label={t("Pair a phone through the relay")}>{pairings.map((pairing) => (
    <div key={pairing.id} className="update-notice is-paired relay-pairing-prompt" data-testid="relay-pairing-prompt">
      <Smartphone aria-hidden="true" />
      <span>
        {t("{name} wants to pair through the relay. Approve it only if its screen shows", { name: pairing.label })}{" "}
        <strong className="relay-pairing-digits">{`${pairing.digits.slice(0, 3)} ${pairing.digits.slice(3)}`}</strong>
        {failure?.id === pairing.id && <span className="relay-error" role="alert"> {failure.text}</span>}
      </span>
      <div className="device-paired-actions">
        <button type="button" className="btn btn-primary" disabled={busy === pairing.id} onClick={() => void decide(pairing.id, "approve")}>{t("Approve")}</button>
        <button type="button" className="btn" disabled={busy === pairing.id} onClick={() => void decide(pairing.id, "decline")}>{t("Decline")}</button>
      </div>
    </div>
  ))}</div>;
}
