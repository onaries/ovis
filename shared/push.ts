/** GET /api/push: base64url VAPID public key, the `applicationServerKey` a browser subscribes with. */
export interface PushKey {
  readonly public_key: string;
}

/**
 * The JSON inside every web push, decrypted by the device's service worker (public/sw.js)
 * and shown as a notification. `pane_id` is null for the enable-confirmation push; `tag`
 * is shared with the in-tab notification of the same pane, so one replaces the other.
 */
export interface PushPayload {
  /** Absent in legacy payloads means local. */
  machine_id?: string;
  pane_id: string | null;
  /** The workspace the pane was last seen in, so the tap of an ended pane opens that workspace. Absent when not known. */
  workspace_id?: string;
  title: string;
  body: string;
  tag: string;
}

/**
 * Why the last push to a subscription did not arrive, as its push service answered: `gone`
 * (404/410, the subscription is retired), `key-mismatch` (401/403, the signing key is not the one
 * it was made for), `rejected` (another 4xx), `throttled` (429), `server` (5xx), `network` (no
 * answer, a timeout or a redirect).
 */
export type PushDeliveryFailure = "gone" | "key-mismatch" | "rejected" | "throttled" | "server" | "network";

/**
 * POST /api/push/status: what the server knows of this browser's own subscription, answered only
 * to its owner holding its keys. `registered` is false for a subscription the push service
 * retired (its record is kept so the device learns why alerts stopped). The times are ISO 8601;
 * a failure older than the last success is history, not a fault.
 */
export interface PushSubscriptionStatus {
  readonly registered: boolean;
  readonly last_success_at: string | null;
  readonly last_failure_at: string | null;
  readonly last_failure: PushDeliveryFailure | null;
}
