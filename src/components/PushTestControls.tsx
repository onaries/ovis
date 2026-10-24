import { useState } from "react";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { inNativeApp } from "../lib/nativeApp.ts";
import { notificationState } from "../lib/notifications.ts";
import { pushSupported, testDevicePush } from "../lib/push.ts";
import { useSettings } from "../lib/settings.ts";

type Result = Awaited<ReturnType<typeof testDevicePush>> | "gone" | "failed" | "sending" | null;

export function PushTestControls({ onEnable }: { onEnable: () => Promise<boolean> }) {
  const { settings } = useSettings();
  const t = useT();
  const [result, setResult] = useState<Result>(null);
  const supported = pushSupported();
  const denied = notificationState() === "denied";
  const busy = result === "sending";
  const enable = !settings.alertsOn || result === "missing" || result === "gone" || result === "permission";

  const send = async (repair: boolean) => {
    setResult("sending");
    try {
      if (repair) setResult(await onEnable() ? "sent" : "failed");
      else setResult(await testDevicePush());
    } catch (error) {
      // gone: the push service retired the endpoint; Turn alerts on again subscribes this device anew
      const code = error instanceof ApiError ? error.code : null;
      setResult(code === "subscription_not_found" ? "missing" : code === "subscription_gone" ? "gone" : "failed");
    }
  };

  return (
    <div className="settings-item">
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-label">{t("Test notification")}</span>
          <span className="settings-description">{t("Check whether this device can receive push alerts")}</span>
          {/* always in the document, empty until there is something to say: a live region */}
          <span className="settings-hint" role="status">
            {!supported || result === "unsupported" ? t("Push alerts need HTTPS or localhost, and on iPhone the home-screen app.")
              : denied ? inNativeApp() ? t("Allow notifications for Ovis in the phone's Settings, then try again.") : t("Allow notifications in your browser settings, then try again.")
              : result === "sent" ? t("Test notification sent. Check this device for the alert.")
              : result === "missing" ? t("This device's push subscription is missing. Turn alerts on again.")
              : result === "gone" ? t("The push service retired this device's subscription. Turn alerts on again to make a new one.")
              : result === "permission" ? t("Allow notifications to test alerts on this device.")
              : result === "failed" ? t("Could not send the test notification. Try again.")
              : !settings.alertsOn ? t("Alerts off") : null}
          </span>
        </div>
        <button type="button" className="btn" disabled={busy || !settings.alertsOn || !supported || denied} onClick={() => void send(false)}>{busy ? t("Sending…") : t("Send test")}</button>
      </div>
      {enable && supported && !denied && <div className="settings-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void send(true)}>{t("Turn alerts on again")}</button>
      </div>}
    </div>
  );
}
