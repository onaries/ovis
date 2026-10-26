import { BellOff } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { usePushHealth } from "../lib/pushHealth.ts";

import "./PushHealthNotice.css";

/**
 * This device asked for alerts and the last push to it failed for good (lib/pushHealth.ts):
 * one line over the pane, like the update and exposure notices, with the one action that
 * helps. Where subscribing anew mends it, that is the action; a refusal opens Alerts in
 * Settings, where Send test says whether it still refuses. Not dismissible: the fault leaves
 * when a push gets through, and the line with it. A denied permission has no line here: the
 * Alerts item of the More menu already reads "On in the app", and Settings says what to allow.
 */
export function PushHealthNotice({ onRepair, onOpen }: { onRepair: () => void; onOpen: () => void }) {
  const t = useT();
  const { health, busy } = usePushHealth();
  if (health.problem === null || health.problem === "permission") return null;
  const text = health.problem === "gone" ? t("The push service retired this device's subscription. Turn alerts on again to make a new one.")
    : health.problem === "missing" ? t("This device's push subscription is missing. Turn alerts on again.")
    : health.problem === "key-mismatch" ? t("This device's push subscription was made for another server key. Turn alerts on again to make a new one.")
    : t("The push service refused the last alert to this device. Send a test to check whether it still does.");
  return (
    <div className="update-notice is-alerts" role="status" data-testid="push-health-notice" data-problem={health.problem}>
      <BellOff aria-hidden="true" />
      <span>{text}</span>
      {health.repair
        ? <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={onRepair}>{busy === "repair" ? t("Turning alerts on…") : t("Turn alerts on again")}</button>
        : <button type="button" className="btn" onClick={onOpen}>{t("Alerts")}</button>}
    </div>
  );
}
