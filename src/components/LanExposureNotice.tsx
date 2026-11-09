import { X } from "lucide-react";

import { isTailnetAddress } from "../../shared/relay-mux.ts";
import { useT } from "../lib/i18n.ts";

import "./LanExposureNotice.css";

/**
 * The server is answering on an address beyond this PC with no access token set and no device
 * paired, so anything that can reach that address is let in. It says so and does nothing about
 * it: pairing or a token is the owner's decision, and the default stays what it is
 * (`server/access.ts`, `lanExposed`).
 *
 * Not dismissible. This is the server's state rather than an event, so it leaves when the
 * state does — and a dismissed warning would not come back when the state returned.
 *
 * `direct`: the line says instead that the relay's same-Wi-Fi direct connection listens here, for
 * relay-paired devices only. That is news, not a warning, so it can be dismissed
 * (lib/directNotice.ts); Settings, Devices and PCs keeps saying it.
 */
export function LanExposureNotice({ host, direct = false, onOpen, onDismiss }: { host: string; direct?: boolean; onOpen: () => void; onDismiss: () => void }) {
  const t = useT();
  return (
    <div className={direct ? "update-notice" : "update-notice is-exposed"} role="status" data-testid="lan-exposure-notice">
      <span>{direct
        ? isTailnetAddress(host) ? t("This PC takes connections at {host} on Tailscale. Only devices paired through the relay can sign in there; nothing new pairs.", { host })
          : t("This PC takes connections at {host} on your home network. Only devices paired through the relay can sign in there; nothing new pairs.", { host })
        : t("Anyone who can reach {host} on your network can type into every pane: no access token is set and no device is paired yet.", { host })}</span>
      <div className="lan-exposure-actions">
        <button type="button" className="btn" onClick={onOpen}>{t("Devices and PCs")}</button>
        {direct && <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={onDismiss}><X /></button>}
      </div>
    </div>
  );
}
