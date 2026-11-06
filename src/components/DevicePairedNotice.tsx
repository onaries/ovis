import { Smartphone, SmartphoneNfc, X } from "lucide-react";

import "./DevicePairedNotice.css";

import type { DevicePairedEvent, DeviceRemovedEvent } from "../../shared/protocol.ts";
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
        <span>{event.approved_by
          ? t("A new device joined at {time}: {name}, approved on {approver}. If that was not you, revoke it.", { time, name: event.label, approver: event.approved_by.label })
          : t("A new device was paired at {time}: {name}. If that was not you, revoke it.", { time, name: event.label })}</span>
        <div className="device-paired-actions">
          <button type="button" className="btn" onClick={() => onOpen(event)}>{t("Devices and PCs")}</button>
          <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => onDismiss(event)}><X /></button>
        </div>
      </div>
    );
  })}</>;
}

/**
 * A device was removed from this PC while this window was open (`device-removed`): revoked here,
 * or removed through the account by another device. One calm line per removal, saying by whom, so
 * a removal nobody here made shows; dismissed by hand.
 */
export function DeviceRemovedNotice({ events, onDismiss }: { events: readonly DeviceRemovedEvent[]; onDismiss: (event: DeviceRemovedEvent) => void }) {
  const t = useT();
  return <>{events.map((event) => {
    const time = new Date(event.removed_at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" });
    const text = event.by === undefined ? t("{name} was removed from this PC at {time}.", { name: event.label, time })
      : event.by === "pc" ? t("{name} was revoked on this PC at {time}.", { name: event.label, time })
      : t("{name} was removed from this PC at {time}, by {by}.", { name: event.label, time, by: event.by.label });
    return (
      <div key={event.event_id} className="update-notice is-paired" role="status" data-testid="device-removed-notice">
        <SmartphoneNfc aria-hidden="true" />
        <span>{text}</span>
        <div className="device-paired-actions">
          <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => onDismiss(event)}><X /></button>
        </div>
      </div>
    );
  })}</>;
}
