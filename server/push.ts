/**
 * Web Push: pane alerts that reach a device even when Ovis is closed there.
 *
 * The browser hands us a subscription (an endpoint on its vendor's push service plus
 * the keys to encrypt for it); we POST encrypted payloads there, signed with our VAPID
 * key. Both halves persist in the state dir (default ~/.config/ovis):
 * - vapid.json: every subscription is bound to this key pair. Regenerating it silently
 *   orphans every subscribed device, so a malformed file is an error, never a rotation.
 * - push-subscriptions.json: survives restarts, so a reboot does not unsubscribe phones.
 *   A 404/410 from a push service means the device dropped it; the record is deleted.
 * - push-retired.json: the endpoint is also remembered, as a hash only (`RETIRED_LIMIT`, `RETIRED_TTL_MS`),
 *   so a restart does not forget it: a browser can keep handing over a subscription its push
 *   service retired, and registering it again would only fail the next push, so it is refused as
 *   `subscription_gone` and the device subscribes anew (#1038).
 *
 * Requests are built by web-push's generateRequestDetails (RFC 8291 aes128gcm + RFC
 * 8292 VAPID) and sent with fetch; its sendNotification path goes through node:https
 * and https-proxy-agent, which Bun does not need.
 *
 * An alert waits before it goes out, and a change of the pane's status meanwhile calls it
 * off: a question answered at the desk, or a finish followed by the next prompt, never
 * reaches the phone. herdr says nothing of whether anyone is at the PC, so a change that
 * quick is taken for someone being there (as Claude Code waits ~6 s on a permission
 * prompt and ~60 s after a reply before it notifies). A question waits `short`; a finish
 * waits `long`, and only one after a turn that worked `longTurn` or more is worth it,
 * unless the device asked for every finish (which then waits `short`).
 *
 * No device gets an alert while a window of the app is in use somewhere (`inUse`: a
 * connected page that is visible and has focus, which says so over its WebSocket): the
 * person is at a screen that already shows the change (#751). It is asked when an alert
 * would go out, so a window brought forward while the alert waits still holds it back.
 *
 * A pane on the shared mute list (`muted`, shared/preferences.ts `muted_panes`) gets no alert
 * on any device: none is scheduled for it, one already waiting is called off when the list
 * changes (`mutesChanged`), and the list is asked again right before a waiting one goes out.
 * Its status is tracked all the same, so an unmute tells only what changes after it.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import webpush from "web-push";

import { paneStorageId } from "../shared/machines.ts";
import type { AgentStatus, HerdrPane, PushPayload } from "../shared/protocol.ts";
import {
  type AlertPrefs,
  DEFAULT_ALERTS,
  ENDED_NOTIFICATION_BODY,
  paneNotificationTag,
  paneTitle,
  parseAlerts,
  shouldNotifyStatus,
  statusNotificationBody,
} from "../shared/notify-policy.ts";
import { badRequest, jsonResponse, setRequestRoute } from "./http.ts";
import { isLoopbackHost } from "./access.ts";
import { writePrivateState } from "./private-state.ts";

/** A blocked agent is still blocked when the phone gets signal back; a newer push for the pane replaces it anyway. */
const PUSH_TTL_SECONDS = 12 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;
const DEFAULT_SUBJECT = "https://github.com/devswha/ovis";
/** How many retired endpoints are remembered; the oldest is forgotten first. */
const RETIRED_LIMIT = 1000;
/** How long a retired endpoint is remembered: a browser that kept it this long has long since moved on. */
const RETIRED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long an alert waits for the pane to change first, and the turn a finish is worth telling. */
export interface AlertTiming {
  /** a question, and a finish on a device that wants every one */
  short: number;
  /** a finish after a long turn */
  long: number;
  /** the least a turn works for its finish to be worth an alert (`done: "long"`) */
  longTurn: number;
}
export const DEFAULT_ALERT_TIMING: AlertTiming = { short: 10_000, long: 60_000, longTurn: 60_000 };

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** what this device wants alerts for; absent in a record from before there was a choice */
  alerts?: AlertPrefs;
  /** null: local/token sign-in; absent: legacy subscription awaiting ownership. */
  device_id?: string | null;
}


export type PushDelivery = { ok: true } | { ok: false; status: number | null; gone: boolean };

export interface PushService {
  publicKey(): string;
  /** `parseSubscription` with this service's endpoint rule: what POST /api/push/subscribe accepts */
  parse(value: unknown): PushSubscriptionRecord | null;
  /** `alerts` absent keeps what the device chose before (a re-registration on load) */
  subscribe(subscription: PushSubscriptionRecord, alerts?: AlertPrefs, deviceId?: string | null): void;
  revokeDevice(id: string): void;
  unsubscribe(endpoint: string): void;
  /** whether a push service answered 404/410 for this endpoint since the server started */
  retired(endpoint: string): boolean;
  /** One confirmation push to one device, so enabling alerts proves the whole path works. */
  sendTest(endpoint: string): Promise<PushDelivery | null>;
  /** The collector's view of every pane: status baselines and the titles notifications use. */
  seed(panes: readonly HerdrPane[], machineId?: string, machineName?: string): void;
  /**
   * After status events were lost, `panes` (every pane on the PC) are the baseline for all
   * but the `newer` ones, which had an event since this snapshot was asked for. A pane
   * missing from it is gone: its waiting alert is called off. Nothing is announced: a
   * change that happened unseen is not news, and an alert it overtook is called off.
   */
  resync(panes: readonly HerdrPane[], newer: ReadonlySet<string>, machineId?: string): void;
  /** Schedules the alert this change is worth, and calls off the one it overtakes. */
  onStatus(paneId: string, status: AgentStatus, machineId?: string): Promise<void>;
  onEnded(paneId: string, machineId?: string): Promise<void>;
  /** The shared mute list changed: an alert waiting for a pane now muted is called off. */
  mutesChanged(): void;
  /** Resolves once every alert scheduled so far went out or was called off (tests wait). */
  settled(): Promise<void>;
}

export interface PushServiceOptions {
  stateDir: string;
  subject?: string;
  /** Current title of a pane, looked up when an alert fires; falls back to the last seeded one. */
  lookupTitle?: (paneId: string) => Promise<string | undefined>;
  timing?: Partial<AlertTiming>;
  now?: () => number;
  canDeliver?: (deviceId: string | null | undefined) => boolean;
  /** whether a window of the app is in use right now: then no alert goes to any device (the test push still does) */
  inUse?: () => boolean;
  /** whether the pane's alerts are off for everyone (shared/notify-policy.ts paneAlertsMuted on the shared preferences) */
  muted?: (machineId: string, paneId: string) => boolean;
  /** accept plain-http loopback endpoints: only for the tests' fake push service (push.fake.ts) */
  loopbackHttp?: boolean;
}

export { defaultStateDir } from "./update-state.ts";

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Owner-only, and written whole, but not flushed: only for push-retired.json, which is telemetry.
 * The key pair and the subscriptions go through writePrivateState (private-state.ts).
 */
function writeJsonPrivate(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function decodedLength(value: unknown): number {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(value)) return -1;
  return Buffer.from(value, "base64url").length;
}

/** The PushSubscription JSON a browser produces, checked before anything is stored. */
export function parseSubscription(value: unknown, options: { loopbackHttp?: boolean } = {}): PushSubscriptionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string") return null;
  try {
    const url = new URL(endpoint);
    // https only. A browser never hands over an http: endpoint (push is https by
    // definition), so one is never a subscription: it is only the shape that turns this
    // server into a POST from inside the user's network at a host no browser page could
    // reach — a link-local metadata address, a router admin page, another VLAN.
    // Loopback is no exception: a watch device would make every agent alert a POST to a
    // local service. Only a push service made for the tests' fake (push.fake.ts, which runs
    // on loopback http) passes `loopbackHttp`, through createServer's `pushLoopbackHttp`.
    const loopbackHttp = options.loopbackHttp === true && url.protocol === "http:" && isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !loopbackHttp) return null;
  } catch {
    return null;
  }
  // p256dh is an uncompressed P-256 point (65 bytes), auth a 16-byte secret
  if (decodedLength(keys?.p256dh) !== 65 || decodedLength(keys?.auth) !== 16) return null;
  return { endpoint, keys: { p256dh: keys!.p256dh as string, auth: keys!.auth as string } };
}

export function statusMessage(paneId: string, title: string, status: AgentStatus): PushPayload {
  return { pane_id: paneId, title, body: statusNotificationBody(status), tag: paneNotificationTag(paneId) };
}

export function endedMessage(paneId: string, title: string): PushPayload {
  return { pane_id: paneId, title, body: ENDED_NOTIFICATION_BODY, tag: paneNotificationTag(paneId) };
}

/** An alert scheduled for a pane, from its scheduling until it went out or was called off. */
interface Scheduled {
  key: string;
  machineId: string;
  paneId: string;
  /** a mute called it off: set for good, so an unmute while its title is looked up sends nothing */
  silenced: boolean;
  /** stops the timers that have not fired yet */
  cancel: () => void;
}

export function createPushService(options: PushServiceOptions): PushService {
  const vapidPath = join(options.stateDir, "vapid.json");
  const subscriptionsPath = join(options.stateDir, "push-subscriptions.json");
  const subject = options.subject ?? process.env["OVIS_PUSH_SUBJECT"] ?? DEFAULT_SUBJECT;

  let vapid: { publicKey: string; privateKey: string } | null = null;
  let subscriptions: Map<string, PushSubscriptionRecord> | null = null;
  const lastStatus = new Map<string, AgentStatus>();
  const titles = new Map<string, string>();
  // the workspace a pane was last seen in: an alert names it, so the tap of an ended pane can open
  // its workspace (src/lib/deepLink.ts resolveLink) once herdr has dropped the pane
  const workspaces = new Map<string, string>();
  const retiredPath = join(options.stateDir, "push-retired.json");
  /** sha256 of each endpoint a push service retired -> when, oldest first; loaded on first need */
  let retiredEndpoints: Map<string, number> | null = null;
  const endpointHash = (endpoint: string): string => createHash("sha256").update(endpoint).digest("base64url");

  /** Created on first need: a server nobody subscribes to never writes a key. */
  function keys(): { publicKey: string; privateKey: string } {
    if (vapid) return vapid;
    const stored = readJson(vapidPath) as { publicKey?: unknown; privateKey?: unknown } | undefined;
    if (stored === undefined) {
      // cached only once on disk: a key no restart would find must never sign a subscription
      const created = webpush.generateVAPIDKeys();
      writePrivateState(vapidPath, created);
      vapid = created;
    } else if (typeof stored.publicKey === "string" && typeof stored.privateKey === "string") {
      vapid = { publicKey: stored.publicKey, privateKey: stored.privateKey };
    } else {
      throw new Error(`${vapidPath} is malformed; restore it or delete it (every device then re-subscribes)`);
    }
    return vapid;
  }

  function store(): Map<string, PushSubscriptionRecord> {
    if (subscriptions) return subscriptions;
    const stored = readJson(subscriptionsPath);
    subscriptions = new Map();
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        const parsed = parseSubscription(entry, options);
        const alerts = (entry as { alerts?: unknown } | null)?.alerts;
        if (parsed) {
          const owner = (entry as PushSubscriptionRecord).device_id;
          subscriptions.set(parsed.endpoint, { ...parsed, ...(alerts === undefined ? {} : { alerts: parseAlerts(alerts) }),
            ...(owner === null || typeof owner === "string" ? { device_id: owner } : {}) });
        }
      }
    }
    return subscriptions;
  }

  function retiredStore(): Map<string, number> {
    if (retiredEndpoints) return retiredEndpoints;
    retiredEndpoints = new Map();
    let stored: unknown;
    try {
      stored = readJson(retiredPath);
    } catch {
      return retiredEndpoints; // an unreadable file only means a retired endpoint registers again once
    }
    if (!Array.isArray(stored)) return retiredEndpoints;
    const cutoff = (options.now ?? Date.now)() - RETIRED_TTL_MS;
    for (const entry of stored.slice(-RETIRED_LIMIT)) {
      const { hash, at } = (entry ?? {}) as { hash?: unknown; at?: unknown };
      if (typeof hash === "string" && typeof at === "number" && at > cutoff) retiredEndpoints.set(hash, at);
    }
    return retiredEndpoints;
  }

  /** Writes `next` and only then makes it the subscriptions in use, so a failed write changes nothing. */
  function persist(next: Map<string, PushSubscriptionRecord>): void {
    writePrivateState(subscriptionsPath, [...next.values()]);
    subscriptions = next;
  }

  function without(remove: (endpoint: string, subscription: PushSubscriptionRecord) => boolean): Map<string, PushSubscriptionRecord> | null {
    const next = new Map([...store()].filter(([endpoint, subscription]) => !remove(endpoint, subscription)));
    return next.size === store().size ? null : next;
  }

  async function deliver(subscription: PushSubscriptionRecord, message: PushPayload, urgency: "normal" | "high"): Promise<PushDelivery> {
    if (options.canDeliver && !options.canDeliver(subscription.device_id)) return { ok: false, status: null, gone: false };
    const { publicKey, privateKey } = keys();
    const details = webpush.generateRequestDetails(subscription, JSON.stringify(message), {
      vapidDetails: { subject, publicKey, privateKey },
      TTL: PUSH_TTL_SECONDS,
      urgency,
      contentEncoding: "aes128gcm",
    });
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(details.headers)) headers[name] = String(value);
    let status: number | null = null;
    try {
      const response = await fetch(details.endpoint, {
        method: details.method,
        headers,
        body: new Uint8Array(details.body),
        // a push service answers, it never redirects: following one would send the alert to
        // wherever the endpoint points, past the https-only check (a local service, over http)
        redirect: "error",
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true };
      status = response.status;
    } catch {
      /* network failure or timeout: status stays null */
    }
    // 404/410: the device unsubscribed or the browser dropped the subscription
    const gone = status === 404 || status === 410;
    if (gone) {
      const hash = endpointHash(subscription.endpoint);
      const retired = retiredStore();
      retired.delete(hash);
      retired.set(hash, (options.now ?? Date.now)());
      if (retired.size > RETIRED_LIMIT) retired.delete(retired.keys().next().value!);
      writeJsonPrivate(retiredPath, [...retired].map(([key, at]) => ({ hash: key, at })));
      const next = without((endpoint) => endpoint === subscription.endpoint);
      if (next) persist(next);
    } else {
      console.error(`web push to ${new URL(subscription.endpoint).host} failed: ${status ?? "no response"}`);
    }
    return { ok: false, status, gone };
  }

  async function broadcast(message: PushPayload, urgency: "normal" | "high", to: readonly PushSubscriptionRecord[] = [...store().values()]): Promise<void> {
    await Promise.all(
      to.map((subscription) =>
        deliver(subscription, message, urgency).catch((error: unknown) => {
          console.error(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
        }),
      ),
    );
  }

  /** Where an alert's pane is: its PC (absent for this one) and the workspace it was last seen in. */
  function where(key: string, machineId: string): Pick<PushPayload, "machine_id" | "workspace_id"> {
    const workspace = workspaces.get(key);
    return { ...(machineId === "local" ? {} : { machine_id: machineId }), ...(workspace ? { workspace_id: workspace } : {}) };
  }

  async function titleOf(paneId: string): Promise<string> {
    try {
      const fresh = await options.lookupTitle?.(paneId);
      if (fresh) return fresh;
    } catch {
      /* herdr busy: the seeded title is at most one reconcile old */
    }
    return titles.get(paneId) ?? paneId;
  }

  const timing = { ...DEFAULT_ALERT_TIMING, ...options.timing };
  const now = options.now ?? Date.now;
  /** when each pane's current turn began: from `working`/`blocked` entered, until idle or done */
  const turnStart = new Map<string, number>();
  /** the alert each pane is waiting to send, called off by the pane's next change (or its mute) */
  const waiting = new Map<string, Scheduled>();
  /**
   * every alert from its scheduling until it went out or was called off, with the pane it is for:
   * a mute calls one off even while its title is looked up, and an unmute after that brings it back nowhere
   */
  const unsent = new Set<Scheduled>();
  /** every alert not yet sent or called off, for `settled()` */
  const inFlight = new Set<Promise<void>>();

  function callOff(key: string): void {
    waiting.get(key)?.cancel();
    waiting.delete(key);
  }

  const muted = (machineId: string, paneId: string): boolean => options.muted?.(machineId, paneId) === true;

  /** How long a device waits before this alert reaches it, or null: it does not want it. */
  function delayFor(prefs: AlertPrefs, status: AgentStatus, worked: number | null): number | null {
    if (status === "blocked") return prefs.input ? timing.short : null;
    if (status !== "done" || prefs.done === "off") return null;
    if (prefs.done === "always") return timing.short;
    // a turn that began before this server knew the pane is of unknown length: tell it
    return worked === null || worked >= timing.longTurn ? timing.long : null;
  }

  /** One timer per delay, each for the devices that wait that long; all called off together. */
  function schedule(key: string, machineId: string, paneId: string, groups: Map<number, PushSubscriptionRecord[]>, send: (to: PushSubscriptionRecord[], silenced: () => boolean) => Promise<void>): void {
    const cancels: Array<() => void> = [];
    let remaining = groups.size;
    let open = groups.size;
    for (const [delay, to] of groups) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let fired = false;
      const done = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          fired = true;
          remaining -= 1;
          if (remaining === 0 && waiting.get(key) === entry) waiting.delete(key);
          send(to, () => entry.silenced).catch((error: unknown) => {
            console.error(`web push failed: ${error instanceof Error ? error.message : String(error)}`);
          }).finally(resolve);
        }, delay);
        // a group already sending is past calling off: it settles when its delivery does
        cancels.push(() => { if (fired) return; clearTimeout(timer); resolve(); });
      });
      inFlight.add(done);
      void done.finally(() => {
        inFlight.delete(done);
        open -= 1;
        if (open === 0) unsent.delete(entry);
      });
    }
    const entry: Scheduled = { key, machineId, paneId, silenced: false, cancel: () => { for (const cancel of cancels) cancel(); } };
    waiting.set(key, entry);
    unsent.add(entry);
  }

  return {
    publicKey: () => keys().publicKey,
    parse: (value) => parseSubscription(value, options),

    subscribe(subscription, alerts, deviceId) {
      const kept = alerts ?? store().get(subscription.endpoint)?.alerts;
      const next = new Map(store());
      next.set(subscription.endpoint, { ...subscription, ...(kept === undefined ? {} : { alerts: kept }),
        ...(deviceId === undefined ? {} : { device_id: deviceId }) });
      persist(next);
    },

    revokeDevice(id) {
      persist(without((_, subscription) => subscription.device_id === id || subscription.device_id === undefined) ?? new Map(store()));
    },

    unsubscribe(endpoint) {
      const next = without((key) => key === endpoint);
      if (next) persist(next);
    },

    retired: (endpoint) => retiredStore().has(endpointHash(endpoint)),

    async sendTest(endpoint) {
      const subscription = store().get(endpoint);
      if (!subscription) return null;
      return deliver(subscription, { pane_id: null, title: "Ovis", body: "Alerts are on for this device", tag: "herdr-test" }, "normal");
    },

    seed(panes, machineId = "local", machineName) {
      for (const pane of panes) {
        // only fill gaps: an event already seen is newer than any snapshot
        const key = paneStorageId(machineId, pane.pane_id);
        titles.set(key, `${machineName ? machineName + " · " : ""}${paneTitle(pane)}`);
        workspaces.set(key, pane.workspace_id);
        if (!lastStatus.has(key)) lastStatus.set(key, pane.agent_status);
      }
    },

    resync(panes, newer, machineId = "local") {
      const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
      const present = new Set(panes.map((pane) => paneStorageId(machineId, pane.pane_id)));
      const newerKeys = new Set([...newer].map((paneId) => paneStorageId(machineId, paneId)));
      const remotePrefix = `remote:${encodeURIComponent(machineId)}:`;
      const onThisPc = (key: string): boolean => machineId === "local" ? !key.startsWith("remote:") : key.startsWith(remotePrefix);
      for (const key of [...lastStatus.keys()]) {
        if (!onThisPc(key) || present.has(key) || newerKeys.has(key)) continue;
        // closed while events were lost: no alert may still speak for it
        callOff(key);
        turnStart.delete(key);
        lastStatus.delete(key);
      }
      for (const pane of panes) {
        if (newer.has(pane.pane_id)) continue;
        const key = paneStorageId(machineId, pane.pane_id);
        const previous = lastStatus.get(key);
        const status = pane.agent_status;
        if (previous === status) continue;
        // done and idle are both at rest: herdr reports a finish nobody has seen as idle. No
        // alert is called off for it, but it is what the next event is measured against
        if (previous !== undefined && !busy(previous) && !busy(status)) { lastStatus.set(key, status); continue; }
        lastStatus.set(key, status);
        if (previous === undefined) continue;
        callOff(key);
        // a turn that began unseen has no known start, like a first sighting mid-turn
        if (busy(status) !== busy(previous)) turnStart.delete(key);
      }
    },

    async onStatus(paneId, status, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      const previous = lastStatus.get(key);
      lastStatus.set(key, status);
      if (previous === status) return;
      // answered, working again, or seen: whatever was waiting is no longer news
      callOff(key);
      const busy = (value: AgentStatus | undefined): boolean => value === "working" || value === "blocked";
      // a first sighting mid-turn has no start: its length stays unknown
      if (busy(status) && previous !== undefined && !busy(previous)) turnStart.set(key, now());
      let worked: number | null = null;
      if (!busy(status)) {
        const start = turnStart.get(key);
        worked = start === undefined ? null : now() - start;
        turnStart.delete(key);
      }
      if (!shouldNotifyStatus(previous, status)) return;
      // muted for everyone: tracked above, told to nobody
      if (muted(machineId, paneId)) return;
      const groups = new Map<number, PushSubscriptionRecord[]>();
      for (const subscription of store().values()) {
        const delay = delayFor(subscription.alerts ?? DEFAULT_ALERTS, status, worked);
        if (delay !== null) groups.set(delay, [...(groups.get(delay) ?? []), subscription]);
      }
      if (groups.size === 0) return;
      schedule(key, machineId, paneId, groups, async (to, silenced) => {
        if (options.inUse?.() || muted(machineId, paneId)) return;
        const title = machineId === "local" ? await titleOf(paneId) : titles.get(key) ?? paneId;
        // the title can wait for herdr: a window that came into use, or a mute made (even one undone since), meanwhile still holds the alert
        if (options.inUse?.() || silenced() || muted(machineId, paneId)) return;
        // a device that dropped out meanwhile is not written to
        const live = to.flatMap((subscription) => {
          const current = store().get(subscription.endpoint);
          return current && current.device_id === subscription.device_id ? [current] : [];
        });
        await broadcast({ ...statusMessage(paneId, title, status), ...where(key, machineId), tag: paneNotificationTag(paneId, machineId) }, status === "blocked" ? "high" : "normal", live);
      });
    },

    async onEnded(paneId, machineId = "local") {
      const key = paneStorageId(machineId, paneId);
      callOff(key);
      turnStart.delete(key);
      if (muted(machineId, paneId)) return;
      // an ended terminal is a finish of its own: a device that wants none hears none
      const to = [...store().values()].filter((subscription) => (subscription.alerts ?? DEFAULT_ALERTS).done !== "off");
      if (to.length === 0 || options.inUse?.()) return;
      // the pane may already be gone from herdr: the seeded title is what is left
      await broadcast({ ...endedMessage(paneId, titles.get(key) ?? paneId), ...where(key, machineId), tag: paneNotificationTag(paneId, machineId) }, "normal", to);
    },

    mutesChanged() {
      // an unmute resurrects nothing: what was called off while muted stays called off, including
      // an alert whose timer has fired and whose title is still being looked up
      for (const entry of [...unsent]) {
        if (!muted(entry.machineId, entry.paneId)) continue;
        entry.silenced = true;
        entry.cancel();
        unsent.delete(entry);
        if (waiting.get(entry.key) === entry) waiting.delete(entry.key);
      }
    },

    async settled() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

/**
 * /api/push routes. All sit behind the token gate (they are /api/ and not health/auth):
 * a subscription receives pane titles until it is removed.
 *   GET    /api/push                        -> { public_key }
 *   POST   /api/push/subscribe { subscription, alerts? } -> 204 (alerts: this device's AlertPrefs)
 *          | 410 subscription_gone (its push service retired the endpoint: subscribe anew)
 *   DELETE /api/push/subscribe { endpoint } -> 204
 *   POST   /api/push/test      { endpoint } -> 204 | 404 subscription_not_found | 410 subscription_gone | 502 push_failed
 */
function subscriptionGone(): Response {
  return jsonResponse({ error: { code: "subscription_gone", message: "the push service retired this subscription; subscribe again" } }, 410);
}

export async function handlePushRequest(request: Request, pathname: string, push: PushService, deviceId: string | null | undefined): Promise<Response | null> {
  if (pathname === "/api/push" || pathname === "/api/push/subscribe" || pathname === "/api/push/test") setRequestRoute(pathname);
  const route = `${request.method} ${pathname}`;
  if (route === "GET /api/push") return jsonResponse({ public_key: push.publicKey() });
  if (route !== "POST /api/push/subscribe" && route !== "DELETE /api/push/subscribe" && route !== "POST /api/push/test") {
    const known = pathname === "/api/push" || pathname === "/api/push/subscribe" || pathname === "/api/push/test";
    return known ? badRequest("method_not_allowed", `${request.method} is not supported on ${pathname}`) : null;
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("invalid_json", "request body must be JSON");
  }
  const body = (typeof payload === "object" && payload !== null ? payload : {}) as { subscription?: unknown; endpoint?: unknown; alerts?: unknown };

  if (route === "POST /api/push/subscribe") {
    const subscription = push.parse(body.subscription);
    if (!subscription) return badRequest("invalid_subscription", "subscription needs an https endpoint and p256dh/auth keys");
    if (push.retired(subscription.endpoint)) return subscriptionGone();
    push.subscribe(subscription, body.alerts === undefined ? undefined : parseAlerts(body.alerts), deviceId);
    return new Response(null, { status: 204 });
  }
  if (typeof body.endpoint !== "string") return badRequest("missing_endpoint", "endpoint is required");
  if (route === "DELETE /api/push/subscribe") {
    push.unsubscribe(body.endpoint);
    return new Response(null, { status: 204 });
  }
  const delivery = await push.sendTest(body.endpoint);
  if (!delivery) {
    return push.retired(body.endpoint) ? subscriptionGone()
      : jsonResponse({ error: { code: "subscription_not_found", message: "this device is not subscribed" } }, 404);
  }
  if (delivery.ok) return new Response(null, { status: 204 });
  if (delivery.gone) return subscriptionGone();
  return jsonResponse({ error: { code: "push_failed", message: `push service answered ${delivery.status ?? "nothing"}` } }, 502);
}
