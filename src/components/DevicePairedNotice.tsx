import { Smartphone, X } from "lucide-react";

import "./DevicePairedNotice.css";

import type { DevicePairedEvent } from "../../shared/protocol.ts";
import { currentLocale, useT } from "../lib/i18n.ts";

/**
 * A device was paired with this server while this window was open (`device-paired` on the
 * machines event stream, shared/machines.ts; App keeps the list, lib/pairedNotices.ts bounds
 * it). The owner pairing their own phone is the usual case, and the line is calm for it; the
 * words carry the warning for the other case, so no colour has to: if that was not you, revoke
 * it. Its action opens Phone & devices, where the device is listed and can be revoked, alone or
 * with every other one. Dismissed by hand only, one line per enrollment, the newest last.
 */
export function DevicePairedNotice({ events, onOpen, onDismiss }: { events: readonly DevicePairedEvent[]; onOpen: (event: DevicePairedEvent) => void; onDismiss: (event: DevicePairedEvent) => void }) {
  const t = useT();
  return <>{events.map((event) => {
    const time = new Date(event.enrolled_at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
    return (
      <div key={event.event_id} className="update-notice is-paired" role="status" data-testid="device-paired-notice">
        <Smartphone aria-hidden="true" />
        <span>{t("A new device was paired at {time}: {name}. If that was not you, revoke it.", { time, name: event.label })}</span>
        <div className="device-paired-actions">
          <button type="button" className="btn" onClick={() => onOpen(event)}>{t("Phone & devices")}</button>
          <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => onDismiss(event)}><X /></button>
        </div>
      </div>
    );
  })}</>;
}
