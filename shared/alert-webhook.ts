/**
 * Settings → Alerts → Also send to: one destination this PC also posts its pane alerts to, in a
 * preset format (server/alert-webhook.ts). The URL or bot token is written once and never read back:
 * the view names it masked.
 *
 *   GET    /api/alerts/webhook        -> AlertWebhookView
 *   PUT    /api/alerts/webhook        AlertWebhookSave -> AlertWebhookView
 *   DELETE /api/alerts/webhook        -> 204
 *   POST   /api/alerts/webhook/test   -> 204 | 404 webhook_not_configured | 502 webhook_failed
 */
import type { AlertPrefs } from "./notify-policy.ts";

export const ALERT_WEBHOOK_PRESETS = ["ntfy", "slack", "discord", "telegram", "json"] as const;
export type AlertWebhookPreset = (typeof ALERT_WEBHOOK_PRESETS)[number];

export interface AlertWebhookView {
  configured: boolean;
  preset: AlertWebhookPreset | null;
  /** the URL or token, masked: enough to recognise it, not to use it */
  target: string | null;
  /** Telegram only */
  chat_id: string | null;
  alerts: AlertPrefs;
  /** whether messages link to an address another device opens: false until a save comes from one (not the relay, not this PC's localhost) */
  reachable_link: boolean;
  /** ISO times of the last post that went through and the last that did not, since this server started */
  last_success_at: string | null;
  last_failure_at: string | null;
  /** what the last failure was ("HTTP 404", "no response"); null after a success */
  last_error: string | null;
}

export interface AlertWebhookSave {
  preset: AlertWebhookPreset;
  /** the webhook or ntfy topic URL; absent keeps the one saved (same preset only) */
  url?: string;
  /** Telegram's bot token; absent keeps the one saved */
  token?: string;
  chat_id?: string;
  alerts?: AlertPrefs;
}
