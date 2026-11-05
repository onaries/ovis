/**
 * A new device asks to join the account through a PC this device is connected to
 * (`remote-pairings`, docs/account.md "Who may admit a device"). The approver picks the number the
 * new device shows out of three, as Microsoft Authenticator's number matching does: a tap without
 * looking is right one time in three, and a wrong pick ends the request. Approve stays off until
 * a number is picked; Deny and Escape end it.
 */
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MonitorSmartphone } from "lucide-react";

import "./AccountApprovalPrompt.css";

import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { objectParticle } from "../lib/koreanParticle.ts";
import { useSettings } from "../lib/settings.ts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";

export interface AccountApprovalPromptProps {
  request: RemotePairingRequest;
  /** the PC the request came through */
  pcName: string;
  /** how many PCs of the account the device joins, from this device's own list */
  pcCount: number;
  onDecide: (decision: "approve" | "decline", digits?: string) => Promise<void>;
}

const grouped = (digits: string): string => `${digits.slice(0, 3)} ${digits.slice(3)}`;

export function AccountApprovalPrompt({ request, pcName, pcCount, onDecide }: AccountApprovalPromptProps) {
  const t = useT();
  const { resolvedLanguage } = useSettings();
  // Korean takes 을 or 를 by how the name ends, so the name carries it there
  const asObject = resolvedLanguage === "ko" ? `${request.label}${objectParticle(request.label)}` : request.label;
  const id = useId();
  const deny = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: deny });
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "approve" | "decline"): Promise<void> => {
    setBusy(true);
    setError(null);
    try { await onDecide(decision, decision === "approve" ? picked ?? undefined : undefined); }
    catch (reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false); }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      void decide("decline");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return createPortal(
    <div className="modal-scrim">
      <div ref={surface} className="modal account-approval" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} data-testid="account-approval">
        <div className="account-approval-mark" aria-hidden="true"><MonitorSmartphone /></div>
        <h2 className="account-approval-title" id={`${id}-title`}>{t("Add {device}?", { device: asObject })}</h2>
        <p className="account-approval-via">{request.intent === "account" ? t("Through {pc} · joins your {n} PCs", { pc: pcName, n: pcCount }) : t("Only for {pc}", { pc: pcName })}</p>
        <p className="account-approval-ask" id={`${id}-ask`}>{t("Pick the number on {device}", { device: request.label })}</p>
        <div className="account-approval-choices" role="radiogroup" aria-labelledby={`${id}-ask`}>
          {request.choices.map((choice) => (
            <button key={choice} type="button" role="radio" aria-checked={picked === choice} aria-label={choice.split("").join(" ")}
              className="account-approval-choice" disabled={busy} onClick={() => setPicked(choice)}>{grouped(choice)}</button>
          ))}
        </div>
        {error !== null && <p className="account-approval-error" role="alert">{error}</p>}
        <div className="account-approval-actions">
          <button ref={deny} type="button" className="btn" disabled={busy} onClick={() => void decide("decline")}>{t("Deny")}</button>
          <button type="button" className="btn btn-primary" disabled={busy || picked === null} onClick={() => void decide("approve")}>{t("Approve")}</button>
        </div>
        <p className="account-approval-note">{t("Didn't ask for this? Deny it.")}</p>
      </div>
    </div>,
    document.body,
  );
}
